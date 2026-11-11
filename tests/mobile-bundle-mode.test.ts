import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewStatus } from "../experiments/mobile-bundle-probe/src/preview-mode";
import { androidPreviewMode } from "../experiments/mobile-bundle-probe/src/android-preview-mode";

const bridge = vi.hoisted(() => ({ begin: vi.fn(), poll: vi.fn(), cancel: vi.fn(), signOut: vi.fn(), status: vi.fn(), available: true }));
vi.mock("../apps/web/src/lib/native-cloud-session", () => ({
  nativeCloudSessionAvailable: () => bridge.available,
  nativeCloudSession: { status: bridge.status },
  beginNativeSignIn: bridge.begin, pollNativeSignIn: bridge.poll,
  cancelNativeSignIn: bridge.cancel, signOutNativeSession: bridge.signOut,
}));
beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); bridge.available = true; });
afterEach(() => vi.unstubAllGlobals());

describe("bundled preview modes", () => {
  it("keeps silent source QA separate from the main private profile and offline probe", () => {
    expect(androidPreviewMode({ nightQa: false, profilePreview: false })).toMatchObject({
      appId: "com.lattelix.aurelia.bundledprobe", requiredUiMode: "private-bundled-offline-guest",
      forceSilent: false, forceYoutubeSource: false, mainApplication: false,
    });
    expect(androidPreviewMode({ nightQa: true, profilePreview: false })).toMatchObject({
      appId: "com.lattelix.aurelia.nightqa", requiredUiMode: "private-bundled-profile-preview",
      forceSilent: true, forceYoutubeSource: true, mainApplication: false,
    });
    expect(androidPreviewMode({ nightQa: false, profilePreview: true })).toMatchObject({
      appId: "com.lattelix.aurelia", appName: "Aurelia", requiredUiMode: "private-bundled-profile-preview",
      forceSilent: false, forceYoutubeSource: false, mainApplication: true,
    });
    expect(() => androidPreviewMode({ nightQa: true, profilePreview: true })).toThrow("mutually exclusive");
  });
  it("does not offer or begin cloud sign-in in an offline build even when the plugin is registered", async () => {
    vi.stubGlobal("__AURELIA_PUBLIC_METADATA__", false);
    const native = await import("../experiments/mobile-bundle-probe/src/native-cloud-session");
    expect(native.nativeCloudSessionAvailable()).toBe(false);
    await expect(native.beginNativeSignIn()).rejects.toThrow("unavailable");
    await expect(native.getNativeCloudSessionStatus()).resolves.toEqual({ available: false, authenticated: false });
    await native.cancelNativeSignIn();
    expect(bridge.begin).not.toHaveBeenCalled();
    expect(bridge.status).not.toHaveBeenCalled();
    expect(bridge.cancel).not.toHaveBeenCalled();
  });
  it("delegates browser approval only in a profile build with the actual native plugin", async () => {
    vi.stubGlobal("__AURELIA_PUBLIC_METADATA__", true);
    const native = await import("../experiments/mobile-bundle-probe/src/native-cloud-session");
    bridge.begin.mockResolvedValue({ userCode: "ABCD-EF23" });
    expect(native.nativeCloudSessionAvailable()).toBe(true);
    await expect(native.beginNativeSignIn()).resolves.toEqual({ userCode: "ABCD-EF23" });
    expect(bridge.begin).toHaveBeenCalledOnce();
    bridge.available = false;
    expect(native.nativeCloudSessionAvailable()).toBe(false);
    await expect(native.pollNativeSignIn()).rejects.toThrow("unavailable");
    expect(bridge.poll).not.toHaveBeenCalled();
  });
  it("describes guest, signed-in and unavailable states without claiming a synced guest profile", () => {
    const input = { profileMode: true, nativeSession: true, signedIn: false, loading: false, failed: false };
    expect(previewStatus(input).description).toContain("Sign in through your browser");
    expect(previewStatus({ ...input, signedIn: true }).description).toContain("Cloud profile connected");
    expect(previewStatus({ ...input, failed: true }).description).toContain("Cloud connection unavailable");
    expect(previewStatus({ ...input, nativeSession: false }).description).toContain("Guest preview");
    expect(previewStatus({ ...input, profileMode: false }).description).toContain("Cloud sign-in is disabled");
  });
});
