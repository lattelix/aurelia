"use client";

import { useEffect, type RefObject } from "react";

/**
 * The shell has one viewport and one dock. Browser/IME resize is measured here;
 * native safe-area CSS variables are supplied by Capacitor System Bars.
 */
export function ViewportMetrics({
  dock,
}: {
  dock: RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const previousCompact = root.getAttribute("data-compact-viewport");
    let frame = 0;
    const properties = [
      "--app-height",
      "--app-offset-top",
      "--playback-dock-height",
    ] as const;
    const previous = properties.map((property) => [
      property,
      root.style.getPropertyValue(property),
    ]);
    const update = () => {
      frame = 0;
      // Reflow for the on-screen keyboard/browser chrome, but keep pinch zoom
      // as magnification rather than turning it into a compact app layout.
      const magnified = viewport && viewport.scale > 1.05;
      const height = magnified
        ? window.innerHeight
        : (viewport?.height ?? window.innerHeight);
      const top = magnified ? 0 : (viewport?.offsetTop ?? 0);
      if (Number.isFinite(height) && height > 0) {
        root.style.setProperty("--app-height", `${height}px`);
        root.toggleAttribute("data-compact-viewport", height < 240);
      }
      root.style.setProperty("--app-offset-top", `${Math.max(0, top)}px`);
      const dockHeight = dock.current?.getBoundingClientRect().height;
      if (dockHeight !== undefined && Number.isFinite(dockHeight))
        root.style.setProperty("--playback-dock-height", `${dockHeight}px`);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    if (dock.current) observer?.observe(dock.current);
    window.addEventListener("resize", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    document.addEventListener("visibilitychange", schedule);
    update();
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      document.removeEventListener("visibilitychange", schedule);
      for (const [property, value] of previous) {
        if (value) root.style.setProperty(property, value);
        else root.style.removeProperty(property);
      }
      if (previousCompact === null)
        root.removeAttribute("data-compact-viewport");
      else root.setAttribute("data-compact-viewport", previousCompact);
    };
  }, [dock]);
  return null;
}
