import { describe, expect, it } from "vitest";
import { PlayerStore, PlayerSnapshotSchema } from "@aurelia/player";
import { catalogue } from "@aurelia/music";

describe("queue occurrence identity", () => {
  it("selects a merely queued first entry paused", () => {
    const player = new PlayerStore();
    player.dispatch({ type: "queue", track: catalogue[0] });
    expect(player.getSnapshot()).toMatchObject({ index: 0, playing: false });
    expect(player.hasPlayRequest()).toBe(false);
  });

  it("retains distinct duplicate occurrences across moves and removals", () => {
    const player = new PlayerStore();
    player.dispatch({
      type: "play",
      tracks: [catalogue[0], catalogue[0], catalogue[1]],
      index: 1,
    });
    player.dispatch({ type: "progress", position: 22, duration: 72 });
    const ids = player.getSnapshot().entryIds!;
    expect(new Set(ids).size).toBe(3);
    player.dispatch({ type: "move", from: 1, to: 2 });
    expect(player.getSnapshot()).toMatchObject({
      index: 2,
      position: 22,
      playing: true,
    });
    expect(player.getSnapshot().entryIds?.[2]).toBe(ids[1]);
    player.dispatch({ type: "remove", index: 0 });
    expect(player.getSnapshot()).toMatchObject({ index: 1, position: 22 });
    expect(player.getSnapshot().entryIds?.[1]).toBe(ids[1]);
  });

  it("reports the queue limit and preserves every existing occurrence", () => {
    const player = new PlayerStore();
    player.dispatch({ type: "play", tracks: Array(500).fill(catalogue[0]) });
    const before = player.getSnapshot();
    expect(player.dispatch({ type: "queue", track: catalogue[1] })).toEqual({
      ok: false,
      code: "queue-full",
    });
    expect(player.getSnapshot()).toBe(before);
  });

  it("inserts Play next without replacing current audio, and clears only upcoming entries", () => {
    const player = new PlayerStore();
    player.dispatch({ type: "play", tracks: catalogue.slice(0, 3) });
    player.dispatch({ type: "progress", position: 20, duration: 72 });
    player.dispatch({ type: "pause" });
    const current = player.getSnapshot().entryIds?.[0];
    player.dispatch({ type: "play-next", track: catalogue[4] });
    expect(player.getSnapshot().queue.map((track) => track.id)).toEqual([
      catalogue[0].id,
      catalogue[4].id,
      catalogue[1].id,
      catalogue[2].id,
    ]);
    expect(player.getSnapshot()).toMatchObject({
      index: 0,
      playing: false,
      position: 20,
    });
    expect(player.getSnapshot().entryIds?.[0]).toBe(current);
    player.dispatch({ type: "clear-upcoming" });
    expect(player.getSnapshot().queue).toEqual([catalogue[0]]);
    expect(player.getSnapshot()).toMatchObject({
      position: 20,
      playing: false,
    });
  });

  it("migrates old persisted queues once and rejects incoherent explicit IDs", () => {
    const player = new PlayerStore();
    const legacy = {
      ...player.getSnapshot(),
      queue: [catalogue[0], catalogue[0]],
      index: 0,
    };
    delete legacy.entryIds;
    player.dispatch({ type: "restore", state: legacy });
    const restored = player.getSnapshot();
    expect(new Set(restored.entryIds).size).toBe(2);
    expect(
      PlayerSnapshotSchema.safeParse({
        ...restored,
        entryIds: [restored.entryIds![0], restored.entryIds![0]],
      }).success,
    ).toBe(false);
    player.dispatch({ type: "restore", state: restored });
    expect(player.getSnapshot().entryIds).toEqual(restored.entryIds);
  });
});
