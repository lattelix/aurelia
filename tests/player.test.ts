import { describe, it, expect } from "vitest";
import { initialPlayer, PlayerStore, transition } from "@aurelia/player";
import { catalogue } from "@aurelia/music";
describe("persistent player transitions", () => {
  const start = () =>
    transition(initialPlayer, { type: "play", tracks: catalogue.slice(0, 3) });
  it("accepts native queue advancement while preserving catalogue ownership", () => {
    const state = start();
    const update = {
      ...state,
      index: 1,
      position: 9,
      duration: 72,
      playing: true,
    };
    const next = transition(state, { type: "native-state", state: update });
    expect(next).toMatchObject({ index: 1, position: 9, playing: true });
    expect(next.queue).toBe(state.queue);
    expect(
      transition(state, {
        type: "native-state",
        state: { ...update, queue: [catalogue[4]] },
      }),
    ).toBe(state);
    expect(
      transition(state, {
        type: "native-state",
        state: { ...update, index: 99 },
      }),
    ).toBe(state);
    expect(
      transition(state, {
        type: "native-state",
        state: { ...update, index: -1 },
      }),
    ).toBe(state);
    expect(
      transition(state, {
        type: "native-state",
        state: { ...update, duration: Infinity },
      }),
    ).toBe(state);
  });
  it("plays and advances without losing the queue", () => {
    const s = transition(start(), { type: "next" });
    expect(s.index).toBe(1);
    expect(s.queue).toHaveLength(3);
    expect(s.playing).toBe(true);
  });
  it("stops at the end without repeat and loops with repeat all", () => {
    let s = transition(start(), { type: "play", tracks: [catalogue[0]] });
    expect(transition(s, { type: "next", ended: true }).playing).toBe(false);
    s = transition(s, { type: "repeat" });
    expect(transition(s, { type: "next", ended: true }).index).toBe(0);
  });
  it("repeat one only affects natural completion", () => {
    const s = { ...start(), repeat: "one" as const, position: 20 };
    expect(transition(s, { type: "next", ended: true }).index).toBe(0);
    expect(transition(s, { type: "next" }).index).toBe(1);
  });
  it("shuffle avoids the current track", () => {
    expect(
      transition({ ...start(), shuffle: true }, { type: "next" }, () => 0)
        .index,
    ).toBe(1);
  });
  it("reordering keeps the same current queue entry", () => {
    const s = transition(start(), { type: "move", from: 0, to: 2 });
    expect(s.index).toBe(2);
    expect(s.queue[s.index].id).toBe(catalogue[0].id);
  });
  it("removing a track before the current entry adjusts its index", () => {
    const s = transition(transition(start(), { type: "next" }), {
      type: "remove",
      index: 0,
    });
    expect(s.index).toBe(0);
    expect(s.queue[0].id).toBe(catalogue[1].id);
  });
  it("empty queues remain safe", () => {
    expect(transition(initialPlayer, { type: "previous" })).toEqual(
      initialPlayer,
    );
    expect(transition(initialPlayer, { type: "next" })).toEqual(initialPlayer);
    expect(
      transition(
        transition(initialPlayer, { type: "play", tracks: [catalogue[0]] }),
        { type: "remove", index: 0 },
      ).index,
    ).toBe(-1);
  });
  it("restores paused and rejects corrupt persistence", () => {
    expect(
      transition(initialPlayer, { type: "restore", state: start() }).playing,
    ).toBe(false);
    expect(
      transition(initialPlayer, {
        type: "restore",
        state: { queue: "broken" },
      }),
    ).toEqual(initialPlayer);
    expect(
      transition(start(), { type: "restore", state: { queue: "broken" } }),
    ).toEqual(initialPlayer);
  });
  it.each(["off", "one", "all"] as const)(
    "ignores natural completion while a restored queue is paused with repeat %s",
    (repeat) => {
      const restored = transition(initialPlayer, {
        type: "restore",
        state: { ...start(), repeat, position: 72 },
      });
      expect(transition(restored, { type: "next", ended: true })).toBe(
        restored,
      );
      expect(transition(restored, { type: "next" })).toMatchObject({
        index: 1,
        playing: true,
      });
      const resumed = transition(restored, { type: "toggle" });
      expect(transition(resumed, { type: "next", ended: true }).playing).toBe(
        true,
      );
    },
  );
  it("keeps fresh startup empty and distinguishes direct Play from restored or merely queued tracks", () => {
    const player = new PlayerStore();
    expect(player.getSnapshot()).toMatchObject({
      queue: [],
      index: -1,
      playing: false,
    });
    expect(player.hasPlayRequest()).toBe(false);
    player.dispatch({ type: "queue", track: catalogue[0] });
    expect(player.hasPlayRequest()).toBe(false);
    player.dispatch({ type: "restore", state: start() });
    expect(player.hasPlayRequest()).toBe(false);
    expect(player.getSnapshot().playing).toBe(false);
    player.dispatch({ type: "play", tracks: [catalogue[0]] });
    expect(player.hasPlayRequest()).toBe(true);
    player.dispatch({ type: "restore", state: initialPlayer });
    expect(player.hasPlayRequest()).toBe(false);
  });
  it("seek and volume are bounded", () => {
    expect(transition(start(), { type: "seek", position: 500 }).position).toBe(
      72,
    );
    expect(transition(start(), { type: "volume", volume: -2 }).volume).toBe(0);
  });
  it("refuses oversized queues and clamps restored positions", () => {
    expect(
      transition(initialPlayer, {
        type: "play",
        tracks: Array(600).fill(catalogue[0]),
        index: 599,
      }),
    ).toBe(initialPlayer);
    const s = start();
    expect(
      transition(initialPlayer, {
        type: "restore",
        state: { ...s, position: 500 },
      }).position,
    ).toBe(72);
  });
  it("can replay a completed track", () => {
    const ended = { ...start(), position: 72, playing: false };
    expect(transition(ended, { type: "toggle" })).toMatchObject({
      position: 0,
      playing: true,
    });
  });
  it("hands off audio/video and quality without losing position or play state", () => {
    const state = { ...start(), position: 24 };
    const video = transition(state, { type: "mode", mode: "video" });
    expect(video).toMatchObject({ position: 24, playing: true, mode: "video" });
    expect(
      transition(video, { type: "quality", quality: "low" }),
    ).toMatchObject({ position: 24, playing: true, quality: "low" });
    expect(
      transition(initialPlayer, { type: "restore", state: video }),
    ).toMatchObject({ position: 24, playing: false, mode: "audio" });
  });
});
