export interface PublicUser {
  userId: string;
  authSalt: string;
  wrappedVaultKey: {
    version: 1;
    nonce: string;
    ciphertext: string;
  };
  kdfParams: {
    authIterations: number;
    wrapIterations: number;
    wrapSalt: string;
  };
}

export interface Note {
  id: string;
  title: string;
  body: string;
  category: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

export interface EncryptedEnvelope {
  nonce: string;
  ciphertext: string;
  aad: string;
  byteSize: number;
}

export interface StoredNote {
  key: string;
  userId: string;
  noteId: string;
  serverRev: number;
  updatedAt: number;
  deleted: boolean;
  envelope: EncryptedEnvelope;
}

export interface OutboxItem {
  key: string;
  userId: string;
  noteId: string;
  baseRev: number;
  mutationId: string;
  createdAt: number;
  envelope: EncryptedEnvelope;
  deleted: boolean;
}

export interface Session {
  user: PublicUser;
  csrfToken: string;
  vaultKey: Uint8Array;
}

export interface SyncNote extends EncryptedEnvelope {
  noteId: string;
  serverRev: number;
  deleted: boolean;
  updatedAt: number;
  syncSeq: number;
}
