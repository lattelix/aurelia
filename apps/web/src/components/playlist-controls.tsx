"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowUp, ArrowDown } from "lucide-react";
import type { Track } from "@aurelia/core";
import {
  captureApiAccountScope,
  apiAccountScopeCurrent,
} from "@/lib/client-account";
import { Dialog } from "./dialog";
import {
  movePlaylistTrack,
  samePlaylistOrder,
  type PlaylistSort,
  type PlaylistTrackSort,
} from "./playlist-view";
import "./playlist-controls.css";

function useCurrentDialog() {
  const [scope] = useState(captureApiAccountScope);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => mounted.current && apiAccountScopeCurrent(scope);
}

export function PlaylistViewControls({
  query,
  sort,
  onQuery,
  onSort,
  tracks = false,
}: {
  query: string;
  sort: PlaylistSort | PlaylistTrackSort;
  onQuery: (value: string) => void;
  onSort: (value: string) => void;
  tracks?: boolean;
}) {
  const id = useId();
  return (
    <div className="playlist-controls">
      <label htmlFor={`${id}-filter`}>
        {tracks ? "Filter songs" : "Filter playlists"}
        <input
          id={`${id}-filter`}
          type="search"
          value={query}
          maxLength={200}
          autoComplete="off"
          onChange={(event) => onQuery(event.target.value)}
          placeholder={
            tracks ? "Title, artist or album" : "Name or description"
          }
        />
      </label>
      <label htmlFor={`${id}-sort`}>
        {tracks ? "Sort songs" : "Sort playlists"}
        <select
          id={`${id}-sort`}
          value={sort}
          onChange={(event) => onSort(event.target.value)}
        >
          {tracks ? (
            <>
              <option value="custom">Original order</option>
              <option value="title">Title</option>
              <option value="artist">Artist</option>
              <option value="duration">Duration</option>
            </>
          ) : (
            <>
              <option value="recent">Recently created</option>
              <option value="name">Name</option>
              <option value="songs">Song count</option>
            </>
          )}
        </select>
      </label>
    </div>
  );
}

export function PlaylistEditorDialog({
  name = "",
  description = "",
  editing = false,
  onSave,
  onSaved,
  onClose,
}: {
  name?: string;
  description?: string;
  editing?: boolean;
  onSave: (values: {
    name: string;
    description: string;
  }) => Promise<boolean | string>;
  onSaved?: (result: true | string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const current = useCurrentDialog();
  const [draftName, setName] = useState(name);
  const [draftDescription, setDescription] = useState(description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      title={editing ? "Edit playlist" : "Create playlist"}
      onClose={onClose}
      className="playlist-editor"
    >
      <form
        aria-busy={busy}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !current()) return;
          if (!draftName.trim()) {
            setError("Enter a playlist name.");
            return;
          }
          setBusy(true);
          setError("");
          try {
            const result = await onSave({
              name: draftName.trim(),
              description: draftDescription,
            });
            if (!current()) return;
            if (result) {
              onClose();
              onSaved?.(result);
            } else
              setError(
                "Could not save the playlist. Your changes are still here. Try again.",
              );
          } catch {
            if (current())
              setError(
                "Could not save the playlist. Your changes are still here. Try again.",
              );
          } finally {
            if (current()) setBusy(false);
          }
        }}
      >
        <label htmlFor={`${id}-name`}>
          Name
          <input
            id={`${id}-name`}
            name="name"
            type="text"
            required
            autoFocus
            maxLength={120}
            value={draftName}
            onChange={(event) => setName(event.target.value)}
            placeholder="A name for your soundtrack"
            disabled={busy}
          />
        </label>
        <label htmlFor={`${id}-description`}>
          Description
          <textarea
            id={`${id}-description`}
            name="description"
            maxLength={1000}
            value={draftDescription}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What belongs in this playlist?"
            disabled={busy}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="playlist-dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? "Saving…" : editing ? "Save changes" : "Create playlist"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function PlaylistOrderDialog({
  tracks,
  onSave,
  onReload,
  onClose,
}: {
  tracks: readonly Track[];
  onSave: (trackIds: string[], expectedTrackIds: string[]) => Promise<boolean>;
  onReload: () => Promise<void>;
  onClose: () => void;
}) {
  const current = useCurrentDialog();
  const [expected] = useState(() => tracks.map((track) => track.id));
  const [draft, setDraft] = useState(() => [...tracks]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const changed = !samePlaylistOrder(
    expected,
    draft.map((track) => track.id),
  );
  const move = (from: number, to: number) => {
    setDraft((value) => movePlaylistTrack(value, from, to));
    setAnnouncement(`Moved ${draft[from].title} to position ${to + 1}.`);
  };
  return (
    <Dialog title="Reorder songs" onClose={onClose}>
      <p className="muted">
        Move songs up or down, then save this playlist order. The current
        playback queue stays separate.
      </p>
      <ol className="playlist-order-list" aria-label="Playlist order">
        {draft.map((track, index) => (
          <li key={track.id}>
            <span className="playlist-order-track">
              <strong>
                {index + 1}. {track.title}
              </strong>
              <small>{track.artist}</small>
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={`Move ${track.title} up`}
              disabled={busy || index === 0}
              onClick={() => move(index, index - 1)}
            >
              <ArrowUp size={18} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`Move ${track.title} down`}
              disabled={busy || index === draft.length - 1}
              onClick={() => move(index, index + 1)}
            >
              <ArrowDown size={18} />
            </button>
          </li>
        ))}
      </ol>
      <p className="muted playlist-order-status" role="status">
        {announcement}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="playlist-dialog-actions">
        <button type="button" className="button secondary" onClick={onClose}>
          Cancel
        </button>
        {error && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={async () => {
              if (busy || !current()) return;
              setBusy(true);
              try {
                await onReload();
                if (current()) onClose();
              } catch {
                if (current())
                  setError("Could not reload the playlist. Try again.");
              } finally {
                if (current()) setBusy(false);
              }
            }}
          >
            Reload playlist
          </button>
        )}
        <button
          type="button"
          className="button primary"
          disabled={busy || !changed}
          onClick={async () => {
            if (busy || !current()) return;
            setBusy(true);
            setError("");
            try {
              const ok = await onSave(
                draft.map((track) => track.id),
                expected,
              );
              if (current()) {
                if (ok) onClose();
                else
                  setError(
                    "Could not save this order. The playlist may have changed. Reload it before trying again.",
                  );
              }
            } catch {
              if (current())
                setError(
                  "Could not save this order. Try again or reload the playlist.",
                );
            } finally {
              if (current()) setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Save order"}
        </button>
      </div>
    </Dialog>
  );
}

export function PlaylistDeleteDialog({
  name,
  onDelete,
  onDeleted,
  onClose,
}: {
  name: string;
  onDelete: () => Promise<boolean>;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const current = useCurrentDialog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog title={`Delete ${name}?`} onClose={onClose} className="playlist-delete">
      <p className="muted">The playlist will be deleted from your library.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="playlist-dialog-actions">
        <button type="button" className="button secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy}
          onClick={async () => {
            if (busy || !current()) return;
            setBusy(true);
            setError("");
            try {
              const ok = await onDelete();
              if (current()) {
                if (ok) {
                  onClose();
                  onDeleted();
                } else setError("Could not delete the playlist. Try again.");
              }
            } catch {
              if (current())
                setError("Could not delete the playlist. Try again.");
            } finally {
              if (current()) setBusy(false);
            }
          }}
        >
          {busy ? "Deleting…" : "Delete playlist"}
        </button>
      </div>
    </Dialog>
  );
}
