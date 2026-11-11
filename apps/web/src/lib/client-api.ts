import { accountRequestHeaders, captureApiAccountScope, apiAccountScopeCurrent } from "./client-account";
import { nativeCloudSession, nativeCloudSessionAvailable, signOutNativeSession } from "./native-cloud-session";

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (options.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
  const scope = captureApiAccountScope();
  const method = (options.method ?? "GET").toUpperCase();
  const requestHeaders = accountRequestHeaders(path, method, options.headers);
  if (nativeCloudSessionAvailable()) {
    if ([...requestHeaders.keys()].some((key) => !["content-type", "x-aurelia-account"].includes(key)))
      throw new Error("This request header is unavailable on this device.");
    if (path === "auth/logout" && method === "POST") {
      await signOutNativeSession();
      if (options.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
      if (!apiAccountScopeCurrent(scope)) throw new Error("Your account changed. Please try again.");
      return { ok: true } as T;
    }
    if (options.body != null && typeof options.body !== "string")
      throw new Error("This request body is unavailable on this device.");
    const response = await nativeCloudSession.request({ path, method,
      ...(typeof options.body === "string" ? { body: options.body } : {}),
      ...(requestHeaders.get("X-Aurelia-Account") ? { expectedAccountId: requestHeaders.get("X-Aurelia-Account")! } : {}),
    });
    if (options.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    if (!apiAccountScopeCurrent(scope)) throw new Error("Your account changed. Please try again.");
    if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(errorMessage(response.data)), { status: response.status });
    return response.data as T;
  }
  requestHeaders.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      ...options,
      credentials: "same-origin",
      headers: requestHeaders,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(
      "Cannot reach Aurelia. Check your connection and try again.",
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("Aurelia is temporarily unavailable. Please try again.");
  }
  if (!apiAccountScopeCurrent(scope)) throw new Error("Your account changed. Please try again.");
  if (!response.ok)
    throw Object.assign(new Error(errorMessage(data)), { status: response.status });
  return data as T;
}
function errorMessage(data: unknown) {
  return data !== null && typeof data === "object" && "error" in data && typeof data.error === "string"
    ? data.error : "Request failed. Please try again.";
}
