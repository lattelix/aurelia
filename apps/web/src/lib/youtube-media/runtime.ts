import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as NodeModule from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AppError } from "@aurelia/core";

let active = 0;
// Resolve from the deployed cwd rather than a webpack-baked source URL.
const requireModule: NodeJS.Require = Reflect.apply(Reflect.get(NodeModule, "createRequire"), undefined, [join(process.cwd(), "package.json")]);
export async function runYoutubeRuntime(task: {
  kind: "attestation" | "player";
  id?: string;
  script?: string;
}): Promise<unknown> {
  if (active >= 2) throw new AppError(503, "Audio is busy. Please retry.");
  active++;
  try {
    // Keep literal imports for Next's dependency tracing. Vercel's parent
    // loader can reject require(ESM); the credential-free native Node child
    // loads and validates these dependencies independently.
    if (task.kind === "attestation") {
      await Promise.allSettled([
        import("bgutils-js/botguard"),
        import("jsdom"),
        import("bgutils-js/utils"),
      ]);
    } else if (!(await import("quickjs-emscripten")).getQuickJS) {
      throw new Error("Runtime unavailable");
    }
    const direct = join(process.cwd(), "youtube-runtime/worker.mjs");
    const entry = existsSync(direct)
      ? direct
      : join(process.cwd(), "apps/web/youtube-runtime/worker.mjs");
    if (!existsSync(entry)) throw new Error("Audio runtime entry unavailable");
    const dependencies = realpathSync(requireModule.resolve("quickjs-emscripten"));
    const marker = dependencies.lastIndexOf("/node_modules/");
    if (marker < 0) throw new Error("Runtime dependencies unavailable");
    const dependencyRoot = dependencies.slice(0, marker + "/node_modules".length);
    return await new Promise<unknown>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [
          "--no-warnings",
          "--max-old-space-size=160",
          "--stack-size=4096",
          "--permission",
          `--allow-fs-read=${dependencyRoot}`,
          `--allow-fs-read=${dirname(entry)}`,
          entry,
        ],
        {
          env: { NODE_ENV: "production" },
          encoding: "utf8",
          timeout: task.kind === "player" ? 5000 : 25_000,
          maxBuffer: 64 * 1024,
          killSignal: "SIGKILL",
        },
        (error, stdout, stderr) => {
          if (error) {
            let phase = "execution";
            let reason = "UNAVAILABLE";
            let code: string | undefined;
            try {
              const diagnostic = z.object({ phase: z.enum([
                "input", "page", "challenge", "interpreter", "snapshot", "integrity", "mint",
              ]), reason: z.enum(["UNAVAILABLE", "MISSING_PAGE_CHALLENGE", "INCOMPLETE_CHALLENGE", "INVALID_INTERPRETER_URL"]).optional(), code: z.enum(["ENOENT", "ERR_ACCESS_DENIED", "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_REQUIRE_ESM", "ERR_REQUIRE_ASYNC_MODULE"]).optional() }).parse(JSON.parse(stderr));
              phase = diagnostic.phase;
              reason = diagnostic.reason ?? reason;
              code = diagnostic.code;
            } catch { /* Logs never contain unvalidated child output. */ }
            console.warn("youtube_runtime_failure", { kind: task.kind, phase, reason, code });
            reject(new AppError(502, "YouTube audio is temporarily unavailable."));
            return;
          }
          try { resolve(JSON.parse(stdout)); }
          catch { reject(new AppError(502, "Invalid audio runtime response")); }
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(task));
    });
  } finally { active--; }
}
