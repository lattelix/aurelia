import { describe, expect, it } from "vitest";
import { evaluatePlayerScript } from "../apps/web/src/lib/youtube-media/client";

describe("isolated YouTube script runtime", () => {
  it("executes the function-body contract without exposing host APIs", async () => {
    const result = await evaluatePlayerScript({
      output: 'return { sig: "deciphered", n: [typeof process, typeof require, typeof fetch, typeof document].join(":") };',
      exported: [],
    });
    expect(result).toEqual({ sig: "deciphered", n: "undefined:undefined:undefined:undefined" });
  });
  it("terminates a script that never finishes", async () => {
    await expect(evaluatePlayerScript({ output: "while (true) {}", exported: [] })).rejects.toThrow("temporarily unavailable");
  }, 8000);
});
