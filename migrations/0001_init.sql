PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email_hash TEXT NOT NULL UNIQUE,
  auth_salt TEXT NOT NULL,
  auth_verifier_hash TEXT NOT NULL,
  wrapped_vault_key TEXT NOT NULL,
  kdf_params TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  csrf_token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS notes (
  user_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  server_rev INTEGER NOT NULL DEFAULT 0,
  last_mutation_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  aad TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, note_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notes_user_updated ON notes(user_id, updated_at);

CREATE TABLE IF NOT EXISTS mutations (
  mutation_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  applied_rev INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mutations_user ON mutations(user_id, created_at);

CREATE TABLE IF NOT EXISTS changes (
  sync_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  server_rev INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_changes_user_seq ON changes(user_id, sync_seq);
