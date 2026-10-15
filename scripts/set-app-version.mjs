import { readFileSync, writeFileSync } from "node:fs";

const rawVersion = process.argv[2] ?? process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME ?? "";
const version = rawVersion.replace(/^app-v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Expected a semantic version from an app-v* release tag, got: ${version}`);
}

const packagePath = "package.json";
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
packageJson.version = version;
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const configPath = "src-tauri/tauri.conf.json";
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.version = version;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const cargoPath = "src-tauri/Cargo.toml";
const cargo = readFileSync(cargoPath, "utf8");
const cargoVersionPattern = /^version = "[^"]+"$/m;
if (!cargoVersionPattern.test(cargo)) {
  throw new Error(`Could not update the package version in ${cargoPath}`);
}
const updatedCargo = cargo.replace(cargoVersionPattern, `version = "${version}"`);
writeFileSync(cargoPath, updatedCargo);
