import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const help = `Usage: node scripts/native-doctor.mjs [--platform ios|android|all] [--json]

Checks the local Capacitor 8 build prerequisites. Defaults to both platforms.
Does not build, install tools, accept licences, sign in, or enumerate devices.
Exit codes: 0 prerequisites detected, 1 missing prerequisites, 2 invalid arguments.
`;

/** @param {string} value */
export function parseVersion(value) {
  const match = /^(?:v)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value.trim());
  return match ? match.slice(1).map((part) => Number(part ?? 0)) : null;
}

/** @param {number[] | null} actual @param {number[]} minimum */
export function atLeast(actual, minimum) {
  if (!actual) return false;
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== (minimum[index] ?? 0))
      return actual[index] > (minimum[index] ?? 0);
  }
  return true;
}

/** @param {string[]} args */
export function parseArguments(args) {
  let platform = "all";
  let json = false;
  let showHelp = false;
  let selected = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") showHelp = true;
    else if (arg === "--platform" || arg.startsWith("--platform=")) {
      if (selected) throw new Error("Choose --platform only once.");
      selected = true;
      platform = arg === "--platform" ? args[++index] : arg.slice(11);
      if (!["ios", "android", "all"].includes(platform))
        throw new Error("Choose --platform ios, android, or all.");
    } else
      throw new Error("Unknown argument. Use --help for supported options.");
  }
  return { platform, json, showHelp };
}

function pathIs(path, kind) {
  try {
    const stat = statSync(path);
    return kind === "file" ? stat.isFile() : stat.isDirectory();
  } catch {
    return false;
  }
}

/** Version probes only; never return or print a child's untrusted diagnostics. */
export function probe(command, args) {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 65536,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      ok: result.status === 0 && !result.error && !result.signal,
      text: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    };
  } catch {
    return { ok: false, text: "" };
  }
}

/** @param {string} text */
export function sdkDirectoryProperty(text) {
  const value = /^\s*sdk\.dir\s*[=:]\s*(.+?)\s*$/m.exec(text)?.[1];
  return value?.replace(/\\([\\:= ])/g, "$1") ?? null;
}

/**
 * All filesystem/subprocess inputs can be replaced for deterministic tests.
 * Reports intentionally contain no environment values, filesystem paths, raw
 * command output, signing identities, account names, or device identifiers.
 */
