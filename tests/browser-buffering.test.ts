import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserAudioEngine,
  PlayerStore,
  type ListeningEvent,
} from "@aurelia/player";
import { catalogue } from "@aurelia/music";
import type { PlaybackSource, Track } from "@aurelia/core";

class TestAudio extends EventTarget {
  static current: TestAudio;
  src = "";
  preload = "";
  volume = 1;
  currentTime = 0;
  duration = 300;
  readyState = 0;
  seeking = false;
  paused = true;
  ended = false;
  constructor() {
    super();
    TestAudio.current = this;
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
  async play() {
    this.paused = false;
  }
  metadata() {
    this.readyState = 4;
    this.dispatchEvent(new Event("loadedmetadata"));
  }
  playing() {
    this.readyState = 4;
    this.dispatchEvent(new Event("playing"));
  }
  progress(position: number) {
    this.currentTime = position;
    this.dispatchEvent(new Event("timeupdate"));
  }
  wait(event: "waiting" | "stalled" = "waiting") {
    this.readyState = 2;
    this.dispatchEvent(new Event(event));
  }
}

const track: Track = {
  ...catalogue[0],
  id: "youtube:aqz-KE-bpKQ",
  provider: "youtube",
  externalId: "aqz-KE-bpKQ",
  duration: 300,
};
const source: PlaybackSource = {
  kind: "audio",
  url: "/api/audio?id=aqz-KE-bpKQ",
  duration: 300,
  capabilities: { background: true, seek: true, mediaSession: true },
};
let engine: BrowserAudioEngine | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Audio", TestAudio);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", {});
});
afterEach(() => {
  engine?.dispose();
  engine = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function playingAudio() {
  const store = new PlayerStore();
  const resolve = vi.fn(async () => source);
  const fail = vi.fn();
  const events: ListeningEvent[] = [];
  engine = new BrowserAudioEngine(
    store,
    resolve,
    (event) => events.push(event),
    fail,
  );
  store.dispatch({ type: "play", tracks: [track] });
  await Promise.resolve();
  TestAudio.current.metadata();
  TestAudio.current.playing();
  TestAudio.current.progress(42);
  return { store, resolve, fail, events, audio: TestAudio.current };
}

describe("browser audio after metadata buffering", () => {
  it("recovers a silent network stall once, then pauses instead of retrying forever", async () => {
    const { store, resolve, fail, events, audio } = await playingAudio();
    audio.wait();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({
      position: 42,
      playing: true,
      mode: "audio",
    });
    audio.metadata();
    expect(audio.currentTime).toBe(42);
    audio.playing();
    audio.wait("stalled");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.getSnapshot()).toMatchObject({ position: 42, playing: false });
    expect(fail).toHaveBeenCalledWith(
      expect.stringContaining("Retry Play or watch the video"),
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.kind === "play")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it("does not let repeated stalled timeupdates or waiting events renew the deadline", async () => {
    const { resolve, audio } = await playingAudio();
    audio.wait();
    await vi.advanceTimersByTimeAsync(10_000);
    audio.progress(42);
    audio.wait();
    await vi.advanceTimersByTimeAsync(10_000);
    audio.progress(42);
    audio.wait("stalled");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it("allows transient buffering to recover through playing or actual progress", async () => {
    const { store, resolve, audio } = await playingAudio();
    audio.wait();
    await vi.advanceTimersByTimeAsync(20_000);
    audio.playing();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolve).toHaveBeenCalledTimes(1);
    audio.wait();
    await vi.advanceTimersByTimeAsync(20_000);
    audio.progress(43);
    // Progress while still low on data starts a fresh bounded wait.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(resolve).toHaveBeenCalledTimes(1);
    audio.readyState = 4;
    audio.progress(44);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ position: 44, playing: true });
  });
  it("ignores a stalled fetch while enough audio remains buffered", async () => {
    const { resolve, audio } = await playingAudio();
    audio.dispatchEvent(new Event("stalled"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it("cancels a paused deadline and re-arms only when playback is requested again", async () => {
    const { store, resolve, audio } = await playingAudio();
    audio.wait();
    await vi.advanceTimersByTimeAsync(20_000);
    store.dispatch({ type: "pause" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ position: 42, playing: false });
    store.dispatch({ type: "toggle" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it("does not resume when paused during a pending recovery", async () => {
    const { store, audio } = await playingAudio();
    audio.wait();
    await vi.advanceTimersByTimeAsync(30_000);
    store.dispatch({ type: "pause" });
    audio.metadata();
    expect(audio.paused).toBe(true);
    expect(audio.currentTime).toBe(42);
    expect(store.getSnapshot()).toMatchObject({ position: 42, playing: false });
  });
  it("hands off a failed recovery to the resolver's video fallback at the same position", async () => {
    const { store, resolve, audio } = await playingAudio();
    resolve.mockResolvedValueOnce({
      kind: "youtube",
      videoId: track.externalId,
      capabilities: { background: false, seek: true, mediaSession: false },
    });
    audio.wait();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.getSnapshot()).toMatchObject({
      position: 42,
      playing: true,
      mode: "video",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it("does not reload audio while video owns playback", async () => {
    const { store, resolve, audio } = await playingAudio();
    audio.wait();
    store.dispatch({ type: "mode", mode: "video" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({
      position: 42,
      playing: true,
      mode: "video",
    });
    store.dispatch({ type: "mode", mode: "audio" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resolve).toHaveBeenCalledTimes(2);
    audio.metadata();
    expect(audio.currentTime).toBe(42);
  });
  it("gives a seek a fresh deadline and resumes at the requested position", async () => {
    const { store, resolve, audio } = await playingAudio();
    audio.wait();
    await vi.advanceTimersByTimeAsync(20_000);
    store.dispatch({ type: "seek", position: 120 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(resolve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolve).toHaveBeenCalledTimes(2);
    audio.metadata();
    expect(audio.currentTime).toBe(120);
    expect(store.getSnapshot()).toMatchObject({ position: 120, playing: true });
  });
  it("cancels the old wait on a quality load and keeps the listening playId", async () => {
    const { store, resolve, events, audio } = await playingAudio();
    audio.wait();
    await vi.advanceTimersByTimeAsync(20_000);
    store.dispatch({ type: "quality", quality: "high" });
    await Promise.resolve();
    audio.metadata();
    audio.playing();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({
      position: 42,
      playing: true,
      quality: "high",
    });
    expect(events.filter((event) => event.kind === "play")).toHaveLength(1);
    expect(new Set(events.map((event) => event.playId)).size).toBe(1);
  });
  it("cancels the deadline on disposal", async () => {
    const { resolve, fail, audio } = await playingAudio();
    audio.wait();
    engine!.dispose();
    engine = undefined;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
  });
});
