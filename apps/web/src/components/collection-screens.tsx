"use client";
import { appHref } from "@/lib/app-navigation";
import Link from "next/link";
import Image from "next/image";
import { useId, useState } from "react";
import type { RankedTrack } from "@aurelia/recommendations";
import { useRouter } from "next/navigation";
import {
  Play,
  Plus,
  Heart,
  Music2,
  ArrowUpRight,
  Trash2,
  ArrowUp,
  ArrowDown,
  X,
  ListMusic,
  Clock3,
} from "lucide-react";
import { useApp, usePlayer } from "./app-context";
import { TrackList } from "./track-list";
import { Dialog } from "./dialog";
import { SectionHeader, TrackCard, playlistArtwork } from "./home";
import { useRecommendationFeed } from "./discovery-home";
import { visibleDiscoveryTracks } from "./discovery-presets";
import {
  captureApiAccountScope,
  apiAccountScopeCurrent,
} from "@/lib/client-account";
import {
  PlaylistEditorDialog,
  PlaylistOrderDialog,
  PlaylistDeleteDialog,
  PlaylistViewControls,
} from "./playlist-controls";
import {
  playlistView,
  playlistTrackView,
  type PlaylistSort,
  type PlaylistTrackSort,
} from "./playlist-view";
export function LibraryScreen() {
  const { data, ensureAccount, createPlaylist } = useApp();
  const [tab, setTab] = useState("Playlists");
  const [createScope, setCreateScope] = useState<ReturnType<
    typeof captureApiAccountScope
  > | null>(null);
  const scope = captureApiAccountScope();
  const viewKey = `${data.user?.id ?? "guest"}:${scope.epoch}`;
  const [view, setView] = useState<{
    key: string;
    query: string;
    sort: PlaylistSort;
  }>({ key: "", query: "", sort: "recent" });
  const query = view.key === viewKey ? view.query : "";
  const sort = view.key === viewKey ? view.sort : "recent";
  const playlists = playlistView(data.library?.playlists ?? [], query, sort);
  const openCreate = () => {
    if (ensureAccount()) setCreateScope(captureApiAccountScope());
  };
  const router = useRouter();
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">ALL THE MUSIC THAT’S YOURS</span>
          <h1>Your library</h1>
        </div>
        <button className="button secondary" onClick={openCreate}>
          <Plus size={18} />
          New playlist
        </button>
      </div>
      <div className="filter-tabs">
        {["Playlists", "Albums", "Artists"].map((t) => (
          <button
            key={t}
            className={t === tab ? "selected" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "Playlists" && (
        <>
          <PlaylistViewControls
            query={query}
            sort={sort}
            onQuery={(value) => setView({ key: viewKey, query: value, sort })}
            onSort={(value) =>
              setView({ key: viewKey, query, sort: value as PlaylistSort })
            }
          />
          {query.trim() && !playlists.length && (
            <p className="muted" role="status">
              No playlists match your filter.{" "}
              <button
                type="button"
                className="text-button"
                onClick={() => setView({ key: viewKey, query: "", sort })}
              >
                Clear filter
              </button>
            </p>
          )}
          <div className="album-grid library-grid">
            <Link href={appHref("/liked")} className="album-card">
              <div className="liked-cover">
                <Heart size={64} fill="currentColor" />
              </div>
              <h3>Liked songs</h3>
              <p>
                {data.library?.likes.length ?? 0} songs · All your favorites
              </p>
            </Link>
            {playlists.map((p) => (
              <Link
                href={appHref(`/playlist/${encodeURIComponent(p.id)}`)}
                className="album-card"
                key={p.id}
              >
                <div className="playlist-cover">
                  {p.tracks[0] ? (
                    <Image
                      src={p.tracks[0].artwork}
                      alt=""
                      width={400}
                      height={400}
                    />
                  ) : (
                    <Music2 size={58} />
                  )}
                </div>
                <h3>{p.name}</h3>
                <p>{p.tracks.length} songs · Your playlist</p>
              </Link>
            ))}
            <button className="new-playlist-card" onClick={openCreate}>
              <Plus size={35} />
              <strong>A new mood starts here</strong>
              <span>
                {data.library?.playlists.length
                  ? "Create a playlist"
                  : "Create your first playlist"}
              </span>
            </button>
          </div>
        </>
      )}
      {tab === "Albums" && (
        <div className="album-grid">
          {data.albums
            .filter(
              (a) =>
                data.library?.likes.some((t) => t.albumId === a.id) ||
                data.library?.playlists.some((p) =>
                  p.tracks.some((t) => t.albumId === a.id),
                ),
            )
            .map((a) => (
              <Link
                className="album-card"
                key={a.id}
                href={appHref(`/album/${encodeURIComponent(a.id)}`)}
              >
                <Image src={a.artwork} alt={a.title} width={400} height={400} />
                <h3>{a.title}</h3>
                <p>{a.artist}</p>
              </Link>
            ))}
        </div>
      )}
      {tab === "Artists" && (
        <div className="album-grid">
          {data.artists
            .filter((a) =>
              data.library?.followedArtists.includes(`studio:${a.id}`),
            )
            .map((a) => (
              <Link
                className="album-card artist-card"
                href={appHref(`/artist/${encodeURIComponent(a.id)}`)}
                key={a.id}
              >
                <Image src={a.artwork} alt={a.name} width={400} height={400} />
                <h3>{a.name}</h3>
                <p>Artist</p>
              </Link>
            ))}
        </div>
      )}
      {tab !== "Playlists" && (
        <p className="muted">
          {tab === "Albums"
            ? "Albums you like or add to a playlist appear here."
            : "Follow an artist to keep them close."}{" "}
          <Link href={appHref("/search")}>Discover music</Link>
        </p>
      )}
      <Link className="import-library-link" href={appHref("/import")}>
        Your music lives somewhere else?
        <span>
          Bring it with you
          <ArrowUpRight size={16} />
        </span>
      </Link>
      {createScope && apiAccountScopeCurrent(createScope) && (
        <PlaylistEditorDialog
          onClose={() => setCreateScope(null)}
          onSave={async ({ name, description }) =>
            (await createPlaylist(name, description)) ?? false
          }
          onSaved={(result) => {
            if (typeof result === "string")
              router.push(appHref(`/playlist/${encodeURIComponent(result)}`));
          }}
        />
      )}
    </div>
  );
}
export function DetailScreen({
  kind,
  id,
}: {
  kind: "playlist" | "mix" | "album" | "artist" | "liked";
  id?: string;
}) {
  const {
    data,
    player,
    mutation,
    toast,
    updatePlaylist,
    reorderPlaylist,
    refresh,
  } = useApp();
  const router = useRouter();
  const helpId = useId();
  const scope = captureApiAccountScope();
  const viewKey = `${scope.epoch}:${kind}:${id ?? ""}`;
  const [view, setView] = useState<{
    key: string;
    query: string;
    sort: PlaylistTrackSort;
  }>({ key: "", query: "", sort: "custom" });
  const query = view.key === viewKey ? view.query : "";
  const sort = view.key === viewKey ? view.sort : "custom";
  const [action, setAction] = useState<{
    kind: "edit" | "order" | "delete";
    playlistId: string;
    scope: ReturnType<typeof captureApiAccountScope>;
  } | null>(null);
  const activeAction =
    action && action.playlistId === id && apiAccountScopeCurrent(action.scope)
      ? action.kind
      : null;
  const openAction = (next: "edit" | "order" | "delete") => {
    if (id && data.user)
      setAction({
        kind: next,
        playlistId: id,
        scope: captureApiAccountScope(),
      });
  };
  const playlist =
    kind === "playlist"
      ? data.library?.playlists.find((p) => p.id === id)
      : kind === "mix"
        ? data.editorialPlaylists.find((p) => p.id === id)
        : null;
  const album = kind === "album" ? data.albums.find((a) => a.id === id) : null;
  const artist =
    kind === "artist" ? data.artists.find((a) => a.id === id) : null;
  const tracks =
    kind === "liked"
      ? (data.library?.likes ?? [])
      : (playlist?.tracks ?? album?.tracks ?? artist?.tracks ?? []);
  const visibleTracks = playlistTrackView(tracks, query, sort);
  const viewChanged = Boolean(query.trim()) || sort !== "custom";
  const reorderAvailable =
    !viewChanged && tracks.length >= 2 && tracks.length <= 5000;
  const title =
    kind === "liked"
      ? "Liked songs"
      : (playlist?.name ?? album?.title ?? artist?.name);
  const art =
    playlist && "artwork" in playlist
      ? playlistArtwork(playlist)
      : (tracks[0]?.artwork ?? album?.artwork ?? artist?.artwork);
  const followed =
    artist && data.library?.followedArtists.includes(`studio:${artist.id}`);
  if (!title)
    return (
      <div className="page empty-state">
        <Music2 size={36} />
        <h1>That collection isn’t here</h1>
        <p>It may have been deleted or belongs to another account.</p>
        <Link href={appHref("/library")} className="button secondary">
          Back to your library
        </Link>
      </div>
    );
  return (
    <div className="page detail-page">
      <header
        className={`collection-hero ${kind === "artist" ? "artist-hero" : ""}`}
      >
        <div
          className={`collection-art ${kind === "liked" ? "liked-cover" : ""}`}
        >
          {kind === "liked" ? (
            <Heart size={80} fill="currentColor" />
          ) : art ? (
            <Image src={art} alt={title} width={400} height={400} />
          ) : (
            <Music2 size={60} />
          )}
        </div>
        <div>
          <span className="eyebrow">
            {kind === "mix"
              ? "AURELIA MIX"
              : kind === "liked"
                ? "YOUR COLLECTION"
                : kind.toUpperCase()}
          </span>
          <h1>{title}</h1>
          <p>
            {playlist?.description ??
              (kind === "liked"
                ? "The songs you keep coming back to."
                : kind === "artist"
                  ? "Original instrumental sketches from our independent studio."
                  : `${album?.year} · ${album?.artist}`)}
          </p>
          <span className="collection-meta">
            {kind === "playlist" || kind === "liked"
              ? (data.user?.name ?? "Your music")
              : "Aurelia Studio"}{" "}
            <i /> {tracks.length} songs <i />{" "}
            {Math.ceil(tracks.reduce((a, t) => a + t.duration, 0) / 60)} min
          </span>
        </div>
      </header>
      <div className="collection-actions playlist-collection-actions">
        <button
          className="play-button large-play"
          aria-label={`Play ${viewChanged ? "results from " : ""}${title}`}
          disabled={!visibleTracks.length}
          onClick={() => {
            if (visibleTracks.length > 500) {
              toast(
                "A queue holds up to 500 songs. Filter this collection to 500 or fewer songs before playing.",
              );
              return;
            }
            player.dispatch({ type: "play", tracks: visibleTracks });
          }}
        >
          <Play size={28} fill="currentColor" />
        </button>
        {kind === "playlist" && (
          <>
            <Link href={appHref("/search")} className="button secondary">
              <Plus size={17} />
              Add songs
            </Link>
            <button
              type="button"
              className="button secondary"
              onClick={() => openAction("edit")}
            >
              Edit playlist
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!reorderAvailable}
              aria-describedby={helpId}
              onClick={() => openAction("order")}
            >
              Reorder songs
            </button>
            <button
              className="icon-button"
              aria-label="Delete playlist"
              onClick={() => openAction("delete")}
            >
              <Trash2 size={20} />
            </button>
          </>
        )}
        {artist && (
          <button
            className="button secondary"
            onClick={() =>
              void mutation("library/artists", "POST", {
                artistId: `studio:${artist.id}`,
                name: artist.name,
                follow: !followed,
              })
            }
          >
            {followed ? "Following" : "Follow artist"}
          </button>
        )}
        <span className="muted">
          {kind === "mix" ? "Handpicked, just for the moment." : ""}
        </span>
      </div>
      {kind === "playlist" && (
        <p className="muted" id={helpId}>
          {tracks.length > 5000
            ? "Reordering supports up to 5,000 songs."
            : tracks.length < 2
              ? "Add at least two songs to reorder this playlist."
              : viewChanged
                ? "To reorder songs, clear the filter and choose Original order."
                : "Reorder songs to save a new playlist order."}
        </p>
      )}
      <PlaylistViewControls
        tracks
        query={query}
        sort={sort}
        onQuery={(value) => setView({ key: viewKey, query: value, sort })}
        onSort={(value) =>
          setView({ key: viewKey, query, sort: value as PlaylistTrackSort })
        }
      />
      {viewChanged && (
        <p className="muted" role="status">
          {visibleTracks.length} of {tracks.length} songs · Playback uses these
          results. Your saved order is unchanged.
        </p>
      )}
      {tracks.length > 0 && !visibleTracks.length ? (
        <div className="empty-state">
          <Music2 size={36} />
          <h3>No songs match your filter</h3>
          <button
            type="button"
            className="button secondary"
            onClick={() => setView({ key: viewKey, query: "", sort })}
          >
            Clear filter
          </button>
        </div>
      ) : (
        <TrackList
          tracks={visibleTracks}
          remove={
            kind === "playlist"
              ? (track) =>
                  void mutation(`library/playlists/${id}/tracks`, "DELETE", {
                    trackId: track.id,
                  }).then((ok) => ok && toast("Song removed"))
              : undefined
          }
        />
      )}
      {artist && (
        <section>
          <SectionHeader title="Albums" />
          <div className="album-grid">
            {artist.albums.map((a) => (
              <Link
                className="album-card"
                key={a.id}
                href={appHref(`/album/${encodeURIComponent(a.id)}`)}
              >
                <Image src={a.artwork} alt={a.title} width={400} height={400} />
                <h3>{a.title}</h3>
                <p>{a.year} · Album</p>
              </Link>
            ))}
          </div>
        </section>
      )}
      {kind === "playlist" && playlist && id && activeAction === "edit" && (
        <PlaylistEditorDialog
          editing
          name={playlist.name}
          description={playlist.description}
          onClose={() => setAction(null)}
          onSave={(changes) => updatePlaylist(id, changes)}
        />
      )}
      {kind === "playlist" && playlist && id && activeAction === "order" && (
        <PlaylistOrderDialog
          tracks={tracks}
          onClose={() => setAction(null)}
          onReload={refresh}
          onSave={(trackIds, expectedTrackIds) =>
            reorderPlaylist(id, trackIds, expectedTrackIds)
          }
        />
      )}
      {kind === "playlist" && id && activeAction === "delete" && (
        <PlaylistDeleteDialog
          name={title}
          onClose={() => setAction(null)}
          onDelete={() => mutation(`library/playlists/${id}`, "DELETE")}
          onDeleted={() => router.push(appHref("/library"))}
        />
      )}
    </div>
  );
}
export function QueueScreen() {
  const { data } = useApp();
  const scope = captureApiAccountScope();
  return (
    <QueueScreenContent key={`${data.user?.id ?? "guest"}:${scope.epoch}`} />
  );
}
function QueueScreenContent() {
  const { player } = useApp();
  const state = usePlayer();
  const [clearing, setClearing] = useState(false);
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">KEEP THE GOOD THINGS COMING</span>
          <h1>Up next</h1>
        </div>
        <div className="queue-actions">
          <span className="muted">{state.queue.length} songs</span>
          {!!state.queue.length && (
            <>
              <button
                className="button secondary small"
                disabled={
                  state.index < 0 || state.index >= state.queue.length - 1
                }
                onClick={() => player.dispatch({ type: "clear-upcoming" })}
              >
                Clear upcoming
              </button>
              <button
                className="button secondary small"
                onClick={() => setClearing(true)}
              >
                Clear queue
              </button>
            </>
          )}
        </div>
      </div>
      {!state.queue.length ? (
        <div className="empty-state">
          <ListMusic size={42} />
          <h3>The stage is yours</h3>
          <p>Play a mix or add a song to get things going.</p>
          <Link className="button primary" href={appHref("/search")}>
            Find something to play
          </Link>
        </div>
      ) : (
        <div className="queue-list">
          {state.queue.map((track, index) => (
            <div
              className={`queue-row ${index === state.index ? "current" : ""}`}
              key={`${track.id}:${index}`}
            >
              <button
                className="queue-track"
                onClick={() =>
                  player.dispatch({ type: "play", tracks: state.queue, index })
                }
              >
                <Image src={track.artwork} alt="" width={56} height={56} />
                <span>
                  <strong>{track.title}</strong>
                  <small>
                    {index === state.index
                      ? state.playing
                        ? "Now playing · "
                        : "Selected · "
                      : ""}
                    {track.artist}
                  </small>
                </span>
              </button>
              <button
                className="icon-button"
                aria-label={`Move ${track.title} up`}
                disabled={index === 0}
                onClick={() =>
                  player.dispatch({ type: "move", from: index, to: index - 1 })
                }
              >
                <ArrowUp size={17} />
              </button>
              <button
                className="icon-button"
                aria-label={`Move ${track.title} down`}
                disabled={index === state.queue.length - 1}
                onClick={() =>
                  player.dispatch({ type: "move", from: index, to: index + 1 })
                }
              >
                <ArrowDown size={17} />
              </button>
              <button
                className="icon-button"
                aria-label={`Remove ${track.title} from queue`}
                onClick={() => player.dispatch({ type: "remove", index })}
              >
                <X size={18} />
              </button>
            </div>
          ))}
        </div>
      )}
      {clearing && (
        <Dialog title="Clear your queue?" onClose={() => setClearing(false)}>
          <p>
            Playback will stop and all songs will be removed from this queue.
            Your library and playlists stay saved.
          </p>
          <button
            className="button danger wide"
            onClick={() => {
              player.dispatch({ type: "clear" });
              setClearing(false);
            }}
          >
            Stop & clear queue
          </button>
        </Dialog>
      )}
    </div>
  );
}
export function HistoryScreen() {
  const { data } = useApp();
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">GOOD SOUNDS LEAVE A TRACE</span>
          <h1>Recently played</h1>
        </div>
        <Clock3 size={26} />
      </div>
      <TrackList tracks={(data.library?.history ?? []).map((h) => h.track)} />
    </div>
  );
}
export function RecommendationsScreen() {
  const { data, player } = useApp();
  const demoCatalogue = data.capabilities.demoCatalogue === true;
  const feed = useRecommendationFeed(data.user?.id ?? null);
  const recommendations = (feed.entries ?? data.recommendations).filter(
    (entry) => demoCatalogue || entry.track.provider === "youtube",
  );
  const fallback: RankedTrack[] = demoCatalogue
    ? data.catalogue.map((track) => ({
        track,
        reason: "Something new for you",
        score: 0,
      }))
    : [];
  const cards = (recommendations.length ? recommendations : fallback).slice(
    0,
    8,
  );
  const collection = cards.map((entry) => entry.track);
  const rotation = visibleDiscoveryTracks(
    data.library?.likes.length
      ? data.library.likes
      : demoCatalogue
        ? data.catalogue
        : [],
    demoCatalogue,
  ).slice(0, 8);
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR TASTE, A LITTLE FURTHER</span>
          <h1>Made for you</h1>
          <p className="muted">Familiar favorites. New corners to explore.</p>
        </div>
        <button
          className="button primary"
          type="button"
          disabled={!collection.length}
          onClick={() =>
            player.dispatch({
              type: "play",
              tracks: collection,
            })
          }
        >
          <Play size={18} fill="currentColor" />
          Play your mix
        </button>
      </div>
      <div className="recommendation-intro">
        <span className="eyebrow">A MIX THAT GROWS WITH YOU</span>
        <h2>
          More listening.
          <br />
          More <em>you.</em>
        </h2>
        <p>
          Likes, skips, completed listens, and the songs you save help shape
          what comes next. A little discovery keeps things interesting.
        </p>
      </div>
      <section>
        <div className="section-heading">
          <h2>
            {demoCatalogue ? "Your daily discovery" : "Recommendations for you"}
          </h2>
          <button
            type="button"
            className="button secondary small"
            disabled={feed.loading || !data.user}
            onClick={feed.refresh}
          >
            Refresh recommendations
          </button>
        </div>
        {feed.loading && (
          <p role="status" className="muted">
            Finding music around your favorites…
          </p>
        )}
        {feed.failed && (
          <p role="status" className="muted">
            Recommendations are temporarily unavailable. Your saved music is
            still in your library.
          </p>
        )}
        <div className="album-grid">
          {cards.map((r) => (
            <TrackCard
              track={r.track}
              reason={r.reason}
              collection={collection}
              key={r.track.id}
            />
          ))}
        </div>
        {!cards.length && !feed.loading && (
          <p className="muted">
            {data.user
              ? "Like songs and listen to music to shape your recommendations."
              : "Sign in to build recommendations around your listening."}{" "}
            <Link href={appHref("/search")}>Find some music</Link>.
          </p>
        )}
      </section>
      <section>
        <SectionHeader title="Your rotation" />
        {rotation.length ? (
          <TrackList tracks={rotation} />
        ) : (
          <p className="muted">Your liked songs will appear here.</p>
        )}
      </section>
    </div>
  );
}
