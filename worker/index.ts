interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AUTH_PEPPER: string;
  SESSION_TTL_SECONDS?: string;
}

type UserRow = {
  id: string;
  email_hash: string;
  auth_salt: string;
  auth_verifier_hash: string;
  wrapped_vault_key: string;
  kdf_params: string;
  created_at: number;
};

type NoteRow = {
  user_id: string;
  note_id: string;
  server_rev: number;
  last_mutation_id: string;
  nonce: string;
  ciphertext: string;
  aad: string;
  deleted: number;
  byte_size: number;
  updated_at: number;
};

type SessionContext = {
  user: UserRow;
  sessionId: string;
  csrfTokenHash: string;
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const MAX_JSON_BYTES = 1_700_000;
const MAX_CIPHERTEXT_BYTES = 1_400_000;
const MAX_SYNC_LIMIT = 100;
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 12;
const authAttempts = new Map<string, { count: number; resetAt: number }>();
const DUMMY_PUBLIC_USER = {
  userId: "00000000-0000-4000-8000-000000000000",
  authSalt: "AAAAAAAAAAAAAAAAAAAAAA",
  wrappedVaultKey: {
    version: 1 as const,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  },
  kdfParams: {
    authIterations: 310_000,
    wrapIterations: 310_000,
    wrapSalt: "AAAAAAAAAAAAAAAAAAAAAA"
  }
};

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers(JSON_HEADERS);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(message: string, status: number, code = "bad_request"): Response {
  return json({ error: message, code }, status);
}

function now(): number {
  return Date.now();
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSafeBase64(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9_-]+={0,2}$/.test(value);
}

function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let output = "";
  for (let index = 0; index < view.length; index += 0x8000) {
    output += String.fromCharCode(...view.subarray(index, index + 0x8000));
  }
  return btoa(output).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(padded);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

async function sha256(value: string): Promise<string> {
  return bytesToBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hashVerifier(verifier: string, env: Env): Promise<string> {
  return sha256(`${env.AUTH_PEPPER}:${verifier}`);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index++) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

function randomToken(bytes = 32): string {
  const output = new Uint8Array(bytes);
  crypto.getRandomValues(output);
  return bytesToBase64Url(output);
}

function cookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function isLocalRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function sessionCookie(value: string, maxAge: number, request: Request): string {
  const secure = isLocalRequest(request) ? "" : " Secure;";
  return `sid=${value}; Max-Age=${maxAge}; Path=/; HttpOnly;${secure} SameSite=Lax`;
}

function clearSessionCookie(request: Request): string {
  const secure = isLocalRequest(request) ? "" : " Secure;";
  return `sid=; Max-Age=0; Path=/; HttpOnly;${secure} SameSite=Lax`;
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function checkAuthRateLimit(request: Request, identity: string): Promise<boolean> {
  const address = request.headers.get("cf-connecting-ip") || "local";
  const key = `${address}:${await sha256(identity)}`;
  const timestamp = now();
  if (authAttempts.size > 2048) {
    for (const [entryKey, entry] of authAttempts) {
      if (entry.resetAt <= timestamp) authAttempts.delete(entryKey);
    }
  }
  const current = authAttempts.get(key);
  if (!current || current.resetAt <= timestamp) {
    authAttempts.set(key, { count: 1, resetAt: timestamp + AUTH_WINDOW_MS });
    return true;
  }
  if (current.count >= AUTH_MAX_ATTEMPTS) return false;
  current.count += 1;
  return true;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_JSON_BYTES) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_JSON_BYTES) return null;
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeKdfParams(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const params = value as Record<string, unknown>;
  const authIterations = typeof params.authIterations === "number" ? params.authIterations : NaN;
  const wrapIterations = typeof params.wrapIterations === "number" ? params.wrapIterations : NaN;
  const wrapSalt = params.wrapSalt;
  if (
    !Number.isInteger(authIterations) ||
    !Number.isInteger(wrapIterations) ||
    authIterations < 100_000 ||
    authIterations > 1_000_000 ||
    wrapIterations < 100_000 ||
    wrapIterations > 1_000_000 ||
    !isSafeBase64(wrapSalt, 128)
  ) return null;
  const serialized = JSON.stringify({
    authIterations,
    wrapIterations,
    wrapSalt
  });
  return serialized.length <= 1024 ? serialized : null;
}

function safeWrappedVaultKey(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (
    envelope.version !== 1 ||
    !isSafeBase64(envelope.nonce, 128) ||
    !isSafeBase64(envelope.ciphertext, 4096)
  ) return null;
  const serialized = JSON.stringify({
    version: 1,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext
  });
  return serialized.length <= 8192 ? serialized : null;
}

function safeNoteEnvelope(body: Record<string, unknown>): {
  mutationId: string;
  baseRev: number;
  nonce: string;
  ciphertext: string;
  aad: string;
  deleted: boolean;
  byteSize: number;
} | null {
  const mutationId = body.mutationId;
  const baseRev = typeof body.baseRev === "number" ? body.baseRev : NaN;
  const nonce = body.nonce;
  const ciphertext = body.ciphertext;
  const aad = body.aad;
  const deleted = body.deleted === true;
  const byteSize = typeof body.byteSize === "number" ? body.byteSize : NaN;
  if (
    !isUuid(mutationId) ||
    !Number.isInteger(baseRev) ||
    baseRev < 0 ||
    baseRev > 2_000_000_000 ||
    !isSafeBase64(nonce, 128) ||
    !isSafeBase64(ciphertext, 1_900_000) ||
    typeof aad !== "string" ||
    aad.length < 8 ||
    aad.length > 512 ||
    !Number.isInteger(byteSize) ||
    byteSize < 0 ||
    byteSize > MAX_CIPHERTEXT_BYTES
  ) return null;
  return { mutationId, baseRev, nonce, ciphertext, aad, deleted, byteSize };
}

async function getSession(request: Request, env: Env): Promise<SessionContext | null> {
  const rawSession = cookieValue(request, "sid");
  if (!rawSession || rawSession.length > 256) return null;
  const sessionHash = await sha256(rawSession);
  const row = await env.DB.prepare(
    `SELECT s.id_hash, s.user_id, s.csrf_token_hash, s.expires_at,
            u.id, u.email_hash, u.auth_salt, u.auth_verifier_hash,
            u.wrapped_vault_key, u.kdf_params, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.expires_at > ?`
  ).bind(sessionHash, now()).first<{
    id_hash: string;
    user_id: string;
    csrf_token_hash: string;
    expires_at: number;
    id: string;
    email_hash: string;
    auth_salt: string;
    auth_verifier_hash: string;
    wrapped_vault_key: string;
    kdf_params: string;
    created_at: number;
  }>();
  if (!row) return null;
  return {
    sessionId: rawSession,
    csrfTokenHash: row.csrf_token_hash,
    user: {
      id: row.id,
      email_hash: row.email_hash,
      auth_salt: row.auth_salt,
      auth_verifier_hash: row.auth_verifier_hash,
      wrapped_vault_key: row.wrapped_vault_key,
      kdf_params: row.kdf_params,
      created_at: row.created_at
    }
  };
}

async function requireSession(request: Request, env: Env, csrf = true): Promise<SessionContext | Response> {
  if (!isSameOrigin(request)) return errorResponse("跨站请求已拒绝", 403, "origin_rejected");
  const session = await getSession(request, env);
  if (!session) return errorResponse("登录已失效，请重新登录", 401, "unauthorized");
  if (csrf) {
    const token = request.headers.get("x-csrf-token");
    if (!token || !constantTimeEqual(await sha256(token), session.csrfTokenHash)) {
      return errorResponse("CSRF 校验失败", 403, "csrf_failed");
    }
  }
  return session;
}

function publicUser(user: UserRow): Record<string, unknown> {
  return {
    userId: user.id,
    authSalt: user.auth_salt,
    wrappedVaultKey: JSON.parse(user.wrapped_vault_key),
    kdfParams: JSON.parse(user.kdf_params)
  };
}

async function rotateCsrf(session: SessionContext, env: Env): Promise<string> {
  const token = randomToken(32);
  await env.DB.prepare("UPDATE sessions SET csrf_token_hash = ? WHERE id_hash = ?")
    .bind(await sha256(token), await sha256(session.sessionId))
    .run();
  return token;
}

async function createSession(userId: string, env: Env): Promise<{ token: string; csrfToken: string }> {
  const ttl = Math.max(3600, Math.min(2_592_000, Number(env.SESSION_TTL_SECONDS || 604800)));
  const token = randomToken(32);
  const csrfToken = randomToken(32);
  const timestamp = now();
  await env.DB.prepare(
    "INSERT INTO sessions (id_hash, user_id, csrf_token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(
    await sha256(token),
    userId,
    await sha256(csrfToken),
    timestamp + ttl * 1000,
    timestamp
  ).run();
  return { token, csrfToken };
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const authSalt = body?.authSalt;
  const authVerifier = body?.authVerifier;
  const wrappedVaultKey = safeWrappedVaultKey(body?.wrappedVaultKey);
  const kdfParams = safeKdfParams(body?.kdfParams);
  if (!email || !isSafeBase64(authSalt, 128) || !isSafeBase64(authVerifier, 256) || !wrappedVaultKey || !kdfParams) {
    return errorResponse("注册数据格式无效", 400);
  }
  if (!await checkAuthRateLimit(request, email)) return errorResponse("尝试次数过多，请稍后再试", 429, "rate_limited");
  const emailHash = await sha256(email);
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email_hash = ?").bind(emailHash).first();
  if (existing) return errorResponse("该邮箱已注册", 409, "email_exists");
  const userId = crypto.randomUUID();
  const timestamp = now();
  await env.DB.prepare(
    `INSERT INTO users (id, email_hash, auth_salt, auth_verifier_hash, wrapped_vault_key, kdf_params, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    userId,
    emailHash,
    authSalt,
    await hashVerifier(authVerifier, env),
    wrappedVaultKey,
    kdfParams,
    timestamp
  ).run();
  const session = await createSession(userId, env);
  const ttl = Math.max(3600, Math.min(2_592_000, Number(env.SESSION_TTL_SECONDS || 604800)));
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
  if (!user) return errorResponse("注册失败", 500, "server_error");
  return json(
    { user: publicUser(user), csrfToken: session.csrfToken },
    201,
    { "set-cookie": sessionCookie(session.token, ttl, request) }
  );
}

async function handleChallenge(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!email) return errorResponse("邮箱格式无效", 400);
  if (!await checkAuthRateLimit(request, email)) return errorResponse("尝试次数过多，请稍后再试", 429, "rate_limited");
  const emailHash = await sha256(email);
  const user = await env.DB.prepare("SELECT * FROM users WHERE email_hash = ?").bind(emailHash).first<UserRow>();
  return json({ user: user ? publicUser(user) : DUMMY_PUBLIC_USER });
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const authVerifier = body?.authVerifier;
  if (!email || !isSafeBase64(authVerifier, 256)) return errorResponse("邮箱或密码不正确", 401, "invalid_credentials");
  if (!await checkAuthRateLimit(request, email)) return errorResponse("尝试次数过多，请稍后再试", 429, "rate_limited");
  const emailHash = await sha256(email);
  const user = await env.DB.prepare("SELECT * FROM users WHERE email_hash = ?").bind(emailHash).first<UserRow>();
  if (!user || !constantTimeEqual(await hashVerifier(authVerifier, env), user.auth_verifier_hash)) {
    return errorResponse("邮箱或密码不正确", 401, "invalid_credentials");
  }
  const session = await createSession(user.id, env);
  const ttl = Math.max(3600, Math.min(2_592_000, Number(env.SESSION_TTL_SECONDS || 604800)));
  return json(
    { user: publicUser(user), csrfToken: session.csrfToken },
    200,
    { "set-cookie": sessionCookie(session.token, ttl, request) }
  );
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const result = await requireSession(request, env, false);
  if (result instanceof Response) return result;
  const csrfToken = await rotateCsrf(result, env);
  return json({ user: publicUser(result.user), csrfToken });
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  const result = await requireSession(request, env, true);
  if (result instanceof Response) return result;
  await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(result.sessionId)).run();
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(request) });
}

async function getNote(env: Env, userId: string, noteId: string): Promise<NoteRow | null> {
  return env.DB.prepare(
    "SELECT user_id, note_id, server_rev, last_mutation_id, nonce, ciphertext, aad, deleted, byte_size, updated_at FROM notes WHERE user_id = ? AND note_id = ?"
  ).bind(userId, noteId).first<NoteRow>();
}

function notePayload(row: NoteRow): Record<string, unknown> {
  return {
    noteId: row.note_id,
    serverRev: row.server_rev,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    aad: row.aad,
    deleted: Boolean(row.deleted),
    byteSize: row.byte_size,
    updatedAt: row.updated_at
  };
}

async function applyNoteMutation(
  env: Env,
  userId: string,
  noteId: string,
  mutation: {
    mutationId: string;
    baseRev: number;
    nonce: string;
    ciphertext: string;
    aad: string;
    deleted: boolean;
    byteSize: number;
  }
): Promise<Response> {
  const existingMutation = await env.DB.prepare(
    "SELECT user_id, note_id, applied_rev FROM mutations WHERE mutation_id = ?"
  ).bind(mutation.mutationId).first<{ user_id: string; note_id: string; applied_rev: number }>();
  if (existingMutation) {
    if (existingMutation.user_id !== userId || existingMutation.note_id !== noteId) {
      return errorResponse("变更标识冲突", 409, "mutation_conflict");
    }
    const current = await getNote(env, userId, noteId);
    return json({ ok: true, note: current ? notePayload(current) : null, idempotent: true });
  }
  const timestamp = now();
  const newRev = mutation.baseRev + 1;
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO notes
        (user_id, note_id, server_rev, last_mutation_id, nonce, ciphertext, aad, deleted, byte_size, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, note_id) DO UPDATE SET
         server_rev = excluded.server_rev,
         last_mutation_id = excluded.last_mutation_id,
         nonce = excluded.nonce,
         ciphertext = excluded.ciphertext,
         aad = excluded.aad,
         deleted = excluded.deleted,
         byte_size = excluded.byte_size,
         updated_at = excluded.updated_at
       WHERE notes.server_rev = ?`
    ).bind(
      userId,
      noteId,
      newRev,
      mutation.mutationId,
      mutation.nonce,
      mutation.ciphertext,
      mutation.aad,
      mutation.deleted ? 1 : 0,
      mutation.byteSize,
      timestamp,
      mutation.baseRev
    ),
    env.DB.prepare(
      `INSERT INTO mutations (mutation_id, user_id, note_id, applied_rev, created_at)
       SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM notes
           WHERE user_id = ? AND note_id = ? AND server_rev = ? AND last_mutation_id = ?
        )`
    ).bind(mutation.mutationId, userId, noteId, newRev, timestamp, userId, noteId, newRev, mutation.mutationId),
    env.DB.prepare(
      `INSERT INTO changes (user_id, note_id, server_rev, deleted, changed_at)
       SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM notes
           WHERE user_id = ? AND note_id = ? AND server_rev = ? AND last_mutation_id = ?
        )`
    ).bind(userId, noteId, newRev, mutation.deleted ? 1 : 0, timestamp, userId, noteId, newRev, mutation.mutationId)
  ]);
  const changed = Number(result[0]?.meta?.changes || 0);
  if (!changed) {
    const current = await getNote(env, userId, noteId);
    return json(
      { error: "笔记已在其他设备更新", code: "conflict", note: current ? notePayload(current) : null },
      409
    );
  }
  const current = await getNote(env, userId, noteId);
  return json({ ok: true, note: current ? notePayload(current) : null });
}

