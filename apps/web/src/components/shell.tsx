"use client";
import { appHref, appPathname } from "@/lib/app-navigation";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  House,
  Search,
  Library,
  Heart,
  Plus,
  ArrowDownToLine,
  Settings,
  History,
  Compass,
  ChevronLeft,
  ChevronRight,
  AudioLines,
  ArrowUpRight,
  WifiOff,
} from "lucide-react";
import { useApp } from "./app-context";
import { PlayerBar } from "./player-bar";
import { YouTubePlayer } from "./youtube-player";
import { Dialog } from "./dialog";
import { ViewportMetrics } from "./viewport-metrics";
const nav = [
  { href: "/", label: "Home", icon: House },
  { href: "/search", label: "Search", icon: Search },
  { href: "/library", label: "Your library", icon: Library },
];
export function Shell({ children }: { children: ReactNode }) {
  const pathname = appPathname(usePathname());
  useEffect(() => {
    // Next's window scroll handling does not reset our independent main scroller.
    document.getElementById("main-content")?.scrollTo({ top: 0, left: 0 });
  }, [pathname]);
  const router = useRouter();
  const { data, openAuth, ensureAccount, createPlaylist, error, refresh } =
    useApp();
  const [create, setCreate] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const dock = useRef<HTMLDivElement>(null);
  return (
    <div className="app-shell" lang="en">
      <ViewportMetrics dock={dock} />
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link className="brand" href={appHref("/")}>
          <AudioLines size={31} strokeWidth={1.8} />
          <span>
            aurelia<span className="brand-dot">.</span>
          </span>
        </Link>
        <div className="sidebar-caption">YOUR DAILY SOUNDTRACK</div>
        <nav className="primary-nav" aria-label="Main navigation">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={appHref(item.href)}
              aria-current={pathname === item.href ? "page" : undefined}
              className={pathname === item.href ? "selected" : ""}
            >
              <item.icon size={21} />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-section">
          <span>COLLECTION</span>
          <button
            className="icon-button"
            aria-label="Create playlist"
            onClick={() => {
              if (ensureAccount()) setCreate(true);
            }}
          >
            <Plus size={17} />
          </button>
        </div>
        <nav className="collection-nav" aria-label="Collection">
          <Link
            href={appHref("/liked")}
            className={pathname === "/liked" ? "selected" : ""}
          >
            <span className="liked-icon">
              <Heart size={17} fill="currentColor" />
            </span>
            Liked songs <small>{data.library?.likes.length ?? 0}</small>
          </Link>
          <Link href={appHref("/history")}>
            <History size={19} />
            Recently played
          </Link>
          <Link href={appHref("/recommendations")}>
            <Compass size={19} />
            Made for you
          </Link>
          {data.library?.playlists.map((p) => (
            <Link
              href={appHref(`/playlist/${encodeURIComponent(p.id)}`)}
              key={p.id}
            >
              <span className="playlist-dot" />
              {p.name}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="import-prompt">
            <ArrowDownToLine size={20} />
            <strong>Bring your music home.</strong>
            <p>Your favorites deserve a new place to play.</p>
            <Link href={appHref("/import")}>
              Import your library <ArrowUpRight size={15} />
            </Link>
          </div>
          <Link href={appHref("/settings")} className="settings-link">
            <Settings size={18} />
            Settings
          </Link>
          <span className="sidebar-footer">A little closer to the music.</span>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="history-nav">
            <button
              className="icon-button"
              aria-label="Go back"
              onClick={() => router.back()}
            >
              <ChevronLeft size={20} />
            </button>
            <button
              className="icon-button"
              aria-label="Go forward"
              onClick={() => router.forward()}
            >
              <ChevronRight size={20} />
            </button>
          </div>
          <Link
            className="topbar-wordmark"
            href={appHref("/")}
            aria-label="Aurelia home"
          >
            aurelia<span>.</span>
          </Link>
          <Link href={appHref("/search")} className="topbar-search">
            <Search size={17} />
            <span>Find your next favorite</span>
            <kbd>⌕</kbd>
          </Link>
          <div className="topbar-account">
            <Link
              className="icon-button topbar-settings"
              href={appHref("/settings")}
              aria-label="Settings"
            >
              <Settings size={20} />
            </Link>
            <span className="studio-tag">
              <i />
              STUDIO EDITION
            </span>
            {data.user ? (
              <Link
                className="avatar"
                href={appHref("/account")}
                aria-label="Your account"
              >
                {data.user.name.slice(0, 1).toUpperCase()}
              </Link>
            ) : (
              <button className="button secondary small" onClick={openAuth}>
                Sign in
              </button>
            )}
          </div>
        </header>
        {error && (
          <div className="network-banner" role="alert">
            <WifiOff size={18} />
            {error}
            <button onClick={() => void refresh()}>Retry</button>
          </div>
        )}
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
      <div className="playback-dock" ref={dock}>
        <YouTubePlayer />
        <PlayerBar />
        <nav className="mobile-nav" aria-label="Mobile navigation">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={appHref(item.href)}
              aria-current={pathname === item.href ? "page" : undefined}
              className={pathname === item.href ? "selected" : ""}
            >
              <item.icon size={22} aria-hidden="true" />
              <span>
                {item.label === "Your library" ? "Library" : item.label}
              </span>
            </Link>
          ))}
        </nav>
      </div>
      {create && (
        <Dialog
          title="A new playlist, a new mood"
          onClose={() => setCreate(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const id = await createPlaylist(name);
              setBusy(false);
              if (id) {
                setCreate(false);
                setName("");
                router.push(appHref(`/playlist/${encodeURIComponent(id)}`));
              }
            }}
          >
            <label>
              Playlist name
              <input
                autoFocus
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                placeholder="Late nights, long drives…"
              />
            </label>
            <button className="button primary wide" disabled={busy}>
              Create playlist
            </button>
          </form>
        </Dialog>
      )}
    </div>
  );
}
