/** Identity changes invalidate all work, including guest -> guest logout/reset. */
export interface AccountOwnershipScope {
  readonly userId: string | null;
  readonly generation: number;
}
export interface AccountRefreshTicket {
  readonly scope: AccountOwnershipScope;
  readonly request: number;
}

export class AccountOwnership {
  private active: AccountOwnershipScope = Object.freeze({
    userId: null,
    generation: 0,
  });
  private latestRefresh = 0;

  capture(): AccountOwnershipScope {
    return this.active;
  }
  current(scope: AccountOwnershipScope): boolean {
    return scope === this.active;
  }

  clearAccount(scope: AccountOwnershipScope): boolean {
    if (!this.current(scope)) return false;
    this.transition(null);
    return true;
  }

  transition(userId: string | null): AccountOwnershipScope {
    this.latestRefresh++;
    this.active = Object.freeze({
      userId,
      generation: this.active.generation + 1,
    });
    return this.active;
  }

  beginRefresh(): AccountRefreshTicket {
    return { scope: this.active, request: ++this.latestRefresh };
  }

  refreshCurrent(ticket: AccountRefreshTicket): boolean {
    return this.current(ticket.scope) && ticket.request === this.latestRefresh;
  }

  acceptRefresh(
    ticket: AccountRefreshTicket,
    userId: string | null,
  ): AccountRefreshTicket | null {
    if (!this.refreshCurrent(ticket)) return null;
    if (userId !== this.active.userId)
      this.active = Object.freeze({
        userId,
        generation: this.active.generation + 1,
      });
    return { scope: this.active, request: ticket.request };
  }
}

/** Native cloud sessions sync metadata; playback intent/position/volume stay on this device. */
export function restoreQueueState(
  nativeSession: boolean,
  serverState: unknown,
  localState: () => unknown,
): unknown {
  return !nativeSession && serverState != null ? serverState : localState();
}
