import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserAudioEngine,
  PlayerStore,
  type ListeningEvent,
} from "@aurelia/player";
import { catalogue } from "@aurelia/music";
import type { PlaybackSource, Track } from "@aurelia/core";

interface PendingPlay {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function pendingPlay(): PendingPlay {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class DeferredAudio extends EventTarget {
  static current: DeferredAudio;
  src = "";
  preload = "";
  volume = 1;
  currentTime = 0;
  duration = 300;
  readyState = 0;
  seeking = false;
  paused = true;
  ended = false;
  plays: PendingPlay[] = [];
  constructor() {
    super();
    DeferredAudio.current = this;
  }
  canPlayType() {
    return "";
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  load() {
    this.currentTime = 0;
    this.readyState = 0;
  }
  pause() {
    this.paused = true;
  }
  play() {
    this.paused = false;
    const pending = pendingPlay();
    this.plays.push(pending);
    return pending.promise;
  }
  metadata() {
    this.readyState = 4;
    this.dispatchEvent(new Event("loadedmetadata"));
  }
  playing() {
    this.readyState = 4;
    this.dispatchEvent(new Event("playing"));
  }
}

const track: Track = {
  ...catalogue[0],
  id: "youtube:aqz-KE-bpKQ",
  provider: "youtube",
  externalId: "aqz-KE-bpKQ",
  duration: 300,
};
const nextTrack: Track = {
  ...track,
  id: "youtube:abcdefghijk",
  externalId: "abcdefghijk",
  title: "Next recording",
};
const source: PlaybackSource = {
  kind: "audio",
  url: "/api/audio?id=aqz-KE-bpKQ",
  duration: 300,
  capabilities: { background: true, seek: true, mediaSession: true },
};
let engine: BrowserAudioEngine | undefined;
let session: {
  metadata: MediaMetadata | null;
  playbackState: MediaSessionPlaybackState;
  setActionHandler: ReturnType<typeof vi.fn>;
  setPositionState: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.useFakeTimers();
  session = {
    metadata: null,
    playbackState: "none",
    setActionHandler: vi.fn(),
    setPositionState: vi.fn(),
  };
  vi.stubGlobal("Audio", DeferredAudio);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", { mediaSession: session });
  vi.stubGlobal("location", { origin: "https://aurelia.example" });
  vi.stubGlobal(
    "MediaMetadata",
    class {
      constructor(init: MediaMetadataInit) {
        Object.assign(this, init);
      }
    },
  );
});
afterEach(() => {
  engine?.dispose();
  engine = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function interruptedPlay() {
  return new DOMException(
    "The play request was interrupted by pause().",
    "AbortError",
  );
}

function gestureRequired() {
  return new DOMException("A user gesture is required.", "NotAllowedError");
}

async function loadingAudio() {
  const store = new PlayerStore();
  const fail = vi.fn();
  const events: ListeningEvent[] = [];
  engine = new BrowserAudioEngine(
    store,
    async (current) => ({
      ...source,
      url: `/api/audio?id=${current.externalId}`,
    }),
    (event) => events.push(event),
    fail,
  );
  store.dispatch({ type: "play", tracks: [track, nextTrack] });
  await flush();
  const audio = DeferredAudio.current;
  audio.metadata();
  expect(audio.plays).toHaveLength(1);
  return { store, fail, events, audio, pending: audio.plays[0] };
}

describe("browser play promise lifecycle", () => {
  it.each([false, true])(
    "keeps the same source and position when current entry moves (paused=%s)",
    async (paused) => {
      const { store, audio, pending } = await loadingAudio();
      pending.resolve();
      audio.playing();
      audio.currentTime = 24;
      store.dispatch({ type: "progress", position: 24, duration: 300 });
      if (paused) store.dispatch({ type: "pause" });
      const src = audio.src;
      const loads = vi.spyOn(audio, "load");
      store.dispatch({ type: "move", from: 0, to: 1 });
      await flush();
      expect(loads).not.toHaveBeenCalled();
      expect(audio.src).toBe(src);
      expect(audio.currentTime).toBe(24);
      expect(store.getSnapshot().playing).toBe(!paused);
    // Removing a different entry before the current occurrence shifts its index again.
    store.dispatch({ type: "remove", index: 0 });
    await flush();
    expect(loads).not.toHaveBeenCalled();
    expect(audio.currentTime).toBe(24);
    },
  );

  it("does not let a paused audio promise stop the requested video", async () => {
    const { store, fail, audio, pending } = await loadingAudio();
    store.dispatch({ type: "mode", mode: "video" });
    expect(audio.paused).toBe(true);
    pending.reject(interruptedPlay());
    await flush();
    expect(store.getSnapshot()).toMatchObject({ mode: "video", playing: true });
    expect(fail).not.toHaveBeenCalled();
  });

  it.each(["AbortError", "NotAllowedError"] as const)(
    "does not let an old %s stop a newer audio play request after pause and resume",
    async (error) => {
      const { store, fail, audio, pending } = await loadingAudio();
      store.dispatch({ type: "pause" });
      // An old rejection can be queued before its catch runs. Resume in the
      // same task to make that queued result stale for the new play request.
      pending.reject(
        error === "AbortError" ? interruptedPlay() : gestureRequired(),
      );
      store.dispatch({ type: "toggle" });
      expect(audio.plays).toHaveLength(2);
      await flush();
      expect(store.getSnapshot()).toMatchObject({
        mode: "audio",
        playing: true,
      });
      expect(audio.paused).toBe(false);
      expect(session.playbackState).toBe("playing");
      expect(fail).not.toHaveBeenCalled();
    },
  );

  it("does not report an autoplay error for a play interrupted by the user pausing", async () => {
    const { store, fail, pending } = await loadingAudio();
    store.dispatch({ type: "pause" });
    pending.reject(interruptedPlay());
    await flush();
    expect(store.getSnapshot().playing).toBe(false);
    expect(session.playbackState).toBe("paused");
    expect(fail).not.toHaveBeenCalled();
  });

  it("does not record a late playing event as a listen after the user paused", async () => {
    const { store, fail, events, audio } = await loadingAudio();
    store.dispatch({ type: "pause" });
    audio.playing();
    expect(store.getSnapshot().playing).toBe(false);
    expect(session.playbackState).toBe("paused");
    expect(fail).not.toHaveBeenCalled();
    expect(events.filter((event) => event.kind === "play")).toHaveLength(0);
    store.dispatch({ type: "toggle" });
    audio.plays[1].resolve();
    audio.playing();
    await flush();
    expect(events.filter((event) => event.kind === "play")).toHaveLength(1);
  });

  it("preserves video ownership when an earlier audio promise resolves and playing arrives late", async () => {
    const { store, fail, events, audio, pending } = await loadingAudio();
    store.dispatch({ type: "mode", mode: "video" });
    const videoMetadata = new MediaMetadata({ title: "Video playback" });
    session.metadata = videoMetadata;
    session.playbackState = "playing";
    pending.resolve();
    audio.playing();
    await flush();
    expect(store.getSnapshot()).toMatchObject({ mode: "video", playing: true });
    expect(audio.paused).toBe(true);
    expect(session.metadata).toBe(videoMetadata);
    expect(session.playbackState).toBe("playing");
    expect(fail).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a stale %s after a quality reload and keeps the new audio active",
    async (settlement) => {
      const { store, fail, events, audio, pending } = await loadingAudio();
      store.dispatch({ type: "quality", quality: "high" });
      await flush();
      audio.metadata();
      expect(audio.plays).toHaveLength(2);
      if (settlement === "reject") pending.reject(gestureRequired());
      else pending.resolve();
      await flush();
      audio.plays[1].resolve();
      audio.playing();
      expect(store.getSnapshot()).toMatchObject({
        playing: true,
        quality: "high",
      });
      expect(session.playbackState).toBe("playing");
      expect(fail).not.toHaveBeenCalled();
      expect(events.filter((event) => event.kind === "play")).toHaveLength(1);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "ignores a stale %s after switching tracks and preserves the new session",
    async (settlement) => {
      const { store, fail, events, audio, pending } = await loadingAudio();
      store.dispatch({ type: "next" });
      await flush();
      audio.metadata();
      expect(audio.plays).toHaveLength(2);
      if (settlement === "reject") pending.reject(gestureRequired());
      else pending.resolve();
      await flush();
      audio.plays[1].resolve();
      audio.playing();
      expect(store.getSnapshot()).toMatchObject({ index: 1, playing: true });
      expect(session.metadata?.title).toBe(nextTrack.title);
      expect(session.playbackState).toBe("playing");
      expect(fail).not.toHaveBeenCalled();
      expect(events.filter((event) => event.kind === "play")).toMatchObject([
        { track: { id: nextTrack.id } },
      ]);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "ignores a late %s and playing event after disposal",
    async (settlement) => {
      const { store, fail, events, audio, pending } = await loadingAudio();
      const state = store.getSnapshot();
      engine!.dispose();
      engine = undefined;
      if (settlement === "reject") pending.reject(gestureRequired());
      else pending.resolve();
      audio.playing();
      await flush();
      expect(store.getSnapshot()).toBe(state);
      expect(session.metadata).toBeNull();
      expect(session.playbackState).toBe("none");
      expect(fail).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    },
  );

  it("still reports a genuine rejection of the current audio play request", async () => {
    const { store, fail, pending } = await loadingAudio();
    pending.reject(gestureRequired());
    await flush();
    expect(store.getSnapshot().playing).toBe(false);
    expect(session.playbackState).toBe("paused");
    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith(
      "Tap Play to start audio on this device.",
    );
  });
});
