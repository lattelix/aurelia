import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: [] as unknown[][], body: "", output: '{"public":"metadata"}', failure: false }));
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    state.calls.push(args);
    const complete = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
    return { stdin: { on: () => {}, end: (body: string) => {
      state.body = body;
      queueMicrotask(() => complete(state.failure ? new Error("synthetic-private-child-error") : null, state.output, "synthetic-private-child-stderr"));
    } } };
  },
}));
import { runMusicCatalogue } from "../apps/web/src/lib/youtube-media/catalogue-runtime";

beforeEach(() => { state.calls = []; state.body = ""; state.output = '{"public":"metadata"}'; state.failure = false; });
describe("isolated catalogue runtime", () => {
  it("passes only typed metadata work, a stripped environment and bounded dependency reads", async () => {
    const task = { operation: "search" as const, kind: "songs" as const, query: "Public artist" };
    await expect(runMusicCatalogue(task)).resolves.toEqual({ public: "metadata" });
    const [binary, args, raw] = state.calls[0], options = raw as Record<string, unknown>;
    expect(binary).toBe(process.execPath);
    expect(args).toEqual(expect.arrayContaining(["--permission", "--max-old-space-size=160", expect.stringMatching(/^--allow-fs-read=.*\/node_modules$/), expect.stringMatching(/catalogue-worker\.mjs$/)]));
    expect((args as string[]).filter((argument) => argument.startsWith("--allow-fs-read="))).toHaveLength(2);
    expect(options).toMatchObject({ env: { NODE_ENV: "production" }, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL" });
    expect(options.env).toEqual({ NODE_ENV: "production" });
    expect(JSON.parse(state.body)).toEqual(task);
  });
  it("rejects invalid work before spawning and hides raw child errors and diagnostics", async () => {
    await expect(runMusicCatalogue({ operation: "browse", kind: "album", id: "../../private" })).rejects.toThrow();
    expect(state.calls).toHaveLength(0);
    state.failure = true;
    await expect(runMusicCatalogue({ operation: "charts", country: "ZZ" })).rejects.toMatchObject({ status: 502, message: "YouTube Music catalogue is temporarily unavailable. Please retry." });
    state.failure = false; state.output = "not JSON synthetic-private-response";
    await expect(runMusicCatalogue({ operation: "charts", country: "ZZ" })).rejects.toMatchObject({ status: 502, message: "YouTube Music returned unsupported catalogue metadata." });
  });
});
