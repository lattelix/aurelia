"use client";
import { useEffect, useRef, useState } from "react";
import { X, ExternalLink } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { useApp, usePlayer } from "./app-context";
interface YTInstance {
  playVideo(): void;
  pauseVideo(): void;
  cueVideoById?(options: { videoId: string; startSeconds: number }): void;
  seekTo(n: number, allow: boolean): void;
  setVolume(n: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  destroy(): void;
}
interface YTApi {
  Player: new (
    node: HTMLElement,
    options: {
      videoId: string;
      width: string;
      height: string;
      playerVars: Record<string, string | number>;
      events: {
        onReady: (e: { target: YTInstance }) => void;
        onStateChange: (e: { data: number }) => void;
        onError: () => void;
      };
    },
  ) => YTInstance;
}
declare global {
  interface Window {
    YT?: YTApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}
let ready: Promise<void> | null = null;
function canPlayYouTube(frame: HTMLElement | null) {
  if (
    document.hidden ||
    document.querySelector("dialog[open]") ||
    !frame?.isConnected
  )
    return false;
  const rect = frame.getBoundingClientRect();
  const card = frame.closest(".youtube-dock")?.getBoundingClientRect();
  const viewport = window.visualViewport;
  const top = Math.max(viewport?.offsetTop ?? 0, card?.top ?? 0);
  const left = Math.max(viewport?.offsetLeft ?? 0, card?.left ?? 0);
  const bottom = Math.min(
    (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
    card?.bottom ?? window.innerHeight,
  );
  const right = Math.min(
    (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth),
    card?.right ?? window.innerWidth,
  );
  return (
    rect.width >= 200 &&
    rect.height >= 200 &&
    rect.top >= top - 1 &&
    rect.bottom <= bottom + 1 &&
    rect.left >= left - 1 &&
    rect.right <= right + 1
  );
}
function loadYouTube() {
  if (typeof window.YT?.Player === "function") return Promise.resolve();
  if (!ready)
    ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ready = null;
        reject(
          new Error(
            "YouTube did not respond. Check your connection and try another video.",
          ),
        );
      }, 10000);
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timeout);
        previous?.();
        resolve();
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.onerror = () => {
        clearTimeout(timeout);
        ready = null;
        reject(new Error("Cannot load YouTube. Check your connection."));
      };
      document.head.appendChild(script);
    });
  return ready;
}
export function YouTubePlayer() {
  const { player, listeningEvent, playback } = useApp();
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const state = usePlayer();
  const track = state.queue[state.index];
  const entryId =
    state.entryIds?.[state.index] ?? `${track?.id ?? ""}:${state.index}`;
  const videoId =
    !Capacitor.isNativePlatform() &&
    track?.provider === "youtube" &&
    state.mode === "video"
      ? track.externalId
      : null;
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<YTInstance | null>(null);
  const position = useRef(0);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!videoId || !container.current) return;
    let disposed = false;
    let playId = crypto.randomUUID();
    let started = false;
    let completed = false;
    const report = (kind: "play" | "skip" | "complete" | "progress") => {
      if (!track || !started) return;
      const yt = instance.current;
      listeningEvent({
        track,
        playId,
        kind,
        completion: yt?.getDuration()
          ? Math.min(1, yt.getCurrentTime() / yt.getDuration())
          : 0,
      });
    };
    const node = document.createElement("div");
    container.current.replaceChildren(node);
    setError("");
    void loadYouTube()
      .then(() => {
        if (disposed || !window.YT) return;
        instance.current = new window.YT.Player(node, {
          videoId,
          width: "100%",
          height: "200",
          playerVars: {
            origin: location.origin,
            playsinline: 1,
            controls: 1,
            autoplay: 0,
          },
          events: {
            onReady: (e) => {
              if (disposed) return;
              instance.current = e.target;
              const s = player.getSnapshot();
              position.current = s.position;
              e.target.setVolume(s.volume * 100);
              if (!s.playing) {
                if (e.target.cueVideoById)
                  e.target.cueVideoById({ videoId, startSeconds: s.position });
                else e.target.seekTo(s.position, false);
                e.target.pauseVideo();
              } else if (canPlayYouTube(container.current)) {
                e.target.seekTo(s.position, true);
                e.target.playVideo();
              } else if (s.playing) {
                if (playbackRef.current.source?.kind === "youtube")
                  player.dispatch({ type: "pause" });
                else player.dispatch({ type: "mode", mode: "audio" });
              }
            },
            onStateChange: (e) => {
              if (disposed || player.getSnapshot().mode !== "video") return;
              if (e.data === 1 && !canPlayYouTube(container.current)) {
                if (playbackRef.current.source?.kind === "youtube")
                  player.dispatch({ type: "pause" });
                else player.dispatch({ type: "mode", mode: "audio" });
                instance.current?.pauseVideo();
                return;
              }
              if (e.data === 1 && !player.getSnapshot().playing) {
                // Programmatic cue/seek events never authorize playback. An actual
                // embedded-control gesture focuses this iframe and activates its window.
                const focused = document.activeElement;
                const embeddedGesture =
                  focused instanceof HTMLIFrameElement &&
                  container.current?.contains(focused) &&
                  navigator.userActivation?.isActive;
                if (!embeddedGesture) {
                  instance.current?.pauseVideo();
                  return;
                }
                player.dispatch({ type: "toggle" });
              }
              if (e.data === 0) {
                if (!player.getSnapshot().playing) return;
                completed = true;
                report("complete");
                const before = player.getSnapshot().index;
                player.dispatch({ type: "next", ended: true });
                const after = player.getSnapshot();
                if (
                  after.index === before &&
                  after.playing &&
                  after.position === 0
                ) {
                  playId = crypto.randomUUID();
                  started = false;
                  completed = false;
                  instance.current?.seekTo(0, true);
                  instance.current?.playVideo();
                }
              }
              if (e.data === 1 && !started) {
                started = true;
                report("play");
              }
              if (e.data === 2) player.dispatch({ type: "pause" });
            },
            onError: () => {
              if (disposed) return;
              setError(
                "This video cannot be embedded or is unavailable in your region. Open it on YouTube or choose another result.",
              );
              player.dispatch({ type: "pause" });
            },
          },
        });
      })
      .catch((e) => {
        if (disposed) return;
        setError(e.message);
        player.dispatch({ type: "pause" });
      });
    const tick = setInterval(() => {
      const yt = instance.current;
      if (yt) {
        position.current = yt.getCurrentTime();
        player.dispatch({
          type: "progress",
          position: position.current,
          duration: yt.getDuration(),
        });
      }
    }, 1000);
    const visibility = () => {
      if (!canPlayYouTube(container.current)) {
        if (playbackRef.current.source?.kind === "youtube")
          player.dispatch({ type: "pause" });
        else player.dispatch({ type: "mode", mode: "audio" });
        instance.current?.pauseVideo();
      }
    };
    const dialogs = new MutationObserver(visibility);
    dialogs.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    visibility();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("resize", visibility);
    window.visualViewport?.addEventListener("resize", visibility);
    window.visualViewport?.addEventListener("scroll", visibility);
    const card = container.current?.closest(".youtube-dock");
    card?.addEventListener("scroll", visibility);
    return () => {
      disposed = true;
      clearInterval(tick);
      dialogs.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("resize", visibility);
      window.visualViewport?.removeEventListener("resize", visibility);
      window.visualViewport?.removeEventListener("scroll", visibility);
      card?.removeEventListener("scroll", visibility);
      if (!completed) report("progress");
      instance.current?.destroy();
      instance.current = null;
    };
  }, [videoId, track, entryId, player, listeningEvent]);
  useEffect(() => {
    const yt = instance.current;
    if (!yt || !videoId) return;
    if (state.playing && !canPlayYouTube(container.current)) {
      if (playbackRef.current.source?.kind === "youtube")
        player.dispatch({ type: "pause" });
      else player.dispatch({ type: "mode", mode: "audio" });
      yt.pauseVideo();
      return;
    }
    if (state.playing) yt.playVideo();
    else yt.pauseVideo();
    yt.setVolume(state.volume * 100);
    if (Math.abs(state.position - position.current) > 1.5) {
      if (!state.playing && yt.cueVideoById)
        yt.cueVideoById({ videoId, startSeconds: state.position });
      else yt.seekTo(state.position, state.playing);
      if (!state.playing) yt.pauseVideo();
      position.current = state.position;
    }
  }, [videoId, state.playing, state.position, state.volume, player]);
  if (!videoId) return null;
  return (
    <aside
      className={`youtube-dock${error ? " youtube-dock-error" : ""}`}
      aria-label="YouTube video player"
    >
      <div className="youtube-dock-head">
        <div className="youtube-dock-title">
          <strong>YouTube</strong>
          <span title={track?.title}>{track?.title}</span>
        </div>
        <a
          href={`https://www.youtube.com/watch?v=${videoId}`}
          target="_blank"
          rel="noreferrer"
          aria-label="Open on YouTube"
        >
          <ExternalLink size={17} />
        </a>
        <button
          type="button"
          className="icon-button"
          aria-label={
            playback.source?.kind === "youtube"
              ? "Close video"
              : "Back to audio"
          }
          onClick={() => {
            if (playback.source?.kind === "youtube")
              player.dispatch({ type: "pause" });
            player.dispatch({ type: "mode", mode: "audio" });
          }}
        >
          <X size={17} />
        </button>
      </div>
      <div className="youtube-video-frame" ref={container} />
      {error && <p role="alert">{error}</p>}
    </aside>
  );
}