async function handlePutNote(request: Request, env: Env, session: SessionContext, noteId: string): Promise<Response> {
  const body = await readJson(request);
  const envelope = body ? safeNoteEnvelope(body) : null;
  if (!envelope) return errorResponse("笔记密文格式无效", 400);
  if (envelope.ciphertext.length > 1_900_000) return errorResponse("笔记过大", 413, "note_too_large");
  return applyNoteMutation(env, session.user.id, noteId, envelope);
}

async function handleDeleteNote(request: Request, env: Env, session: SessionContext, noteId: string): Promise<Response> {
  const body = await readJson(request);
  const baseRev = typeof body?.baseRev === "number" ? body.baseRev : NaN;
  if (!body || !isUuid(body.mutationId) || !Number.isInteger(baseRev) || baseRev < 0) {
    return errorResponse("删除请求格式无效", 400);
  }
  const current = await getNote(env, session.user.id, noteId);
  if (!current) return errorResponse("笔记不存在", 404, "not_found");
  return applyNoteMutation(env, session.user.id, noteId, {
    mutationId: body.mutationId,
    baseRev,
    nonce: current.nonce,
    ciphertext: current.ciphertext,
    aad: current.aad,
    deleted: true,
    byteSize: current.byte_size
  });
}

async function handleSync(request: Request, env: Env, session: SessionContext): Promise<Response> {
  const url = new URL(request.url);
  const cursor = Math.max(0, Number(url.searchParams.get("cursor") || 0));
  const limit = Math.min(MAX_SYNC_LIMIT, Math.max(1, Number(url.searchParams.get("limit") || MAX_SYNC_LIMIT)));
  if (!Number.isSafeInteger(cursor) || !Number.isSafeInteger(limit)) return errorResponse("同步游标无效", 400);
  const rows = await env.DB.prepare(
    `SELECT c.sync_seq, n.note_id, n.server_rev, n.last_mutation_id,
            n.nonce, n.ciphertext, n.aad, n.deleted, n.byte_size, n.updated_at
       FROM changes c
       JOIN notes n ON n.user_id = c.user_id AND n.note_id = c.note_id
      WHERE c.user_id = ? AND c.sync_seq > ?
      ORDER BY c.sync_seq ASC
      LIMIT ?`
  ).bind(session.user.id, cursor, limit + 1).all<NoteRow & { sync_seq: number }>();
  const hasMore = rows.results.length > limit;
  const visibleRows = hasMore ? rows.results.slice(0, limit) : rows.results;
  const nextCursor = visibleRows.length ? visibleRows[visibleRows.length - 1].sync_seq : cursor;
  return json({
    cursor: nextCursor,
    hasMore,
    notes: visibleRows.map((row) => ({ syncSeq: row.sync_seq, ...notePayload(row) }))
  });
}

