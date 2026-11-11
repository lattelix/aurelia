import { describe, expect, it } from "vitest";
import {
  AuthRequestGate,
  authReturnTo,
  emailChallenge,
  emailCodeStep,
  emailStep,
  pendingEmailChallenge,
  signInResult,
} from "../apps/web/src/components/auth/flow";
describe("email-first sign-in flow", () => {
  it("accepts only explicit discovery steps and never treats a challenge as a signed-in user", () => {
    for (const step of ["password", "register", "provider"] as const)
      expect(emailStep({ step })).toBe(step);
    expect(() => emailStep({ step: "other" })).toThrow();
    const challenge = signInResult({
      status: "challenge",
      challengeId: "synthetic-challenge",
      expiresIn: 600,
    });
    expect(challenge).toEqual({
      status: "challenge",
      challengeId: "synthetic-challenge",
      expiresIn: 600,
      resendAfter: 60,
    });
    expect(challenge).not.toHaveProperty("user");
  });
  it("validates challenge bounds and code-send cooldowns", () => {
    for (const patch of [
      { challengeId: "https://untrusted.invalid" },
      { expiresIn: 0 },
      { expiresIn: 999999 },
      { resendAfter: -1 },
    ])
      expect(() =>
        emailChallenge({
          status: "challenge",
          challengeId: "synthetic-challenge",
          expiresIn: 600,
          ...patch,
        }),
      ).toThrow();
    expect(
      emailChallenge({
        status: "challenge",
        challengeId: "new-challenge",
        expiresIn: 300,
        resendAfter: 60,
      }).challengeId,
    ).toBe("new-challenge");
  });
  it("recovers an OAuth email challenge from server data with bounded expiry and resend times", () => {
    const pending = pendingEmailChallenge({
      email: "listener@example.test",
      challenge: {
        status: "challenge",
        challengeId: "browser-bound-challenge",
        expiresIn: 300,
        resendAfter: 60,
        code: "must-not-enter-client-state",
      },
      token: "must-not-enter-client-state",
    });
    expect(emailCodeStep(pending.email, pending.challenge, 1000)).toEqual({
      kind: "code",
      email: "listener@example.test",
      challenge: {
        status: "challenge",
        challengeId: "browser-bound-challenge",
        expiresIn: 300,
        resendAfter: 60,
      },
      expiresAt: 301000,
      resendAt: 61000,
    });
    expect(pending).not.toHaveProperty("token");
    expect(pending.challenge).not.toHaveProperty("code");
    for (const value of [
      null,
      { email: "not-an-email", challenge: pending.challenge },
      {
        email: pending.email,
        challenge: { ...pending.challenge, expiresIn: 0 },
      },
    ])
      expect(() => pendingEmailChallenge(value)).toThrow();
  });
  it("preserves only native consent or expected account return paths", () => {
    expect(authReturnTo("/account", "?connect=ABCD-EF23")).toBe(
      "/account?connect=ABCD-EF23",
    );
    const owner = "daed6c3c-9924-42b7-91f1-3a7799731ab2";
    expect(authReturnTo("/account", `?expectedUserId=${owner}`)).toBe(
      `/account?expectedUserId=${owner}`,
    );
    expect(authReturnTo("/account", "?next=https://untrusted.invalid")).toBe(
      "/account",
    );
    expect(authReturnTo("/search", "?connect=ABCD-EF23")).toBe("/account");
    expect(authReturnTo("/app/account", "?connect=ABCD-EF23")).toBe(
      "/account?connect=ABCD-EF23",
    );
    expect(authReturnTo("/app/account", `?expectedUserId=${owner}`)).toBe(
      `/account?expectedUserId=${owner}`,
    );
    expect(authReturnTo("/app/account", "?next=//untrusted.invalid")).toBe(
      "/account",
    );
    expect(authReturnTo("/app/account/extra", "?connect=ABCD-EF23")).toBe(
      "/account",
    );
  });
  it("aborts and rejects late results when emailA is replaced by B or the dialog closes", async () => {
    const gate = new AuthRequestGate(),
      first = gate.begin();
    expect(gate.pending).toBe(true);
    gate.cancel();
    expect(first.signal.aborted).toBe(true);
    const second = gate.begin();
    expect(gate.current(first)).toBe(false);
    expect(gate.current(second)).toBe(true);
    gate.finish(first);
    expect(gate.pending).toBe(true);
    gate.finish(second);
    expect(gate.pending).toBe(false);
    expect(gate.current(second)).toBe(false);
    const pending = gate.begin();
    gate.cancel();
    await Promise.resolve();
    expect(gate.current(pending)).toBe(false);
  });
});
