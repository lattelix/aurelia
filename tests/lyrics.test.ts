import { describe, it, expect } from "vitest";
import { parseLyrics } from "../apps/web/src/lib/lyrics";
describe("synchronized lyrics", () => {
  it("parses fractions, repeated timestamps and sorts lines", () => {
    expect(
      parseLyrics(
        "[ar:Fixture]\n[00:12.50]second\n[00:01.250][00:03.25]first\nplain text",
      ),
    ).toEqual([
      { time: 1.25, text: "first" },
      { time: 3.25, text: "first" },
      { time: 12.5, text: "second" },
    ]);
  });
  it("keeps instrumental gaps and ignores invalid times", () => {
    expect(parseLyrics("[00:02.00]\n[00:70.00]invalid")).toEqual([
      { time: 2, text: "" },
    ]);
  });
});
