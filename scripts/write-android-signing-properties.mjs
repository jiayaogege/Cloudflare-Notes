import { writeFileSync } from "node:fs";

function escapeProperty(value) {
  if (/[\r\n]/.test(value)) throw new Error("Android signing properties cannot contain newlines.");
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(" ", "\\ ")
    .replaceAll(":", "\\:")
    .replaceAll("=", "\\=")
    .replaceAll("#", "\\#")
    .replaceAll("!", "\\!");
}

const properties = {
  keyAlias: process.env.SIGNING_KEY_ALIAS,
  password: process.env.SIGNING_KEY_PASSWORD,
  storeFile: process.env.SIGNING_KEYSTORE_PATH
};
for (const [name, value] of Object.entries(properties)) {
  if (!value) throw new Error(`Missing Android signing property: ${name}`);
}

writeFileSync(
  "src-tauri/gen/android/keystore.properties",
  Object.entries(properties).map(([name, value]) => `${name}=${escapeProperty(value)}\n`).join("")
);
