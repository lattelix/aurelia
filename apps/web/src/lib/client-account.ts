"use client";
export interface ApiAccountScope { readonly userId: string | null; readonly epoch: number }
let active: ApiAccountScope = { userId: null, epoch: 0 };
export function bindApiAccount(userId: string | null) {
  if (userId !== active.userId) active = { userId, epoch: active.epoch + 1 };
}
export const captureApiAccountScope = () => active;
export const apiAccountScopeCurrent = (scope: ApiAccountScope) => scope === active;
export function accountRequestHeaders(path: string, _method: string, input?: HeadersInit) {
  const output = new Headers(input);
  if (/^(?:library(?:\/|$)|import(?:\/|$)|auth\/(?:account|local|security(?:\/.*)?|device\/(?:grant|approve))$)/.test(path.split("?")[0]) &&
      !output.has("X-Aurelia-Account") && active.userId)
    output.set("X-Aurelia-Account", active.userId);
  return output;
}
