"use client";
import { appHref } from "@/lib/app-navigation";
import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  Volume2,
  VolumeX,
  ListMusic,
  Heart,
  ChevronDown,
  ArrowUpRight,
  Video,
  Headphones,
  LoaderCircle,
} from "lucide-react";
import { formatTime } from "@aurelia/core";
import { Capacitor } from "@capacitor/core";
import { useApp, usePlayer } from "./app-context";
import { Dialog } from "./dialog";
import { LyricsPanel } from "./lyrics-panel";
export function PlayerControls({ large = false }: { large?: boolean }) {
  const { player, playback } = useApp();
  const state = usePlayer();
  return (
    <div className={`transport ${large ? "large" : ""}`}>
      <button
        className={`icon-button ${state.shuffle ? "active" : ""}`}
        aria-label="Shuffle"
        aria-pressed={state.shuffle}
        onClick={() => player.dispatch({ type: "shuffle" })}
      >
        <Shuffle size={large ? 22 : 17} />
      </button>
      <button
        className="icon-button"
        aria-label="Previous track"
        onClick={() => player.dispatch({ type: "previous" })}
      >
        <SkipBack size={large ? 29 : 21} fill="currentColor" />
      </button>
      <button
        className="play-button"
        aria-label={state.playing ? "Pause" : "Play"}
        disabled={state.index < 0}
        onClick={() => player.dispatch({ type: "toggle" })}
      >
        {state.playing &&
        playback.state === "loading" &&
        state.mode === "audio" ? (
          <LoaderCircle className="spin" size={large ? 30 : 22} />
        ) : state.playing ? (
          <Pause size={large ? 30 : 22} fill="currentColor" />
        ) : (
          <Play size={large ? 30 : 22} fill="currentColor" />
        )}
      </button>
      <button
        className="icon-button"
        aria-label="Next track"
        onClick={() => player.dispatch({ type: "next" })}
      >
        <SkipForward size={large ? 29 : 21} fill="currentColor" />
      </button>
      <button
        className={`icon-button ${state.repeat !== "off" ? "active" : ""}`}
        aria-label={`Repeat: ${state.repeat}`}
        aria-pressed={state.repeat !== "off"}
        onClick={() => player.dispatch({ type: "repeat" })}
      >
        {state.repeat === "one" ? (
          <Repeat1 size={large ? 22 : 17} />
        ) : (
          <Repeat size={large ? 22 : 17} />
        )}
      </button>
    </div>
  );
}
function SeekBar() {
  const { player } = useApp();
  const state = usePlayer();
  return (
    <div className="seek-bar">
      <span>{formatTime(state.position)}</span>
      <input
        type="range"
        aria-label="Seek"
        min={0}
        max={state.duration || 1}
        step={0.5}
        value={Math.min(state.position, state.duration || 1)}
        onChange={(event) =>
          player.dispatch({
            type: "seek",
            position: Number(event.target.value),
          })
        }
        style={
          {
            "--range-progress": `${state.duration ? (state.position / state.duration) * 100 : 0}%`,
          } as React.CSSProperties
        }
      />
      <span>{formatTime(state.duration)}</span>
    </div>
  );
}
export function PlayerBar() {
  const { player, data, like, playback } = useApp();
  const state = usePlayer();
  const track = state.queue[state.index];
  const [expanded, setExpanded] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const liked = data.library?.likes.some((t) => t.id === track?.id);
  const videoOnly = playback.source?.kind === "youtube";
  const devicePlayback =
    Capacitor.isNativePlatform() && track?.provider === "youtube";
  const videoUrl =
    track?.provider === "youtube"
      ? `https://www.youtube.com/watch?v=${encodeURIComponent(track.externalId)}`
      : "";
  function toggleVideo() {
    const mode = state.mode === "video" ? "audio" : "video";
    player.dispatch({ type: "mode", mode });
    if (mode === "video" && !state.playing) player.dispatch({ type: "toggle" });
  }
  return (
    <>
      <footer
        className={`player-bar ${track ? "has-track" : ""}`}
        aria-label="Music player"
      >
        <div className="playing-info">
          {track ? (
            <>
              <button
                className="playing-art"
                onClick={() => setExpanded(true)}
                aria-label="Open now playing"
              >
                <Image src={track.artwork} alt="" width={56} height={56} />
              </button>
              <button
                className="playing-text"
                onClick={() => setExpanded(true)}
              >
                <strong>{track.title}</strong>
                <span>
                  {playback.state === "error"
                    ? "Playback unavailable · tap for details"
                    : track.artist}
                </span>
              </button>
              <button
                className={`icon-button player-like ${liked ? "active" : ""}`}
                aria-label={
                  liked ? "Unlike current track" : "Like current track"
                }
                aria-pressed={liked}
                onClick={() => void like(track)}
              >
                <Heart size={18} fill={liked ? "currentColor" : "none"} />
              </button>
            </>
          ) : (
            <>
              <div className="idle-art">
                <Volume2 size={24} />
              </div>
              <span>
                <strong>Your next favorite awaits</strong>
                <small>Pick something and press play</small>
              </span>
            </>
          )}
        </div>
        <div className="player-center">
          <PlayerControls />
          <SeekBar />
        </div>
        <div className="player-extras">
          {devicePlayback ? (
            <a
              className="icon-button"
              href={videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Watch on YouTube"
            >
              <Video size={20} />
            </a>
          ) : (
            track?.provider === "youtube" && (
              <button
                className={`icon-button ${state.mode === "video" ? "active" : ""}`}
                aria-label={
                  videoOnly && state.mode === "video"
                    ? "Video only"
                    : state.mode === "video"
                      ? "Listen to audio"
                      : "Watch video"
                }
                disabled={videoOnly && state.mode === "video"}
                onClick={toggleVideo}
              >
                {state.mode === "video" ? (
                  <Headphones size={20} />
                ) : (
                  <Video size={20} />
                )}
              </button>
            )
          )}
          <Link
            className="icon-button"
            href={appHref("/queue")}
            aria-label="Open queue"
          >
            <ListMusic size={21} />
          </Link>
          <button
            className="icon-button"
            aria-label={state.volume ? "Mute" : "Unmute"}
            onClick={() =>
              player.dispatch({
                type: "volume",
                volume: state.volume ? 0 : 0.75,
              })
            }
          >
            {state.volume ? <Volume2 size={20} /> : <VolumeX size={20} />}
          </button>
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.01}
            value={state.volume}
            onChange={(e) =>
              player.dispatch({
                type: "volume",
                volume: Number(e.target.value),
              })
            }
          />
          <button
            className="icon-button expand-player"
            aria-label="Expand player"
            disabled={!track}
            onClick={() => setExpanded(true)}
          >
            <ArrowUpRight size={18} />
          </button>
        </div>
        <div className="mobile-transport">
          <button
            className="icon-button mobile-play-button"
            aria-label={state.playing ? "Pause" : "Play"}
            disabled={!track}
            onClick={() => player.dispatch({ type: "toggle" })}
          >
            {state.playing && playback.state === "loading" ? (
              <LoaderCircle className="spin" size={24} />
            ) : state.playing ? (
              <Pause size={24} fill="currentColor" />
            ) : (
              <Play size={24} fill="currentColor" />
            )}
          </button>
          <button
            className="icon-button"
            aria-label="Next track"
            onClick={() => player.dispatch({ type: "next" })}
          >
            <SkipForward size={24} />
          </button>
        </div>
        <div
          className="mini-progress"
          style={{
            width: `${state.duration ? (state.position / state.duration) * 100 : 0}%`,
          }}
        />
      </footer>
      {expanded && track && (
        <Dialog
          title="Now playing"
          className="now-playing"
          onClose={() => setExpanded(false)}
        >
          <div className="now-playing-label">
            <ChevronDown size={18} />
            <span>
              {track.album
                ? `FROM ${track.album.toUpperCase()}`
                : "FROM YOUTUBE"}
            </span>
          </div>
          <Image
            className="now-playing-art"
            src={track.artwork}
            alt={`${track.album} artwork`}
            width={800}
            height={800}
          />
          <div className="now-playing-title">
            <div>
              <h2>{track.title}</h2>
              <p>{track.artist}</p>
            </div>
            <button
              className={`icon-button ${liked ? "active" : ""}`}
              aria-label="Like current track"
              onClick={() => void like(track)}
            >
              <Heart size={26} fill={liked ? "currentColor" : "none"} />
            </button>
          </div>
          <SeekBar />
          <PlayerControls large />
          {playback.state === "error" && (
            <p className="form-error" role="status">
              {playback.message}
            </p>
          )}
          {track.provider === "youtube" && (
            <div className="playback-options">
              {devicePlayback ? (
                <a
                  className="button secondary small"
                  href={videoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Video size={18} />
                  Watch on YouTube
                </a>
              ) : (
                <button
                  className="button secondary small"
                  disabled={videoOnly && state.mode === "video"}
                  onClick={() => {
                    setExpanded(false);
                    toggleVideo();
                  }}
                >
                  {state.mode === "video" ? (
                    <Headphones size={18} />
                  ) : (
                    <Video size={18} />
                  )}
                  {videoOnly && state.mode === "video"
                    ? "Video only on this server"
                    : state.mode === "video"
                      ? "Listen to audio"
                      : "Watch video"}
                </button>
              )}
              {!devicePlayback && (
                <label>
                  <span>Audio quality</span>
                  <select
                    aria-label="Audio quality"
                    disabled={videoOnly}
                    value={state.quality}
                    onChange={(e) =>
                      player.dispatch({
                        type: "quality",
                        quality: e.target.value as "low" | "balanced" | "high",
                      })
                    }
                  >
                    <option value="low">Data saver</option>
                    <option value="balanced">Balanced</option>
                    <option value="high">High</option>
                  </select>
                </label>
              )}
              <small role="status">
                {playback.state === "loading"
                  ? "Connecting to audio…"
                  : playback.state === "error"
                    ? playback.message
                    : playback.source?.kind === "youtube"
                      ? (playback.source.notice ?? "Video playback")
                      : playback.source?.kind === "audio" &&
                          playback.source.bitrate
                        ? `${Math.round(playback.source.bitrate / 1000)} kbps · AAC`
                        : devicePlayback
                          ? "Direct device audio"
                          : "Audio playback"}
              </small>
            </div>
          )}
          {track.provider === "youtube" && (
            <>
              <button
                className="button secondary wide"
                aria-expanded={showLyrics}
                onClick={() => setShowLyrics((value) => !value)}
              >
                {showLyrics ? "Hide lyrics" : "Show lyrics"}
              </button>
              {showLyrics && <LyricsPanel key={track.id} track={track} />}
            </>
          )}
          <Link
            className="button secondary wide"
            href={appHref("/queue")}
            onClick={() => setExpanded(false)}
          >
            <ListMusic size={18} />
            Up next · {Math.max(0, state.queue.length - state.index - 1)} songs
          </Link>
        </Dialog>
      )}
    </>
  );
}
