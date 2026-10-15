import { readFileSync, writeFileSync } from "node:fs";

const gradlePath = "src-tauri/gen/android/app/build.gradle.kts";
const apiLevel = 36;
let gradle = readFileSync(gradlePath, "utf8");

for (const setting of ["compileSdk", "targetSdk"]) {
  const pattern = new RegExp(`^([\\t ]*${setting}[\\t ]*=[\\t ]*)\\d+`, "m");
  if (!pattern.test(gradle)) {
    throw new Error(`Could not find ${setting} in ${gradlePath}`);
  }
  gradle = gradle.replace(pattern, `$1${apiLevel}`);
}

writeFileSync(gradlePath, gradle);
