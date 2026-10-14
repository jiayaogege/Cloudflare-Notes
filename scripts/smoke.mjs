const base = process.env.BASE_URL || "http://127.0.0.1:8787";
const uuid = () => crypto.randomUUID();
const base64 = "YWJj";
const email = `smoke-${Date.now()}@example.com`;

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const body = await response.json().catch(() => null);
  return { response, body };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const registration = await request("/api/auth/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email,
    authSalt: base64,
    authVerifier: base64,
    wrappedVaultKey: { version: 1, nonce: base64, ciphertext: base64 },
    kdfParams: { authIterations: 310000, wrapIterations: 310000, wrapSalt: base64 }
  })
});
assert(registration.response.status === 201, `register failed: ${registration.response.status}`);
const cookie = registration.response.headers.get("set-cookie")?.split(";")[0];
let csrf = registration.body.csrfToken;
assert(cookie && csrf, "session response missing cookie or CSRF token");

const session = await request("/api/auth/me", { headers: { cookie } });
assert(session.response.status === 200, `session failed: ${session.response.status}`);
csrf = session.body.csrfToken;

const noteId = uuid();
const note = {
  mutationId: uuid(),
  baseRev: 0,
  nonce: base64,
  ciphertext: base64,
  aad: `cloudflare-private-notes:v1:${session.body.user.userId}:${noteId}`,
  deleted: false,
  byteSize: 3
};
const write = await request(`/api/notes/${noteId}`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
  body: JSON.stringify(note)
});
assert(write.response.status === 200, `write failed: ${write.response.status}`);

const sync = await request("/api/sync?cursor=0", { headers: { cookie } });
assert(sync.response.status === 200 && sync.body.notes.length === 1, "sync did not return the note");

const conflict = await request(`/api/notes/${noteId}`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
  body: JSON.stringify({ ...note, mutationId: uuid() })
});
assert(conflict.response.status === 409, `CAS conflict failed: ${conflict.response.status}`);

const exported = await request("/api/export", { headers: { cookie } });
assert(exported.response.status === 200 && exported.body.notes?.length === 1, "export failed");

const logout = await request("/api/auth/logout", {
  method: "POST",
  headers: { cookie, "x-csrf-token": csrf }
});
assert(logout.response.status === 200, `logout failed: ${logout.response.status}`);

const afterLogout = await request("/api/auth/me", { headers: { cookie } });
assert(afterLogout.response.status === 401, "session remained valid after logout");

console.log(JSON.stringify({ ok: true, base, noteId }));