export function inspectNative(options = {}, overrides = {}) {
  const runtime = {
    root: projectRoot,
    host: process.platform,
    nodeVersion: process.versions.node,
    home: homedir(),
    env: process.env,
    file: (path) => pathIs(path, "file"),
    directory: (path) => pathIs(path, "directory"),
    read: (path) => readFileSync(path, "utf8"),
    run: probe,
    ...overrides,
  };
  const target = options.platform ?? "all";
  if (!["ios", "android", "all"].includes(target))
    throw new Error("Choose --platform ios, android, or all.");
  const checks = [];
  const add = (id, platform, passed, summary, action) => {
    checks.push({
      id,
      platform,
      status: passed ? "pass" : "fail",
      summary,
      ...(!passed ? { action } : {}),
    });
  };
  const read = (path) => {
    try {
      return runtime.read(path);
    } catch {
      return "";
    }
  };
  const installed = (name) => {
    try {
      const value = JSON.parse(
        read(
          join(
            runtime.root,
            "node_modules",
            "@capacitor",
            name,
            "package.json",
          ),
        ),
      );
      return typeof value.version === "string"
        ? parseVersion(value.version)
        : null;
    } catch {
      return null;
    }
  };
  const run = (command, args) => {
    try {
      return runtime.run(command, args);
    } catch {
      return { ok: false, text: "" };
    }
  };
  const node = parseVersion(runtime.nodeVersion);
  add(
    "node",
    "common",
    node?.[0] === 24 && atLeast(node, [24, 15, 0]),
    node
      ? `Node ${node.join(".")}; this repository requires Node 24.15+ in the 24.x series.`
      : "Node version could not be identified.",
    "Select the project's Node 24 runtime, then rerun this command with that Node executable.",
  );
  const core = installed("core");
  const cli = installed("cli");
  const sameVersion = (version) =>
    core?.[0] === 8 && version?.join(".") === core.join(".");
  add(
    "capacitor",
    "common",
    sameVersion(cli),
    "Capacitor core and CLI must be installed at the same 8.x version.",
    "Run npm ci with Node 24 from the repository root; do not upgrade the pinned Capacitor major version.",
  );

  if (target === "ios" || target === "all") {
    add(
      "ios.host",
      "ios",
      runtime.host === "darwin",
      "Local iOS builds require macOS.",
      "Use a Mac with Xcode 26 or newer for iOS builds.",
    );
    add(
      "ios.package",
      "ios",
      sameVersion(installed("ios")),
      "The iOS runtime must match the installed Capacitor core.",
      "Restore the pinned iOS dependency with npm ci using Node 24.",
    );
    add(
      "ios.project",
      "ios",
      runtime.file(
        join(runtime.root, "apps/mobile/ios/App/App.xcodeproj/project.pbxproj"),
      ),
      "The native iOS Xcode project must exist.",
      "Restore the tracked iOS project before syncing; do not overwrite its custom audio bridge.",
    );
    if (runtime.host === "darwin") {
      const selection = run("xcode-select", ["-p"]);
      const fullXcode =
        selection.ok &&
        /\.app\/Contents\/Developer\s*$/.test(selection.text.trim());
      add(
        "ios.selection",
        "ios",
        fullXcode,
        "The selected developer directory must belong to full Xcode, rather than Command Line Tools.",
        "Install/open Xcode 26+, finish its initial setup, then choose it in Xcode Settings > Locations > Command Line Tools.",
      );
      const xcode = run("xcodebuild", ["-version"]);
      const version = xcode.ok
        ? parseVersion(
            /^Xcode (\d+(?:\.\d+){0,2})\s*$/m.exec(xcode.text)?.[1] ?? "",
          )
        : null;
      add(
        "ios.xcode",
        "ios",
        fullXcode && atLeast(version, [26, 0, 0]),
        version
          ? `Xcode ${version.join(".")} detected; Xcode 26+ is required.`
          : "Xcode 26+ could not be verified.",
        "Open full Xcode 26+, complete its components/licence setup, and select its Command Line Tools.",
      );
      const sdk =
        fullXcode && atLeast(version, [26, 0, 0])
          ? run("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-version"])
          : { ok: false, text: "" };
      const sdkVersion = sdk.ok ? parseVersion(sdk.text.trim()) : null;
      add(
        "ios.sdk",
        "ios",
        atLeast(sdkVersion, [26, 0, 0]),
        "An iOS Simulator SDK from Xcode 26+ must be available.",
        "Install iOS platform support in Xcode Settings > Components, then rerun the preflight.",
      );
    }
  }

  if (target === "android" || target === "all") {
    const android = join(runtime.root, "apps/mobile/android");
    const windows = runtime.host === "win32";
    add(
      "android.package",
      "android",
      sameVersion(installed("android")),
      "The Android runtime must match the installed Capacitor core.",
      "Install the project's pinned @capacitor/android version and sync the Android project using Node 24.",
    );
    add(
      "android.project",
      "android",
      runtime.file(join(android, "app/build.gradle")),
      "The native Android Gradle project must exist.",
      "Create the Android platform with the pinned Capacitor CLI, then sync its bundled assets and native dependencies.",
    );
    const wrapper =
      runtime.file(join(android, windows ? "gradlew.bat" : "gradlew")) &&
      runtime.file(join(android, "gradle/wrapper/gradle-wrapper.jar")) &&
      runtime.file(join(android, "gradle/wrapper/gradle-wrapper.properties"));
    add(
      "android.wrapper",
      "android",
      wrapper,
      "The project Gradle wrapper, JAR and properties must exist.",
      "Restore the tracked Gradle wrapper; a global Gradle installation is not required. The build may download its pinned Gradle distribution.",
    );
    const javaHome = runtime.env.JAVA_HOME;
    const javaCommand = (name) =>
      javaHome
        ? join(javaHome, "bin", `${name}${windows ? ".exe" : ""}`)
        : name;
    const java = run(javaCommand("java"), ["-version"]);
    const javac = run(javaCommand("javac"), ["-version"]);
    const javaVersion = java.ok
      ? parseVersion(
          /(?:openjdk|java)\s+(?:version\s+)?"?(\d+(?:\.\d+){0,2})/i.exec(
            java.text,
          )?.[1] ?? "",
        )
      : null;
    const compilerVersion = javac.ok
      ? parseVersion(
          /\bjavac\s+(\d+(?:\.\d+){0,2})/.exec(javac.text)?.[1] ?? "",
        )
      : null;
    add(
      "android.java",
      "android",
      atLeast(javaVersion, [21, 0, 0]) &&
        javaVersion[0] <= 24 &&
        atLeast(compilerVersion, [21, 0, 0]) &&
        javaVersion[0] === compilerVersion[0],
      "Java and javac must both be available from a matching JDK 21–24 for the pinned Gradle 8.14 wrapper.",
      "Install Android Studio 2025.2.1+ and configure JAVA_HOME/PATH to its bundled JDK (JDK 21 is recommended), then reopen the terminal.",
    );
    const localSdk = sdkDirectoryProperty(
      read(join(android, "local.properties")),
    );
    const configuredSdk =
      localSdk || runtime.env.ANDROID_HOME || runtime.env.ANDROID_SDK_ROOT;
    const defaults = windows
      ? [
          runtime.env.LOCALAPPDATA &&
            join(runtime.env.LOCALAPPDATA, "Android/Sdk"),
        ].filter(Boolean)
      : [
          join(
            runtime.home,
            runtime.host === "darwin" ? "Library/Android/sdk" : "Android/Sdk",
          ),
        ];
    const sdk = configuredSdk
      ? resolve(android, configuredSdk)
      : defaults.find((path) => runtime.directory(path));
    const conflicting =
      !localSdk &&
      runtime.env.ANDROID_HOME &&
      runtime.env.ANDROID_SDK_ROOT &&
      resolve(runtime.env.ANDROID_HOME) !==
        resolve(runtime.env.ANDROID_SDK_ROOT);
    add(
      "android.sdk",
      "android",
      !conflicting && Boolean(sdk && runtime.directory(sdk)),
      "A consistent Android SDK location must be configured or installed at the standard location.",
      "Install the SDK through Android Studio SDK Manager; set ANDROID_HOME to that SDK and remove conflicting ANDROID_SDK_ROOT settings. A project local.properties sdk.dir also works.",
    );
    add(
      "android.platform",
      "android",
      Boolean(
        sdk && runtime.file(join(sdk, "platforms/android-36/android.jar")),
      ),
      "Android SDK Platform 36 must be installed.",
      "In Android Studio SDK Manager, install Android 16 / API 36.",
    );
    // The project does not override AGP 8.13's Build Tools 35.0.0 default.
    // Installing 36 alone does not satisfy that selected version.
    const buildTools =
      sdk &&
      [
        windows ? "aapt2.exe" : "aapt2",
        windows ? "zipalign.exe" : "zipalign",
      ].every((tool) => runtime.file(join(sdk, "build-tools", "35.0.0", tool)));
    add(
      "android.tools",
      "android",
      Boolean(buildTools),
      "Android SDK Build Tools 35.0.0 must be installed for this project's AGP default.",
      "In SDK Manager > SDK Tools > Show Package Details, install Build Tools 35.0.0 (AGP 8.13 default). Review and accept the required licences yourself.",
    );
  }
  return {
    schemaVersion: 1,
    platform: target,
    ready: checks.every((check) => check.status === "pass"),
    buildPerformed: false,
    checks,
  };
}

