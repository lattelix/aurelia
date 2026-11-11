import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bindApiAccount, captureApiAccountScope } from "../apps/web/src/lib/client-account";

const bridge = vi.hoisted(() => ({
  available: true, request: vi.fn(), status: vi.fn(), signOut: vi.fn(), publicGet: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  CapacitorHttp: { get: bridge.publicGet },
}));
vi.mock("../apps/web/src/lib/native-cloud-session", () => ({
  nativeCloudSessionAvailable: () => bridge.available,
  nativeCloudSession: { request: bridge.request, status: bridge.status, signOut: bridge.signOut },
  beginNativeSignIn: vi.fn(), pollNativeSignIn: vi.fn(), cancelNativeSignIn: vi.fn(), signOutNativeSession: vi.fn(),
}));
let api: typeof import("../experiments/mobile-bundle-probe/src/client-api").api;
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
beforeAll(async () => {
  vi.stubGlobal("__AURELIA_PUBLIC_METADATA__", true);
  ({ api } = await import("../experiments/mobile-bundle-probe/src/client-api"));
});
beforeEach(() => {
  vi.clearAllMocks();
  bridge.available = true;
  bindApiAccount(null);
});
afterAll(() => { bindApiAccount(null); vi.unstubAllGlobals(); });

describe("bundled native profile transport", () => {
  it("returns the native authenticated bootstrap without substituting a guest", async () => {
    const payload = { user: { id: owner }, library: { likes: [] } };
    bridge.request.mockResolvedValue({ status: 200, data: payload });
    expect(await api("bootstrap")).toBe(payload);
    expect(bridge.request).toHaveBeenCalledWith({ path: "bootstrap", method: "GET" });
    expect(bridge.publicGet).not.toHaveBeenCalled();
  });
  it("does not downgrade a surviving native session on the first failed bootstrap", async () => {
    bridge.request.mockRejectedValue(new Error("synthetic offline"));
    bridge.status.mockResolvedValue({ available: true, authenticated: true });
    await expect(api("bootstrap")).rejects.toThrow("Cannot reach Aurelia");
    expect(bridge.status).toHaveBeenCalledOnce();
    expect(bridge.signOut).not.toHaveBeenCalled();
  });
  it("uses a guest bootstrap only after the native bridge confirms it has no session", async () => {
    bridge.request.mockRejectedValue(new Error("synthetic offline"));
    bridge.status.mockResolvedValue({ available: true, authenticated: false });
    expect(await api("bootstrap")).toMatchObject({
      user: null, library: null,
      capabilities: { localAccounts: false, nativeAccounts: false, google: false, telegram: false, apple: false },
    });
  });
  it("keeps bootstrap failure visible when native session status is unknown", async () => {
    bridge.request.mockRejectedValue(new Error("synthetic offline"));
    bridge.status.mockRejectedValue(new Error("synthetic unavailable status"));
    await expect(api("bootstrap")).rejects.toThrow("Cannot reach Aurelia");
  });
  it("does not downgrade an already bound account or reset its active scope", async () => {
    bindApiAccount(owner);
    bridge.request.mockRejectedValue(new Error("synthetic offline"));
    await expect(api("bootstrap")).rejects.toThrow("Cannot reach Aurelia");
    expect(captureApiAccountScope().userId).toBe(owner);
    expect(bridge.status).not.toHaveBeenCalled();
  });
  it("retains captured ownership and rejects private responses after switching accounts", async () => {
    bindApiAccount(owner);
    let deliver!: (value: { status: number; data: unknown }) => void;
    bridge.request.mockReturnValue(new Promise((done) => { deliver = done; }));
    const request = api("library");
    expect(bridge.request).toHaveBeenCalledWith({ path: "library", method: "GET", expectedAccountId: owner });
    bindApiAccount(other);
    deliver({ status: 200, data: { syntheticOwner: owner } });
    await expect(request).rejects.toThrow("active account changed");
  });
  it("preserves cancellation during native startup status lookup", async () => {
    bridge.request.mockRejectedValue(new Error("synthetic offline"));
    let deliver!: (status: { available: boolean; authenticated: boolean }) => void;
    bridge.status.mockReturnValue(new Promise((done) => { deliver = done; }));
    const controller = new AbortController();
    const request = api("bootstrap", { signal: controller.signal });
    await vi.waitFor(() => expect(bridge.status).toHaveBeenCalledOnce());
    controller.abort();
    deliver({ available: true, authenticated: false });
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
  it("does not simulate guest writes and rejects web media endpoints before any transport", async () => {
    bridge.available = false;
    await expect(api("library/likes", { method: "POST", body: "{}" })).rejects.toThrow("Cloud features are unavailable");
    bridge.available = true;
    for (const path of ["stream?id=synthetic", "audio?id=synthetic", "hls/fixture", "media/gateway", "download?id=synthetic"])
      await expect(api(path)).rejects.toThrow("native audio engine");
    expect(bridge.request).not.toHaveBeenCalled();
    expect(bridge.publicGet).not.toHaveBeenCalled();
  });
});
