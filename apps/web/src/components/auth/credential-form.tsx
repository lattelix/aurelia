"use client";
import type { FormEvent, RefCallback } from "react";
import { ArrowRight } from "lucide-react";
export function CredentialForm({
  mode,
  email,
  busy,
  error,
  focus,
  onSubmit,
  onChangeEmail,
}: {
  mode: "password" | "register";
  email: string;
  busy: boolean;
  error: string;
  focus: RefCallback<HTMLInputElement>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onChangeEmail: () => void;
}) {
  const register = mode === "register";
  return (
    <form
      id={register ? "aurelia-registration-form" : "aurelia-password-form"}
      name={register ? "aurelia-registration" : "aurelia-password-sign-in"}
      method="post"
      autoComplete="on"
      onSubmit={onSubmit}
      aria-busy={busy}
    >
      <label htmlFor="auth-email">
        Email
        <input
          id="auth-email"
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          readOnly
          maxLength={254}
        />
      </label>
      {register && (
        <label htmlFor="auth-name">
          Your name
          <input
            ref={focus}
            id="auth-name"
            name="name"
            type="text"
            autoComplete="name"
            placeholder="What should we call you?"
            required
            maxLength={80}
            disabled={busy}
          />
        </label>
      )}
      <label htmlFor="auth-password">
        Password
        <input
          ref={register ? undefined : focus}
          id="auth-password"
          name="password"
          type="password"
          autoComplete={register ? "new-password" : "current-password"}
          minLength={12}
          maxLength={256}
          placeholder={register ? "At least 12 characters" : "Your password"}
          required
          disabled={busy}
          aria-describedby={error ? "auth-error" : undefined}
        />
      </label>
      {error && (
        <p id="auth-error" role="alert" className="form-error">
          {error}
        </p>
      )}
      <button type="submit" className="button primary wide" disabled={busy}>
        {busy ? "One moment…" : register ? "Create account" : "Sign in"}
        <ArrowRight size={17} />
      </button>
      <p className="auth-switch">
        <button type="button" onClick={onChangeEmail}>
          Change email
        </button>
      </p>
    </form>
  );
}
