import type { Note, OutboxItem, StoredNote } from "./types";

const DB_NAME = "cloudflare-private-notes";
const DB_VERSION = 1;
const NOTES = "notes";
const OUTBOX = "outbox";
const META = "meta";
const CONFLICTS = "conflicts";

let dbPromise: Promise<IDBDatabase> | null = null;

export function noteKey(userId: string, noteId: string): string {
  return `${userId}:${noteId}`;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(NOTES)) db.createObjectStore(NOTES, { keyPath: "key" });
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: "key" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
      if (!db.objectStoreNames.contains(CONFLICTS)) db.createObjectStore(CONFLICTS, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB 打开失败"));
  });
  return dbPromise;
}

async function request<T>(storeName: string, mode: IDBTransactionMode, callback: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const result = callback(transaction.objectStore(storeName));
    result.onsuccess = () => resolve(result.result);
    result.onerror = () => reject(result.error || new Error("IndexedDB 操作失败"));
  });
}

export async function putStoredNote(note: StoredNote): Promise<void> {
  await request(NOTES, "readwrite", (store) => store.put(note));
}

export async function getStoredNote(userId: string, noteId: string): Promise<StoredNote | undefined> {
  return request(NOTES, "readonly", (store) => store.get(noteKey(userId, noteId)));
}

export async function listStoredNotes(userId: string): Promise<StoredNote[]> {
  const all = await request<StoredNote[]>(NOTES, "readonly", (store) => store.getAll());
  return all.filter((note) => note.userId === userId);
}

export async function putOutbox(item: OutboxItem): Promise<void> {
  await request(OUTBOX, "readwrite", (store) => store.put(item));
}

export async function getOutbox(userId: string): Promise<OutboxItem[]> {
  const all = await request<OutboxItem[]>(OUTBOX, "readonly", (store) => store.getAll());
  return all.filter((item) => item.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getOutboxForNote(userId: string, noteId: string): Promise<OutboxItem | undefined> {
  return request(OUTBOX, "readonly", (store) => store.get(noteKey(userId, noteId)));
}

export async function deleteOutbox(userId: string, noteId: string): Promise<void> {
  await request(OUTBOX, "readwrite", (store) => store.delete(noteKey(userId, noteId)));
}

export async function deleteOutboxIfMutation(userId: string, noteId: string, mutationId: string): Promise<boolean> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(OUTBOX, "readwrite");
    const store = transaction.objectStore(OUTBOX);
    const read = store.get(noteKey(userId, noteId));
    let deleted = false;
    read.onsuccess = () => {
      const current = read.result as OutboxItem | undefined;
      if (current?.mutationId === mutationId) {
        store.delete(noteKey(userId, noteId));
        deleted = true;
      }
    };
    transaction.oncomplete = () => resolve(deleted);
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB 操作失败"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB 操作被取消"));
  });
}

export async function rebaseOutboxIfMutation(
  userId: string,
  noteId: string,
  mutationId: string,
  baseRev: number
): Promise<OutboxItem | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(OUTBOX, "readwrite");
    const store = transaction.objectStore(OUTBOX);
    const read = store.get(noteKey(userId, noteId));
    let updated: OutboxItem | undefined;
    read.onsuccess = () => {
      const current = read.result as OutboxItem | undefined;
      if (current?.mutationId === mutationId) {
        updated = { ...current, baseRev };
        store.put(updated);
      }
    };
    transaction.oncomplete = () => resolve(updated);
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB 操作失败"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB 操作被取消"));
  });
}

export async function putMeta<T>(key: string, value: T): Promise<void> {
  await request(META, "readwrite", (store) => store.put({ key, value }));
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const record = await request<{ key: string; value: T } | undefined>(META, "readonly", (store) => store.get(key));
  return record?.value;
}

export async function putConflict(note: StoredNote): Promise<void> {
  await request(CONFLICTS, "readwrite", (store) => store.put(note));
}

export async function removeLocalNote(userId: string, noteId: string): Promise<void> {
  await request(NOTES, "readwrite", (store) => store.delete(noteKey(userId, noteId)));
}

export async function countPending(userId: string): Promise<number> {
  return (await getOutbox(userId)).length;
}

export type PlainNoteCache = Map<string, Note>;
