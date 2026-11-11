import {
  forwardRef,
  useMemo,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
} from "react";
import { appPathname } from "../../../apps/web/src/lib/app-navigation";

const routeRoots = new Set([
  "search", "library", "liked", "mix", "playlist", "album", "artist", "queue",
  "history", "recommendations", "import", "account", "settings", "privacy",
]);

function routeHash(hash: string): string | null {
  if (!hash.startsWith("#/")) return null;
  const path = hash.slice(1).split(/[?#]/, 1)[0];
  return path || "/";
}

// Accessibility fragments must never become routes or erase the current screen.
const stateKey = "aureliaBundledPreviewRoute";
const queryStateKey = "aureliaBundledPreviewQuery";
function rememberedPath(): string | null {
  const state: unknown = window.history.state;
  if (state && typeof state === "object" && stateKey in state) {
    const path: unknown = (state as Record<string, unknown>)[stateKey];
    if (typeof path === "string" && isInternalPath(path)) return path;
  }
  return null;
}
let lastPath = routeHash(window.location.hash) ?? rememberedPath() ?? "/";
function routeQuery(hash: string): string | null {
  if (!hash.startsWith("#/")) return null;
  const question = hash.indexOf("?");
  return question < 0 ? "" : hash.slice(question + 1).split("#", 1)[0];
}
function rememberedQuery(): string | null {
  const state: unknown = window.history.state;
  if (state && typeof state === "object" && queryStateKey in state) {
    const query: unknown = (state as Record<string, unknown>)[queryStateKey];
    if (typeof query === "string") return query;
  }
  return null;
}
let lastQuery = routeQuery(window.location.hash) ?? rememberedQuery() ?? window.location.search.slice(1);
function snapshot(): string {
  lastPath = routeHash(window.location.hash) ?? rememberedPath() ?? lastPath;
  return lastPath;
}
function subscribe(listener: () => void): () => void {
  const changed = () => {
    const path = snapshot();
    const query = searchSnapshot();
    try {
      // Retain a fragment's screen when back/forward revisits #main-content.
      const state: unknown = window.history.state;
      window.history.replaceState(
        { ...(state && typeof state === "object" ? state : {}), [stateKey]: path, [queryStateKey]: query },
        "",
      );
    } catch {
      // Navigation still works if this WebView restricts history state.
    }
    listener();
  };
  window.addEventListener("hashchange", changed);
  window.addEventListener("popstate", changed);
  return () => {
    window.removeEventListener("hashchange", changed);
    window.removeEventListener("popstate", changed);
  };
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, snapshot, () => "/");
}

function searchSnapshot(): string {
  lastQuery = routeQuery(window.location.hash) ?? rememberedQuery() ?? lastQuery;
  return lastQuery;
}
export function useSearchParams(): URLSearchParams {
  const query = useSyncExternalStore(subscribe, searchSnapshot, () => "");
  return useMemo(() => new URLSearchParams(query), [query]);
}

export function screenRoute(path: string): string[] | null {
  path = appPathname(path);
  if (path === "/") return [];
  const segments = path.split("/").filter(Boolean);
  try {
    const decoded = segments.map(decodeURIComponent);
    if (!routeRoots.has(decoded[0])) return null;
    const detail = ["mix", "playlist", "album", "artist"].includes(decoded[0]);
    if (decoded.length !== (detail ? 2 : 1)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function isInternalPath(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}
function safeHref(href: string): string | undefined {
  if (/[\u0000-\u0020\u007f]/.test(href)) return undefined;
  if (isInternalPath(href)) return `#${href}`;
  if (href.startsWith("#")) return href;
  try {
    const url = new URL(href, window.location.href);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function push(href: string): void {
  if (!isInternalPath(href) || safeHref(href) === undefined) return;
  window.location.hash = href;
}
const router = {
  push,
  back: () => window.history.back(),
  forward: () => window.history.forward(),
};
export function useRouter(): typeof router {
  return router;
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
};
const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, onClick, target, rel, ...props },
  ref,
) {
  const resolved = safeHref(href);
  function navigate(event: MouseEvent<HTMLAnchorElement>): void {
    onClick?.(event);
    if (
      event.defaultPrevented || event.button !== 0 || event.metaKey ||
      event.ctrlKey || event.shiftKey || event.altKey ||
      (target && target !== "_self") || props.download !== undefined
    ) return;
    if (resolved === undefined) {
      event.preventDefault();
      return;
    }
    if (isInternalPath(href)) {
      event.preventDefault();
      push(href);
    }
  }
  const safeRel = target === "_blank"
    ? [...new Set(`${rel ?? ""} noopener noreferrer`.trim().split(/\s+/))].join(" ")
    : rel;
  return (
    <a
      {...props}
      ref={ref}
      href={resolved}
      target={target}
      rel={safeRel}
      onClick={navigate}
      aria-disabled={resolved === undefined ? true : props["aria-disabled"]}
    />
  );
});
export default Link;
