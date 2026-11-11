"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import { ArrowRight, Music2 } from "lucide-react";
import type { Account } from "@aurelia/core";
import { api } from "@/lib/client-api";
import { Dialog } from "../dialog";
import { ProviderButtons } from "./provider-buttons";
import { CredentialForm } from "./credential-form";
import { CodeForm } from "./code-form";
import {
  AuthRequestGate,
  authReturnTo,
  emailCodeStep,
  emailStep,
  signInResult,
  type PendingEmailChallenge,
  type SignInStep,
} from "./flow";
import styles from "./sign-in.module.css";

export function BrowserSignIn({
  capabilities,
  onAuthenticated,
  onClose,
  pendingChallenge,
}: {
  capabilities: Record<string, boolean>;
  onAuthenticated: (account: Account) => void;
  onClose: () => void;
  pendingChallenge?: PendingEmailChallenge;
}) {
  const [step, setStep] = useState<SignInStep>(() =>
    pendingChallenge
      ? emailCodeStep(pendingChallenge.email, pendingChallenge.challenge)
      : { kind: "email", email: "" },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [gate] = useState(() => new AuthRequestGate());
  const callbacks = useRef({ onAuthenticated, onClose });
  callbacks.current = { onAuthenticated, onClose };
  const focusTarget = useRef<HTMLInputElement>(null);
  const focus = useCallback((input: HTMLInputElement | null) => {
    focusTarget.current = input;
  }, []);
  useEffect(() => () => gate.cancel(), [gate]);
  const focusKey =
    step.kind === "code"
      ? `${step.challenge.challengeId}:${step.expiresAt}`
      : step.kind;
  useEffect(() => {
    focusTarget.current?.focus();
  }, [focusKey]);
  useEffect(() => {
    if (error && !busy) focusTarget.current?.focus();
  }, [error, busy]);
  const interrupt = useCallback(() => {
    gate.cancel();
    setBusy(false);
    setError("");
    setMessage("");
  }, [gate]);
  const close = useCallback(() => {
    gate.cancel();
    callbacks.current.onClose();
  }, [gate]);
  const returnTo =
    typeof window === "undefined"
      ? "/account"
      : authReturnTo(window.location.pathname, window.location.search);
  function changeEmail() {
    interrupt();
    setStep({ kind: "email", email: step.email });
  }
  async function perform(
    operation: (signal: AbortSignal) => Promise<unknown>,
    accept: (value: unknown) => void,
  ) {
    if (gate.pending) return;
    const ticket = gate.begin();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const value = await operation(ticket.signal);
      if (gate.current(ticket)) accept(value);
    } catch (reason) {
      if (gate.current(ticket)) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to sign in. Please try again.",
        );
      }
    } finally {
      if (gate.current(ticket)) {
        gate.finish(ticket);
        setBusy(false);
      }
    }
  }
  function applyResult(value: unknown, email: string) {
    const result = signInResult(value);
    if ("user" in result) {
      callbacks.current.onAuthenticated(result.user);
      close();
      return;
    }
    setStep(emailCodeStep(email, result));
  }
  function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "")
      .trim()
      .toLowerCase();
    void perform(
      (signal) =>
        api("auth/email", {
          method: "POST",
          signal,
          body: JSON.stringify({ email }),
        }),
      (value) => setStep({ kind: emailStep(value), email }),
    );
  }
  function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.kind !== "password" && step.kind !== "register") return;
    const fields = new FormData(event.currentTarget),
      register = step.kind === "register",
      email = step.email;
    if (
      String(fields.get("email") ?? "")
        .trim()
        .toLowerCase() !== email
    ) {
      setError("Choose Change email before signing in to another account.");
      return;
    }
    const body = JSON.stringify({
      email,
      password: fields.get("password"),
      ...(register ? { name: fields.get("name") } : {}),
    });
    void perform(
      (signal) =>
        api(`auth/${register ? "register" : "login"}`, {
          method: "POST",
          signal,
          body,
        }),
      (value) => applyResult(value, email),
    );
  }
  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.kind !== "code") return;
    if (Date.now() >= step.expiresAt) {
      setError("This code expired. Request a new code to continue.");
      return;
    }
    const code = String(
      new FormData(event.currentTarget).get("code") ?? "",
    ).trim();
    if (!/^[0-9]{6}$/.test(code)) {
      setError("Enter the six-digit email code.");
      return;
    }
    const { email, challenge } = step;
    void perform(
      (signal) =>
        api("auth/email-code", {
          method: "POST",
          signal,
          body: JSON.stringify({ challengeId: challenge.challengeId, code }),
        }),
      (value) => applyResult(value, email),
    );
  }
  function resend() {
    if (step.kind !== "code" || Date.now() < step.resendAt) return;
    const email = step.email,
      challengeId = step.challenge.challengeId;
    void perform(
      (signal) =>
        api("auth/email-code/resend", {
          method: "POST",
          signal,
          body: JSON.stringify({ challengeId }),
        }),
      (value) => {
        setStep(emailCodeStep(email, value));
        setMessage("A new code has been sent.");
      },
    );
  }
  const title =
    step.kind === "password"
      ? "Welcome back"
      : step.kind === "register"
        ? "Create your account"
        : step.kind === "code"
          ? "Check your email"
          : "Your Aurelia account";
  return (
    <Dialog title={title} onClose={close} className={styles.dialog}>
      {step.kind === "email" || step.kind === "provider" ? (
        <>
          <div className="auth-mark">
            <Music2 size={26} />
          </div>
          <p className={`muted ${styles.intro}`}>
            {step.kind === "provider"
              ? "Use a connected sign-in service for this email."
              : "Sign in to keep your library with you."}
          </p>
          {step.kind === "provider" && (
            <p className={styles.email}>
              <strong>{step.email}</strong>
            </p>
          )}
          <ProviderButtons
            capabilities={capabilities}
            returnTo={returnTo}
            onNavigate={interrupt}
          />
        </>
      ) : null}
      {step.kind === "email" && (
        <>
          <div className="divider">
            <span>or continue with email</span>
          </div>
          {capabilities.localAccounts !== false ? (
            <form
              id="aurelia-email-form"
              name="aurelia-email-sign-in"
              method="post"
              autoComplete="on"
              onSubmit={submitEmail}
              aria-busy={busy}
            >
              <label htmlFor="auth-email">
                Email
                <input
                  ref={focus}
                  id="auth-email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@example.com"
                  value={step.email}
                  required
                  maxLength={254}
                  onChange={(event) => {
                    interrupt();
                    setStep({
                      kind: "email",
                      email: event.currentTarget.value,
                    });
                  }}
                  aria-describedby={error ? "auth-error" : undefined}
                />
              </label>
              {error && (
                <p id="auth-error" role="alert" className="form-error">
                  {error}
                </p>
              )}
              <button
                type="submit"
                className="button primary wide"
                disabled={busy}
              >
                {busy ? "Checking…" : "Continue"}
                <ArrowRight size={17} />
              </button>
            </form>
          ) : (
            <p className="muted">
              Email accounts are unavailable. Use a connected sign-in service.
            </p>
          )}
        </>
      )}
      {(step.kind === "password" || step.kind === "register") && (
        <CredentialForm
          key={step.kind}
          mode={step.kind}
          email={step.email}
          busy={busy}
          error={error}
          focus={focus}
          onSubmit={submitCredentials}
          onChangeEmail={changeEmail}
        />
      )}
      {step.kind === "provider" && (
        <p className="auth-switch">
          <button type="button" onClick={changeEmail}>
            Change email
          </button>
        </p>
      )}
      {step.kind === "code" && (
        <CodeForm
          key={`${step.challenge.challengeId}:${step.expiresAt}`}
          email={step.email}
          expiresAt={step.expiresAt}
          resendAt={step.resendAt}
          busy={busy}
          error={error}
          message={message}
          focus={focus}
          onSubmit={submitCode}
          onResend={resend}
          onChangeEmail={changeEmail}
        />
      )}
      <p className="fine-print">
        By continuing, you agree to our{" "}
        <Link href="/privacy" onClick={close}>
          privacy policy
        </Link>
        . You can delete your account and listening data at any time.
      </p>
    </Dialog>
  );
}
