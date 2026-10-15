import { readFileSync, writeFileSync } from "node:fs";

const configuredUrl = process.env.VITE_NATIVE_API_BASE_URL ?? process.argv[2] ?? "";
let url;
try {
  url = new URL(configuredUrl);
} catch {
  throw new Error(`Invalid VITE_NATIVE_API_BASE_URL: ${configuredUrl}`);
}

if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
  throw new Error("The native API base URL must be an HTTPS origin without credentials, path, query, or fragment.");
}

const origin = url.origin;
const capabilityPath = "src-tauri/capabilities/default.json";
const capability = JSON.parse(readFileSync(capabilityPath, "utf8"));
const httpPermission = capability.permissions.find(
  (permission) => typeof permission === "object" && permission.identifier === "http:default"
);
if (!httpPermission) throw new Error("Could not find the http:default capability.");
httpPermission.allow = [{ url: `${origin}/api/*` }];
writeFileSync(capabilityPath, `${JSON.stringify(capability, null, 2)}\n`);

const configPath = "src-tauri/tauri.conf.json";
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.app.security.csp["connect-src"] = `ipc: http://ipc.localhost ${origin}`;
config.plugins.http.scopeRedirects = true;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
