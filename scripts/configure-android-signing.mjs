import { readFileSync, writeFileSync } from "node:fs";

const gradlePath = "src-tauri/gen/android/app/build.gradle.kts";
let gradle = readFileSync(gradlePath, "utf8");

if (!gradle.includes("import java.util.Properties")) {
  gradle = `import java.util.Properties\n${gradle}`;
}

const signingConfig = `
        signingConfigs {
            create("release") {
                val keystoreProperties = Properties().apply {
                    rootProject.file("keystore.properties").inputStream().use { load(it) }
                }
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("password")
                storePassword = keystoreProperties.getProperty("password")
                storeFile = file(keystoreProperties.getProperty("storeFile"))
            }
        }
`;

if (!gradle.includes('create("release")')) {
  const androidBlock = /(android\s*\{[\s\S]*?)(\n\s*buildTypes\s*\{)/;
  if (!androidBlock.test(gradle)) {
    throw new Error(`Could not locate the Android buildTypes block in ${gradlePath}`);
  }
  gradle = gradle.replace(androidBlock, `$1${signingConfig}$2`);
}

const releaseBuildType = /getByName\("release"\)\s*\{/;
if (!releaseBuildType.test(gradle)) {
  throw new Error(`Could not locate the Android release build type in ${gradlePath}`);
}
if (!/getByName\("release"\)\s*\{\s*signingConfig\s*=/.test(gradle)) {
  gradle = gradle.replace(
    releaseBuildType,
    'getByName("release") {\n            signingConfig = signingConfigs.getByName("release")'
  );
}

writeFileSync(gradlePath, gradle);
