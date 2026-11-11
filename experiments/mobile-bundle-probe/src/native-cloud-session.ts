import {
  nativeCloudSession,
  nativeCloudSessionAvailable as sharedSessionAvailable,
  beginNativeSignIn as sharedBegin,
  pollNativeSignIn as sharedPoll,
  cancelNativeSignIn as sharedCancel,
  signOutNativeSession as sharedSignOut,
} from "../../../apps/web/src/lib/native-cloud-session";
import { publicMetadataEnabled } from "./preview-mode";

export type { NativeSignIn, NativeSignInPoll } from "../../../apps/web/src/lib/native-cloud-session";
export { nativeCloudSession };
export const nativeCloudSessionAvailable = () => publicMetadataEnabled && sharedSessionAvailable();
function requireProfileMode() {
  if (!nativeCloudSessionAvailable())
    throw new Error("Cloud sign-in is unavailable in this bundled preview.");
}
export async function getNativeCloudSessionStatus() {
  if (!nativeCloudSessionAvailable()) return { available: false, authenticated: false };
  return nativeCloudSession.status();
}
export async function beginNativeSignIn() { requireProfileMode(); return sharedBegin(); }
export async function pollNativeSignIn() { requireProfileMode(); return sharedPoll(); }
export async function signOutNativeSession() { requireProfileMode(); return sharedSignOut(); }
export async function cancelNativeSignIn() {
  if (nativeCloudSessionAvailable()) await sharedCancel();
}
