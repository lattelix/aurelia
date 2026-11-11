import type { Account } from "@aurelia/core";

export type EmailStep = "password" | "register" | "provider";
export interface EmailChallenge {
  status: "challenge";
  challengeId: string;
  expiresIn: number;
  resendAfter: number;
}
/** Recovered by a same-origin, browser-bound endpoint; never from a URL. */
export interface PendingEmailChallenge {
  email: string;
  challenge: EmailChallenge;
}
export interface EmailCodeStep {
  kind: "code";
  email: string;
  challenge: EmailChallenge;
  expiresAt: number;
  resendAt: number;
}
export type SignInStep =
  { kind: "email" | EmailStep; email: string } | EmailCodeStep;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const unexpected = () =>
  new Error("Sign-in is temporarily unavailable. Please try again.");
export function emailStep(value: unknown): EmailStep {
  if (
    !object(value) ||
    !["password", "register", "provider"].includes(String(value.step))
  )
    throw unexpected();
  return value.step as EmailStep;
}
export function emailChallenge(value: unknown): EmailChallenge {
  if (
    !object(value) ||
    value.status !== "challenge" ||
    typeof value.challengeId !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(value.challengeId) ||
    !Number.isInteger(value.expiresIn) ||
    (value.expiresIn as number) < 1 ||
    (value.expiresIn as number) > 3600 ||
    (value.resendAfter !== undefined &&
      (!Number.isInteger(value.resendAfter) ||
        (value.resendAfter as number) < 0 ||
        (value.resendAfter as number) > 600))
  )
    throw unexpected();
  return {
    status: "challenge",
    challengeId: value.challengeId,
    expiresIn: value.expiresIn as number,
    resendAfter: (value.resendAfter as number | undefined) ?? 60,
  };
}
export function pendingEmailChallenge(value: unknown): PendingEmailChallenge {
  if (
    !object(value) ||
    typeof value.email !== "string" ||
    value.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)
  )
    throw unexpected();
  return { email: value.email, challenge: emailChallenge(value.challenge) };
}
export function emailCodeStep(
  email: string,
  value: unknown,
  now = Date.now(),
): EmailCodeStep {
  const challenge = emailChallenge(value);
  return {
    kind: "code",
    email,
    challenge,
    expiresAt: now + challenge.expiresIn * 1000,
    resendAt: now + challenge.resendAfter * 1000,
  };
}
export function signInResult(
  value: unknown,
): { user: Account } | EmailChallenge {
  if (!object(value)) throw unexpected();
  if (value.status === "challenge") return emailChallenge(value);
  const user = value.user;
  if (
    !object(user) ||
    typeof user.id !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(user.id) ||
    typeof user.name !== "string" ||
    user.name.length > 160 ||
    (user.email !== null && typeof user.email !== "string") ||
    !Array.isArray(user.identities) ||
    user.identities.length > 16 ||
    user.identities.some(
      (identity) => typeof identity !== "string" || identity.length > 80,
    )
  )
    throw unexpected();
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email as string | null,
      identities: user.identities as string[],
    },
  };
}
/** Keep native consent/account binding; discard unrelated query parameters. */
export function authReturnTo(pathname: string, search: string): string {
  if (pathname !== "/account" && pathname !== "/app/account") return "/account";
  const params = new URLSearchParams(search),
    connect = params.get("connect"),
    expected = params.get("expectedUserId");
  if (connect && /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(connect))
    return `/account?connect=${connect}`;
  if (
    expected &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(expected)
  )
    return `/account?expectedUserId=${encodeURIComponent(expected)}`;
  return "/account";
}
/** Fence responses from replaced emails, abandoned steps and closed dialogs. */
export class AuthRequestGate {
  private generation = 0;
  private controller: AbortController | null = null;
  get pending() {
    return this.controller !== null;
  }
  begin() {
    this.cancel();
    this.controller = new AbortController();
    return { generation: this.generation, signal: this.controller.signal };
  }
  current(ticket: { generation: number; signal: AbortSignal }) {
    return (
      ticket.generation === this.generation &&
      this.controller?.signal === ticket.signal &&
      !ticket.signal.aborted
    );
  }
  finish(ticket: { generation: number; signal: AbortSignal }) {
    if (this.current(ticket)) this.controller = null;
  }
  cancel() {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
  }
}
