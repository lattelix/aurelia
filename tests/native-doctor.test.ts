import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

type Check = {
  id: string;
  platform: string;
  status: "pass" | "fail";
  summary: string;
  action?: string;
};
type Report = { ready: boolean; buildPerformed: false; checks: Check[] };
type Runtime = {
  root: string;
  host: NodeJS.Platform;
  nodeVersion: string;
  home: string;
  env: Record<string, string>;
  file: (path: string) => boolean;
  directory: (path: string) => boolean;
  read: (path: string) => string;
  run: (command: string, args: string[]) => { ok: boolean; text: string };
};
type Doctor = {
  inspectNative: (options: { platform?: string }, runtime: Runtime) => Report;
  runNativeDoctor: (
    options: { platform?: string },
    runtime: Runtime,
  ) => Report & { ok: boolean };
  runDoctor: (
    args: string[],
    runtime: Runtime,
  ) => { exitCode: number; output: string };
  sdkDirectoryProperty: (text: string) => string | null;
  parseVersion: (text: string) => number[] | null;
};
// Runtime import lets this plain Node script stay independent of TS build output.
const modulePath = new URL("../scripts/native-doctor.mjs", import.meta.url)
  .href;
const doctor: Doctor = await import(modulePath);

function fixture(host: NodeJS.Platform = "darwin") {
  const root = resolve("/fixture/aurelia");
  const home = resolve("/fixture/private-user");
  const android = join(root, "apps/mobile/android");
  const sdk = join(home, "Library/Android/sdk");
  const files = new Map<string, string>();
  const directories = new Set([sdk]);
  for (const name of ["core", "cli", "ios", "android"]) {
    files.set(
      join(root, "node_modules/@capacitor", name, "package.json"),
      JSON.stringify({ version: "8.5.2" }),
    );
  }
  files.set(
    join(root, "apps/mobile/ios/App/App.xcodeproj/project.pbxproj"),
    "project",
  );
  for (const path of [
    "app/build.gradle",
    "gradlew",
    "gradle/wrapper/gradle-wrapper.jar",
    "gradle/wrapper/gradle-wrapper.properties",
  ])
    files.set(join(android, path), "");
  for (const path of [
    "platforms/android-36/android.jar",
    "build-tools/35.0.0/aapt2",
    "build-tools/35.0.0/zipalign",
  ])
    files.set(join(sdk, path), "");
  const results = new Map([
    [
      "xcode-select -p",
      { ok: true, text: "/Applications/Xcode.app/Contents/Developer\n" },
    ],
    [
      "xcodebuild -version",
      { ok: true, text: "Xcode 26.1\nBuild version 17A123\n" },
    ],
    [
      "xcrun --sdk iphonesimulator --show-sdk-version",
      { ok: true, text: "26.1\n" },
    ],
    [
      "java -version",
      {
        ok: true,
        text: 'openjdk version "21.0.7" 2025-04-15\nOpenJDK Runtime Environment\n',
      },
    ],
    ["javac -version", { ok: true, text: "javac 21.0.7\n" }],
  ]);
  const run = vi.fn(
    (command: string, args: string[]) =>
      results.get([command, ...args].join(" ")) ?? { ok: false, text: "" },
  );
  const runtime: Runtime = {
    root,
    home,
    host,
    nodeVersion: "24.19.0",
    env: {},
    file: (path) => files.has(path),
    directory: (path) => directories.has(path),
    read: (path) => {
      if (!files.has(path)) throw new Error("Missing fixture file");
      return files.get(path)!;
    },
    run,
  };
  const check = (report: Report, id: string) =>
    report.checks.find((entry) => entry.id === id);
  return {
    root,
    home,
    android,
    sdk,
    files,
    directories,
    results,
    runtime,
    run,
    check,
  };
}

