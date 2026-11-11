"use client";
import { appHref } from "@/lib/app-navigation";
import Link from "next/link";
import Image from "next/image";
import { Play, ArrowUpRight, ChevronRight, Heart } from "lucide-react";
import type { MusicPlaylist, Track } from "@aurelia/core";
import { useApp } from "./app-context";
import { TrackList } from "./track-list";
import { DiscoveryHome } from "./discovery-home";
import { trackCollection } from "./discovery-presets";
const PLAYLIST_ARTWORK: Record<string, string> = {
  "golden-hour": "/art/listening/warm-evening.webp",
  "night-swim": "/art/listening/night-city.webp",
  "deep-focus": "/art/listening/deep-focus.webp",
  "slow-sundays": "/art/listening/slow-sundays.webp",
};
export function playlistArtwork(playlist: MusicPlaylist) {
  return PLAYLIST_ARTWORK[playlist.id] ?? playlist.artwork;
}
export function PlaylistCard({ playlist }: { playlist: MusicPlaylist }) {
  const { player } = useApp();
  return (
    <article className="album-card">
      <div className="album-image">
        <Link href={appHref(`/mix/${encodeURIComponent(playlist.id)}`)}>
          <Image
            src={playlistArtwork(playlist)}
            alt={playlist.name}
            width={400}
            height={400}
          />
        </Link>
        <button
          className="card-play"
          aria-label={`Play ${playlist.name}`}
          onClick={() =>
            player.dispatch({ type: "play", tracks: playlist.tracks })
          }
        >
          <Play size={22} fill="currentColor" />
        </button>
      </div>
      <Link
        href={appHref(`/mix/${encodeURIComponent(playlist.id)}`)}
        className="card-title"
      >
        {playlist.name}
      </Link>
      <p>{playlist.description}</p>
    </article>
  );
}
export function TrackCard({
  track,
  reason,
  collection,
}: {
  track: Track;
  reason?: string;
  collection?: readonly Track[];
}) {
  const { player } = useApp();
  const play = () =>
    player.dispatch({ type: "play", ...trackCollection(track, collection) });
  return (
    <article className="album-card">
      <div className="album-image">
        <button
          className="art-button"
          onClick={play}
          aria-label={`Play ${track.title}`}
        >
          <Image
            src={track.artwork}
            alt={track.album}
            width={400}
            height={400}
          />
          <span className="card-play">
            <Play size={22} fill="currentColor" />
          </span>
        </button>
      </div>
      <button className="card-title text-button" onClick={play}>
        {track.title}
      </button>
      <p>{reason ?? track.artist}</p>
    </article>
  );
}
export function SectionHeader({
  eyebrow,
  title,
  href,
  label = "Explore all",
}: {
  eyebrow?: string;
  title: string;
  href?: string;
  label?: string;
}) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
      </div>
      {href && (
        <Link href={appHref(href)}>
          {label}
          <ChevronRight size={16} />
        </Link>
      )}
    </div>
  );
}
export function Home() {
  const { data } = useApp();
  return data.capabilities.demoCatalogue ? <StudioHome /> : <DiscoveryHome />;
}
function StudioHome() {
  const { data, player, loading } = useApp();
  const recent = [
    ...new Map(
      (data.library?.history ?? []).map((entry) => [
        entry.track.id,
        entry.track,
      ]),
    ).values(),
  ];
  const quickMixes = ["night-swim", "golden-hour", "deep-focus"].flatMap((id) =>
    data.editorialPlaylists.filter((mix) => mix.id === id),
  );
  const firstMix = data.editorialPlaylists[0];
  const recommendations = data.recommendations.map((entry) => entry.track);
  const listening = recent.length
    ? recent
    : recommendations.length
      ? recommendations
      : data.catalogue;
  return (
    <div className="page home-page listening-home">
      <div className="page-heading">
        <div>
          <h1>For you</h1>
        </div>
      </div>
      <nav className="listening-shortcuts" aria-label="Quick listening">
        <Link className="listening-shortcut" href={appHref("/liked")}>
          <span className="listening-liked-art">
            <Heart size={23} fill="currentColor" />
          </span>
          <span>Liked songs</span>
          <ChevronRight size={18} aria-hidden="true" />
        </Link>
        {quickMixes.map((mix) => (
          <Link
            className="listening-shortcut"
            key={mix.id}
            href={appHref(`/mix/${encodeURIComponent(mix.id)}`)}
          >
            <Image src={playlistArtwork(mix)} alt="" width={56} height={56} />
            <span>{mix.name}</span>
            <ChevronRight size={18} aria-hidden="true" />
          </Link>
        ))}
      </nav>
      <section className="listening-mixes">
        <div className="section-heading">
          <h2>Your mixes</h2>
          {firstMix && (
            <button
              className="button primary small"
              aria-label={`Play ${firstMix.name.toLowerCase()}`}
              onClick={() =>
                player.dispatch({ type: "play", tracks: firstMix.tracks })
              }
            >
              <Play size={16} fill="currentColor" />
              Play mix
            </button>
          )}
        </div>
        {data.editorialPlaylists.length ? (
          <div className="listening-grid listening-featured-grid">
            {data.editorialPlaylists.slice(0, 2).map((mix) => (
              <PlaylistCard key={mix.id} playlist={mix} />
            ))}
          </div>
        ) : (
          <p className="muted">
            Your next mix starts with a song.{" "}
            <Link href={appHref("/search")}>Find some music</Link>.
          </p>
        )}
      </section>
      <section className="continue-list">
        <SectionHeader
          title={recent.length ? "Continue listening" : "Start listening"}
          href={appHref(recent.length ? "/history" : "/recommendations")}
          label={recent.length ? "History" : "Made for you"}
        />
        {loading ? (
          <div className="skeleton-grid" aria-label="Loading recommendations">
            {[0, 1].map((index) => (
              <div className="skeleton" key={index} />
            ))}
          </div>
        ) : (
          <TrackList
            tracks={listening.slice(0, recent.length ? 3 : 5)}
            compact
          />
        )}
      </section>
      {data.editorialPlaylists.length > 2 && (
        <section>
          <SectionHeader title="More to explore" />
          <div className="listening-grid">
            {data.editorialPlaylists.slice(2).map((mix) => (
              <PlaylistCard key={mix.id} playlist={mix} />
            ))}
          </div>
        </section>
      )}
      <div className="catalogue-note">
        <p>
          Keep the music you love together. Search for a song, save it, make it
          yours.
        </p>
        <Link href={appHref("/search")}>
          Find your music
          <ArrowUpRight size={15} />
        </Link>
      </div>
    </div>
  );
}
