"use client";
import { useEffect, useState, type FormEvent, type RefCallback } from "react";
import styles from "./sign-in.module.css";
export function CodeForm({
  email,
  expiresAt,
  resendAt,
  busy,
  error,
  message,
  focus,
  onSubmit,
  onResend,
  onChangeEmail,
}: {
  email: string;
  expiresAt: number;
  resendAt: number;
  busy: boolean;
  error: string;
  message: string;
  focus: RefCallback<HTMLInputElement>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onResend: () => void;
  onChangeEmail: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = now >= expiresAt,
    wait = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const feedback =
    error ||
    (expired ? "This code expired. Request a new code to continue." : "");
  return (
    <form
      id="aurelia-email-code-form"
      name="aurelia-email-code"
      method="post"
      autoComplete="on"
      onSubmit={onSubmit}
      aria-busy={busy}
    >
      <p className="muted">
        Enter the six-digit code sent to{" "}
        <strong className={styles.email}>{email}</strong>.
      </p>
      <label htmlFor="auth-email-code">
        Email code
        <input
          ref={focus}
          id="auth-email-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          minLength={6}
          maxLength={6}
          placeholder="000000"
          required
          disabled={busy || expired}
          aria-describedby={feedback ? "auth-error" : undefined}
        />
      </label>
      {feedback && (
        <p id="auth-error" role="alert" className="form-error">
          {feedback}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <button
        type="submit"
        className="button primary wide"
        disabled={busy || expired}
      >
        {busy ? "Checking…" : "Verify code"}
      </button>
      <p className="auth-switch">
        <button type="button" disabled={busy || wait > 0} onClick={onResend}>
          {wait ? `Resend code in ${wait}s` : "Resend code"}
        </button>
      </p>
      <p className="auth-switch">
        <button type="button" onClick={onChangeEmail}>
          Change email
        </button>
      </p>
    </form>
  );
}
