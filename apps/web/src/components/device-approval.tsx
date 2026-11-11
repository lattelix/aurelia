"use client";
import { useEffect, useState } from "react";
import { Smartphone, Check } from "lucide-react";
import { api } from "@/lib/client-api";
import { captureApiAccountScope, apiAccountScopeCurrent } from "@/lib/client-account";
import { useApp } from "./app-context";

export function DeviceApproval() {
  const { data, openAuth, toast } = useApp();
  const [code, setCode] = useState("");
  const [grant, setGrant] = useState<{ deviceName: string; status: "pending" | "approved" } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search).get("connect");
    if (query && /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(query)) setCode(query);
  }, []);
  const userId = data.user?.id;
  useEffect(() => {
    if (!code || !userId) { setGrant(null); return; }
    const controller = new AbortController();
    setError(""); setGrant(null);
    void api<{ deviceName: string; status: "pending" | "approved" }>(`auth/device/grant?userCode=${encodeURIComponent(code)}`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setGrant(value); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "This device request is unavailable."); });
    return () => controller.abort();
  }, [code, userId]);
  if (!code) return null;
  return <section className="settings-section" aria-labelledby="connect-device-title">
    <h2 id="connect-device-title"><Smartphone size={21} /> Connect your app</h2>
    <p>Only approve a request you started in Aurelia on your own device.</p>
    <p><strong>Code: <code>{code}</code></strong></p>
    {!data.user ? <button className="button primary" onClick={openAuth}>Sign in to connect this device</button>
      : grant?.status === "approved" ? <p role="status"><Check size={18} /> Connected. You can return to Aurelia.</p>
      : grant ? <>
        <p>Connect <strong>{grant.deviceName}</strong> as <strong>{data.user.name}</strong>?</p>
        <p className="muted">This app will have access to your library. Music playback stays on each device.</p>
        <button className="button primary" disabled={busy} onClick={async () => {
          const scope = captureApiAccountScope();
          setBusy(true); setError("");
          try {
            const result = await api<{ deviceName: string; status: "pending" | "approved" }>("auth/device/approve", { method: "POST", headers: { "X-Aurelia-Account": data.user!.id }, body: JSON.stringify({ userCode: code }) });
            if (!apiAccountScopeCurrent(scope)) return;
            setGrant(result); toast("App connected to your account");
          } catch (reason) { if (apiAccountScopeCurrent(scope)) setError(reason instanceof Error ? reason.message : "Could not connect this app."); }
          finally { if (apiAccountScopeCurrent(scope)) setBusy(false); }
        }}>{busy ? "Connecting…" : `Connect as ${data.user.name}`}</button>
      </> : !error && <p role="status">Checking this device request…</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
  </section>;
}
