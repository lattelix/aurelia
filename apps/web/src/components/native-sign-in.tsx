"use client";
import { useEffect, useRef, useState } from "react";
import { beginNativeSignIn, pollNativeSignIn, cancelNativeSignIn, type NativeSignIn } from "@/lib/native-cloud-session";
import { useApp } from "./app-context";

export function NativeSignInPanel({ onClose }: { onClose: () => void }) {
  const { setUser } = useApp();
  const [grant, setGrant] = useState<NativeSignIn | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const callbacks = useRef({ setUser, onClose });
  callbacks.current = { setUser, onClose };
  useEffect(() => { active.current = true; return () => { active.current = false; void cancelNativeSignIn().catch(() => {}); }; }, []);
  useEffect(() => {
    if (!grant) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const expires = Date.now() + grant.expiresIn * 1000;
    const poll = async () => {
      if (cancelled || !active.current) return;
      if (Date.now() >= expires) { setError("This request expired. Start again to sign in."); setGrant(null); return; }
      if (document.visibilityState === "hidden") { timer = setTimeout(() => void poll(), 3000); return; }
      try {
        const result = await pollNativeSignIn();
        if (cancelled || !active.current) return;
        if (result.status === "approved") { callbacks.current.setUser(result.user); callbacks.current.onClose(); return; }
        if (result.status === "expired") { setError("This request expired. Start again to sign in."); setGrant(null); return; }
      } catch (reason) {
        if (cancelled || !active.current) return;
        setError(reason instanceof Error ? reason.message : "Could not check sign-in. Try again.");
      }
      timer = setTimeout(() => void poll(), Math.max(3, grant.interval) * 1000);
    };
    timer = setTimeout(() => void poll(), Math.max(3, grant.interval) * 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [grant]);
  return <div className="native-sign-in">
    <p>Sign in through your browser, then approve this app to use the same Aurelia library.</p>
    {grant ? <>
      <p>Compare this code with the browser: <strong><code>{grant.userCode}</code></strong></p>
      <p role="status">Waiting for your confirmation. Return here after connecting.</p>
      <button className="button secondary wide" onClick={() => { void cancelNativeSignIn().catch(() => {}); setGrant(null); setError(""); }}>Cancel request</button>
    </> : <button className="button primary wide" disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { const result = await beginNativeSignIn(); if (active.current) setGrant(result); }
      catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : "Could not start sign-in."); }
      finally { if (active.current) setBusy(false); }
    }}>{busy ? "Opening browser…" : "Sign in through your browser"}</button>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </div>;
}
