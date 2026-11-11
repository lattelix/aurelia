"use client";
import { useEffect, useId, useState } from "react";
import { api } from "@/lib/client-api";
import {
  apiAccountScopeCurrent,
  captureApiAccountScope,
} from "@/lib/client-account";
import { nativeCloudSessionAvailable } from "@/lib/native-cloud-session";

interface UnavailableSecurity {
  enabled: false;
  available: false;
  reason: string;
}
type SecurityState =
  | { owner: string; status: "loading" }
  | { owner: string; status: "error"; error: string }
  | { owner: string; status: "ready"; value: UnavailableSecurity };

function unavailableSecurity(value: unknown): UnavailableSecurity {
  if (
    value === null ||
    typeof value !== "object" ||
    !("enabled" in value) ||
    value.enabled !== false ||
    !("available" in value) ||
    value.available !== false ||
    !("reason" in value) ||
    typeof value.reason !== "string" ||
    !value.reason.trim() ||
    value.reason.length > 500
  )
    throw new Error("Security settings are temporarily unavailable. Try again.");
  return { enabled: false, available: false, reason: value.reason };
}

/** Account settings are read-only until email delivery is connected. */
export function AccountSecurity({ userId }: { userId: string }) {
  const titleId = useId(),
    reasonId = useId();
  const nativeSession = nativeCloudSessionAvailable();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SecurityState>({
    owner: userId,
    status: "loading",
  });
  useEffect(() => {
    if (nativeSession) return;
    const scope = captureApiAccountScope();
    if (scope.userId !== userId) return;
    const controller = new AbortController();
    let active = true;
    const current = () =>
      active && !controller.signal.aborted && apiAccountScopeCurrent(scope);
    setState({ owner: userId, status: "loading" });
    void api<unknown>("auth/security", {
      signal: controller.signal,
      headers: { "X-Aurelia-Account": userId },
    })
      .then((value) => {
        if (!current()) return;
        setState({
          owner: userId,
          status: "ready",
          value: unavailableSecurity(value),
        });
      })
      .catch((reason) => {
        if (!current()) return;
        setState({
          owner: userId,
          status: "error",
          error:
            reason instanceof Error
              ? reason.message
              : "Security settings are temporarily unavailable. Try again.",
        });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [userId, nativeSession, attempt]);
  if (nativeSession) return null;
  const status = state.owner === userId ? state.status : "loading";
  return (
    <section
      className="settings-section"
      aria-labelledby={titleId}
      aria-busy={status === "loading"}
    >
      <h2 id={titleId}>Account security</h2>
      {status === "loading" && (
        <p role="status" className="muted">
          Loading security settings…
        </p>
      )}
      {status === "error" && state.status === "error" && (
        <>
          <p role="alert" className="error-text">
            {state.error}
          </p>
          <button
            type="button"
            className="button secondary small"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
        </>
      )}
      {status === "ready" && state.status === "ready" && (
        <div className="settings-row">
          <span>
            <strong>Email sign-in code</strong>
            <small id={reasonId}>
              Off · Unavailable. {state.value.reason}
            </small>
          </span>
          <button
            type="button"
            role="switch"
            aria-label="Email sign-in code"
            aria-checked={false}
            aria-describedby={reasonId}
            className="switch"
            disabled
          >
            <span />
          </button>
        </div>
      )}
      <div className="settings-row">
        <span>
          <strong>Authenticator app</strong>
          <small>Planned. Time-based codes are not available yet.</small>
        </span>
        <span className="status-pill">Planned</span>
      </div>
    </section>
  );
}
