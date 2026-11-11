import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogue } from "@aurelia/music";
import type { Track } from "@aurelia/core";
import { PlayerStore } from "@aurelia/player";
import {
  DeviceAudioEngine,
  DeviceSnapshotSchema,
  type DeviceAudioBridge,
  type DeviceSnapshot,
  type DeviceTrack,
} from "../packages/player/src/device-engine";

const tracks: Track[] = ["jfKfPfyJRdk", "aqz-KE-bpKQ"].map(
  (externalId, index) => ({
    ...catalogue[0],
    provider: "youtube",
    id: `youtube:${externalId}`,
    externalId,
    title: `Device fixture ${index + 1}`,
    artist: "Test artist",
    duration: 120,
  }),
);
const entries: DeviceTrack[] = tracks.map((track) => ({
  entryId: crypto.randomUUID(),
  trackId: track.id,
  provider: "youtube",
  externalId: track.externalId,
  title: track.title,
  artist: track.artist,
}));
function snapshot(change: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return {
    apiVersion: 1,
    transport: "device",
    ownerId: "account-a",
    revision: "existing-revision",
    sequence: 1,
    queue: entries,
    index: 0,
    entryId: entries[0].entryId,
    trackId: entries[0].trackId,
    position: 0,
    duration: 120,
    status: "playing",
    playing: true,
    repeat: "off",
    shuffle: false,
    volume: 0.75,
    error: null,
    ...change,
  };
}
function idle(): DeviceSnapshot {
  return snapshot({
    ownerId: null,
    revision: "",
    sequence: 0,
    queue: [],
    index: null,
    entryId: null,
    trackId: null,
    playing: false,
    status: "idle",
    duration: 0,
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}

const studioCapabilities = {
  apiVersion: 1,
  transport: "device",
  nativeQueue: true,
  queueMutation: true,
  available: true,
  supportedProviders: ["studio"],
  providerReasons: { youtube: "source-unverified" },
  reason: null,
  coverage: "bundled-studio-only",
};
const studioTracks = catalogue.slice(0, 2);
function fixture(
  existing: DeviceSnapshot = idle(),
  options: { tracks?: Track[]; capabilities?: unknown } = {},
) {
  let native = existing;
  let listener: (value: unknown) => void = () => {};
  const remove = vi.fn(async () => {});
  const update = (revision: string, change: Partial<DeviceSnapshot>) => {
    if (revision !== native.revision)
      return Promise.reject(new Error("stale-request"));
    native = { ...native, ...change, sequence: native.sequence + 1 };
    return Promise.resolve(native);
  };
  const bridge = {
    capabilities: vi.fn(
      async () =>
        options.capabilities ?? {
          apiVersion: 1,
          transport: "device",
          nativeQueue: true,
          queueMutation: true,
          available: true,
          supportedProviders: ["youtube"],
        },
    ),
    getSnapshot: vi.fn(async () => native),
    addListener: vi.fn(
      async (_event: "snapshot", next: (value: unknown) => void) => {
        listener = next;
        return { remove };
      },
    ),
    loadQueue: vi.fn(
      async (options: Parameters<DeviceAudioBridge["loadQueue"]>[0]) => {
        native = snapshot({
          ownerId: options.ownerId,
          revision: options.revision,
          sequence: native.sequence + 1,
          queue: options.tracks,
          index: options.index,
          entryId: options.tracks[options.index].entryId,
          trackId: options.tracks[options.index].trackId,
          position: options.position,
          playing: options.playing,
          status: options.playing ? "playing" : "paused",
          repeat: options.repeat,
          shuffle: options.shuffle,
          volume: options.volume,
        });
        return native;
      },
    ),
    mutateQueue: vi.fn(
      async (options: Parameters<DeviceAudioBridge["mutateQueue"]>[0]) => {
        if (
          options.ownerId !== native.ownerId ||
          options.expectedRevision !== native.revision
        )
          throw new Error("stale-request");
        const retainedIndex = options.tracks.findIndex(
          (entry) => entry.entryId === native.entryId,
        );
        const index =
          retainedIndex >= 0
            ? retainedIndex
            : Math.min(native.index ?? 0, options.tracks.length - 1);
        native = {
          ...native,
          revision: options.revision,
          queue: options.tracks,
          index,
          entryId: options.tracks[index].entryId,
          trackId: options.tracks[index].trackId,
          ...(retainedIndex < 0 ? { position: 0 } : {}),
          sequence: native.sequence + 1,
        };
        return native;
      },
    ),
    play: vi.fn(({ revision }: { revision: string }) =>
      update(revision, { playing: true, status: "playing" }),
    ),
    pause: vi.fn(({ revision }: { revision: string }) =>
      update(revision, { playing: false, status: "paused" }),
    ),
    seek: vi.fn(
      ({ revision, position }: { revision: string; position: number }) =>
        update(revision, { position }),
    ),
    setRepeat: vi.fn(
      ({
        revision,
        mode,
      }: {
        revision: string;
        mode: DeviceSnapshot["repeat"];
      }) => update(revision, { repeat: mode }),
    ),
    setShuffle: vi.fn(
      ({ revision, enabled }: { revision: string; enabled: boolean }) =>
        update(revision, { shuffle: enabled }),
    ),
    setVolume: vi.fn(
      ({ revision, value }: { revision: string; value: number }) =>
        update(revision, { volume: value }),
    ),
    stop: vi.fn(async ({ revision }: { revision: string }) => {
      if (revision !== native.revision) throw new Error("stale-request");
      native = {
        ...idle(),
        revision: "superseded-revision",
        sequence: native.sequence + 1,
      };
      return native;
    }),
  } satisfies DeviceAudioBridge;
  const store = new PlayerStore();
  store.dispatch({ type: "play", tracks: options.tracks ?? tracks });
  if (existing.queue?.length) {
    // This fixture models reopening the matching persisted queue, not a new explicit Play.
    store.dispatch({ type: "restore", state: { ...store.getSnapshot() } });
  }
  const events = vi.fn(),
    fail = vi.fn(),
    status = vi.fn();
  const engine = new DeviceAudioEngine(store, events, fail, status, {
    ownerId: "account-a",
    pluginAvailable: true,
    bridge,
  });
  engines.push(engine);
  return {
    bridge,
    store,
    engine,
    fail,
    status,
    events,
    remove,
    emit: (value: unknown) => listener(value),
    current: () => native,
  };
}
const engines: DeviceAudioEngine[] = [];
afterEach(async () => {
  engines.splice(0).forEach((engine) => engine.dispose());
  await settle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("device-owned audio adapter", () => {
  it("uses the safe replacement path when an older bridge has no queue-mutation capability", async () => {
    const test = fixture(idle(), {
      capabilities: {
        apiVersion: 1,
        transport: "device",
        nativeQueue: true,
        available: true,
        supportedProviders: ["youtube"],
      },
    });
    await settle();
    test.store.dispatch({ type: "queue", track: tracks[1] });
    await settle();
    expect(test.bridge.mutateQueue).not.toHaveBeenCalled();
    expect(test.bridge.loadQueue).toHaveBeenCalledTimes(2);
    expect(test.bridge.stop).toHaveBeenCalledTimes(1);
    expect(test.fail).not.toHaveBeenCalled();
  });

  it("stops the old captured revision when mutation is rejected before committing", async () => {
    const test = fixture();
    await settle();
    const old = test.current().revision;
    test.bridge.mutateQueue.mockRejectedValueOnce(
      new Error("rejected-before-CAS"),
    );
    test.store.dispatch({ type: "move", from: 0, to: 1 });
    await settle();
    expect(test.bridge.stop).toHaveBeenCalledWith({ revision: old });
    expect(test.current().ownerId).toBeNull();
    expect(test.store.getSnapshot().playing).toBe(false);
  });

  it("keeps a newer Pause during mutation and ignores old-revision progress", async () => {
    const test = fixture();
    await settle();
    test.store.dispatch({ type: "seek", position: 23 });
    await settle();
    const old = test.current();
    const pending = deferred<void>();
    const mutate = test.bridge.mutateQueue.getMockImplementation()!;
    test.bridge.mutateQueue.mockImplementationOnce(async (options) => {
      const value = await mutate(options);
      await pending.promise;
      return value;
    });
    test.store.dispatch({ type: "queue", track: tracks[0] });
    await settle();
    test.store.dispatch({ type: "pause" });
    // A second edit must not replace the unacknowledged transport baseline.
    test.store.dispatch({ type: "queue", track: tracks[1] });
    test.emit({ ...old, sequence: old.sequence + 100, position: 60 });
    pending.resolve();
    await settle();
    expect(test.bridge.loadQueue).toHaveBeenCalledTimes(1);
    expect(test.bridge.stop).not.toHaveBeenCalled();
    expect(test.current()).toMatchObject({ playing: false, position: 23 });
    expect(test.store.getSnapshot()).toMatchObject({
      playing: false,
      position: 23,
    });
  });

  it.each(["seek", "repeat", "shuffle", "volume", "resume"] as const)(
    "reconciles pending %s across two queue-only mutations",
    async (control) => {
      const test = fixture();
      await settle();
      if (control === "resume") {
        test.store.dispatch({ type: "pause" });
        await settle();
      }
      const pending = deferred<void>();
      const mutate = test.bridge.mutateQueue.getMockImplementation()!;
      test.bridge.mutateQueue.mockImplementationOnce(async (options) => {
        const value = await mutate(options);
        await pending.promise;
        return value;
      });
      test.store.dispatch({ type: "queue", track: tracks[0] });
      await settle();
      if (control === "seek")
        test.store.dispatch({ type: "seek", position: 43 });
      else if (control === "volume")
        test.store.dispatch({ type: "volume", volume: 0.25 });
      else if (control === "resume") test.store.dispatch({ type: "toggle" });
      else test.store.dispatch({ type: control });
      test.store.dispatch({ type: "queue", track: tracks[1] });
      pending.resolve();
      await settle();
      const expected =
        control === "seek"
          ? { position: 43 }
          : control === "volume"
            ? { volume: 0.25 }
            : control === "repeat"
              ? { repeat: "all" }
              : control === "shuffle"
                ? { shuffle: true }
                : { playing: true };
      expect(test.current()).toMatchObject(expected);
      expect(test.store.getSnapshot()).toMatchObject(expected);
      expect(test.bridge.loadQueue).toHaveBeenCalledTimes(1);
      expect(test.bridge.stop).not.toHaveBeenCalled();
      expect(test.bridge.mutateQueue).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["pause", false],
    ["pause", true],
    ["seek", false],
    ["seek", true],
    ["volume", false],
    ["volume", true],
  ] as const)(
    "retains a reversed %s intent after a committed delayed reply (third edit=%s)",
    async (control, thirdEdit) => {
      const test = fixture();
      await settle();
      const cas = deferred<void>(),
        reply = deferred<void>();
      const mutate = test.bridge.mutateQueue.getMockImplementation()!;
      test.bridge.mutateQueue.mockImplementationOnce(async (options) => {
        const value = await mutate(options);
        await cas.promise;
        return value;
      });
      const method =
        control === "pause"
          ? test.bridge.pause
          : control === "seek"
            ? test.bridge.seek
            : test.bridge.setVolume;
      const pause = test.bridge.pause.getMockImplementation()!;
      const seek = test.bridge.seek.getMockImplementation()!;
      const setVolume = test.bridge.setVolume.getMockImplementation()!;
      if (control === "pause")
        test.bridge.pause.mockImplementationOnce(async (options) => {
          const value = await pause(options);
          await reply.promise;
          return value;
        });
      if (control === "seek")
        test.bridge.seek.mockImplementationOnce(async (options) => {
          const value = await seek(options);
          await reply.promise;
          return value;
        });
      if (control === "volume")
        test.bridge.setVolume.mockImplementationOnce(async (options) => {
          const value = await setVolume(options);
          await reply.promise;
          return value;
        });
      test.store.dispatch({ type: "queue", track: tracks[0] });
      await settle();
      if (control === "pause") test.store.dispatch({ type: "pause" });
      if (control === "seek")
        test.store.dispatch({ type: "seek", position: 43 });
      if (control === "volume")
        test.store.dispatch({ type: "volume", volume: 0.25 });
      test.store.dispatch({ type: "queue", track: tracks[1] });
      cas.resolve();
      await settle();
      expect(method).toHaveBeenCalledTimes(1);
      if (control === "pause") test.store.dispatch({ type: "toggle" });
      if (control === "seek")
        test.store.dispatch({ type: "seek", position: 0 });
      if (control === "volume")
        test.store.dispatch({ type: "volume", volume: 0.75 });
      if (thirdEdit) test.store.dispatch({ type: "queue", track: tracks[0] });
      reply.resolve();
      await settle();
      const expected =
        control === "pause"
          ? { playing: true }
          : control === "seek"
            ? { position: 0 }
            : { volume: 0.75 };
      expect(test.current()).toMatchObject(expected);
      expect(test.store.getSnapshot()).toMatchObject(expected);
      expect(test.bridge.loadQueue).toHaveBeenCalledTimes(1);
      expect(test.bridge.stop).not.toHaveBeenCalled();
    },
  );

  it("does not acknowledge an unsent Seek while an earlier Pause reply is pending", async () => {
    const test = fixture();
    await settle();
    const cas = deferred<void>(),
      reply = deferred<void>();
    const mutate = test.bridge.mutateQueue.getMockImplementation()!;
    const pause = test.bridge.pause.getMockImplementation()!;
    test.bridge.mutateQueue.mockImplementationOnce(async (options) => {
      const value = await mutate(options);
      await cas.promise;
      return value;
    });
    test.bridge.pause.mockImplementationOnce(async (options) => {
      const value = await pause(options);
      await reply.promise;
      return value;
    });
    test.store.dispatch({ type: "queue", track: tracks[0] });
    await settle();
    test.store.dispatch({ type: "pause" });
    test.store.dispatch({ type: "seek", position: 43 });
    test.store.dispatch({ type: "queue", track: tracks[1] });
    cas.resolve();
    await settle();
    expect(test.bridge.pause).toHaveBeenCalledOnce();
    expect(test.bridge.seek).not.toHaveBeenCalled();
    test.store.dispatch({ type: "queue", track: tracks[0] });
    reply.resolve();
    await settle();
    expect(test.current()).toMatchObject({ playing: false, position: 43 });
    expect(test.store.getSnapshot()).toMatchObject({
      playing: false,
      position: 43,
    });
    expect(test.bridge.seek).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "mutates duplicate queue occurrences without stop/reload (paused=%s)",
    async (paused) => {
      const test = fixture(idle(), {
        tracks: [tracks[0], tracks[0], tracks[1]],
      });
      await settle();
      test.store.dispatch({ type: "seek", position: 22 });
      await settle();
      if (paused) {
        test.store.dispatch({ type: "pause" });
        await settle();
      }
      const first = test.current().entryId;
      const revision = test.current().revision;
      test.store.dispatch({ type: "move", from: 0, to: 2 });
      await settle();
      expect(test.bridge.loadQueue).toHaveBeenCalledTimes(1);
      expect(test.bridge.stop).not.toHaveBeenCalled();
      expect(test.bridge.mutateQueue).toHaveBeenCalledTimes(1);
      expect(test.current().entryId).toBe(first);
      expect(test.current().revision).not.toBe(revision);
      expect(test.store.getSnapshot()).toMatchObject({
        index: 2,
        playing: !paused,
        position: 22,
      });
      test.store.dispatch({ type: "remove", index: 0 });
      await settle();
      test.store.dispatch({ type: "queue", track: tracks[1] });
      await settle();
      expect(test.bridge.loadQueue).toHaveBeenCalledTimes(1);
      expect(test.bridge.stop).not.toHaveBeenCalled();
      expect(test.current().entryId).toBe(first);
    },
  );

  it("loads a validated YouTube queue using identifiers only and no web transport", async () => {
    const fetch = vi.fn(() => {
      throw new Error("Web transport is forbidden");
    });
    vi.stubGlobal("fetch", fetch);
    const test = fixture();
    await settle();
    expect(test.bridge.loadQueue).toHaveBeenCalledTimes(1);
    expect(test.store.getSnapshot().playing).toBe(true);
    const request = test.bridge.loadQueue.mock.calls[0][0];
    expect(request.ownerId).toBe("account-a");
    expect(Object.keys(request.tracks[0]).sort()).toEqual([
      "artist",
      "entryId",
      "externalId",
      "provider",
      "title",
      "trackId",
    ]);
    expect(new Set(request.tracks.map((track) => track.entryId)).size).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(test.status).toHaveBeenLastCalledWith({ state: "ready" });
  });

  it("loads bundled Studio IDs and mirrors native-owned next/progress without early play telemetry", async () => {
    const fetch = vi.fn(() => {
      throw new Error("Web transport is forbidden");
    });
    vi.stubGlobal("fetch", fetch);
    const test = fixture(idle(), {
      tracks: studioTracks,
      capabilities: studioCapabilities,
    });
    await settle();
    const request = test.bridge.loadQueue.mock.calls[0][0];
    expect(
      request.tracks.map(({ provider, externalId }) => [provider, externalId]),
    ).toEqual([
      ["studio", "1"],
      ["studio", "2"],
    ]);
    expect(Object.keys(request.tracks[0]).sort()).toEqual([
      "artist",
      "entryId",
      "externalId",
      "provider",
      "title",
      "trackId",
    ]);
    expect(JSON.stringify(request)).not.toMatch(/https?:|url|token|cookie/i);
    expect(test.events).not.toHaveBeenCalled();
    const active = test.current();
    test.emit({ ...active, sequence: active.sequence + 1, position: 2 });
    expect(test.events).toHaveBeenCalledTimes(1);
    test.emit({
      ...active,
      sequence: active.sequence + 2,
      index: 1,
      entryId: request.tracks[1].entryId,
      trackId: request.tracks[1].trackId,
      position: 0,
    });
    expect(test.store.getSnapshot()).toMatchObject({ index: 1, position: 0 });
    expect(test.events).toHaveBeenCalledTimes(1);
    test.emit({
      ...active,
      sequence: active.sequence + 3,
      index: 1,
      entryId: request.tracks[1].entryId,
      trackId: request.tracks[1].trackId,
      position: 3,
    });
    expect(test.store.getSnapshot()).toMatchObject({ index: 1, position: 3 });
    expect(test.events).toHaveBeenLastCalledWith(
      expect.objectContaining({
        track: studioTracks[1],
        playId: request.tracks[1].entryId,
        kind: "play",
      }),
    );
    expect(test.bridge.loadQueue).toHaveBeenCalledTimes(1);
    expect(test.bridge.seek).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    test.engine.dispose();
    const afterDispose = test.store.getSnapshot();
    test.emit({ ...active, sequence: active.sequence + 4, position: 60 });
    await settle();
    expect(test.store.getSnapshot()).toBe(afterDispose);
    expect(test.remove).toHaveBeenCalledTimes(1);
    expect(test.bridge.stop).toHaveBeenLastCalledWith({
      revision: request.revision,
    });
  });

  it("rejects unverified YouTube, stops prior Studio ownership and later accepts Studio on the same engine", async () => {
    const test = fixture(idle(), {
      tracks: studioTracks,
      capabilities: studioCapabilities,
    });
    await settle();
    const active = test.current();
    test.store.dispatch({ type: "play", tracks });
    await settle();
    expect(test.bridge.stop).toHaveBeenCalledWith({
      revision: active.revision,
    });
    expect(test.bridge.loadQueue).toHaveBeenCalledTimes(1);
    expect(test.store.getSnapshot().playing).toBe(false);
    expect(test.fail).toHaveBeenLastCalledWith(
      expect.stringContaining("native audio source has not been verified"),
    );
    test.emit({ ...active, sequence: active.sequence + 10, position: 60 });
    expect(test.store.getSnapshot().queue).toEqual(tracks);
    expect(test.store.getSnapshot().position).toBe(0);
    test.store.dispatch({ type: "play", tracks: studioTracks });
    await settle();
    expect(test.bridge.capabilities).toHaveBeenCalledTimes(1);
    expect(test.bridge.loadQueue).toHaveBeenCalledTimes(2);
    expect(test.bridge.loadQueue.mock.calls[1][0].revision).not.toBe(
      active.revision,
    );
    expect(test.store.getSnapshot().playing).toBe(true);
    expect(test.status).toHaveBeenLastCalledWith({ state: "ready" });
  });

  it("rejects a mixed queue as a whole even when both individual providers are supported", async () => {
    const test = fixture(idle(), {
      tracks: [studioTracks[0], tracks[0]],
      capabilities: {
        ...studioCapabilities,
        supportedProviders: ["youtube", "studio"],
      },
    });
    await settle();
    expect(test.bridge.loadQueue).not.toHaveBeenCalled();
    expect(test.store.getSnapshot()).toMatchObject({
      queue: [studioTracks[0], tracks[0]],
      playing: false,
    });
    expect(test.fail).toHaveBeenLastCalledWith(
      expect.stringContaining("device does not support"),
    );
  });

  it("rehydrates a supported Studio queue without reconstructing its metadata or duplicating play", async () => {
    const queue: DeviceTrack[] = studioTracks.map((track) => ({
      entryId: crypto.randomUUID(),
      trackId: track.id,
      provider: "studio",
      externalId: track.externalId,
      title: track.title,
      artist: track.artist,
    }));
    const test = fixture(
      snapshot({
        queue,
        entryId: queue[0].entryId,
        trackId: queue[0].trackId,
        position: 10,
      }),
      { tracks: studioTracks, capabilities: studioCapabilities },
    );
    await settle();
    expect(test.bridge.loadQueue).not.toHaveBeenCalled();
    expect(test.store.getSnapshot()).toMatchObject({
      position: 10,
      playing: true,
    });
    expect(test.events).not.toHaveBeenCalled();
  });

  it("keeps source-unverified distinct from a missing plugin and ignores arbitrary native reason text", async () => {
    const unverified = fixture(idle(), {
      capabilities: {
        ...studioCapabilities,
        available: false,
        supportedProviders: [],
        reason: "source-unverified",
      },
    });
    const hostile = fixture(idle(), {
      capabilities: {
        ...studioCapabilities,
        reason: "https://private.invalid/token",
        providerReasons: {
          youtube: "https://private.invalid/token",
          studio: { reason: "source-unverified" },
        },
      },
    });
    await settle();
    expect(unverified.fail).toHaveBeenLastCalledWith(
      expect.stringContaining("native audio source has not been verified"),
    );
    expect(unverified.bridge.addListener).not.toHaveBeenCalled();
    unverified.store.dispatch({ type: "toggle" });
    expect(unverified.fail).toHaveBeenLastCalledWith(
      expect.stringContaining("native audio source has not been verified"),
    );
    expect(hostile.fail).toHaveBeenLastCalledWith(
      expect.stringContaining("device does not support"),
    );
    expect(JSON.stringify(hostile.fail.mock.calls)).not.toContain(
      "private.invalid",
    );
    expect(hostile.bridge.loadQueue).not.toHaveBeenCalled();
  });

  it("fails closed without a registered plugin or accepted capabilities", async () => {
    const bridge = { capabilities: vi.fn() } as unknown as DeviceAudioBridge;
    const store = new PlayerStore();
    store.dispatch({ type: "play", tracks });
    const fail = vi.fn();
    const engine = new DeviceAudioEngine(store, vi.fn(), fail, vi.fn(), {
      ownerId: "account-a",
      pluginAvailable: false,
      bridge,
    });
    engines.push(engine);
    expect(bridge.capabilities).not.toHaveBeenCalled();
    expect(store.getSnapshot().playing).toBe(false);
    expect(fail).toHaveBeenCalledWith(
      expect.stringContaining("native audio update"),
    );
    store.dispatch({ type: "toggle" });
    expect(store.getSnapshot().playing).toBe(false);
    const unavailableBridge = {
      getSnapshot: vi.fn(),
      loadQueue: vi.fn(),
      addListener: vi.fn(),
      capabilities: vi.fn(async () => ({
        apiVersion: 1,
        transport: "device",
        nativeQueue: true,
        available: false,
        supportedProviders: [],
      })),
    } as unknown as DeviceAudioBridge;
    const unavailableStore = new PlayerStore();
    unavailableStore.dispatch({ type: "play", tracks });
    const unavailable = new DeviceAudioEngine(
      unavailableStore,
      vi.fn(),
      fail,
      vi.fn(),
      {
        ownerId: "account-a",
        pluginAvailable: true,
        bridge: unavailableBridge,
      },
    );
    engines.push(unavailable);
    await settle();
    expect(unavailableBridge.capabilities).toHaveBeenCalledTimes(1);
    expect(unavailableBridge.getSnapshot).not.toHaveBeenCalled();
    expect(unavailableBridge.loadQueue).not.toHaveBeenCalled();
    expect(unavailableBridge.addListener).not.toHaveBeenCalled();
    expect(unavailableStore.getSnapshot().playing).toBe(false);
  });

  it("rehydrates only the same owner and exact known queue, including native-owned next", async () => {
    const test = fixture(
      snapshot({
        index: 1,
        entryId: entries[1].entryId,
        trackId: entries[1].trackId,
        position: 42,
      }),
    );
    await settle();
    expect(test.bridge.loadQueue).not.toHaveBeenCalled();
    expect(test.bridge.stop).not.toHaveBeenCalled();
    expect(test.store.getSnapshot()).toMatchObject({
      index: 1,
      position: 42,
      playing: true,
    });
    expect(test.events).not.toHaveBeenCalled();
  });

  it("stops a different owner's queue before loading without exposing it", async () => {
    const test = fixture(
      snapshot({ ownerId: "account-b", revision: "other-owner", position: 67 }),
    );
    await settle();
    expect(test.bridge.stop).toHaveBeenCalledWith({ revision: "other-owner" });
    expect(test.bridge.stop.mock.invocationCallOrder[0]).toBeLessThan(
      test.bridge.loadQueue.mock.invocationCallOrder[0],
    );
    expect(test.store.getSnapshot().position).toBe(0);
  });

  it("prefers a newer native notification over a stale initial read", async () => {
    const test = fixture(snapshot());
    const response = deferred<DeviceSnapshot>();
    test.bridge.getSnapshot.mockReturnValueOnce(response.promise);
    await settle();
    test.emit(snapshot({ sequence: 9, position: 30 }));
    response.resolve(snapshot({ sequence: 1, position: 0 }));
    await settle();
    expect(test.store.getSnapshot().position).toBe(30);
    expect(test.bridge.loadQueue).not.toHaveBeenCalled();
  });

  it("keeps an explicit user selection made during native initialization", async () => {
    const test = fixture(snapshot());
    const response = deferred<DeviceSnapshot>();
    test.bridge.getSnapshot.mockReturnValueOnce(response.promise);
    await settle();
    test.store.dispatch({ type: "play", tracks, index: 1 });
    response.resolve(snapshot({ index: 0, position: 60 }));
    await settle();
    expect(test.bridge.loadQueue).toHaveBeenCalledTimes(1);
    expect(test.bridge.loadQueue.mock.calls[0][0].index).toBe(1);
    expect(test.store.getSnapshot()).toMatchObject({ index: 1, position: 0 });
  });

  it("does not rehydrate a queue with changed metadata or unknown tracks", async () => {
    const test = fixture(
      snapshot({
        queue: [{ ...entries[0], title: "Unknown metadata" }, entries[1]],
        position: 67,
      }),
    );
    await settle();
    expect(test.bridge.stop).toHaveBeenCalledWith({
      revision: "existing-revision",
    });
    expect(test.bridge.loadQueue).toHaveBeenCalledTimes(1);
    expect(test.store.getSnapshot().queue).toEqual(tracks);
  });

  it("ignores stale revisions, sequences, owners and incoherent entries", async () => {
    const test = fixture(snapshot());
    await settle();
    test.emit(snapshot({ sequence: 5, position: 11 }));
    expect(test.store.getSnapshot().position).toBe(11);
    for (const invalid of [
      snapshot({ sequence: 4, position: 21 }),
      snapshot({ sequence: 6, revision: "stale", position: 21 }),
      snapshot({ sequence: 6, ownerId: "account-b", position: 21 }),
      snapshot({ sequence: 6, entryId: entries[1].entryId, position: 21 }),
      snapshot({ sequence: 6, index: null, position: 21 }),
      snapshot({
        sequence: 6,
        queue: [entries[0], { ...entries[1], entryId: crypto.randomUUID() }],
        position: 21,
      }),
      snapshot({ sequence: 6, status: "paused", playing: true, position: 21 }),
    ])
      test.emit(invalid);
    expect(test.store.getSnapshot().position).toBe(11);
    test.emit(snapshot({ sequence: 6, position: 12 }));
    expect(test.store.getSnapshot().position).toBe(12);
  });

  it("mirrors autonomous native track advancement without issuing another queue load", async () => {
    const test = fixture(snapshot({ position: 119 }));
    await settle();
    test.emit(
      snapshot({
        sequence: 2,
        index: 1,
        entryId: entries[1].entryId,
        trackId: entries[1].trackId,
        position: 1,
      }),
    );
    await settle();
    expect(test.store.getSnapshot()).toMatchObject({
      index: 1,
      position: 1,
      playing: true,
    });
    expect(test.bridge.loadQueue).not.toHaveBeenCalled();
    expect(test.bridge.seek).not.toHaveBeenCalled();
    expect(test.events).toHaveBeenCalledWith(
      expect.objectContaining({ track: tracks[1], playId: entries[1].entryId }),
    );
  });

  it("uses command snapshot responses when no notification is emitted", async () => {
    const test = fixture(snapshot());
    await settle();
    test.store.dispatch({ type: "pause" });
    await settle();
    expect(test.store.getSnapshot().playing).toBe(false);
    test.bridge.seek.mockImplementationOnce(({ revision }) =>
      Promise.resolve(
        snapshot({
          revision,
          sequence: 50,
          position: 23,
          playing: false,
          status: "paused",
        }),
      ),
    );
    test.store.dispatch({ type: "seek", position: 40 });
    await settle();
    expect(test.store.getSnapshot().position).toBe(23);
    expect(test.bridge.seek).toHaveBeenCalledWith({
      revision: "existing-revision",
      position: 40,
    });
  });

  it("does not roll back a newer native event to a delayed command response", async () => {
    const test = fixture(snapshot());
    await settle();
    const response = deferred<DeviceSnapshot>();
    test.bridge.pause.mockReturnValueOnce(response.promise);
    test.store.dispatch({ type: "pause" });
    test.emit(
      snapshot({ sequence: 9, playing: false, status: "paused", position: 25 }),
    );
    response.resolve(
      snapshot({ sequence: 8, playing: false, status: "paused", position: 20 }),
    );
    await settle();
    expect(test.store.getSnapshot()).toMatchObject({
      playing: false,
      position: 25,
    });
  });

  it("stops prior native audio when the queue becomes mixed/unsupported, including retry", async () => {
    const test = fixture(snapshot());
    await settle();
    test.store.dispatch({ type: "play", tracks: [tracks[0], catalogue[0]] });
    await settle();
    expect(test.bridge.stop).toHaveBeenCalledWith({
      revision: "existing-revision",
    });
    expect(test.bridge.loadQueue).not.toHaveBeenCalled();
    expect(test.store.getSnapshot().playing).toBe(false);
    test.store.dispatch({ type: "toggle" });
    await settle();
    expect(test.store.getSnapshot().playing).toBe(false);
    expect(test.fail).toHaveBeenLastCalledWith(
      expect.stringContaining("device does not support"),
    );
  });

  it("allows a failed queue load to be retried with a fresh revision", async () => {
    const test = fixture();
    test.bridge.loadQueue.mockRejectedValueOnce(
      new Error("Private upstream URL must never escape"),
    );
    await settle();
    const first = test.bridge.loadQueue.mock.calls[0][0].revision;
    expect(test.store.getSnapshot().playing).toBe(false);
    expect(test.fail).toHaveBeenLastCalledWith(
      expect.not.stringContaining("Private"),
    );
    test.store.dispatch({ type: "toggle" });
    await settle();
    expect(test.bridge.loadQueue).toHaveBeenCalledTimes(2);
    expect(test.bridge.loadQueue.mock.calls[1][0].revision).not.toBe(first);
    expect(test.store.getSnapshot().playing).toBe(true);
  });

  it("fails an invalid command response safely and allows a subsequent reload", async () => {
    const test = fixture(snapshot());
    await settle();
    test.bridge.pause.mockResolvedValueOnce(
      snapshot({ ownerId: "foreign-owner", sequence: 2 }),
    );
    test.store.dispatch({ type: "pause" });
    await settle();
    expect(test.fail).toHaveBeenCalledWith(
      expect.stringContaining("could not be played directly"),
    );
    test.store.dispatch({ type: "toggle" });
    await settle();
    expect(test.bridge.loadQueue).toHaveBeenCalledTimes(1);
    expect(test.store.getSnapshot().playing).toBe(true);
  });

  it("clearing the queue releases native ownership and late progress cannot restore it", async () => {
    const test = fixture(snapshot());
    await settle();
    test.store.dispatch({ type: "remove", index: 1 });
    await settle();
    const active = test.current();
    test.store.dispatch({ type: "remove", index: 0 });
    await settle();
    test.emit({ ...active, sequence: active.sequence + 1, position: 20 });
    expect(test.store.getSnapshot()).toMatchObject({
      queue: [],
      index: -1,
      playing: false,
    });
    expect(test.bridge.stop).toHaveBeenLastCalledWith({
      revision: active.revision,
    });
    expect(test.status).toHaveBeenLastCalledWith({ state: "idle" });
  });

  it("preserves newer user intent while an older load response is pending", async () => {
    const test = fixture();
    const response = deferred<DeviceSnapshot>();
    test.bridge.loadQueue.mockReturnValueOnce(response.promise);
    await settle();
    const request = test.bridge.loadQueue.mock.calls[0][0];
    test.store.dispatch({ type: "play", tracks, index: 1 });
    response.resolve(
      snapshot({
        revision: request.revision,
        queue: request.tracks,
        entryId: request.tracks[0].entryId,
      }),
    );
    await settle();
    expect(test.bridge.loadQueue).toHaveBeenCalledTimes(2);
    expect(test.bridge.loadQueue.mock.calls[1][0].index).toBe(1);
    expect(test.store.getSnapshot().index).toBe(1);
  });

  it("disposal stops only its captured revision and ignores late events/promises", async () => {
    const test = fixture(snapshot());
    await settle();
    const response = deferred<DeviceSnapshot>();
    test.bridge.pause.mockReturnValueOnce(response.promise);
    test.store.dispatch({ type: "pause" });
    test.engine.dispose();
    const current = test.store.getSnapshot();
    test.emit(snapshot({ sequence: 9, position: 76 }));
    response.resolve(snapshot({ sequence: 8, position: 20 }));
    await settle();
    expect(test.store.getSnapshot()).toBe(current);
    expect(test.bridge.stop).toHaveBeenLastCalledWith({
      revision: "existing-revision",
    });
    expect(test.remove).toHaveBeenCalledTimes(1);
    test.engine.dispose();
    expect(test.remove).toHaveBeenCalledTimes(1);
  });

  it("cleans up a listener that resolves after the registration deadline", async () => {
    vi.useFakeTimers();
    const test = fixture();
    const registration = deferred<{ remove: typeof test.remove }>();
    test.bridge.addListener.mockReturnValueOnce(registration.promise);
    await settle();
    await vi.advanceTimersByTimeAsync(10001);
    expect(test.fail).toHaveBeenCalledWith(
      expect.stringContaining("native audio update"),
    );
    const remove = vi.fn(async () => {});
    registration.resolve({ remove });
    await settle();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(test.bridge.getSnapshot).not.toHaveBeenCalled();
  });

  it("rejects duplicate queue entries and inconsistent snapshot positions at the schema boundary", () => {
    expect(
      DeviceSnapshotSchema.safeParse(
        snapshot({ queue: [entries[0], entries[0]] }),
      ).success,
    ).toBe(false);
    expect(
      DeviceSnapshotSchema.safeParse(
        snapshot({ position: Number.POSITIVE_INFINITY }),
      ).success,
    ).toBe(false);
    expect(DeviceSnapshotSchema.safeParse(snapshot({ index: 4 })).success).toBe(
      false,
    );
    expect(
      DeviceSnapshotSchema.safeParse(snapshot({ volume: -1 })).success,
    ).toBe(false);
    for (const externalId of [
      "0",
      "13",
      "01",
      "../1",
      "https://audio.invalid/1",
      "1.wav",
    ]) {
      expect(
        DeviceSnapshotSchema.safeParse(
          snapshot({
            queue: [
              { ...entries[0], provider: "studio", externalId },
              entries[1],
            ],
          }),
        ).success,
      ).toBe(false);
    }
    expect(
      DeviceSnapshotSchema.safeParse(
        snapshot({
          queue: [
            { ...entries[0], provider: "studio", externalId: "12" },
            entries[1],
          ],
        }),
      ).success,
    ).toBe(true);
  });
});
