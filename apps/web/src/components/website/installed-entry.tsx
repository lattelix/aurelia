"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Capacitor } from "@capacitor/core";

/** Old installed clients launch at the origin. This changes navigation only. */
export function InstalledEntry() {
  const router = useRouter();
  useEffect(() => {
    const iosStandalone = (navigator as Navigator & { standalone?: boolean })
      .standalone;
    if (
      Capacitor.isNativePlatform() ||
      iosStandalone ||
      window.matchMedia("(display-mode: standalone)").matches
    )
      router.replace(`/app${window.location.search}${window.location.hash}`);
  }, [router]);
  return null;
}
