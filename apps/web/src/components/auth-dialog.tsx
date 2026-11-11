"use client";
import { useCallback, useLayoutEffect, useRef } from "react";
import { nativeCloudSessionAvailable } from "@/lib/native-cloud-session";
import { useApp } from "./app-context";
import { Dialog } from "./dialog";
import { NativeSignInPanel } from "./native-sign-in";
import { BrowserSignIn } from "./auth/browser-sign-in";
import type { PendingEmailChallenge } from "./auth/flow";
import styles from "./auth/sign-in.module.css";

export function AuthDialog({
  onClose,
  pendingChallenge,
  returnFocusTo,
}: {
  onClose: () => void;
  pendingChallenge?: PendingEmailChallenge;
  returnFocusTo?: HTMLElement | null;
}) {
  const { data, setUser } = useApp();
  const callbacks = useRef({ onClose });
  callbacks.current = { onClose };
  const close = useCallback(() => callbacks.current.onClose(), []);
  const opener = useRef<HTMLElement | null>(null);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    // Capture before Dialog's passive effect opens the modal and moves focus.
    if (!opener.current)
      opener.current = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    return () => {
      mounted.current = false;
      const target = opener.current;
      // Let the nested dialog close before restoring the actual keyboard opener.
      queueMicrotask(() => {
        if (!mounted.current && target?.isConnected) target.focus();
      });
    };
  }, [returnFocusTo]);
  if (nativeCloudSessionAvailable())
    return (
      <Dialog
        title="Your Aurelia account"
        onClose={close}
        className={styles.dialog}
      >
        <NativeSignInPanel onClose={close} />
      </Dialog>
    );
  return (
    <BrowserSignIn
      key={pendingChallenge?.challenge.challengeId ?? "email"}
      capabilities={data.capabilities}
      onAuthenticated={setUser}
      onClose={close}
      pendingChallenge={pendingChallenge}
    />
  );
}
