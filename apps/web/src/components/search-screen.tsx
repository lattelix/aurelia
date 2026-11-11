"use client";
import { appHref } from "@/lib/app-navigation";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { Search, X, Clock3, Play, ArrowUpRight } from "lucide-react";
import type { SearchResult } from "@aurelia/core";
import { api } from "@/lib/client-api";
import {
  captureApiAccountScope,
  apiAccountScopeCurrent,
} from "@/lib/client-account";
import { useApp } from "./app-context";
import { TrackList } from "./track-list";
import { PlaylistCard } from "./home";
import {
  moodSearchPresets,
  searchQueryFromUrl,
  visibleDiscoveryTracks,
} from "./discovery-presets";
export function SearchScreen() {
  return (
    <Suspense
      fallback={
        <p className="page muted" role="status">
          Loading search…
        </p>
      }
    >
      <SearchContent />
    </Suspense>
  );
}
interface SearchState {
  key: string;
  result: SearchResult | null;
  busy: boolean;
  error: string;
  suggestions: string[];
}
function SearchContent() {
  const { data, player, ensureAccount } = useApp();
  const params = useSearchParams();
  const urlQuery = params.get("q");
  const demoCatalogue = data.capabilities.demoCatalogue === true;
  const owner = data.user?.id ?? null;
  const accountScope = captureApiAccountScope();
  const accountKey = `${owner ?? "guest"}:${accountScope.epoch}`;
  const [query, setQuery] = useState("");
  const [selectedSource, setSource] = useState("youtube");
  const source = demoCatalogue ? selectedSource : "youtube";
  const [tab, setTab] = useState("All");
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState<SearchState | null>(null);
  const [savedSearches, setSavedSearches] = useState<{
    key: string;
    values: string[];
  } | null>(null);
  const requestKey = JSON.stringify([accountKey, query, source, attempt]);
  const current = search?.key === requestKey ? search : null;
  const rawResult = current?.result;
  const result =
    rawResult && (demoCatalogue || rawResult.source === "youtube")
      ? {
          ...rawResult,
          tracks: visibleDiscoveryTracks(rawResult.tracks, demoCatalogue),
          albums: demoCatalogue ? rawResult.albums : [],
          artists: demoCatalogue ? rawResult.artists : [],
          playlists: demoCatalogue ? rawResult.playlists : [],
        }
      : null;
  const busy = Boolean(query.trim()) && (current?.busy ?? true);
  const error = current?.error ?? "";
  const suggestions = current?.suggestions ?? [];
  const recent = savedSearches?.key === accountKey ? savedSearches.values : [];
  useEffect(() => {
    setQuery(searchQueryFromUrl(urlQuery));
    setSource("youtube");
    setTab("All");
  }, [urlQuery]);
  useEffect(() => {
    try {
      const parsed: unknown = JSON.parse(
        localStorage.getItem(`aurelia.search.${owner ?? "guest"}`) ?? "[]",
      );
      const values = Array.isArray(parsed)
        ? parsed
            .filter(
              (value): value is string =>
                typeof value === "string" &&
                value.length > 0 &&
                value.length <= 200,
            )
            .slice(0, 8)
        : [];
      setSavedSearches({ key: accountKey, values });
    } catch {
      setSavedSearches({ key: accountKey, values: [] });
    }
  }, [owner, accountKey]);
  useEffect(() => {
    if (!query.trim()) {
      return;
    }
    const controller = new AbortController();
    const scope = captureApiAccountScope();
    const update = (value: Partial<SearchState>) => {
      if (!controller.signal.aborted && apiAccountScopeCurrent(scope))
        setSearch((previous) =>
          previous?.key === requestKey ? { ...previous, ...value } : previous,
        );
    };
    setSearch({
      key: requestKey,
      result: null,
      busy: true,
      error: "",
      suggestions: [],
    });
    const timer = setTimeout(
      () => {
        void api<SearchResult>(
          `search?q=${encodeURIComponent(query)}&provider=${source}`,
          { signal: controller.signal },
        )
          .then((result) => update({ result }))
          .catch((e) => {
            update({
              result: null,
              error:
                e instanceof Error
                  ? e.message
                  : "Search is unavailable. Try again.",
            });
          })
          .finally(() => update({ busy: false }));
        if (source === "studio")
          void api<{ suggestions: string[] }>(
            `autocomplete?q=${encodeURIComponent(query)}`,
            { signal: controller.signal },
          )
            .then((r) => update({ suggestions: r.suggestions }))
            .catch(() => {});
      },
      source === "youtube" ? 700 : 250,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, source, requestKey]);
  function remember() {
    if (!query.trim()) return;
    const searches = [query, ...recent.filter((x) => x !== query)].slice(0, 8);
    setSavedSearches({ key: accountKey, values: searches });
    try {
      localStorage.setItem(
        `aurelia.search.${owner ?? "guest"}`,
        JSON.stringify(searches),
      );
    } catch {
      /* Search remains usable without storage. */
    }
    if (data.user)
      void api("library/signals", {
        method: "POST",
        body: JSON.stringify({ kind: "search", query }),
      }).catch(() => {});
  }
  const top = result?.tracks[0];
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">FOLLOW YOUR CURIOSITY</span>
          <h1>What’s your next favorite?</h1>
        </div>
      </div>
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          remember();
        }}
      >
        <Search size={23} />
        <input
          aria-label="Search music"
          placeholder={
            source === "youtube"
              ? data.capabilities.youtube
                ? "Song, artist, or YouTube video link…"
                : "Paste a YouTube video link…"
              : "Songs, artists, albums, a feeling…"
          }
          aria-describedby={
            source === "youtube" ? "youtube-search-help" : undefined
          }
          autoComplete="off"
          value={query}
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            className="icon-button"
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery("")}
          >
            <X size={21} />
          </button>
        )}
        <button className="button primary small" type="submit">
          Search
        </button>
      </form>
      {demoCatalogue && (
        <div className="search-sources">
          <button
            className={source === "studio" ? "selected" : ""}
            onClick={() => setSource("studio")}
          >
            Studio catalogue
          </button>
          <button
            className={source === "youtube" ? "selected" : ""}
            onClick={() => setSource("youtube")}
          >
            YouTube <ArrowUpRight size={14} />
          </button>
        </div>
      )}
      {source === "youtube" && (
        <p className="source-notice" id="youtube-search-help">
          Search for a song or artist, or paste a YouTube link. Listen, watch
          the video from the player, and save discoveries to Likes or a
          playlist.
          {!data.capabilities.youtube &&
            " Search by song title is not connected yet."}
        </p>
      )}
      {!query && (
        <>
          {recent.length > 0 && (
            <section>
              <h2>Recent searches</h2>
              <div className="recent-searches">
                {recent.map((text) => (
                  <button key={text} onClick={() => setQuery(text)}>
                    <Clock3 size={15} />
                    {text}
                  </button>
                ))}
                <button
                  className="muted"
                  onClick={() => {
                    setSavedSearches({ key: accountKey, values: [] });
                    try {
                      localStorage.removeItem(
                        `aurelia.search.${owner ?? "guest"}`,
                      );
                    } catch {
                      /* Optional browser storage. */
                    }
                  }}
                >
                  Clear
                </button>
              </div>
            </section>
          )}
          <section>
            <div className="section-heading">
              <h2>Search by mood</h2>
            </div>
            <p className="muted">
              A starting point for your next YouTube search.
            </p>
            <div className="mood-grid">
              {moodSearchPresets.map((preset) => (
                <button
                  type="button"
                  key={preset.id}
                  onClick={() => {
                    setSource("youtube");
                    setQuery(preset.query);
                    setTab("All");
                  }}
                  style={{
                    backgroundImage: `linear-gradient(90deg, #161917bb, #16191722),url(${preset.artwork})`,
                  }}
                >
                  <span>{preset.caption}</span>
                  <strong>{preset.title}</strong>
                  <ArrowUpRight size={22} />
                </button>
              ))}
            </div>
          </section>
          {demoCatalogue && (
            <section>
              <div className="section-heading">
                <h2>Start here</h2>
              </div>
              <TrackList tracks={data.catalogue.slice(0, 5)} />
            </section>
          )}
          {!data.user && (
            <button className="text-button muted" onClick={ensureAccount}>
              Sign in to keep your discoveries
            </button>
          )}
        </>
      )}
      {query && (
        <>
          <div className="filter-tabs">
            {(demoCatalogue
              ? ["All", "Songs", "Albums", "Artists", "Playlists"]
              : ["All", "Songs"]
            ).map((t) => (
              <button
                className={tab === t ? "selected" : ""}
                key={t}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          {suggestions.length > 0 && (
            <div className="suggestions" aria-label="Search suggestions">
              {suggestions.slice(0, 3).map((text) => (
                <button key={text} onClick={() => setQuery(text)}>
                  {text}
                </button>
              ))}
            </div>
          )}
          {busy ? (
            <div className="skeleton-grid" aria-label="Searching">
              <div className="skeleton" />
              <div className="skeleton" />
              <div className="skeleton" />
            </div>
          ) : error ? (
            <div className="empty-state" role="alert">
              <Search size={32} />
              <h3>We couldn’t search there yet</h3>
              <p>{error}</p>
              {demoCatalogue ? (
                <button
                  className="button secondary"
                  onClick={() => setSource("studio")}
                >
                  Search the studio catalogue
                </button>
              ) : (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Try again
                </button>
              )}
            </div>
          ) : (
            result && (
              <>
                {result.notice && (
                  <p className="source-notice">{result.notice}</p>
                )}
                {tab === "All" && top && (
                  <section className="top-result">
                    <Image
                      src={top.artwork}
                      alt={top.album}
                      width={120}
                      height={120}
                    />
                    <div>
                      <span className="eyebrow">
                        TOP RESULT{source === "youtube" ? " · YOUTUBE" : ""}
                      </span>
                      <h2>{top.title}</h2>
                      <p>{top.artist}</p>
                    </div>
                    <button
                      className="card-play"
                      aria-label={`Play top result ${top.title}`}
                      onClick={() => {
                        remember();
                        player.dispatch({
                          type: "play",
                          tracks: result.tracks,
                        });
                      }}
                    >
                      <Play size={25} fill="currentColor" />
                    </button>
                  </section>
                )}
                {["All", "Songs"].includes(tab) && (
                  <section>
                    <h2>Songs</h2>
                    <TrackList tracks={result.tracks} />
                  </section>
                )}
                {["All", "Albums"].includes(tab) &&
                  result.albums.length > 0 && (
                    <section>
                      <h2>Albums</h2>
                      <div className="album-grid">
                        {result.albums.map((a) => (
                          <article className="album-card" key={a.id}>
                            <Link
                              href={appHref(
                                `/album/${encodeURIComponent(a.id)}`,
                              )}
                            >
                              <Image
                                src={a.artwork}
                                alt={a.title}
                                width={300}
                                height={300}
                              />
                              <h3>{a.title}</h3>
                              <p>{a.artist}</p>
                            </Link>
                          </article>
                        ))}
                      </div>
                    </section>
                  )}
                {["All", "Artists"].includes(tab) &&
                  result.artists.map((a) => (
                    <Link
                      className="artist-result"
                      key={a.id}
                      href={appHref(`/artist/${encodeURIComponent(a.id)}`)}
                    >
                      <Image src={a.artwork} alt="" width={70} height={70} />
                      <span>
                        <strong>{a.name}</strong>
                        <small>Artist</small>
                      </span>
                    </Link>
                  ))}
                {["All", "Playlists"].includes(tab) &&
                  result.playlists.length > 0 && (
                    <div className="album-grid">
                      {result.playlists.map((p) => (
                        <PlaylistCard key={p.id} playlist={p} />
                      ))}
                    </div>
                  )}
                {!top &&
                  result.albums.length === 0 &&
                  result.artists.length === 0 &&
                  result.playlists.length === 0 && (
                    <div className="empty-state">
                      <Search size={36} />
                      <h3>Nothing here just yet</h3>
                      <p>Try a different title, artist, or mood.</p>
                    </div>
                  )}
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
