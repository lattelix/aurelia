import type { PlaybackSource, Track } from "@aurelia/core";
import type { PlayerStore } from "./index";
export interface ListeningEvent {
  track: Track;
  playId: string;
  kind: "play" | "skip" | "complete" | "progress";
  completion: number;
}
export interface PlaybackStatus {
  state: "idle" | "loading" | "ready" | "error";
  source?: PlaybackSource;
  message?: string;
}
export class BrowserAudioEngine {
  private audio = new Audio();
  private key = "";
  private current: Track | null = null;
  private playId = "";
  private lastPosition = 0;
  private controller: AbortController | null = null;
  private unlisten: () => void;
  private disposed = false;
  private ready = false;
  private started = false;
  private source: PlaybackSource | null = null;
  private audioOwnsSession = false;
  private refreshing = false;
  private refreshAttempts = 0;
  private playAttempt = 0;
  private metadataTimer: ReturnType<typeof setTimeout> | undefined;
  private bufferTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private store: PlayerStore,
    private resolve: (
      track: Track,
      signal: AbortSignal,
    ) => Promise<PlaybackSource>,
    private event: (event: ListeningEvent) => void,
    private fail: (message: string) => void,
    private related?: (track: Track) => Promise<Track[]>,
    private status?: (status: PlaybackStatus) => void,
    private accepts: (track: Track) => boolean = () => true,
  ) {
    this.audio.preload = "metadata";
    this.audio.addEventListener("timeupdate", this.progress);
    this.audio.addEventListener("loadedmetadata", this.metadataReady);
    this.audio.addEventListener("ended", this.ended);
    this.audio.addEventListener("playing", this.playing);
    this.audio.addEventListener("error", this.error);
    this.audio.addEventListener("waiting", this.buffering);
    this.audio.addEventListener("stalled", this.buffering);
    this.unlisten = store.subscribe(this.sync);
    this.sync();
    window.addEventListener("keydown", this.keyboard);
  }
  private report(kind: ListeningEvent["kind"]) {
    if (this.current && this.playId && this.started)
      this.event({
        track: this.current,
        playId: this.playId,
        kind,
        completion: this.audio.duration
          ? Math.min(1, this.audio.currentTime / this.audio.duration)
          : 0,
      });
  }
  private playing = () => {
    if (
      this.disposed ||
      !this.ready ||
      this.videoActive() ||
      !this.store.getSnapshot().playing ||
      this.audio.paused
    )
      return;
    this.clearBufferTimer();
    if (this.started) return;
    this.started = true;
    this.report("play");
  };
  private metadataReady = () => {
    if (this.disposed || !this.current || !Number.isFinite(this.audio.duration))
      return;
    this.lastPosition = Math.min(
      this.store.getSnapshot().position,
      this.audio.duration,
    );
    this.audio.currentTime = this.lastPosition;
    this.ready = true;
    clearTimeout(this.metadataTimer);
    this.refreshing = false;
    this.status?.({ state: "ready", source: this.source ?? undefined });
    this.sync();
  };
  private progress = () => {
    if (
      !this.ready ||
      this.disposed ||
      this.videoActive() ||
      this.audio.seeking ||
      !Number.isFinite(this.audio.duration)
    )
      return;
    // Some browsers keep emitting timeupdate while a request is stalled.
    if (this.audio.currentTime > this.lastPosition + 0.01)
      this.clearBufferTimer();
    this.lastPosition = this.audio.currentTime;
    this.store.dispatch({
      type: "progress",
      position: this.audio.currentTime,
      duration: this.audio.duration,
    });
    if ("mediaSession" in navigator && this.audioOwnsSession) {
      try {
        navigator.mediaSession.setPositionState({
          duration: this.audio.duration,
          position: Math.min(this.audio.currentTime, this.audio.duration),
          playbackRate: 1,
        });
      } catch {
        /* Older WebKit does not expose position state. */
      }
    }
  };
  private ended = () => {
    if (
      this.disposed ||
      this.videoActive() ||
      !this.ready ||
      !this.store.getSnapshot().playing
    )
      return;
    this.clearBufferTimer();
    this.report("complete");
    this.playId = crypto.randomUUID();
    this.started = false;
    const state = this.store.getSnapshot();
    const current = this.current;
    if (
      state.autoplay &&
      state.repeat === "off" &&
      state.index === state.queue.length - 1 &&
      current &&
      this.related
    ) {
      const key = this.key;
      const intent = this.store.getIntentRevision();
      const canAdvance = () => {
        const latest = this.store.getSnapshot();
        return (
          !this.disposed &&
          this.key === key &&
          this.store.getIntentRevision() === intent &&
          latest.playing &&
          latest.autoplay &&
          latest.repeat === "off" &&
          latest.index === state.index &&
          latest.entryIds?.[latest.index] === state.entryIds?.[state.index]
        );
      };
      void this.related(current)
        .then((tracks) => {
          if (!canAdvance()) return;
          for (const track of tracks
            .filter((t) => t.id !== current.id)
            .slice(0, 5))
            this.store.dispatch({ type: "queue", track });
          this.store.dispatch({ type: "next", ended: true });
        })
        .catch(() => {
          if (canAdvance()) this.store.dispatch({ type: "next", ended: true });
        });
      return;
    }
    this.store.dispatch({ type: "next", ended: true });
  };
  private error = () => {
    if (this.disposed || !this.current || this.videoActive() || this.refreshing)
      return;
    this.recoverPlayback(
      "This recording could not be loaded. Retry Play or watch the video.",
    );
  };
  private clearBufferTimer() {
    clearTimeout(this.bufferTimer);
    this.bufferTimer = undefined;
  }
  private buffering = () => {
    if (
      this.bufferTimer !== undefined ||
      this.disposed ||
      !this.current ||
      !this.ready ||
      this.refreshing ||
      this.videoActive() ||
      !this.store.getSnapshot().playing ||
      this.audio.readyState >= 3
    )
      return;
    this.bufferTimer = setTimeout(() => {
      this.bufferTimer = undefined;
      if (
        this.disposed ||
        !this.ready ||
        this.refreshing ||
        this.videoActive() ||
        !this.store.getSnapshot().playing ||
        this.audio.readyState >= 3
      )
        return;
      this.recoverPlayback(
        "Audio stopped receiving data. Retry Play or watch the video.",
      );
    }, 30_000);
  };
  private recoverPlayback(message: string) {
    this.clearBufferTimer();
    if (!this.current) return;
    if (this.current.provider === "youtube" && this.refreshAttempts < 1) {
      this.refreshAttempts++;
      this.refreshing = true;
      this.load(this.current, true);
      return;
    }
    this.playbackFailure(message);
  }
  private videoActive() {
    return (
      this.current?.provider === "youtube" &&
      this.store.getSnapshot().mode === "video"
    );
  }
  private playbackFailure(message: string) {
    this.clearBufferTimer();
    clearTimeout(this.metadataTimer);
    this.controller?.abort();
    this.ready = false;
    this.refreshing = false;
    this.status?.({ state: "error", message });
    this.store.dispatch({ type: "pause" });
    this.fail(message);
  }
  private load(track: Track, refresh = false) {
    this.playAttempt++;
    this.clearBufferTimer();
    clearTimeout(this.metadataTimer);
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.ready = false;
    this.audio.pause();
    this.status?.({ state: "loading" });
    this.metadataTimer = setTimeout(() => {
      if (!controller.signal.aborted && !this.ready && !this.videoActive())
        this.playbackFailure(
          "Audio is taking too long to load. Retry Play or watch the video.",
        );
    }, 45_000);
    void this.resolve(track, controller.signal)
      .then((source) => {
        if (controller.signal.aborted || this.disposed) return;
        this.source = source;
        if (source.kind !== "audio") {
          clearTimeout(this.metadataTimer);
          this.clearMedia();
          this.ready = true;
          this.refreshing = false;
          if (source.notice) this.fail(source.notice);
          this.status?.({ state: "ready", source });
          if (this.store.getSnapshot().playing)
            this.store.dispatch({ type: "mode", mode: "video" });
          return;
        }
        this.audio.src =
          source.hlsUrl &&
          this.audio.canPlayType("application/vnd.apple.mpegurl")
            ? source.hlsUrl
            : source.url;
        // A same-URL reload is intentional after a transient upstream rejection.
        if (refresh) this.lastPosition = this.store.getSnapshot().position;
        this.audio.load();
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        const message =
          error instanceof Error ? error.message : "Playback unavailable";
        if (this.videoActive()) {
          controller.abort();
          this.status?.({ state: "error", message });
        } else this.playbackFailure(message);
      });
  }
  private sync = () => {
    const state = this.store.getSnapshot();
    // pause() rejects a pending play() asynchronously. Invalidate that attempt
    // before another owner or a newer play request can use its result.
    if (!state.playing || this.videoActive()) this.playAttempt++;
    if (!state.playing) this.clearBufferTimer();
    const track = state.queue[state.index];
    // Ownership can change synchronously before React replaces the adapter.
    // Never start a web request for a recording owned by a device transport.
    if (track && !this.accepts(track)) {
      this.playAttempt++;
      this.controller?.abort();
      this.controller = null;
      this.clearBufferTimer();
      clearTimeout(this.metadataTimer);
      this.audio.pause();
      this.clearMedia();
      this.ready = false;
      this.current = null;
      this.key = "";
      return;
    }
    const occurrence =
      state.entryIds?.[state.index] ?? `${track?.id}:${state.index}`;
    const key = track ? `${occurrence}:${state.quality}` : "";
    if (key !== this.key) {
      const qualityChange = !!track && this.key.startsWith(`${occurrence}:`);
      this.clearMedia();
      if (this.current && this.audio.currentTime > 1)
        this.report(
          track?.id === this.current.id
            ? "progress"
            : this.audio.currentTime / (this.audio.duration || 1) < 0.85
              ? "skip"
              : "progress",
        );
      this.controller?.abort();
      this.audio.pause();
      this.ready = false;
      this.audio.removeAttribute("src");
      this.audio.load();
      if (!qualityChange) this.started = false;
      this.refreshAttempts = 0;
      this.refreshing = false;
      this.source = null;
      this.key = key;
      this.current = track ?? null;
      this.lastPosition = state.position;
      if (!track) {
        this.status?.({ state: "idle" });
        return;
      }
      if (!qualityChange) this.playId = crypto.randomUUID();
      if (!state.playing) {
        this.status?.({ state: "idle" });
        return;
      }
      this.load(track);
      return;
    }
    if (this.videoActive()) {
      this.clearBufferTimer();
      if (!this.audio.paused) {
        this.report("progress");
        this.audio.pause();
      }
      if (this.audioOwnsSession) this.clearMedia();
      return;
    }
    if (!track) return;
    if (this.source?.kind === "youtube") {
      if (state.playing) this.store.dispatch({ type: "mode", mode: "video" });
      return;
    }
    if (!this.ready) {
      if (
        state.playing &&
        !this.refreshing &&
        (!this.controller || this.controller.signal.aborted)
      )
        this.load(track);
      return;
    }
    if (!this.audioOwnsSession) this.media(track);
    this.audio.volume = state.volume;
    if (Math.abs(state.position - this.lastPosition) > 0.8) {
      this.clearBufferTimer();
      this.audio.currentTime = state.position;
      this.lastPosition = state.position;
    }
    this.buffering();
    const controller = this.controller;
    if (state.playing && this.audio.paused && !this.audio.ended) {
      const attempt = ++this.playAttempt;
      void this.audio.play().catch(() => {
        if (
          controller?.signal.aborted ||
          this.disposed ||
          attempt !== this.playAttempt ||
          this.videoActive() ||
          !this.store.getSnapshot().playing
        )
          return;
        this.store.dispatch({ type: "pause" });
        this.fail("Tap Play to start audio on this device.");
      });
    }
    if (!state.playing && !this.audio.paused) {
      this.report("progress");
      this.audio.pause();
    }
    if ("mediaSession" in navigator)
      navigator.mediaSession.playbackState = state.playing
        ? "playing"
        : "paused";
  };
  private media(track: Track) {
    this.audioOwnsSession = true;
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: [
        {
          src: new URL(track.artwork, location.origin).href,
          sizes: track.provider === "youtube" ? "480x360" : "800x800",
          type: track.provider === "youtube" ? "image/jpeg" : "image/svg+xml",
        },
      ],
    });
    const handlers: Partial<
      Record<MediaSessionAction, MediaSessionActionHandler>
    > = {
      play: () => {
        if (!this.store.getSnapshot().playing)
          this.store.dispatch({ type: "toggle" });
      },
      pause: () => this.store.dispatch({ type: "pause" }),
      nexttrack: () => this.store.dispatch({ type: "next" }),
      previoustrack: () => this.store.dispatch({ type: "previous" }),
      seekto: (e) =>
        this.store.dispatch({ type: "seek", position: e.seekTime ?? 0 }),
      seekbackward: () =>
        this.store.dispatch({
          type: "seek",
          position: this.audio.currentTime - 10,
        }),
      seekforward: () =>
        this.store.dispatch({
          type: "seek",
          position: this.audio.currentTime + 10,
        }),
    };
    for (const [action, handler] of Object.entries(handlers))
      try {
        navigator.mediaSession.setActionHandler(
          action as MediaSessionAction,
          handler,
        );
      } catch {
        /* Unsupported media actions are optional. */
      }
  }
  private clearMedia() {
    this.audioOwnsSession = false;
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
    for (const action of [
      "play",
      "pause",
      "nexttrack",
      "previoustrack",
      "seekto",
      "seekbackward",
      "seekforward",
    ] as const)
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {
        /* Unsupported media actions are optional. */
      }
  }
  private keyboard = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (
      target.closest(
        'input,textarea,select,[contenteditable="true"],button,a,[role="dialog"]',
      )
    )
      return;
    if (event.code === "Space") {
      event.preventDefault();
      this.store.dispatch({ type: "toggle" });
    } else if (event.altKey && event.code === "ArrowRight")
      this.store.dispatch({ type: "next" });
    else if (event.altKey && event.code === "ArrowLeft")
      this.store.dispatch({ type: "previous" });
  };
  dispose() {
    this.playAttempt++;
    this.clearBufferTimer();
    clearTimeout(this.metadataTimer);
    this.report("progress");
    this.disposed = true;
    this.controller?.abort();
    this.unlisten();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.clearMedia();
    window.removeEventListener("keydown", this.keyboard);
  }
}
