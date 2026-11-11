import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserAudioEngine,
  PlayerStore,
  initialPlayer,
  type ListeningEvent,
} from "@aurelia/player";
import { catalogue } from "@aurelia/music";
import type { PlaybackSource, Track } from "@aurelia/core";

class HydrationAudio extends EventTarget {
  static current: HydrationAudio;
  src = "";
  preload = "";
  volume = 1;
  currentTime = 0;
  duration = 72;
  readyState = 0;
  seeking = false;
  paused = true;
  ended = false;
  playCalls = 0;
  constructor() {
    super();
    HydrationAudio.current = this;
  }
  canPlayType() {
    return "";
  }
  removeAttribute() {
    this.src = "";
  }
  load() {
    this.currentTime = 0;
  }
  pause() {
    this.paused = true;
  }
  async play() {
    this.playCalls++;
    this.paused = false;
  }
  metadata() {
    this.readyState = 4;
    this.dispatchEvent(new Event("loadedmetadata"));
  }
}

const youtube: Track = {
  ...catalogue[0],
  id: "youtube:abcdefghijk",
  externalId: "abcdefghijk",
  provider: "youtube",
};
const audio: PlaybackSource = {
  kind: "audio",
  url: "/audio/1.mp3",
  duration: 72,
  capabilities: { background: true, seek: true, mediaSession: true },
};
const fallback: PlaybackSource = {
  kind: "youtube",
  videoId: "abcdefghijk",
  capabilities: { background: false, seek: true, mediaSession: false },
};
let engine: BrowserAudioEngine | undefined;
beforeEach(() => {
  vi.stubGlobal("Audio", HydrationAudio);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", {});
});
afterEach(() => {
  engine?.dispose();
  engine = undefined;
  vi.unstubAllGlobals();
});
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("page-load player hydration", () => {
  it.each([
    "dispose",
    "pause-resume",
    "seek",
    "queue",
    "autoplay-off",
  ] as const)(
    "rejects an ended-related continuation after %s changes its ownership or intent",
    async (action) => {
      const store = new PlayerStore();
      let resolveRelated!: (tracks: Track[]) => void;
      const related = vi.fn(
        () =>
          new Promise<Track[]>((resolve) => {
            resolveRelated = resolve;
          }),
      );
      engine = new BrowserAudioEngine(
        store,
        async () => audio,
        vi.fn(),
        vi.fn(),
        related,
      );
      store.dispatch({ type: "play", tracks: [catalogue[0]] });
      await flush();
      HydrationAudio.current.metadata();
      HydrationAudio.current.dispatchEvent(new Event("ended"));
      expect(related).toHaveBeenCalledOnce();
      if (action === "dispose") engine.dispose();
      if (action === "pause-resume") {
        store.dispatch({ type: "pause" });
        store.dispatch({ type: "toggle" });
      }
      if (action === "seek") store.dispatch({ type: "seek", position: 12 });
      if (action === "queue")
        store.dispatch({ type: "queue", track: catalogue[2] });
      if (action === "autoplay-off")
        store.dispatch({ type: "autoplay", enabled: false });
      const before = store.getSnapshot();
      resolveRelated([catalogue[1]]);
      await flush();
      expect(store.getSnapshot()).toBe(before);
    },
  );
  it("keeps a listener with no saved playback empty without loading or playing a seed track", () => {
    const store = new PlayerStore(),
      resolve = vi.fn(async () => audio);
    engine = new BrowserAudioEngine(store, resolve, vi.fn(), vi.fn());
    expect(store.getSnapshot()).toEqual(initialPlayer);
    expect(resolve).not.toHaveBeenCalled();
    expect(HydrationAudio.current.playCalls).toBe(0);
  });
  it.each([catalogue[0], youtube])(
    "restores $provider queue and position paused, loading only after explicit Play",
    async (track) => {
      const store = new PlayerStore(),
        resolve = vi.fn(async () => audio);
      store.dispatch({
        type: "restore",
        state: {
          ...initialPlayer,
          queue: [track, catalogue[1]],
          index: 0,
          position: 27,
          duration: 72,
          playing: true,
        },
      });
      engine = new BrowserAudioEngine(store, resolve, vi.fn(), vi.fn());
      await flush();
      expect(store.getSnapshot()).toMatchObject({
        index: 0,
        position: 27,
        playing: false,
        mode: "audio",
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(HydrationAudio.current.playCalls).toBe(0);
      store.dispatch({ type: "toggle" });
      await flush();
      expect(resolve).toHaveBeenCalledOnce();
      HydrationAudio.current.metadata();
      expect(HydrationAudio.current.currentTime).toBe(27);
      expect(HydrationAudio.current.playCalls).toBe(1);
    },
  );
  it("does not let a delayed video fallback open a paused iframe, but resumes it after explicit Play", async () => {
    const store = new PlayerStore();
    let deliver!: (source: PlaybackSource) => void;
    engine = new BrowserAudioEngine(
      store,
      () =>
        new Promise<PlaybackSource>((resolve) => {
          deliver = resolve;
        }),
      vi.fn(),
      vi.fn(),
    );
    store.dispatch({ type: "play", tracks: [youtube] });
    store.dispatch({ type: "pause" });
    deliver(fallback);
    await flush();
    expect(store.getSnapshot()).toMatchObject({
      playing: false,
      mode: "audio",
    });
    store.dispatch({ type: "toggle" });
    expect(store.getSnapshot()).toMatchObject({ playing: true, mode: "video" });
  });
  it("ignores late completion after pause and preserves normal related-track autoplay after Play", async () => {
    const store = new PlayerStore(),
      related = vi.fn(async () => [catalogue[1]]);
    const events: ListeningEvent[] = [];
    engine = new BrowserAudioEngine(
      store,
      async () => audio,
      (event) => events.push(event),
      vi.fn(),
      related,
    );
    store.dispatch({ type: "play", tracks: [catalogue[0]] });
    await flush();
    HydrationAudio.current.metadata();
    store.dispatch({ type: "pause" });
    HydrationAudio.current.dispatchEvent(new Event("ended"));
    expect(related).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(store.getSnapshot()).toMatchObject({ index: 0, playing: false });
    store.dispatch({ type: "toggle" });
    HydrationAudio.current.dispatchEvent(new Event("ended"));
    await flush();
    expect(related).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({ index: 1, playing: true });
  });
});
