import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../apps/web/src/lib/client-api";

afterEach(() => vi.unstubAllGlobals());

describe("client API availability", () => {
  it("explains a lost connection instead of leaking the browser fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    await expect(api("auth/register", { method: "POST" })).rejects.toThrow(
      "Cannot reach Aurelia. Check your connection and try again.",
    );
  });

  it("keeps aborts distinct so cancelled searches stay silent", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    await expect(api("search", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explains proxy/server failures that return HTML", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<h1>Unavailable</h1>", { status: 503 }),
        ),
    );
    await expect(api("auth/register")).rejects.toThrow(
      "Aurelia is temporarily unavailable. Please try again.",
    );
  });

  it("preserves actionable validation errors from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: "Email is already registered" },
            { status: 409 },
          ),
        ),
    );
    await expect(api("auth/register")).rejects.toThrow(
      "Email is already registered",
    );
  });
});
