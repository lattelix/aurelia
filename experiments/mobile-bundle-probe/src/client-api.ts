import { Capacitor, CapacitorHttp } from "@capacitor/core";
import {
  albums,
  artists,
  catalogue,
  editorialPlaylists,
  StudioProvider,
} from "@aurelia/music";
import { parsePublicSearch, publicSearchURL } from "./public-metadata";
import { nativeCloudSession, nativeCloudSessionAvailable } from "./native-cloud-session";
import { accountRequestHeaders, apiAccountScopeCurrent, captureApiAccountScope } from "../../../apps/web/src/lib/client-account";
import { publicMetadataEnabled } from "./preview-mode";

export { publicMetadataEnabled } from "./preview-mode";
const studio = new StudioProvider();
export const previewCloudMessage =
  "Cloud features are unavailable in this private bundled UI preview. " +
  "The original Studio catalogue and device appearance settings are available offline.";

function aborted(signal?: AbortSignal | null) {
  if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");
}

async function offline<T>(path: string): Promise<T> {
  if (path === "bootstrap") return {
    user: null, library: null, catalogue, albums, artists, editorialPlaylists,
    capabilities: {
      demoCatalogue: !publicMetadataEnabled,
      studio: true, youtube: publicMetadataEnabled && Capacitor.isNativePlatform(),
      localAccounts: false, nativeAccounts: false, google: false, telegram: false, apple: false,
    }, recommendations: [],
  } as T;
  const local = new URL(path, "https://bundled.invalid/");
  if (local.origin !== "https://bundled.invalid" || local.hash) throw new Error(previewCloudMessage);
  if (local.pathname === "/search" && local.searchParams.get("provider") === "studio")
    return await studio.search((local.searchParams.get("q") ?? "").slice(0, 200)) as T;
  if (local.pathname === "/autocomplete") return {
    suggestions: await studio.autocomplete((local.searchParams.get("q") ?? "").slice(0, 200)),
  } as T;
  throw new Error(previewCloudMessage);
}

/** Credentials stay in the native plugin; only account-bound JSON crosses this bridge. */
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  aborted(options.signal);
  const scope = captureApiAccountScope();
  const method = (options.method ?? "GET").toUpperCase();
  if (/^(?:stream|audio|hls|media|download)(?:[/?]|$)/.test(path))
    throw new Error("Playback requires the native audio engine in this app.");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
      (options.body != null && typeof options.body !== "string")) throw new Error(previewCloudMessage);
  const headers = accountRequestHeaders(path, method, options.headers);
  for (const [key, value] of headers) {
    if (key === "content-type" && /^application\/json(?:;\s*charset=utf-8)?$/i.test(value)) continue;
    if (key === "x-aurelia-account" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) continue;
    throw new Error("This request header is unavailable in the native client.");
  }
  if (!publicMetadataEnabled) {
    if (method !== "GET" || options.body != null) throw new Error(previewCloudMessage);
    return offline<T>(path);
  }
  if (nativeCloudSessionAvailable()) {
    if (path === "auth/logout" && method === "POST") {
      const result = await nativeCloudSession.signOut();
      aborted(options.signal);
      if (!apiAccountScopeCurrent(scope)) throw new Error("The active account changed. Try again.");
      return result as T;
    }
    let response: { status: number; data: unknown };
    try {
      response = await nativeCloudSession.request({ path, method,
        ...(typeof options.body === "string" ? { body: options.body } : {}),
        ...(headers.has("X-Aurelia-Account") ? { expectedAccountId: headers.get("X-Aurelia-Account")! } : {}),
      });
    } catch {
      aborted(options.signal);
      if (!apiAccountScopeCurrent(scope)) throw new Error("The active account changed. Try again.");
      if (method === "GET" && path === "bootstrap" && scope.userId === null) {
        // A fresh JS scope is also null when a native credential survived an app restart.
        // Only an explicitly unauthenticated bridge may become a guest after a network error.
        const status = await nativeCloudSession.status().catch(() => null);
        aborted(options.signal);
        if (!apiAccountScopeCurrent(scope)) throw new Error("The active account changed. Try again.");
        if (status?.available === true && status.authenticated === false) return offline<T>(path);
      }
      throw new Error("Cannot reach Aurelia. Check your connection and try again.");
    }
    aborted(options.signal);
    if (!apiAccountScopeCurrent(scope)) throw new Error("The active account changed. Try again.");
    if (response.status < 200 || response.status >= 300)
      throw Object.assign(new Error(response.status === 401 ? "Sign in to continue." : "Cloud request failed. Please try again."), { status: response.status });
    return response.data as T;
  }
  if (method !== "GET" || options.body != null) throw new Error(previewCloudMessage);
  if (path === "bootstrap" || path.startsWith("autocomplete?") ||
      new URL(path, "https://bundled.invalid/").searchParams.get("provider") === "studio") return offline<T>(path);
  const url = publicSearchURL(path);
  if (!Capacitor.isNativePlatform())
    throw new Error("YouTube search is available in the Android preview.");
  const response = await CapacitorHttp.get({
    url,
    headers: { Accept: "application/json" },
    responseType: "json",
    connectTimeout: 10_000,
    readTimeout: 20_000,
    disableRedirects: true,
  });
  aborted(options.signal);
  if (!apiAccountScopeCurrent(scope)) throw new Error("The active account changed. Try again.");
  if (response.status < 200 || response.status >= 300 || response.url !== url)
    throw new Error("YouTube search is unavailable. Try again later.");
  return parsePublicSearch(response.data) as T;
}
