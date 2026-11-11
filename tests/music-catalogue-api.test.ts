import { beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({
  rate: vi.fn(async () => {}),
  catalogue: vi.fn(async () => ({ source: "youtube-music", tracks: [] })),
}));
vi.mock("@aurelia/database", () => ({
  getDatabase: async () => ({}),
  getLibrary: vi.fn(),
  getSignals: vi.fn(),
}));
vi.mock("@aurelia/auth", () => ({ rateLimit: calls.rate }));
vi.mock("../apps/web/src/lib/http", () => ({
  account: async () => null,
  json: (value: unknown) => Response.json(value),
}));
vi.mock("../apps/web/src/lib/providers", () => ({
  studio: {},
  youtube: {},
  trustedTrack: vi.fn(),
  providerFor: vi.fn(),
}));
vi.mock("../apps/web/src/lib/env", () => ({
  capabilities: { demoCatalogue: false },
  env: { WEB_GUEST_VERIFICATION: "off", APP_URL: "http://localhost:3000" },
}));
vi.mock("../apps/web/src/lib/youtube-media/catalogue", () => ({
  getMusicCatalogue: calls.catalogue,
}));
import { musicApi } from "../apps/web/src/lib/api-music";
beforeEach(() => {
  calls.rate.mockClear();
  calls.catalogue.mockClear();
});
describe("anonymous typed catalogue API dispatch", () => {
  it("uses the existing public handler with validated typed search and guest rate limiting", async () => {
    const response = await musicApi(
      ["music", "catalogue", "search"],
      new Request(
        "https://aurelia.lattelix.com/api/music/catalogue/search?q=Artist&kind=albums",
      ),
    );
    expect(response?.status).toBe(200);
    expect(calls.catalogue).toHaveBeenCalledWith({
      operation: "search",
      query: "Artist",
      kind: "albums",
    });
    expect(calls.rate).toHaveBeenCalledWith({}, "music-catalogue:guest", 30);
  });
  it("rejects malformed metadata requests before a runtime job and never accepts writes", async () => {
    await expect(
      musicApi(
        ["music", "catalogue", "browse"],
        new Request(
          "https://aurelia.lattelix.com/api/music/catalogue/browse?kind=artist&id=../private",
        ),
      ),
    ).rejects.toThrow();
    expect(calls.catalogue).not.toHaveBeenCalled();
    expect(calls.rate).not.toHaveBeenCalled();
    const response = await musicApi(
      ["music", "catalogue", "search"],
      new Request(
        "https://aurelia.lattelix.com/api/music/catalogue/search?q=Artist",
        { method: "POST" },
      ),
    );
    expect(response).toBeNull();
    expect(calls.catalogue).not.toHaveBeenCalled();
  });
});
