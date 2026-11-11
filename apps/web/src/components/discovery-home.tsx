"use client";
import { appHref } from "@/lib/app-navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, ChevronRight, Heart } from "lucide-react";
import { DiscoveryPageSchema, type DiscoveryPage } from "@aurelia/core";
import type { RankedTrack } from "@aurelia/recommendations";
import { api } from "@/lib/client-api";
import {
  captureApiAccountScope,
  apiAccountScopeCurrent,
  type ApiAccountScope,
} from "@/lib/client-account";
import { useApp } from "./app-context";
import { TrackList } from "./track-list";
import {
  moodSearchHref,
  moodSearchPresets,
  visibleDiscoveryTracks,
} from "./discovery-presets";

interface RecommendationFeed {
  scope: ApiAccountScope;
  owner: string | null;
  attempt: number;
  entries: RankedTrack[] | null;
  loading: boolean;
  failed: boolean;
}

/** Account/epoch checks also reject late results after sign-out and sign-in to the same account. */
export function useRecommendationFeed(owner: string | null) {
  const accountEpoch = captureApiAccountScope().epoch;
  const [attempt, setAttempt] = useState(0);
  const [feed, setFeed] = useState<RecommendationFeed | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const scope = captureApiAccountScope();
    if (!owner) return () => controller.abort();
    const current = () =>
      !controller.signal.aborted && apiAccountScopeCurrent(scope);
    setFeed({
      scope,
      owner,
      attempt,
      entries: null,
      loading: true,
      failed: false,
    });
    void api<RankedTrack[]>("recommendations", { signal: controller.signal })
      .then((entries) => {
        if (current())
          setFeed({
            scope,
            owner,
            attempt,
            entries,
            loading: false,
            failed: false,
          });
      })
      .catch(() => {
        if (current())
          setFeed({
            scope,
            owner,
            attempt,
            entries: null,
            loading: false,
            failed: true,
          });
      });
    return () => controller.abort();
  }, [owner, attempt, accountEpoch]);
  const current =
    feed?.owner === owner &&
    feed.attempt === attempt &&
    apiAccountScopeCurrent(feed.scope)
      ? feed
      : null;
  return {
    entries: current?.entries ?? null,
    loading: Boolean(owner) && (current?.loading ?? true),
    failed: current?.failed ?? false,
    refresh: () => setAttempt((value) => value + 1),
  };
}

interface DiscoveryFeed {
  scope: ApiAccountScope;
  owner: string | null;
  attempt: number;
  page: DiscoveryPage | null;
  loading: boolean;
  failed: boolean;
}

