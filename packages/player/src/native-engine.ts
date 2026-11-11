import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { Track, PlaybackSource } from "@aurelia/core";
import type { PlayerStore } from "./index";
import type { ListeningEvent } from "./browser-engine";
interface NativeProgress {
  position: number;
  duration: number;
  playing: boolean;
  audible: boolean;
}
interface AudioBridge {
  load(options: {
    url: string;
    title: string;
    artist: string;
    album: string;
    position: number;
    playing: boolean;
    volume: number;
  }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { position: number }): Promise<void>;
  volume(options: { value: number }): Promise<void>;
  stop(): Promise<void>;
  addListener(
    event: "progress",
    listener: (event: NativeProgress) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "ended",
    listener: () => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "control",
    listener: (event: { action: string }) => void,
  ): Promise<PluginListenerHandle>;
}
const bridge = registerPlugin<AudioBridge>("AureliaAudio");
export class NativeAudioEngine {
  private key = "";
  private track: Track | null = null;
  private playId = "";
  private lastPosition = 0;
  private lastPlaying = false;
  private lastVolume = -1;
  private unsubscribe: () => void;
  private handles: PluginListenerHandle[] = [];
  private controller: AbortController | null = null;
  private disposed = false;
  private loaded = false;
  private started = false;
  constructor(
    private store: PlayerStore,
    private resolve: (
      track: Track,
      signal: AbortSignal,
    ) => Promise<PlaybackSource>,
    private event: (event: ListeningEvent) => void,
    private fail: (message: string) => void,
  ) {
    this.unsubscribe = store.subscribe(this.sync);
    void Promise.all([
      bridge.addListener("progress", (progress) => {
        if (this.disposed) return;
        if (progress.audible && !this.started) {
          this.started = true;
          this.report("play");
        }
        this.lastPosition = progress.position;
        this.lastPlaying = progress.playing;
        const state = this.store.getSnapshot();
        if (state.playing !== progress.playing)
          this.store.dispatch({ type: progress.playing ? "toggle" : "pause" });
        this.store.dispatch({
          type: "progress",
          position: progress.position,
          duration: progress.duration,
        });
      }),
      bridge.addListener("ended", () => {
        if (this.disposed) return;
        this.report("complete");
        const key = this.key;
        this.store.dispatch({ type: "next", ended: true });
        if (key === this.key && this.store.getSnapshot().playing) {
          this.playId = crypto.randomUUID();
          this.started = false;
          this.lastPosition = 0;
          void bridge.seek({ position: 0 }).then(() => bridge.play());
        }
      }),
      bridge.addListener("control", (event) => {
        if (this.disposed) return;
        if (event.action === "next") this.store.dispatch({ type: "next" });
        if (event.action === "previous")
          this.store.dispatch({ type: "previous" });
      }),
    ])
      .then((handles) => {
        if (this.disposed) handles.forEach((h) => void h.remove());
        else this.handles = handles;
      })
      .catch(() => {
        if (!this.disposed)
          this.fail(
            "The native audio bridge is unavailable. Sync the iOS project.",
          );
      });
    this.sync();
  }
  private report(kind: ListeningEvent["kind"]) {
    if (this.track && this.playId && this.started) {
      const s = this.store.getSnapshot();
      this.event({
        track: this.track,
        playId: this.playId,
        kind,
        completion: s.duration
          ? Math.min(1, this.lastPosition / s.duration)
          : 0,
      });
    }
  }
  private sync = () => {
    const s = this.store.getSnapshot();
    const track = s.queue[s.index];
    const key = track ? `${track.id}:${s.index}` : "";
    if (key !== this.key) {
      this.report("progress");
      this.controller?.abort();
      void bridge.stop();
      this.loaded = false;
      this.started = false;
      this.key = key;
      this.track = track ?? null;
      if (!track || track.provider !== "studio") return;
      const controller = new AbortController();
      this.controller = controller;
      this.playId = crypto.randomUUID();
      void this.resolve(track, controller.signal)
        .then(async (source) => {
          if (controller.signal.aborted || source.kind !== "audio") return;
          const current = this.store.getSnapshot();
          await bridge.load({
            url: new URL(source.url, location.origin).href,
            title: track.title,
            artist: track.artist,
            album: track.album,
            position: current.position,
            playing: current.playing,
            volume: current.volume,
          });
          if (controller.signal.aborted) return;
          this.loaded = true;
          this.lastPosition = current.position;
          this.lastPlaying = current.playing;
          this.lastVolume = current.volume;
          this.sync();
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            this.fail(
              error instanceof Error
                ? error.message
                : "Native playback unavailable",
            );
            this.store.dispatch({ type: "pause" });
          }
        });
      return;
    }
    if (!this.loaded || track?.provider !== "studio") return;
    if (Math.abs(s.position - this.lastPosition) > 1) {
      this.lastPosition = s.position;
      void bridge.seek({ position: s.position });
    }
    if (s.playing !== this.lastPlaying) {
      this.lastPlaying = s.playing;
      void (s.playing ? bridge.play() : bridge.pause());
    }
    if (s.volume !== this.lastVolume) {
      this.lastVolume = s.volume;
      void bridge.volume({ value: s.volume });
    }
  };
  dispose() {
    this.report("progress");
    this.disposed = true;
    this.controller?.abort();
    this.unsubscribe();
    this.handles.forEach((h) => void h.remove());
    void bridge.stop();
  }
}
