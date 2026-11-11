import { afterEach, describe, expect, it, vi } from "vitest";
import { appHref, appPathname } from "../apps/web/src/lib/app-navigation";

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
      snapshot(),
    useMemo: (compute: () => unknown) => compute(),
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("application navigation", () => {
  it.each([
    "/",
    "/search",
    "/library",
    "/liked",
    "/queue",
    "/history",
    "/recommendations",
    "/import",
    "/account",
    "/settings",
    "/mix/golden-hour",
    "/playlist/fixture-id",
    "/album/studio%3Aafterglow",
    "/artist/Bj%C3%B6rk%20fixture",
  ])("maps %s to the player without double prefixes", (logical) => {
    const expected = logical === "/" ? "/app" : `/app${logical}`;
    expect(appHref(logical)).toBe(expected);
    expect(appHref(expected)).toBe(expected);
    expect(appPathname(expected)).toBe(logical);
    expect(appPathname(logical)).toBe(logical);
  });

  it("preserves raw queries, encoding, query order and fragments", () => {
    const query =
      "/search?q=jazz%20%26%20soul&q=second+value&next=https%3A%2F%2Fexample.invalid#main-content";
    expect(appHref(query)).toBe(`/app${query}`);
    expect(appPathname(appHref(query))).toBe(query);
    expect(new URL(appHref(query), "https://app.example").origin).toBe(
      "https://app.example",
    );
    expect(appHref("/account?connect=ABCD-EF23")).toBe(
      "/app/account?connect=ABCD-EF23",
    );
    expect(appHref("/?view=recent#main-content")).toBe(
      "/app?view=recent#main-content",
    );
  });

  it("canonicalizes a single trailing slash and matches the complete app segment", () => {
    expect(appHref("/app/")).toBe("/app");
    expect(appHref("/search/?q=fixture")).toBe("/app/search?q=fixture");
    expect(appPathname("/app/library/")).toBe("/library");
    for (const value of [
      "/apple/search",
      "/application/search",
      "/app-search",
      "/app//search",
    ])
      expect(appPathname(value)).toBe(value);
  });

  it.each([
    "https://example.invalid/search",
    "//example.invalid/search",
    "javascript:alert(1)",
    "search",
    "/\\example.invalid",
    "/search\n",
    "/../search",
    "/artist/..",
    "/artist/%2e%2e",
    "/artist/%252e%252e",
    "/artist/a%2Fb",
    "/artist/a%5Cb",
    "/artist/%ZZ",
    "/artist/%C3",
    "/artist/id/extra",
    "/search/extra",
    "/api/auth/google/start",
    "/privacy",
    "/docs",
    "/features",
    "/app/unknown",
  ])("rejects non-app or ambiguous destination %s", (value) => {
    expect(() => appHref(value)).toThrow(TypeError);
    expect(appPathname(value)).toBe(value);
  });

  it("leaves public, API and external addresses unclassified", () => {
    for (const value of [
      "/privacy",
      "/api/auth/apple/callback?state=fixture",
      "https://www.youtube.com/watch?v=fixture",
      "#main-content",
    ])
      expect(appPathname(value)).toBe(value);
  });
});

describe("bundled hash router compatibility", () => {
  it.each(["#/search?q=jazz%20%26%20soul", "#/app/search?q=jazz%20%26%20soul"])(
    "keeps screen and query for %s",
    async (hash) => {
      vi.stubGlobal("window", {
        location: { hash, search: "" },
        history: { state: null },
      });
      const navigation =
        await import("../experiments/mobile-bundle-probe/src/navigation");
      expect(navigation.screenRoute(navigation.usePathname())).toEqual([
        "search",
      ]);
      expect(navigation.useSearchParams().get("q")).toBe("jazz & soul");
      expect(appPathname(navigation.usePathname())).toBe("/search");
      window.location.hash = "#main-content";
      expect(navigation.screenRoute(navigation.usePathname())).toEqual([
        "search",
      ]);
      expect(navigation.useSearchParams().get("q")).toBe("jazz & soul");
    },
  );

  it("supports old and new home, detail and history addresses", async () => {
    const history = { state: null as Record<string, string> | null };
    vi.stubGlobal("window", {
      location: { hash: "#/app", search: "" },
      history,
    });
    const navigation =
      await import("../experiments/mobile-bundle-probe/src/navigation");
    for (const path of ["/", "/app", "/app/"])
      expect(navigation.screenRoute(path)).toEqual([]);
    for (const path of ["/playlist/fixture-id", "/app/playlist/fixture-id"])
      expect(navigation.screenRoute(path)).toEqual(["playlist", "fixture-id"]);
    for (const path of [
      "/album/studio%3Aafterglow",
      "/app/album/studio%3Aafterglow",
    ])
      expect(navigation.screenRoute(path)).toEqual([
        "album",
        "studio:afterglow",
      ]);
    expect(navigation.screenRoute("/privacy")).toEqual(["privacy"]);
    history.state = {
      aureliaBundledPreviewRoute: "/app/library",
      aureliaBundledPreviewQuery: "filter=fixture%20query",
    };
    window.location.hash = "#main-content";
    expect(navigation.screenRoute(navigation.usePathname())).toEqual([
      "library",
    ]);
    expect(navigation.useSearchParams().get("filter")).toBe("fixture query");
    expect(navigation.screenRoute("/app/unknown")).toBeNull();
  });
});
