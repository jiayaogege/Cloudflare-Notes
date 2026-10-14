import { authVerifierForLogin, createVaultCredentials, unwrapVaultKey } from "./crypto";
import type { EncryptedEnvelope, PublicUser, SyncNote } from "./types";

export class ApiError extends Error {
  status: number;
  code?: string;
  data: Record<string, unknown>;

  constructor(status: number, data: Record<string, unknown>) {
    super(typeof data.error === "string" ? data.error : "请求失败");
    this.status = status;
    this.code = typeof data.code === "string" ? data.code : undefined;
    this.data = data;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {})
    }
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}

export interface AuthResult {
  user: PublicUser;
  csrfToken: string;
  vaultKey: Uint8Array;
}

export async function register(email: string, password: string): Promise<AuthResult> {
  const credentials = await createVaultCredentials(password);
  const response = await request<{ user: PublicUser; csrfToken: string }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email,
      authSalt: credentials.authSalt,
      authVerifier: credentials.authVerifier,
      wrappedVaultKey: credentials.wrappedVaultKey,
      kdfParams: credentials.kdfParams
    })
  });
  return { ...response, vaultKey: credentials.vaultKey };
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const challenge = await request<{ user: PublicUser }>("/api/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ email })
  });
  const authVerifier = await authVerifierForLogin(password, challenge.user);
  const response = await request<{ user: PublicUser; csrfToken: string }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, authVerifier })
  });
  const vaultKey = await unwrapVaultKey(password, response.user);
  return { ...response, vaultKey };
}

export async function logout(csrfToken: string): Promise<void> {
  await request("/api/auth/logout", {
    method: "POST",
    headers: { "x-csrf-token": csrfToken }
  });
}

export async function sync(cursor: number): Promise<{ cursor: number; hasMore: boolean; notes: SyncNote[] }> {
  return request(`/api/sync?cursor=${encodeURIComponent(cursor)}&limit=100`);
}

export async function putNote(
  noteId: string,
  csrfToken: string,
  payload: EncryptedEnvelope & { mutationId: string; baseRev: number; deleted: boolean }
): Promise<{ note: SyncNote | null }> {
  return request(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: { "x-csrf-token": csrfToken },
    body: JSON.stringify(payload)
  });
}

export async function exportEncrypted(): Promise<Blob> {
  const response = await fetch("/api/export", { credentials: "include" });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(response.status, data);
  return response.blob();
}
