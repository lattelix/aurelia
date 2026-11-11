"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "./dialog";

interface Admission {
  required: boolean;
  allowed: boolean;
  ready: boolean;
  siteKey?: string;
  action: "listen_guest";
}
interface VerificationRequest {
  id: number;
  config: Admission;
  signal: AbortSignal;
  done: () => void;
  fail: (error: Error) => void;
}
interface Turnstile {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  remove(id: string): void;
  reset(id: string): void;
}
const widgetApi = () =>
  (window as Window & { turnstile?: Turnstile }).turnstile;

function GuestVerificationDialog({
  request,
}: {
  request: VerificationRequest;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<string | undefined>(undefined);
  const widgetEpoch = useRef(0);
  const active = useRef(false);
  const submission = useRef<AbortController | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [scriptAttempt, setScriptAttempt] = useState(0);
  const close = useCallback(
    () => request.fail(new Error("Guest verification cancelled.")),
    [request],
  );

  const mount = useCallback(() => {
    const api = widgetApi();
    if (
      !active.current ||
      request.signal.aborted ||
      !container.current ||
      widget.current !== undefined ||
      !api
    )
      return;
    const epoch = ++widgetEpoch.current;
    const current = () =>
      active.current &&
      !request.signal.aborted &&
      widgetEpoch.current === epoch;
    try {
      widget.current = api.render(container.current, {
        sitekey: request.config.siteKey,
        action: request.config.action,
        theme: "auto",
        size: "flexible",
        callback: async (token: string) => {
          if (!current() || submission.current) return;
          const controller = new AbortController();
          submission.current = controller;
          setBusy(true);
          setError("");
          try {
            const response = await fetch("/api/guest", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token }),
              signal: controller.signal,
            });
            if (!response.ok)
              throw new Error("Verification failed. Please try again.");
            const result: unknown = await response.json();
            if (
              !result ||
              typeof result !== "object" ||
              !("ok" in result) ||
              result.ok !== true
            )
              throw new Error("Verification failed. Please try again.");
            if (current()) request.done();
          } catch {
            if (current()) {
              setError(
                "Could not verify access. Check your connection and try again.",
              );
              if (widget.current !== undefined) api.reset(widget.current);
            }
          } finally {
            if (submission.current === controller) submission.current = null;
            if (current()) setBusy(false);
          }
        },
        "error-callback": () => {
          if (current())
            setError(
              "Verification is unavailable. Check your connection and retry.",
            );
        },
        "expired-callback": () => {
          if (current() && widget.current !== undefined)
            api.reset(widget.current);
        },
      });
    } catch {
      setError("Verification could not start. Please retry.");
    }
  }, [request]);

  useEffect(() => {
    active.current = true;
    let script: HTMLScriptElement | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    const detach = () => {
      clearTimeout(timer);
      script?.removeEventListener("load", loaded);
      script?.removeEventListener("error", failed);
      script?.remove();
    };
    const failed = () => {
      if (ended) return;
      ended = true;
      detach();
      if (active.current && !request.signal.aborted)
        setError(
          "Verification could not load. Check your connection and retry.",
        );
    };
    const loaded = () => {
      if (ended || !active.current || request.signal.aborted) return;
      if (!widgetApi()) {
        failed();
        return;
      }
      ended = true;
      detach();
      mount();
    };
    // Keep provider loading, errors and retries owned by this widget instance.
    if (!widgetApi()) {
      script = document.createElement("script");
      script.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.addEventListener("load", loaded);
      script.addEventListener("error", failed);
      timer = setTimeout(failed, 15_000);
      document.head.appendChild(script);
    }
    mount();
    return () => {
      active.current = false;
      ended = true;
      // Numeric generation intentionally advances during cleanup, rather than reading a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++widgetEpoch.current;
      detach();
      submission.current?.abort();
      submission.current = null;
      if (widget.current !== undefined) widgetApi()?.remove(widget.current);
      widget.current = undefined;
    };
  }, [mount, request.signal, scriptAttempt]);

  return (
    <Dialog title="Listen as a guest" onClose={close}>
      <p>
        A quick check helps keep Aurelia available. No account is needed to
        listen.
      </p>
      <div
        ref={container}
        style={{ minHeight: 70 }}
        aria-label="Guest access verification"
      />

      {busy && <p role="status">Verifying…</p>}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button
            className="button secondary"
            onClick={() => {
              setError("");
              if (widget.current !== undefined)
                widgetApi()?.reset(widget.current);
              else if (widgetApi()) mount();
              else setScriptAttempt((attempt) => attempt + 1);
            }}
          >
            Retry verification
          </button>
        </>
      )}
      <p className="muted">
        Verification is provided by Cloudflare. Your playback still follows the
        music source’s availability.
      </p>
    </Dialog>
  );
}

/** A source change or Pause cancels both the status request and the open widget. */
export function useGuestVerification() {
  const [request, setRequest] = useState<VerificationRequest | null>(null);
  const pending = useRef<VerificationRequest | null>(null);
  const operation = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const cancel = useCallback(() => {
    operation.current?.abort();
    pending.current?.fail(new DOMException("Aborted", "AbortError"));
  }, []);
  const verify = useCallback(
    async (signal: AbortSignal) => {
      signal.throwIfAborted();
      cancel();
      const controller = new AbortController();
      operation.current = controller;
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        const response = await fetch("/api/guest", {
          credentials: "same-origin",
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (!response.ok)
          throw new Error("Guest access is temporarily unavailable.");
        const config = (await response.json()) as Admission;
        controller.signal.throwIfAborted();
        if (config.allowed === true) return;
        if (
          config.required !== true ||
          config.ready !== true ||
          !config.siteKey ||
          config.action !== "listen_guest"
        )
          throw new Error("Guest access is temporarily unavailable.");
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener("abort", cancelled);
            if (pending.current === next) {
              pending.current = null;
              setRequest(null);
            }
            if (error) reject(error);
            else resolve();
          };
          const cancelled = () =>
            finish(new DOMException("Aborted", "AbortError"));
          const next: VerificationRequest = {
            id: ++sequence.current,
            config,
            signal: controller.signal,
            done: () => finish(),
            fail: finish,
          };
          pending.current = next;
          controller.signal.addEventListener("abort", cancelled, {
            once: true,
          });
          setRequest(next);
          if (controller.signal.aborted) cancelled();
        });
        controller.signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", abort);
        if (operation.current === controller) operation.current = null;
      }
    },
    [cancel],
  );
  useEffect(() => cancel, [cancel]);
  return {
    verify,
    cancel,
    dialog: request ? (
      <GuestVerificationDialog key={request.id} request={request} />
    ) : null,
  };
}
