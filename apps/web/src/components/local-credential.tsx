"use client";
import { useState, type FormEvent } from "react";
import type { Account } from "@aurelia/core";
import { api } from "@/lib/client-api";
import { captureApiAccountScope, apiAccountScopeCurrent } from "@/lib/client-account";
import { useApp } from "./app-context";
export function LocalCredential({ user }: { user: Account }) {
  const { setUser, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const values = new FormData(event.currentTarget);
    const scope = captureApiAccountScope();
    try {
      const result = await api<{ user: Account }>("auth/local", { method: "POST",
        headers: { "X-Aurelia-Account": user.id },
        body: JSON.stringify({ email: values.get("email"), password: values.get("password") }),
      });
      if (!apiAccountScopeCurrent(scope)) return;
      setUser(result.user); toast("Email sign-in added to this account");
    } catch (reason) { if (apiAccountScopeCurrent(scope)) setError(reason instanceof Error ? reason.message : "Could not add email sign-in."); }
    finally { if (apiAccountScopeCurrent(scope)) setBusy(false); }
  }
  return <form onSubmit={submit}>
    <h3>Add email and password</h3>
    <p className="muted">Use an email verified by a Google or Apple account you have linked here. Sign in again first if your session is older than ten minutes.</p>
    <label>Email<input name="email" type="email" defaultValue={user.email ?? ""} autoComplete="email" required maxLength={254} /></label>
    <label>New password<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required /></label>
    {error && <p role="alert" className="error-text">{error}</p>}
    <button className="button secondary" disabled={busy}>{busy ? "Adding…" : "Add email sign-in"}</button>
  </form>;
}
