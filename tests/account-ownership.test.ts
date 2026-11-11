import { describe, expect, it } from "vitest";
import {
  AccountOwnership,
  restoreQueueState,
} from "../apps/web/src/components/account-ownership";

describe("account ownership during asynchronous client work", () => {
  it("rejects startup account data after a guest logout/reset even when both bindings are null", () => {
    const ownership = new AccountOwnership();
    const startup = ownership.beginRefresh();
    ownership.transition(null);
    expect(ownership.acceptRefresh(startup, "account-a")).toBeNull();
    expect(ownership.refreshCurrent(startup)).toBe(false);
    expect(ownership.capture().userId).toBeNull();
  });

  it("drops an A response and its error/finally after logout and B login", () => {
    const ownership = new AccountOwnership();
    ownership.transition("account-a");
    const oldOperation = ownership.capture();
    const oldBootstrap = ownership.beginRefresh();
    ownership.transition(null);
    ownership.transition("account-b");
    const current = ownership.beginRefresh();
    const accepted = ownership.acceptRefresh(current, "account-b");
    expect(ownership.acceptRefresh(oldBootstrap, "account-a")).toBeNull();
    expect(ownership.current(oldOperation)).toBe(false);
    expect(ownership.refreshCurrent(oldBootstrap)).toBe(false);
    expect(accepted && ownership.refreshCurrent(accepted)).toBe(true);
    expect(ownership.capture().userId).toBe("account-b");
  });

  it("does not let an older same-owner refresh undo a later successful mutation refresh", () => {
    const ownership = new AccountOwnership();
    ownership.transition("account-a");
    const focusRefresh = ownership.beginRefresh();
    const mutationRefresh = ownership.beginRefresh();
    const accepted = ownership.acceptRefresh(mutationRefresh, "account-a");
    expect(ownership.acceptRefresh(focusRefresh, "account-a")).toBeNull();
    expect(ownership.refreshCurrent(focusRefresh)).toBe(false);
    expect(accepted && ownership.refreshCurrent(accepted)).toBe(true);
  });

  it("accepts initial account discovery but gives its completion the new ownership scope", () => {
    const ownership = new AccountOwnership();
    const startup = ownership.beginRefresh();
    const accepted = ownership.acceptRefresh(startup, "account-a");
    expect(accepted).not.toBeNull();
    expect(ownership.refreshCurrent(startup)).toBe(false);
    expect(accepted && ownership.refreshCurrent(accepted)).toBe(true);
    expect(accepted?.scope.userId).toBe("account-a");
  });

  it("keeps operation ownership stable across same-account background library updates", () => {
    const ownership = new AccountOwnership();
    ownership.transition("account-a");
    const operation = ownership.capture();
    const accepted = ownership.acceptRefresh(
      ownership.beginRefresh(),
      "account-a",
    );
    expect(accepted?.scope).toBe(operation);
    expect(ownership.current(operation)).toBe(true);
  });

  it("invalidates operations when an accepted foreground bootstrap detects a different session", () => {
    const ownership = new AccountOwnership();
    ownership.transition("account-a");
    const operation = ownership.capture();
    const accepted = ownership.acceptRefresh(ownership.beginRefresh(), null);
    expect(accepted?.scope.userId).toBeNull();
    expect(ownership.current(operation)).toBe(false);
  });

  it("reauthentication to the same ID still invalidates pending mutation completions", () => {
    const ownership = new AccountOwnership();
    ownership.transition("account-a");
    const operation = ownership.capture();
    const refresh = ownership.beginRefresh();
    ownership.transition("account-a");
    expect(ownership.current(operation)).toBe(false);
    expect(ownership.acceptRefresh(refresh, "account-a")).toBeNull();
  });

  it("clears current unauthorized ownership but a late A rejection cannot clear B", () => {
    const ownership = new AccountOwnership();
    ownership.transition("account-a");
    const a = ownership.capture();
    ownership.transition("account-b");
    const b = ownership.capture();
    expect(ownership.clearAccount(a)).toBe(false);
    expect(ownership.capture().userId).toBe("account-b");
    expect(ownership.clearAccount(b)).toBe(true);
    expect(ownership.capture().userId).toBeNull();
    expect(ownership.current(b)).toBe(false);
  });
});

describe("per-device native playback restoration", () => {
  it("restores only the native account's local intent even when cloud queue carries different playback and volume", () => {
    const server = {
      queue: ["other-device"],
      playing: true,
      volume: 1,
      position: 40,
    };
    const local = {
      queue: ["this-device"],
      playing: false,
      volume: 0,
      position: 12,
    };
    expect(restoreQueueState(true, server, () => local)).toBe(local);
  });
  it("does not import cloud playback when the native local queue is empty", () => {
    const empty = { queue: [], playing: false, volume: 0, position: 0 };
    expect(restoreQueueState(true, { queue: ["remote"] }, () => empty)).toBe(
      empty,
    );
  });
  it("preserves legacy browser cloud priority without reading a corrupt local value", () => {
    const server = { queue: ["browser-cloud"], playing: false };
    expect(
      restoreQueueState(false, server, () => {
        throw new Error("local must not be read");
      }),
    ).toBe(server);
    const local = { queue: ["browser-local"] };
    expect(restoreQueueState(false, null, () => local)).toBe(local);
  });
});