export function DiscoveryHome() {
  const { data } = useApp();
  const router = useRouter();
  const owner = data.user?.id ?? null;
  const accountEpoch = captureApiAccountScope().epoch;
  const personal = useRecommendationFeed(owner);
  const [attempt, setAttempt] = useState(0);
  const [feed, setFeed] = useState<DiscoveryFeed | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const scope = captureApiAccountScope();
    const current = () =>
      !controller.signal.aborted && apiAccountScopeCurrent(scope);
    setFeed({
      scope,
      owner,
      attempt,
      page: null,
      loading: true,
      failed: false,
    });
    void api<DiscoveryPage>("discovery", { signal: controller.signal })
      .then((result) => DiscoveryPageSchema.parse(result))
      .then((page) => {
        if (current())
          setFeed({
            scope,
            owner,
            attempt,
            page,
            loading: false,
            failed: false,
          });
      })
      .catch(() => {
        if (current())
          setFeed({
            scope,
            owner,
            attempt,
            page: null,
            loading: false,
            failed: true,
          });
      });
    return () => controller.abort();
  }, [owner, attempt, accountEpoch]);
  const current =
    feed?.owner === owner &&
    feed.attempt === attempt &&
    apiAccountScopeCurrent(feed.scope)
      ? feed
      : null;
  const recent = visibleDiscoveryTracks(
    (data.library?.history ?? []).map((entry) => entry.track),
  ).slice(0, 3);
  const recommendations = visibleDiscoveryTracks(
    (personal.entries ?? data.recommendations).map((entry) => entry.track),
  ).slice(0, 8);
  const sections = (current?.page?.sections ?? [])
    .map((section) => ({
      ...section,
      tracks: visibleDiscoveryTracks(section.tracks),
    }))
    .filter((section) => section.tracks.length > 0);
  return (
    <div className="page home-page listening-home">
      <div className="page-heading">
        <h1>For you</h1>
      </div>
      <nav className="listening-shortcuts" aria-label="Quick listening">
        <Link className="listening-shortcut" href={appHref("/liked")}>
          <span className="listening-liked-art">
            <Heart size={23} fill="currentColor" />
          </span>
          <span>Liked songs</span>
          <ChevronRight size={18} aria-hidden="true" />
        </Link>
        <Link className="listening-shortcut" href={appHref("/library")}>
          <span>Your library</span>
          <ChevronRight size={18} aria-hidden="true" />
        </Link>
      </nav>
      {recent.length > 0 && (
        <section className="continue-list">
          <div className="section-heading">
            <h2>Continue listening</h2>
            <Link href={appHref("/history")}>
              History
              <ChevronRight size={16} />
            </Link>
          </div>
          <TrackList tracks={recent} compact />
        </section>
      )}
      <section>
        <div className="section-heading">
          <h2>Search by mood</h2>
        </div>
        <p className="muted">A starting point for your next YouTube search.</p>
        <div className="mood-grid">
          {moodSearchPresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => router.push(appHref(moodSearchHref(preset.query)))}
              style={{
                backgroundImage: `linear-gradient(90deg, #161917bb, #16191722),url(${preset.artwork})`,
              }}
            >
              <span>{preset.caption}</span>
              <strong>{preset.title}</strong>
              <ArrowUpRight size={22} aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>
      {owner && (
        <section>
          <div className="section-heading">
            <h2>Around your favorites</h2>
            <button
              type="button"
              className="button secondary small"
              disabled={personal.loading}
              onClick={personal.refresh}
            >
              Refresh recommendations
            </button>
          </div>
          {personal.loading && (
            <p className="muted" role="status">
              Finding music around your favorites…
            </p>
          )}
          {personal.failed && (
            <p className="muted" role="status">
              Recommendations are unavailable. Your saved music is still in your
              library.
            </p>
          )}
          {recommendations.length ? (
            <TrackList tracks={recommendations} />
          ) : (
            !personal.loading && (
              <p className="muted">
                Like a song or play something you enjoy to shape your
                recommendations.
              </p>
            )
          )}
        </section>
      )}
      <section aria-busy={current?.loading ?? true}>
        <div className="section-heading">
          <h2>Explore YouTube Music</h2>
          <button
            type="button"
            className="button secondary small"
            disabled={current?.loading ?? true}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Refresh discoveries
          </button>
        </div>
        {(current?.loading ?? true) ? (
          <p className="muted" role="status">
            Loading YouTube Music discoveries…
          </p>
        ) : current?.failed ? (
          <div className="empty-state" role="status">
            <h3>Discoveries are unavailable</h3>
            <p>Check your connection and try again, or search for a song.</p>
            <button
              className="button secondary"
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        ) : sections.length ? (
          <>
            <p className="source-notice">
              From YouTube Music
              {current?.page && (
                <>
                  {" "}
                  · Fetched {new Date(current.page.fetchedAt).toLocaleString()}
                </>
              )}
            </p>
            {sections.map((section) => (
              <section key={section.id}>
                <div className="section-heading">
                  <h3>{section.title}</h3>
                </div>
                <TrackList tracks={section.tracks} />
              </section>
            ))}
          </>
        ) : (
          <p className="muted" role="status">
            No discoveries are available right now. Try a mood or{" "}
            <Link href={appHref("/search")}>search for music</Link>.
          </p>
        )}
      </section>
    </div>
  );
}
