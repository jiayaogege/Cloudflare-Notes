import { authVerifierForLogin, createVaultCredentials, unwrapVaultKey } from "./crypto";
import type { EncryptedEnvelope, PublicUser, SyncNote } from "./types";

const DEFAULT_NATIVE_API_BASE_URL = "https://cloudflare-private-notes.nanxunke.workers.dev";

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
};

type NativeFetch = (input: URL | Request | string, init?: RequestInit) => Promise<Response>;

let nativeFetchPromise: Promise<NativeFetch> | null = null;

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

function isNativeRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as TauriWindow).__TAURI_INTERNALS__);
}

function nativeApiBaseUrl(): string {
  const configured = import.meta.env?.VITE_NATIVE_API_BASE_URL?.trim() || DEFAULT_NATIVE_API_BASE_URL;
  try {
    const url = new URL(configured);
    const localDevelopment = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(localDevelopment && url.protocol === "http:")) {
      return DEFAULT_NATIVE_API_BASE_URL;
    }
    return url.origin;
  } catch {
    return DEFAULT_NATIVE_API_BASE_URL;
  }
}

function requestUrl(path: string): string {
  return isNativeRuntime() ? new URL(path, nativeApiBaseUrl()).toString() : path;
}

async function nativeFetch(): Promise<NativeFetch> {
  if (!nativeFetchPromise) {
    nativeFetchPromise = import("@tauri-apps/plugin-http").then((module) => module.fetch);
  }
  return nativeFetchPromise;
}

async function sendRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const native = isNativeRuntime();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  if (native) {
    // The Tauri HTTP plugin's Rust cookie jar handles the HttpOnly session.
    // Its `unsafe-headers` feature is required to remove this Origin override;
    // otherwise the Worker would reject writes from tauri://localhost.
    headers.set("origin", "");
  }

  const transport = native ? await nativeFetch() : globalThis.fetch.bind(globalThis);
  return transport(requestUrl(path), {
    ...init,
    credentials: "include",
    headers
  });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await sendRequest(path, init);
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
  const response = await sendRequest("/api/export");
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    throw new ApiError(response.status, data);
  }
  return response.blob();
}