describe("native build preflight", () => {
  it("detects complete prerequisites while explicitly recording that no build ran", () => {
    const f = fixture();
    const report = doctor.runNativeDoctor({ platform: "all" }, f.runtime);
    expect(report).toMatchObject({
      ready: true,
      ok: true,
      buildPerformed: false,
    });
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(f.run.mock.calls.map(([command]) => command)).toEqual([
      "xcode-select",
      "xcodebuild",
      "xcrun",
      "java",
      "javac",
    ]);
    const cli = doctor.runDoctor(["--platform", "all"], f.runtime);
    expect(cli.exitCode).toBe(0);
    expect(cli.output).toContain(
      "Run the platform build to verify compilation",
    );
    expect(cli.output).not.toContain("build succeeded");
  });

  it.each(["20.20.2", "22.21.1", "24.14.9", "25.0.0", "unknown"])(
    "rejects unsupported project Node %s",
    (version) => {
      const f = fixture();
      f.runtime.nodeVersion = version;
      expect(
        f.check(doctor.inspectNative({ platform: "ios" }, f.runtime), "node")
          ?.status,
      ).toBe("fail");
      expect(doctor.runDoctor(["--platform", "ios"], f.runtime).exitCode).toBe(
        1,
      );
    },
  );

  it("does not mistake Command Line Tools and a forged Xcode version for a full Xcode selection", () => {
    const f = fixture();
    f.results.set("xcode-select -p", {
      ok: true,
      text: "/Library/Developer/CommandLineTools",
    });
    const report = doctor.inspectNative({ platform: "ios" }, f.runtime);
    expect(f.check(report, "ios.selection")?.status).toBe("fail");
    expect(f.check(report, "ios.xcode")?.status).toBe("fail");
    expect(f.check(report, "ios.sdk")?.status).toBe("fail");
    expect(f.run.mock.calls.some(([command]) => command === "xcrun")).toBe(
      false,
    );
  });

  it("fails old Xcode, command errors, and absent simulator SDK independently", () => {
    const f = fixture();
    f.results.set("xcodebuild -version", { ok: true, text: "Xcode 16.4" });
    expect(
      f.check(doctor.inspectNative({ platform: "ios" }, f.runtime), "ios.xcode")
        ?.status,
    ).toBe("fail");
    f.results.set("xcodebuild -version", {
      ok: false,
      text: "Xcode 26.1\nlicence failure",
    });
    expect(
      f.check(doctor.inspectNative({ platform: "ios" }, f.runtime), "ios.xcode")
        ?.status,
    ).toBe("fail");
    f.results.set("xcodebuild -version", { ok: true, text: "Xcode 26.1" });
    f.results.set("xcrun --sdk iphonesimulator --show-sdk-version", {
      ok: false,
      text: "SDK unavailable",
    });
    expect(
      f.check(doctor.inspectNative({ platform: "ios" }, f.runtime), "ios.sdk")
        ?.status,
    ).toBe("fail");
  });

  it("does not execute iOS probes on other hosts or Android probes for an iOS-only request", () => {
    const f = fixture("linux");
    const report = doctor.inspectNative({ platform: "ios" }, f.runtime);
    expect(f.check(report, "ios.host")?.status).toBe("fail");
    expect(f.run).not.toHaveBeenCalled();
    expect(report.checks.some((check) => check.platform === "android")).toBe(
      false,
    );
  });

  it("requires a full matching JDK and respects JAVA_HOME without silently falling back", () => {
    const f = fixture();
    f.results.set("java -version", {
      ok: true,
      text: 'openjdk version "17.0.10"',
    });
    expect(
      f.check(
        doctor.inspectNative({ platform: "android" }, f.runtime),
        "android.java",
      )?.status,
    ).toBe("fail");
    f.runtime.env.JAVA_HOME = "/fixture/jdk";
    f.results.set("/fixture/jdk/bin/java -version", {
      ok: true,
      text: 'java version "21.0.7"',
    });
    f.results.set("/fixture/jdk/bin/javac -version", {
      ok: true,
      text: "javac 21.0.7",
    });
    expect(
      f.check(
        doctor.inspectNative({ platform: "android" }, f.runtime),
        "android.java",
      )?.status,
    ).toBe("pass");
    f.results.set("/fixture/jdk/bin/javac -version", {
      ok: false,
      text: "No compiler",
    });
    expect(
      f.check(
        doctor.inspectNative({ platform: "android" }, f.runtime),
        "android.java",
      )?.status,
    ).toBe("fail");
  });

  it("honours project SDK location and does not hide an invalid explicit SDK with a valid default", () => {
    const f = fixture();
    f.runtime.env.ANDROID_HOME = "/fixture/missing-sdk";
    let report = doctor.inspectNative({ platform: "android" }, f.runtime);
    expect(f.check(report, "android.sdk")?.status).toBe("fail");
    f.files.set(
      join(f.android, "local.properties"),
      `# project preference\nsdk.dir=${f.sdk}\n`,
    );
    report = doctor.inspectNative({ platform: "android" }, f.runtime);
    expect(f.check(report, "android.sdk")?.status).toBe("pass");
    expect(f.check(report, "android.platform")?.status).toBe("pass");
    f.files.delete(join(f.android, "local.properties"));
    f.runtime.env.ANDROID_HOME = f.sdk;
    f.runtime.env.ANDROID_SDK_ROOT = "/fixture/different-sdk";
    expect(
      f.check(
        doctor.inspectNative({ platform: "android" }, f.runtime),
        "android.sdk",
      )?.status,
    ).toBe("fail");
  });

  it("rejects a JDK newer than the pinned Gradle runtime supports and mismatched compiler majors", () => {
    const f = fixture();
    f.results.set("java -version", {
      ok: true,
      text: 'openjdk version "25.0.0"',
    });
    f.results.set("javac -version", { ok: true, text: "javac 25.0.0" });
    expect(
      f.check(
        doctor.inspectNative({ platform: "android" }, f.runtime),
        "android.java",
      )?.status,
    ).toBe("fail");
    f.results.set("java -version", {
      ok: true,
      text: 'openjdk version "21.0.7"',
    });
    expect(
      f.check(
        doctor.inspectNative({ platform: "android" }, f.runtime),
        "android.java",
      )?.status,
    ).toBe("fail");
  });

  it("finds the standard Linux Android SDK and ignores the macOS SDK location there", () => {
    const f = fixture("linux");
    expect(
      f.check(
        doctor.inspectNative({ platform: "android" }, f.runtime),
        "android.sdk",
      )?.status,
    ).toBe("fail");
    const linuxSdk = join(f.home, "Android/Sdk");
    f.directories.add(linuxSdk);
    expect(
      f.check(
        doctor.inspectNative({ platform: "android" }, f.runtime),
        "android.sdk",
      )?.status,
    ).toBe("pass");
  });

  it("fails missing wrapper, SDK platform and build tools without executing Gradle or accepting licences", () => {
    const f = fixture();
    f.files.delete(join(f.android, "gradle/wrapper/gradle-wrapper.jar"));
    f.files.delete(join(f.sdk, "platforms/android-36/android.jar"));
    f.files.delete(join(f.sdk, "build-tools/35.0.0/zipalign"));
    const report = doctor.inspectNative({ platform: "android" }, f.runtime);
    for (const id of ["android.wrapper", "android.platform", "android.tools"])
      expect(f.check(report, id)?.status).toBe("fail");
    expect(f.run.mock.calls.map(([command]) => command)).toEqual([
      "java",
      "javac",
    ]);
  });

  it("requires AGP's selected Build Tools 35 even when Build Tools 36 is installed", () => {
    const f = fixture();
    for (const tool of ["aapt2", "zipalign"]) {
      f.files.delete(join(f.sdk, "build-tools/35.0.0", tool));
      f.files.set(join(f.sdk, "build-tools/36.0.0", tool), "");
    }
    const report = doctor.inspectNative({ platform: "android" }, f.runtime);
    expect(f.check(report, "android.platform")?.status).toBe("pass");
    expect(f.check(report, "android.tools")?.status).toBe("fail");
    expect(report.ready).toBe(false);
  });

  it("requires matching installed Capacitor dependencies and handles malformed package metadata", () => {
    const f = fixture();
    f.files.set(
      join(f.root, "node_modules/@capacitor/android/package.json"),
      JSON.stringify({ version: "9.0.0" }),
    );
    expect(
      f.check(
        doctor.inspectNative({ platform: "android" }, f.runtime),
        "android.package",
      )?.status,
    ).toBe("fail");
    f.files.set(
      join(f.root, "node_modules/@capacitor/cli/package.json"),
      "{invalid",
    );
    expect(
      f.check(
        doctor.inspectNative({ platform: "android" }, f.runtime),
        "capacitor",
      )?.status,
    ).toBe("fail");
  });

  it("keeps paths, environment values and arbitrary child diagnostics out of human and JSON output", () => {
    const f = fixture();
    const secret = "secret-token-and-private-account@example.test";
    f.runtime.env.UNRELATED_SECRET = secret;
    f.results.set("java -version", { ok: false, text: secret });
    for (const args of [
      ["--platform", "all"],
      ["--platform", "all", "--json"],
    ]) {
      const result = doctor.runDoctor(args, f.runtime);
      expect(result.exitCode).toBe(1);
      expect(result.output).not.toContain(secret);
      expect(result.output).not.toContain(f.home);
      expect(result.output).not.toContain(f.root);
    }
    const result = doctor.runDoctor(["--json"], {
      ...f.runtime,
      file: () => {
        throw new Error(secret);
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).not.toContain(secret);
  });

  it("handles thrown subprocess errors as failed probes without leaking errors", () => {
    const f = fixture();
    f.runtime.run = () => {
      throw new Error("private diagnostic");
    };
    const result = doctor.runDoctor(["--platform", "all", "--json"], f.runtime);
    expect(result.exitCode).toBe(1);
    expect(result.output).not.toContain("private diagnostic");
    expect(JSON.parse(result.output).ready).toBe(false);
  });

  it("rejects unknown/missing/duplicate arguments and keeps help free of side effects", () => {
    const f = fixture();
    for (const args of [
      ["--platform"],
      ["--platform=desktop"],
      ["--platform", "ios", "--platform", "android"],
      ["--unknown-secret", "--json"],
    ])
      expect(doctor.runDoctor(args, f.runtime).exitCode).toBe(2);
    expect(doctor.runDoctor(["--help"], f.runtime)).toMatchObject({
      exitCode: 0,
    });
    expect(f.run).not.toHaveBeenCalled();
    expect(
      doctor.runDoctor(["--platform=android", "--json"], f.runtime).exitCode,
    ).toBe(0);
  });

  it("parses Java properties path escapes and validates plain numeric versions", () => {
    expect(
      doctor.sdkDirectoryProperty(
        "sdk.dir=C\\:\\\\Users\\\\Music\\\\Android\\\\Sdk\n",
      ),
    ).toBe("C:\\Users\\Music\\Android\\Sdk");
    expect(doctor.sdkDirectoryProperty("sdk.dir=/opt/Android\\ SDK")).toBe(
      "/opt/Android SDK",
    );
    expect(doctor.parseVersion("v24.19.0")).toEqual([24, 19, 0]);
    expect(doctor.parseVersion("26.1")).toEqual([26, 1, 0]);
    expect(doctor.parseVersion("26.1 private diagnostic")).toBeNull();
  });
});
