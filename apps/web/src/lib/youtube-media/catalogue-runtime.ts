import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as NodeModule from "node:module";
import { dirname, join } from "node:path";
import { AppError } from "@aurelia/core";
import { CatalogueTaskSchema, type CatalogueTask } from "./catalogue-contracts";

const requireModule: NodeJS.Require = Reflect.apply(Reflect.get(NodeModule, "createRequire"), undefined, [join(process.cwd(), "package.json")]);
let active = 0;
export const catalogueRuntimeLimits = { timeout: 15_000, maximumBytes: 8 * 1024 * 1024, maximumActive: 2 } as const;
/** A metadata child receives no application environment, cookies or credentials. */
export async function runMusicCatalogue(input: CatalogueTask): Promise<unknown> {
  const task = CatalogueTaskSchema.parse(input);
  if (active >= catalogueRuntimeLimits.maximumActive) throw new AppError(503, "Music catalogue is busy. Please retry.");
  active++;
  try {
    // Literal import preserves dependency tracing for the standalone deployment.
    await import("youtubei.js");
    const direct = join(process.cwd(), "youtube-runtime/catalogue-worker.mjs");
    const entry = existsSync(direct) ? direct : join(process.cwd(), "apps/web/youtube-runtime/catalogue-worker.mjs");
    const dependency = realpathSync(requireModule.resolve("youtubei.js"));
    const marker = dependency.lastIndexOf("/node_modules/");
    if (marker < 0 || !existsSync(entry)) throw new Error("Catalogue runtime unavailable");
    const dependencies = dependency.slice(0, marker + "/node_modules".length);
    return await new Promise<unknown>((resolve, reject) => {
      const child = execFile(process.execPath, ["--no-warnings", "--max-old-space-size=160", "--permission",
        `--allow-fs-read=${dependencies}`, `--allow-fs-read=${dirname(entry)}`, entry], {
        env: { NODE_ENV: "production" }, encoding: "utf8", timeout: catalogueRuntimeLimits.timeout,
        maxBuffer: catalogueRuntimeLimits.maximumBytes, killSignal: "SIGKILL",
      }, (error, stdout) => {
        if (error) { reject(new AppError(502, "YouTube Music catalogue is temporarily unavailable. Please retry.")); return; }
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new AppError(502, "YouTube Music returned unsupported catalogue metadata.")); }
      });
      child.stdin?.on("error", () => {}); child.stdin?.end(JSON.stringify(task));
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, "YouTube Music catalogue is temporarily unavailable. Please retry.");
  } finally { active--; }
}
