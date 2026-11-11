"use client";
import { useEffect, useMemo, useState } from "react";
import type { Track } from "@aurelia/core";
import { api } from "@/lib/client-api";
import { parseLyrics, type Lyrics } from "@/lib/lyrics";
import { useApp, usePlayer } from "./app-context";

export function LyricsPanel({ track }: { track: Track }) {
  const { player } = useApp();
  const state = usePlayer();
  const [query, setQuery] = useState(
    track.title
      .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
      .trim()
      .slice(0, 200),
  );
  const [submitted, setSubmitted] = useState(query);
  const [attempt, setAttempt] = useState(0);
  const [records, setRecords] = useState<Lyrics[]>([]);
  const [selected, setSelected] = useState<Lyrics | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    setSelected(null);
    void api<Lyrics[]>(`lyrics?q=${encodeURIComponent(submitted)}`, {
      signal: controller.signal,
    })
      .then((results) => {
        if (!controller.signal.aborted) setRecords(results);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [submitted, attempt]);
  const lines = useMemo(
    () => parseLyrics(selected?.syncedLyrics ?? ""),
    [selected],
  );
  const active = lines.reduce(
    (index, line, current) => (line.time <= state.position ? current : index),
    -1,
  );
  return (
    <section className="lyrics-panel" aria-label="Lyrics">
      <h3>Lyrics</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim().length >= 2) {
            setSubmitted(query.trim());
            setAttempt((value) => value + 1);
          }
        }}
      >
        <label className="sr-only" htmlFor="lyrics-query">
          Song and artist
        </label>
        <input
          id="lyrics-query"
          value={query}
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className="button secondary small"
          type="submit"
          disabled={busy}
        >
          Find lyrics
        </button>
      </form>
      {busy ? (
        <p role="status">Finding lyrics…</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : !selected ? (
        <>
          <p className="muted">Choose the recording that matches this song.</p>
          {records.length ? (
            records.map((record) => (
              <button
                className="lyrics-candidate"
                key={record.id}
                onClick={() => setSelected(record)}
              >
                <strong>{record.trackName}</strong>
                <span>
                  {record.artistName} · {record.albumName} ·{" "}
                  {Math.round(record.duration)}s
                </span>
                <small>
                  {record.syncedLyrics
                    ? "Synced lyrics"
                    : record.instrumental
                      ? "Instrumental"
                      : "Plain lyrics"}
                </small>
              </button>
            ))
          ) : (
            <p>No lyrics found. Try the song name and artist.</p>
          )}
        </>
      ) : (
        <>
          <p className="muted">
            {selected.trackName} · {selected.artistName}
          </p>
          <button className="text-button" onClick={() => setSelected(null)}>
            Choose another recording
          </button>
          <div className="lyrics-lines">
            {lines.length ? (
              lines.map((line, i) => (
                <p
                  className={i === active ? "current" : ""}
                  aria-current={i === active ? "true" : undefined}
                  key={`${line.time}:${i}`}
                >
                  <button
                    className="lyric-seek"
                    aria-current={i === active ? "true" : undefined}
                    disabled={
                      state.queue[state.index]?.id !== track.id ||
                      (state.duration > 0 && line.time > state.duration)
                    }
                    aria-label={`Seek to ${Math.floor(line.time / 60)}:${String(Math.floor(line.time % 60)).padStart(2, "0")} — ${line.text || "instrumental"}`}
                    onClick={() =>
                      player.dispatch({ type: "seek", position: line.time })
                    }
                  >
                    {line.text || "♪"}
                  </button>
                </p>
              ))
            ) : (
              <p className="plain-lyrics">
                {selected.instrumental
                  ? "Instrumental recording"
                  : selected.plainLyrics || "No lyrics available"}
              </p>
            )}
          </div>
        </>
      )}
      <small className="muted">
        Lyrics from{" "}
        <a href="https://lrclib.net" target="_blank" rel="noreferrer">
          LRCLIB
        </a>
        . Timing depends on the selected recording.
      </small>
    </section>
  );
}