async function handleExport(request: Request, env: Env, session: SessionContext): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT note_id, server_rev, last_mutation_id, nonce, ciphertext, aad, deleted, byte_size, updated_at
       FROM notes WHERE user_id = ? ORDER BY updated_at DESC`
  ).bind(session.user.id).all<NoteRow>();
  return json({
    version: 1,
    exportedAt: now(),
    userId: session.user.id,
    notes: rows.results.map(notePayload)
  });
}

async function routeApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== "GET" && !isSameOrigin(request)) {
    return errorResponse("跨站请求已拒绝", 403, "origin_rejected");
  }
  if (request.method === "POST" && path === "/api/auth/register") return handleRegister(request, env);
  if (request.method === "POST" && path === "/api/auth/challenge") return handleChallenge(request, env);
  if (request.method === "POST" && path === "/api/auth/login") return handleLogin(request, env);
  if (request.method === "GET" && path === "/api/auth/me") return handleMe(request, env);
  if (request.method === "POST" && path === "/api/auth/logout") return handleLogout(request, env);

  if (request.method === "GET" && path === "/api/sync") {
    const result = await requireSession(request, env, false);
    return result instanceof Response ? result : handleSync(request, env, result);
  }
  if (request.method === "GET" && path === "/api/export") {
    const result = await requireSession(request, env, false);
    return result instanceof Response ? result : handleExport(request, env, result);
  }

  const noteMatch = path.match(/^\/api\/notes\/([0-9a-f-]{36})$/i);
  if (noteMatch && (request.method === "PUT" || request.method === "DELETE")) {
    const result = await requireSession(request, env, true);
    if (result instanceof Response) return result;
    const noteId = noteMatch[1];
    return request.method === "PUT"
      ? handlePutNote(request, env, result, noteId)
      : handleDeleteNote(request, env, result, noteId);
  }
  return errorResponse("未找到 API 路由", 404, "not_found");
}

function withSecurityHeaders(response: Response, secure = false): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'self' blob:");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  if (secure) headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const secure = new URL(request.url).protocol === "https:";
      if (new URL(request.url).pathname.startsWith("/api/")) {
        if (!env.AUTH_PEPPER) {
          return withSecurityHeaders(errorResponse("服务端未配置 AUTH_PEPPER", 500, "server_misconfigured"), secure);
        }
        return withSecurityHeaders(await routeApi(request, env), secure);
      }
      return withSecurityHeaders(await env.ASSETS.fetch(request), secure);
    } catch {
      return withSecurityHeaders(errorResponse("服务暂时不可用", 500, "server_error"), new URL(request.url).protocol === "https:");
    }
  }
};
