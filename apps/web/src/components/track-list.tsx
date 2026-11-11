"use client";
import { appHref } from "@/lib/app-navigation";
import { useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  Play,
  Heart,
  Plus,
  ListPlus,
  MoreHorizontal,
  EyeOff,
  Trash2,
  Music2,
  ListStart,
  Link2,
} from "lucide-react";
import { formatTime, type Track } from "@aurelia/core";
import { useApp, usePlayer } from "./app-context";
import { Dialog } from "./dialog";
import {
  captureApiAccountScope,
  apiAccountScopeCurrent,
} from "@/lib/client-account";
export function AddTrackDialog({
  track,
  onClose,
}: {
  track: Track;
  onClose: () => void;
}) {
  const { data, addTrack, createPlaylist } = useApp();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const playlists = data.library?.playlists ?? [];
  return (
    <Dialog title="Add to a playlist" onClose={onClose}>
      <p className="muted">
        {track.title} · {track.artist}
      </p>
      <div className="playlist-choices">
        {playlists.map((playlist) => (
          <button
            key={playlist.id}
            disabled={busy}
            onClick={async () => {
              if (pending.current) return;
              pending.current = true;
              setBusy(true);
              setError("");
              try {
                if (await addTrack(playlist, track)) onClose();
                else
                  setError(
                    "Could not confirm the addition. Refresh your library, then retry if needed.",
                  );
              } finally {
                pending.current = false;
                setBusy(false);
              }
            }}
          >
            <Music2 size={24} />
            <span>
              <strong>{playlist.name}</strong>
              <small>{playlist.tracks.length} songs</small>
            </span>
            <Plus size={18} />
          </button>
        ))}
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (pending.current || !name.trim()) return;
          pending.current = true;
          setBusy(true);
          setError("");
          try {
            const id = await createPlaylist(name.trim());
            if (!id) {
              setError("Could not create the playlist. Please retry.");
              return;
            }
            const added = await addTrack(
              {
                id,
                name: name.trim(),
                description: "",
                tracks: [],
                createdAt: "",
              },
              track,
            );
            if (added) onClose();
            else {
              setName("");
              setError(
                "Playlist created, but the song was not added. Select the new playlist above to retry.",
              );
            }
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      >
        <label>
          Or create a new playlist
          <input
            required
            placeholder="Playlist name"
            maxLength={120}
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button className="button primary wide" disabled={busy}>
          Create & add
        </button>
      </form>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
type TrackListProps = {
  tracks: Track[];
  remove?: (track: Track) => void;
  compact?: boolean;
};
export function TrackList(props: TrackListProps) {
  const { data } = useApp();
  const scope = captureApiAccountScope();
  return (
    <TrackListContent
      key={`${data.user?.id ?? "guest"}:${scope.epoch}`}
      {...props}
    />
  );
}
function TrackListContent({ tracks, remove, compact = false }: TrackListProps) {
  const { data, player, like, hide, ensureAccount, toast } = useApp();
  const state = usePlayer();
  const [add, setAdd] = useState<Track | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const closeDialog = () => {
    setAdd(null);
    setShareLink(null);
    requestAnimationFrame(() => {
      if (menuTrigger.current?.isConnected) menuTrigger.current.focus();
    });
  };
  const enqueue = (track: Track, next: boolean) => {
    if (player.getSnapshot().queue.length >= 500) {
      toast("Queue is full (500 songs). Remove a song before adding another.");
    } else {
      player.dispatch({ type: next ? "play-next" : "queue", track });
      toast(next ? "Playing next" : "Added to queue");
    }
    setMenu(null);
  };
  const likes = new Set(data.library?.likes.map((t) => t.id));
  const current = state.queue[state.index];
  const play = (index: number) => {
    const result = player.dispatch({ type: "play", tracks, index });
    if (!result.ok)
      toast(
        "A queue holds up to 500 songs. Filter this collection to 500 or fewer songs before playing, or use Play next for one song.",
      );
  };
  if (!tracks.length)
    return (
      <div className="empty-state">
        <Music2 size={36} />
        <h3>A little quiet here</h3>
        <p>Find a song you love and make it yours.</p>
        <Link className="button secondary" href={appHref("/search")}>
          Explore music
        </Link>
      </div>
    );
  return (
    <>
      <div
        className={`track-list ${compact ? "compact" : ""}`}
        role="list"
        aria-label="Songs"
      >
        {!compact && (
          <div className="track-header" aria-hidden="true">
            <span>#</span>
            <span>Title</span>
            <span>Album</span>
            <span />
            <span>Time</span>
            <span />
          </div>
        )}
        {tracks.map((track, index) => (
          <div
            key={`${track.id}:${index}`}
            className={`track-row ${current?.id === track.id ? "current" : ""}`}
            role="listitem"
          >
            <button
              className="track-number"
              aria-label={`Play ${track.title}`}
              onClick={() => play(index)}
            >
              <span>
                {current?.id === track.id && state.playing ? (
                  <span className="equalizer">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  index + 1
                )}
              </span>
              <Play size={16} className="row-play" fill="currentColor" />
            </button>
            <div className="track-info">
              <button
                className="track-art"
                onClick={() => play(index)}
                aria-label={`Play ${track.title}`}
              >
                <Image src={track.artwork} alt="" width={44} height={44} />
              </button>
              <span>
                <button className="track-title" onClick={() => play(index)}>
                  {track.title}
                </button>
                {track.provider === "youtube" ? (
                  <a
                    href={track.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="track-artist"
                  >
                    YouTube · {track.artist}
                  </a>
                ) : (
                  <Link
                    className="track-artist"
                    href={appHref(
                      `/artist/${encodeURIComponent(track.artistId)}`,
                    )}
                  >
                    {track.artist}
                  </Link>
                )}
              </span>
            </div>
            {track.provider === "youtube" ? (
              <span className="track-album">{track.album}</span>
            ) : (
              <Link
                className="track-album"
                href={appHref(`/album/${encodeURIComponent(track.albumId)}`)}
              >
                {track.album}
              </Link>
            )}
            <button
              className={`icon-button like-button ${likes.has(track.id) ? "active" : ""}`}
              aria-label={`${likes.has(track.id) ? "Unlike" : "Like"} ${track.title}`}
              aria-pressed={likes.has(track.id)}
              onClick={() => void like(track)}
            >
              <Heart
                size={18}
                fill={likes.has(track.id) ? "currentColor" : "none"}
              />
            </button>
            <span className="track-duration">
              {track.provider === "youtube" && !track.duration
                ? "—"
                : formatTime(track.duration)}
            </span>
            <div className="track-menu-wrap">
              <button
                className="icon-button"
                aria-label={`More options for ${track.title}`}
                aria-expanded={menu === `${track.id}:${index}`}
                onClick={(event) => {
                  menuTrigger.current = event.currentTarget;
                  const key = `${track.id}:${index}`;
                  setMenu(menu === key ? null : key);
                }}
              >
                <MoreHorizontal size={20} />
              </button>
              {menu === `${track.id}:${index}` && (
                <div className="track-menu">
                  <button
                    disabled={state.shuffle}
                    onClick={() => enqueue(track, true)}
                    title={
                      state.shuffle
                        ? "Turn off Shuffle to choose the next song"
                        : undefined
                    }
                  >
                    <ListStart size={16} />
                    {state.shuffle ? "Play next (Shuffle is on)" : "Play next"}
                  </button>
                  <button onClick={() => enqueue(track, false)}>
                    <ListPlus size={16} />
                    Add to queue
                  </button>
                  <button
                    onClick={() => {
                      if (ensureAccount()) setAdd(track);
                      setMenu(null);
                    }}
                  >
                    <Plus size={16} />
                    Add to playlist
                  </button>
                  {track.provider === "youtube" && (
                    <button
                      onClick={async () => {
                        const scope = captureApiAccountScope();
                        const link = `https://www.youtube.com/watch?v=${encodeURIComponent(track.externalId)}`;
                        setMenu(null);
                        try {
                          await navigator.clipboard.writeText(link);
                          if (apiAccountScopeCurrent(scope))
                            toast("YouTube link copied");
                        } catch {
                          if (apiAccountScopeCurrent(scope)) setShareLink(link);
                        }
                      }}
                    >
                      <Link2 size={16} />
                      Copy song link
                    </button>
                  )}
                  <button
                    onClick={() => {
                      void hide(track);
                      setMenu(null);
                    }}
                  >
                    <EyeOff size={16} />
                    Play less like this
                  </button>
                  {remove && (
                    <button
                      onClick={() => {
                        remove(track);
                        setMenu(null);
                      }}
                    >
                      <Trash2 size={16} />
                      Remove from playlist
                    </button>
                  )}
                  <button className="muted" onClick={() => setMenu(null)}>
                    Close menu
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {add && <AddTrackDialog track={add} onClose={closeDialog} />}
      {shareLink && (
        <Dialog title="Share song" onClose={closeDialog}>
          <p className="muted">Copy this public YouTube link.</p>
          <label>
            Song link
            <input
              readOnly
              value={shareLink}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
        </Dialog>
      )}
    </>
  );
}
