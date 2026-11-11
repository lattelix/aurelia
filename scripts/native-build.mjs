import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mobile = join(root, "apps/mobile");
const [platform, ...options] = process.argv.slice(2);
if (platform === "--help" || options.includes("--help")) {
  console.log("Usage: node scripts/native-build.mjs ios|android");
  console.log(
    "iOS builds an unsigned simulator app. Android builds a debug APK.",
  );
  console.log(
    "Neither build establishes device-local YouTube or background playback.",
  );
  process.exit(0);
}
if (!["ios", "android"].includes(platform) || options.length) {
  console.error("Choose ios or android. See --help for build targets.");
  process.exit(2);
}

const env = {
  ...process.env,
  PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
};
function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
      shell: false,
    });
    const forward = (signal) => child.kill(signal);
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    const cleanup = () => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    };
    child.once("error", () => {
      cleanup();
      reject(new Error("Build command could not start."));
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code === 0) resolve();
      else
        reject(
          new Error(
            signal
              ? "Build interrupted."
              : `Build command failed (${code ?? "unknown"}).`,
          ),
        );
    });
  });
}

try {
  // A hosted preview must never silently turn into the local setup screen when
  // sync regenerates Capacitor config. Keep the origin explicit on every build.
  if (!env.CAPACITOR_SERVER_URL)
    throw new Error(
      "Set CAPACITOR_SERVER_URL to the trusted HTTPS Aurelia origin for this hosted preview build. See docs/native-installation.md.",
    );
  // Fail before sync/build when the required SDKs are absent. Never auto-install
  // tools, accept licences, select a signing team or publish an application.
  await run(process.execPath, [
    join(root, "scripts/native-doctor.mjs"),
    "--platform",
    platform,
  ]);
  await run(
    process.execPath,
    [join(root, "node_modules/@capacitor/cli/bin/capacitor"), "sync", platform],
    mobile,
  );
  if (platform === "android") {
    const directory = join(mobile, "android");
    await run(
      process.platform === "win32" ? "cmd.exe" : join(directory, "gradlew"),
      process.platform === "win32"
        ? ["/d", "/s", "/c", "gradlew.bat assembleDebug --console=plain"]
        : ["assembleDebug", "--console=plain"],
      directory,
    );
    const artifact = join(
      directory,
      "app/build/outputs/apk/debug/app-debug.apk",
    );
    const bytes = await readFile(artifact);
    if (!bytes.length)
      throw new Error("Gradle did not produce a nonempty debug APK.");
    console.log(`Debug APK: ${artifact}`);
    console.log(`SHA-256: ${createHash("sha256").update(bytes).digest("hex")}`);
    console.log(
      "Development signing only; physical-device playback is still a separate check.",
    );
  } else {
    const derivedData = join(root, ".runtime/native-build/ios");
    await mkdir(derivedData, { recursive: true });
    await run("xcodebuild", [
      "-project",
      join(mobile, "ios/App/App.xcodeproj"),
      "-scheme",
      "App",
      "-configuration",
      "Debug",
      "-destination",
      "generic/platform=iOS Simulator",
      "-derivedDataPath",
      derivedData,
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ]);
    const artifact = join(
      derivedData,
      "Build/Products/Debug-iphonesimulator/App.app",
    );
    await access(join(artifact, "Info.plist"));
    console.log(`Unsigned simulator application: ${artifact}`);
    console.log(
      "For an iPhone, open Xcode, select Personal Team and the physical device, then Run.",
    );
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Native build failed.",
  );
  process.exitCode = 1;
}
