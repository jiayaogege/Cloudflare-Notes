import type { EncryptedEnvelope, Note, PublicUser } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const text = (value: string) => encoder.encode(value);
const PBKDF2_HASH = "SHA-256";
const AES_ALGORITHM = "AES-GCM";
const DEFAULT_ITERATIONS = 310_000;

export const CRYPTO_VERSION = 1;

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function digest(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", asArrayBuffer(value)));
}

async function derivePasswordKey(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey("raw", asArrayBuffer(text(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: asArrayBuffer(salt), iterations, hash: PBKDF2_HASH },
    baseKey,
    256
  );
  return new Uint8Array(bits);
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", asArrayBuffer(raw), { name: AES_ALGORITHM }, false, ["encrypt", "decrypt"]);
}

async function aesEncrypt(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: AES_ALGORITHM, iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(aad) },
    await importAesKey(key),
    asArrayBuffer(plaintext)
  ));
  return { nonce, ciphertext };
}

async function aesDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: AES_ALGORITHM, iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(aad) },
    await importAesKey(key),
    asArrayBuffer(ciphertext)
  ));
}

export async function sha256Base64(value: string): Promise<string> {
  return bytesToBase64Url(await digest(text(value)));
}

export async function createVaultCredentials(password: string): Promise<{
  authSalt: string;
  authVerifier: string;
  wrappedVaultKey: { version: 1; nonce: string; ciphertext: string };
  kdfParams: { authIterations: number; wrapIterations: number; wrapSalt: string };
  vaultKey: Uint8Array;
}> {
  const authSalt = crypto.getRandomValues(new Uint8Array(16));
  const wrapSalt = crypto.getRandomValues(new Uint8Array(16));
  const vaultKey = crypto.getRandomValues(new Uint8Array(32));
  const authKey = await derivePasswordKey(password, authSalt, DEFAULT_ITERATIONS);
  const wrapKey = await derivePasswordKey(password, wrapSalt, DEFAULT_ITERATIONS);
  const authVerifier = bytesToBase64Url(await digest(authKey));
  const wrapped = await aesEncrypt(wrapKey, vaultKey, text("cloudflare-private-notes:v1:vault-wrap"));
  return {
    authSalt: bytesToBase64Url(authSalt),
    authVerifier,
    wrappedVaultKey: {
      version: CRYPTO_VERSION,
      nonce: bytesToBase64Url(wrapped.nonce),
      ciphertext: bytesToBase64Url(wrapped.ciphertext)
    },
    kdfParams: {
      authIterations: DEFAULT_ITERATIONS,
      wrapIterations: DEFAULT_ITERATIONS,
      wrapSalt: bytesToBase64Url(wrapSalt)
    },
    vaultKey
  };
}

export async function unwrapVaultKey(password: string, user: PublicUser): Promise<Uint8Array> {
  const wrapSalt = base64UrlToBytes(user.kdfParams.wrapSalt);
  const wrapKey = await derivePasswordKey(password, wrapSalt, user.kdfParams.wrapIterations);
  return aesDecrypt(
    wrapKey,
    base64UrlToBytes(user.wrappedVaultKey.nonce),
    base64UrlToBytes(user.wrappedVaultKey.ciphertext),
    text("cloudflare-private-notes:v1:vault-wrap")
  );
}

export async function authVerifierForLogin(password: string, user: PublicUser): Promise<string> {
  const authKey = await derivePasswordKey(password, base64UrlToBytes(user.authSalt), user.kdfParams.authIterations);
  return bytesToBase64Url(await digest(authKey));
}

function noteAad(userId: string, noteId: string): Uint8Array {
  return text(`cloudflare-private-notes:v${CRYPTO_VERSION}:${userId}:${noteId}`);
}

export async function encryptNote(userId: string, note: Note, vaultKey: Uint8Array): Promise<EncryptedEnvelope> {
  const payload = JSON.stringify({
    version: CRYPTO_VERSION,
    id: note.id,
    title: note.title,
    body: note.body,
    category: note.category,
    tags: note.tags,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  });
  const aad = noteAad(userId, note.id);
  const encrypted = await aesEncrypt(vaultKey, text(payload), aad);
  return {
    nonce: bytesToBase64Url(encrypted.nonce),
    ciphertext: bytesToBase64Url(encrypted.ciphertext),
    aad: decoder.decode(aad),
    byteSize: encrypted.ciphertext.byteLength
  };
}

export async function decryptNote(userId: string, noteId: string, envelope: EncryptedEnvelope, vaultKey: Uint8Array): Promise<Note> {
  const expectedAad = decoder.decode(noteAad(userId, noteId));
  if (envelope.aad !== expectedAad) throw new Error("密文绑定信息不匹配");
  const plaintext = await aesDecrypt(
    vaultKey,
    base64UrlToBytes(envelope.nonce),
    base64UrlToBytes(envelope.ciphertext),
    text(expectedAad)
  );
  const parsed: unknown = JSON.parse(decoder.decode(plaintext));
  if (!parsed || typeof parsed !== "object") throw new Error("笔记内容无效");
  const value = parsed as Record<string, unknown>;
  if (
    value.version !== CRYPTO_VERSION ||
    value.id !== noteId ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    typeof value.category !== "string" ||
    !Array.isArray(value.tags) ||
    !value.tags.every((tag) => typeof tag === "string") ||
    !Number.isFinite(value.createdAt) ||
    !Number.isFinite(value.updatedAt)
  ) throw new Error("笔记内容校验失败");
  return {
    id: noteId,
    title: value.title,
    body: value.body,
    category: value.category,
    tags: value.tags as string[],
    createdAt: Number(value.createdAt),
    updatedAt: Number(value.updatedAt)
  };
}

export function wipeKey(key: Uint8Array): void {
  key.fill(0);
}

export function generateId(): string {
  return crypto.randomUUID();
}
