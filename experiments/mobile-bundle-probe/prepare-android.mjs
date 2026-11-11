import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { androidPreviewMode } from "./src/android-preview-mode.ts";

const experiment = dirname(fileURLToPath(import.meta.url));
const root = resolve(experiment, "../..");
const sourceAndroid = join(root, "apps/mobile/android");
const runtime = join(root, ".runtime");
const www = join(experiment, "www");
const args = process.argv.slice(2);
let sdkInput = process.env.ANDROID_SDK_ROOT;
let outputName = "bundled-probe-android";
let nightQa = false;
let profilePreview = false;
const seen = new Set();
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  assert(!seen.has(arg), "Duplicate scaffold option.");
  seen.add(arg);
  if (arg === "--night-qa") nightQa = true;
  else if (arg === "--profile-preview") profilePreview = true;
  else if (arg === "--sdk" || arg === "--output") {
    const value = args[++index];
    assert(value && !value.startsWith("--"), "Missing scaffold option value.");
    if (arg === "--sdk") sdkInput = value;
    else outputName = value;
  } else
    throw new Error(
      "Usage: prepare-android.mjs --sdk <directory> [--output <runtime-child-name>] [--night-qa | --profile-preview]",
    );
}
assert(
  /^[a-z0-9][a-z0-9-]{0,79}$/.test(outputName),
  "Output must be a direct named child of .runtime.",
);
const output = join(runtime, outputName);
const mode = androidPreviewMode({ nightQa, profilePreview });
const { appId, appName } = mode;
assert(
  sdkInput,
  "An explicit SDK directory is required. This script never discovers or installs SDKs.",
);
const sdk = resolve(sdkInput);
assert(
  (await lstat(sdk)).isDirectory(),
  "SDK input must be an existing directory (not a symlink).",
);
try {
  assert(
    !(await lstat(runtime)).isSymbolicLink(),
    "Refusing a symlinked .runtime directory.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
try {
  await lstat(output);
  throw new Error(
    "The generated scaffold already exists. Review/archive/remove that exact generated directory before preparing another copy.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(
      !entry.isSymbolicLink(),
      `Unexpected symlink: ${join(directory, entry.name)}`,
    );
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else {
      assert(entry.isFile(), `Expected a regular file: ${path}`);
      found.push(path);
    }
  }
  return found.sort();
}
const evidence = JSON.parse(
  await readFile(join(experiment, "build-evidence.json"), "utf8"),
);
assert.equal(evidence.esbuildVersion, "0.28.2");
if (mode.mainApplication) {
  const properties = await readFile(join(sourceAndroid, "gradle.properties"), "utf8");
  assert(
    !/^\s*aurelia(?:YoutubeSource|SilentQa)\s*=\s*true\s*$/m.test(properties),
    "A main profile scaffold must not inherit enabled source/silent Gradle properties.",
  );
  const appBuild = await readFile(join(sourceAndroid, "app/build.gradle"), "utf8");
  for (const flag of ["aureliaYoutubeSource", "aureliaSilentQa"])
    assert(appBuild.includes(`project.findProperty('${flag}') ?: 'false'`),
      "Review native flag defaults before generating a main profile scaffold.");
}
assert.equal(
  evidence.mode,
  mode.requiredUiMode,
);
assert.deepEqual(evidence.disallowedInputMatches, []);
assert.deepEqual(evidence.externalOutputImports, []);
const uiFiles = await files(www);
const expected = new Map(
  evidence.files.map((entry) => [entry.path, entry.sha256]),
);
assert.equal(
  uiFiles.length,
  expected.size,
  "UI file list differs from build evidence; rebuild it explicitly.",
);
for (const file of uiFiles) {
  const name = relative(www, file);
  assert(
    !/(?:^audio[\\/]|\.mp3$|^sw\.js$)/.test(name),
    "Audio/service worker must not be duplicated in the UI.",
  );
  assert.equal(
    sha(await readFile(file)),
    expected.get(name),
    `UI hash mismatch: ${name}`,
  );
}
const html = await readFile(join(www, "index.html"), "utf8");
assert(
  !/<script[^>]+src\s*=\s*["'](?:https?:)?\/\//i.test(html),
  "Remote UI script detected.",
);
const variables = await readFile(
  join(sourceAndroid, "variables.gradle"),
  "utf8",
);
assert(
  /compileSdkVersion\s*=\s*37/.test(variables),
  "Review the SDK37 baseline before another migration.",
);
assert(
  (
    await readFile(
      join(sourceAndroid, "gradle/wrapper/gradle-wrapper.properties"),
      "utf8",
    )
  ).includes("gradle-9.4.1-bin.zip"),
);
assert(
  (await readFile(join(sourceAndroid, "build.gradle"), "utf8")).includes(
    "gradle:9.2.1",
  ),
);

await mkdir(runtime, { recursive: true });
await mkdir(output);
const copied = [];
async function copy(source, destination) {
  const info = await lstat(source);
  assert(
    info.isFile() && !info.isSymbolicLink(),
    `Not a regular source file: ${source}`,
  );
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, info.mode & 0o777);
  copied.push({
    source: relative(root, source),
    destination: relative(output, destination),
    sha256: sha(await readFile(destination)),
  });
}
const whitelist = [
  "build.gradle",
  "settings.gradle",
  "capacitor.settings.gradle",
  "variables.gradle",
  "gradle.properties",
  "gradlew",
  "gradlew.bat",
  "gradle/wrapper/gradle-wrapper.jar",
  "gradle/wrapper/gradle-wrapper.properties",
  "app/build.gradle",
  "app/capacitor.build.gradle",
  "app/proguard-rules.pro",
  "app/src/main/AndroidManifest.xml",
  "capacitor-cordova-android-plugins/build.gradle",
  "capacitor-cordova-android-plugins/cordova.variables.gradle",
  "capacitor-cordova-android-plugins/src/main/AndroidManifest.xml",
  "youtube-source/build.gradle.kts",
  "youtube-source/src/main/AndroidManifest.xml",
];
for (const name of whitelist)
  await copy(join(sourceAndroid, name), join(output, name));
for (const [directory, extensions] of [
  ["app/src/main/java", [".java"]],
  ["app/src/main/res", [".xml", ".png"]],
  ["app/src/test/java", [".java"]],
  ["youtube-source/src/main/kotlin", [".kt"]],
  ["youtube-source/src/test/kotlin", [".kt"]],
]) {
  for (const source of await files(join(sourceAndroid, directory))) {
    assert(
      extensions.some((extension) => source.endsWith(extension)),
      `Unexpected Android source/resource: ${source}`,
    );
    await copy(source, join(output, relative(sourceAndroid, source)));
  }
}
async function replace(file, before, after) {
  const text = await readFile(file, "utf8");
  assert.equal(
    text.split(before).length - 1,
    1,
    `Expected one reviewed substitution in ${file}`,
  );
  await writeFile(file, text.replace(before, after));
}
await replace(
  join(output, "app/build.gradle"),
  'applicationId "com.lattelix.aurelia"',
  `applicationId "${appId}"`,
);
await replace(
  join(output, "app/build.gradle"),
  "assets.srcDir rootProject.file('../../web/public/audio')",
  "// Isolated probe: original Studio files are copied into the default assets directory.",
);
const capacitorModule = join(root, "node_modules/@capacitor/android/capacitor");
await replace(
  join(output, "capacitor.settings.gradle"),
  "new File('../../../node_modules/@capacitor/android/capacitor')",
  `new File(${JSON.stringify(capacitorModule)})`,
);
const stringsFile = join(output, "app/src/main/res/values/strings.xml");
await writeFile(
  stringsFile,
  (await readFile(stringsFile, "utf8"))
    .replaceAll(">Aurelia<", `>${appName}<`)
    .replaceAll(">com.lattelix.aurelia<", `>${appId}<`),
);
if (mode.forceSilent && mode.forceYoutubeSource)
  await writeFile(
    join(output, "gradle.properties"),
    (await readFile(join(output, "gradle.properties"), "utf8")) +
      "\n# This separate QA package must never emit audio.\naureliaYoutubeSource=true\naureliaSilentQa=true\n",
  );
if (nightQa) {
  const qaSource = "src/main/java/com/lattelix/aurelia/qa/AureliaNightQaInstrumentation.java";
  await copy(join(experiment, "qa", qaSource), join(output, "app", qaSource));
  await replace(join(output, "app/src/main/AndroidManifest.xml"), "</manifest>",
    '<instrumentation android:name="com.lattelix.aurelia.qa.AureliaNightQaInstrumentation" ' +
    'android:targetPackage="com.lattelix.aurelia.nightqa" android:functionalTest="true" ' +
    'android:handleProfiling="false" />\n</manifest>');
}

const assets = join(output, "app/src/main/assets");
for (let index = 1; index <= 12; index++)
  await copy(
    join(root, "apps/web/public/audio", `${index}.mp3`),
    join(assets, `${index}.mp3`),
  );
for (const file of uiFiles)
  await copy(file, join(assets, "public", relative(www, file)));
for (const name of ["cordova.js", "cordova_plugins.js"])
  await writeFile(join(assets, "public", name), "");
const config = {
  appId,
  appName,
  webDir: "public",
  backgroundColor: "#171918",
  loggingBehavior: "none",
};
assert(!("server" in config));
await writeFile(
  join(assets, "capacitor.config.json"),
  JSON.stringify(config, null, 2) + "\n",
);
await writeFile(join(assets, "capacitor.plugins.json"), "[]\n");
// Never read or copy a local.properties file or any signing configuration.
const sdkProperty = sdk.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
await writeFile(join(output, "local.properties"), `sdk.dir=${sdkProperty}\n`);
assert(
  (await readFile(join(output, "app/build.gradle"), "utf8")).includes(
    'namespace = "com.lattelix.aurelia"',
  ),
);
assert(
  (
    await readFile(
      join(output, "app/src/main/java/com/lattelix/aurelia/MainActivity.java"),
      "utf8",
    )
  ).includes("registerPlugin(AureliaDeviceAudioPlugin.class)"),
);
const finalFiles = [];
for (const file of await files(output)) {
  const name = relative(output, file);
  assert(
    !name
      .split(/[\\/]/)
      .some(
        (part) =>
          [".gradle", "build", "auth.json", "google-services.json"].includes(
            part,
          ) ||
          part === ".env" ||
          part.startsWith(".env."),
      ),
  );
  assert(!/\.(?:jks|keystore|p12|p8)$/.test(name));
  finalFiles.push({
    path: name,
    bytes: (await lstat(file)).size,
    sha256: sha(await readFile(file)),
  });
}
assert.equal(
  finalFiles.filter((entry) =>
    /^app[\\/]src[\\/]main[\\/]assets[\\/]\d+\.mp3$/.test(entry.path),
  ).length,
  12,
);
for (const [name, hash] of expected)
  assert.equal(sha(await readFile(join(assets, "public", name))), hash);
await writeFile(
  join(output, "scaffold-evidence.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      appId,
      mainApplication: mode.mainApplication,
      namespace: "com.lattelix.aurelia",
      cloudApi: evidence.cloudApi,
      sourceCapability: nightQa
        ? "enabled only in private silent QA; device verification pending"
        : "disabled",
      silentQa: nightQa,
      nativeBuildRun: false,
      signingRun: false,
      deviceRun: false,
      networkRun: false,
      sdkDirectoryProvidedExplicitly: true,
      copiedFiles: copied,
      finalFiles,
      uiBundleSHA256: sha(await readFile(join(assets, "public/assets/app.js"))),
    },
    null,
    2,
  ) + "\n",
);
console.log(`Prepared ${mode.mainApplication ? "private main-application" : "separate-package"} Android source: ${output}`);
console.log(
  "No build, signing, installation, SDK/license operation or network request was performed.",
);