export function formatReport(report, json = false) {
  if (json) return JSON.stringify(report, null, 2);
  const lines = [
    "Aurelia native build preflight (no native build is performed)",
    "",
  ];
  for (const check of report.checks) {
    lines.push(
      `${check.status === "pass" ? "PASS" : "FAIL"} ${check.id}: ${check.summary}`,
    );
    if (check.action) lines.push(`  Next: ${check.action}`);
  }
  lines.push(
    "",
    report.ready
      ? "Prerequisites detected. Run the platform build to verify compilation; signing and physical-device playback still need separate validation."
      : "Native build prerequisites are incomplete. No native binary was built.",
  );
  return lines.join("\n");
}

export function runDoctor(args, overrides = {}) {
  let options;
  try {
    options = parseArguments(args);
  } catch (error) {
    const message = error.message;
    return {
      exitCode: 2,
      output: args.includes("--json")
        ? JSON.stringify({
            schemaVersion: 1,
            buildPerformed: false,
            error: message,
          })
        : message,
    };
  }
  if (options.showHelp) return { exitCode: 0, output: help };
  try {
    const report = inspectNative(options, overrides);
    return {
      exitCode: report.ready ? 0 : 1,
      output: formatReport(report, options.json),
    };
  } catch {
    const message =
      "Preflight could not complete. Check filesystem access and rerun; no build was performed.";
    return {
      exitCode: 2,
      output: args.includes("--json")
        ? JSON.stringify({
            schemaVersion: 1,
            buildPerformed: false,
            error: message,
          })
        : message,
    };
  }
}

export function runNativeDoctor(options = {}, overrides = {}) {
  const report = inspectNative(options, overrides);
  return { ...report, ok: report.ready };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = runDoctor(process.argv.slice(2));
  process.stdout.write(`${result.output}\n`);
  process.exitCode = result.exitCode;
}
