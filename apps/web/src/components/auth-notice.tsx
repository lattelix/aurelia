"use client";
import { useEffect, useState } from "react";

/** Callback errors contain a fixed public category, never provider responses. */
export function AuthNotice() {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("authError") !== "provider-failed") return;
    setFailed(true);
    url.searchParams.delete("authError");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  if (!failed) return null;
  return <div role="alert" className="error-text">
    The sign-in service could not complete the connection. Please try connecting the service again.
  </div>;
}
