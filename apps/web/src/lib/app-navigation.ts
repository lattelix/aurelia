const pages = new Set([
  "search",
  "library",
  "liked",
  "queue",
  "history",
  "recommendations",
  "import",
  "account",
  "settings",
]);
const collections = new Set(["mix", "playlist", "album", "artist"]);

function parts(href: string): { path: string; suffix: string } | null {
  if (
    !href.startsWith("/") ||
    href.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/.test(href)
  )
    return null;
  const separator = href.search(/[?#]/);
  return separator < 0
    ? { path: href, suffix: "" }
    : { path: href.slice(0, separator), suffix: href.slice(separator) };
}

function logicalPath(path: string): string | null {
  const unprefixed =
    path === "/app" ? "/" : path.startsWith("/app/") ? path.slice(4) : path;
  const logical =
    unprefixed.length > 1 && unprefixed.endsWith("/")
      ? unprefixed.slice(0, -1)
      : unprefixed;
  if (logical === "/") return logical;
  if (/\s/.test(logical)) return null;
  const segments = logical.slice(1).split("/");
  if (segments.length === 1 && pages.has(segments[0])) return logical;
  if (
    segments.length !== 2 ||
    !collections.has(segments[0]) ||
    !segments[1] ||
    /%(?:2f|5c|2e|25)/i.test(segments[1])
  )
    return null;
  try {
    const identifier = decodeURIComponent(segments[1]);
    return identifier !== "." &&
      identifier !== ".." &&
      !/[\\/\u0000-\u001f\u007f]/.test(identifier)
      ? logical
      : null;
  } catch {
    return null;
  }
}

/** Application navigation only. Public pages, API paths and external URLs are not app routes. */
export function appHref(href: string): string {
  const parsed = parts(href);
  const logical = parsed && logicalPath(parsed.path);
  if (!parsed || logical === null)
    throw new TypeError("Expected an internal application route");
  return `${logical === "/" ? "/app" : `/app${logical}`}${parsed.suffix}`;
}

/** Classify pathnames for UI selection and the bundled router, without making auth decisions. */
export function appPathname(pathname: string): string {
  const parsed = parts(pathname);
  const logical = parsed && logicalPath(parsed.path);
  return parsed && logical !== null ? logical + parsed.suffix : pathname;
}
