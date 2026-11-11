import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindApiAccount } from "../apps/web/src/lib/client-account";

const bridge = vi.hoisted(() => ({ request: vi.fn(), logout: vi.fn() }));
vi.mock("../apps/web/src/lib/native-cloud-session", () => ({
  nativeCloudSessionAvailable: () => true,
  nativeCloudSession: { request: bridge.request },
  signOutNativeSession: bridge.logout,
}));
import { api } from "../apps/web/src/lib/client-api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { vi.clearAllMocks(); bindApiAccount("account-A"); });
afterEach(() => bindApiAccount(null));

describe("native API account and cancellation boundary", () => {
  it("captures the initiating owner and discards a late private response after switching", async () => {
    const pending = deferred<{ status: number; data: unknown }>();
    bridge.request.mockReturnValue(pending.promise);
    const request = api("library");
    expect(bridge.request).toHaveBeenCalledWith({ path: "library", method: "GET", expectedAccountId: "account-A" });
    bindApiAccount("account-B");
    pending.resolve({ status: 200, data: { private: "A" } });
    await expect(request).rejects.toThrow("Your account changed");
  });
  it("does not report a late old-session logout as a successful action for the new profile", async () => {
    const pending = deferred<{ revoked: boolean }>();
    bridge.logout.mockReturnValue(pending.promise);
    const request = api("auth/logout", { method: "POST" });
    bindApiAccount("account-B");
    pending.resolve({ revoked: true });
    await expect(request).rejects.toThrow("Your account changed");
  });
  it("checks cancellation after a native logout completes", async () => {
    const pending = deferred<{ revoked: boolean }>();
    bridge.logout.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const request = api("auth/logout", { method: "POST", signal: controller.signal });
    controller.abort(); pending.resolve({ revoked: true });
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
  it("rejects bearer injection before invoking a native transport", async () => {
    await expect(api("bootstrap", { headers: { Authorization: "Bearer injected" } })).rejects.toThrow("header is unavailable");
    expect(bridge.request).not.toHaveBeenCalled();
  });
  it("keeps an explicit captured owner instead of rebinding a delayed mutation to the active account", async () => {
    bridge.request.mockResolvedValue({ status: 409, data: { error: "Wrong owner" } });
    bindApiAccount("account-B");
    await expect(api("library/playlists", { method: "POST", headers: { "X-Aurelia-Account": "account-A" }, body: "{}" })).rejects.toMatchObject({ status: 409 });
    expect(bridge.request).toHaveBeenCalledWith({ path: "library/playlists", method: "POST", body: "{}", expectedAccountId: "account-A" });
  });
});
