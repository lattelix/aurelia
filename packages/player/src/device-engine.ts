import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { z } from "zod";
import type { Track } from "@aurelia/core";
import type { PlayerSnapshot, PlayerStore } from "./index";
import type { ListeningEvent, PlaybackStatus } from "./browser-engine";

const deviceTrackMetadata = {
  entryId: z.string().uuid(),
  trackId: z.string().min(1).max(160),
  title: z.string().max(500),
  artist: z.string().max(500),
};
const DeviceTrackSchema = z.discriminatedUnion("provider", [
  z.object({
    ...deviceTrackMetadata,
    provider: z.literal("youtube"),
    externalId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  }),
  z.object({
    ...deviceTrackMetadata,
    provider: z.literal("studio"),
    externalId: z.string().regex(/^(?:[1-9]|1[0-2])$/),
  }),
]);
export type DeviceTrack = z.infer<typeof DeviceTrackSchema>;
export const DeviceSnapshotSchema = z
  .object({
    apiVersion: z.literal(1),
    transport: z.literal("device"),
    ownerId: z.string().min(1).max(160).nullable(),
    revision: z
      .string()
      .max(128)
      .regex(/^[A-Za-z0-9:_-]*$/),
    sequence: z.number().int().nonnegative(),
    index: z.number().int().min(0).max(499).nullable(),
    entryId: z.string().uuid().nullable(),
    trackId: z.string().min(1).max(160).nullable(),
    position: z.number().finite().min(0).max(86400),
    duration: z.number().finite().min(0).max(86400),
    status: z.enum(["idle", "loading", "playing", "paused", "ended", "failed"]),
    playing: z.boolean(),
    repeat: z.enum(["off", "all", "one"]),
    shuffle: z.boolean(),
    volume: z.number().finite().min(0).max(1),
    error: z.string().max(160).nullable(),
    queue: z.array(DeviceTrackSchema).max(500).optional(),
  })
  .superRefine((snapshot, context) => {
    const bad = () =>
      context.addIssue({
        code: "custom",
        message: "Incoherent device snapshot",
      });
    if ((snapshot.status === "playing") !== snapshot.playing) bad();
    if (snapshot.index === null) {
      if (snapshot.entryId !== null || snapshot.trackId !== null) bad();
    } else if (
      !snapshot.entryId ||
      !snapshot.trackId ||
      !snapshot.ownerId ||
      !snapshot.revision
    )
      bad();
    if (snapshot.queue) {
      if (
        new Set(snapshot.queue.map((entry) => entry.entryId)).size !==
        snapshot.queue.length
      )
        bad();
      const current =
        snapshot.index === null ? undefined : snapshot.queue[snapshot.index];
      if (
        snapshot.index !== null &&
        (!current ||
          current.entryId !== snapshot.entryId ||
          current.trackId !== snapshot.trackId)
      )
        bad();
      if (snapshot.index === null && snapshot.queue.length) bad();
    }
  });
export type DeviceSnapshot = z.infer<typeof DeviceSnapshotSchema>;
const NativeReasonSchema = z
  .enum(["source-unverified"])
  .optional()
  .catch(undefined);
const CapabilitiesSchema = z.object({
  apiVersion: z.literal(1),
  transport: z.literal("device"),
  nativeQueue: z.literal(true),
  queueMutation: z.boolean().optional().default(false),
  available: z.boolean(),
  supportedProviders: z.array(z.string()).max(10),
  reason: NativeReasonSchema.optional(),
  providerReasons: z
    .object({
      youtube: NativeReasonSchema.optional(),
      studio: NativeReasonSchema.optional(),
    })
    .catch({})
    .optional(),
});
type Revision = { revision: string };
export interface DeviceAudioBridge {
  capabilities(): Promise<unknown>;
  getSnapshot(): Promise<unknown>;
  loadQueue(options: {
    ownerId: string;
    revision: string;
    tracks: DeviceTrack[];
    index: number;
    position: number;
    playing: boolean;
    repeat: PlayerSnapshot["repeat"];
    shuffle: boolean;
    volume: number;
  }): Promise<unknown>;
  mutateQueue(options: {
    ownerId: string;
    expectedRevision: string;
    revision: string;
    tracks: DeviceTrack[];
  }): Promise<unknown>;
  play(options: Revision): Promise<unknown>;
  pause(options: Revision): Promise<unknown>;
  seek(options: Revision & { position: number }): Promise<unknown>;
  setRepeat(
    options: Revision & { mode: PlayerSnapshot["repeat"] },
  ): Promise<unknown>;
  setShuffle(options: Revision & { enabled: boolean }): Promise<unknown>;
  setVolume(options: Revision & { value: number }): Promise<unknown>;
  stop(options: Revision): Promise<unknown>;
  addListener(
    event: "snapshot",
    listener: (value: unknown) => void,
  ): Promise<PluginListenerHandle>;
}
const nativeBridge = registerPlugin<DeviceAudioBridge>("AureliaDeviceAudio");
const UNAVAILABLE =
  "Direct playback is not available in this app version. A native audio update is required.";
const FAILED =
  "This recording could not be played directly. Try another recording or retry.";
const UNSUPPORTED =
  "This queue contains recordings that this device does not support. Choose a supported playlist.";
const SOURCE_UNVERIFIED =
  "Direct playback is unavailable because the native audio source has not been verified.";
const queueKey = (
  tracks: readonly Pick<
    Track,
    "id" | "externalId" | "title" | "artist" | "provider"
  >[],
) =>
  JSON.stringify(
    tracks.map((track) => [
      track.id,
      track.provider,
      track.externalId,
      track.title,
      track.artist,
    ]),
  );
const deviceQueueKey = (tracks: readonly DeviceTrack[]) =>
  JSON.stringify([
    queueKey(tracks.map((track) => ({ ...track, id: track.trackId }))),
    tracks.map((track) => track.entryId),
  ]);
const stateQueueKey = (state: PlayerSnapshot) =>
  JSON.stringify([queueKey(state.queue), state.entryIds]);

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("native-timeout")), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Device-only adapter. It has no resolver, fetch, signed URL or iframe fallback. */
export class DeviceAudioEngine {
  private readonly bridge: DeviceAudioBridge;
  private readonly ownerId: string;
  private disposed = false;
  private ready = false;
  private unavailable = false;
  private unavailableMessage = UNAVAILABLE;
  private supportedProviders = new Set<string>();
  private providerReasons: Partial<
    Record<DeviceTrack["provider"], "source-unverified">
  > = {};
  private applying = false;
  private running = false;
  private busy = false;
  private pending = false;
  private intent = 0;
  private revision = "";
  private sequence = -1;
  private tracks: DeviceTrack[] = [];
  private key = "";
  private last: PlayerSnapshot | null = null;
  private buffered: DeviceSnapshot | null = null;
  private early: DeviceSnapshot | null = null;
  private earlyVersion = 0;
  private registrationAbandoned = false;
  private handle: PluginListenerHandle | null = null;
  private readonly removedHandles = new WeakSet<PluginListenerHandle>();
  private readonly unsubscribe: () => void;
  private startedEntry: string | null = null;
  private queueMutation = false;
  constructor(
    private readonly store: PlayerStore,
    private readonly event: (event: ListeningEvent) => void,
    private readonly fail: (message: string) => void,
    private readonly status: (status: PlaybackStatus) => void,
    options: {
      ownerId: string;
      pluginAvailable: boolean;
      bridge?: DeviceAudioBridge;
    },
  ) {
    this.bridge = options.bridge ?? nativeBridge;
    this.ownerId = options.ownerId;
    this.unsubscribe = store.subscribe(this.sync);
    if (
      !options.pluginAvailable ||
      !this.ownerId ||
      this.ownerId.length > 160
    ) {
      this.unavailable = true;
      this.failure(UNAVAILABLE);
      return;
    }
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", this.resume);
    void this.initialize();
  }
  private releaseHandle(handle: PluginListenerHandle) {
    if (this.removedHandles.has(handle)) return;
    this.removedHandles.add(handle);
    try {
      void handle.remove().catch(() => {});
    } catch {
      /* A broken bridge must not break disposal. */
    }
  }
  private async initialize() {
    const intent = this.intent;
    try {
      const result = CapabilitiesSchema.safeParse(
        await bounded(this.bridge.capabilities()),
      );
      if (this.disposed) return;
      if (!result.success || !result.data.available) {
        this.unavailable = true;
        if (result.success && result.data.reason === "source-unverified")
          this.unavailableMessage = SOURCE_UNVERIFIED;
        this.failure(this.unavailableMessage);
        return;
      }
      this.supportedProviders = new Set(result.data.supportedProviders);
      this.queueMutation = result.data.queueMutation;
      this.providerReasons = result.data.providerReasons ?? {};
      const registration = this.bridge.addListener("snapshot", this.receive);
      // A timed-out registration may still resolve later. Release that handle
      // even though initialize() has already failed or the engine was disposed.
      void registration
        .then((handle) => {
          if (this.disposed || this.registrationAbandoned)
            this.releaseHandle(handle);
        })
        .catch(() => {});
      const handle = await bounded(registration);
      if (this.disposed) {
        this.releaseHandle(handle);
        return;
      }
      this.handle = handle;
      const beforeRead = this.earlyVersion;
      const parsed = DeviceSnapshotSchema.safeParse(
        await bounded(this.bridge.getSnapshot()),
      );
      if (this.disposed) return;
      let snapshot = parsed.success ? parsed.data : null;
      const early = this.early;
      if (early && this.earlyVersion > beforeRead && early.queue)
        snapshot = early;
      else if (
        early &&
        snapshot &&
        early.revision === snapshot.revision &&
        early.sequence > snapshot.sequence
      ) {
        snapshot = { ...early, queue: early.queue ?? snapshot.queue };
      }
      this.early = null;
      const state = this.store.getSnapshot();
      if (
        intent === this.intent &&
        snapshot?.ownerId === this.ownerId &&
        snapshot.revision &&
        snapshot.queue?.length &&
        this.supportsQueue(snapshot.queue) &&
        queueKey(state.queue) ===
          queueKey(
            snapshot.queue.map((track) => ({ ...track, id: track.trackId })),
          ) &&
        (!this.store.hasPlayRequest() ||
          stateQueueKey(state) === deviceQueueKey(snapshot.queue))
      ) {
        // Legacy persisted metadata may adopt identities only after exact owner/catalogue matching.
        this.applying = true;
        try {
          this.store.dispatch({
            type: "restore",
            state: {
              ...state,
              entryIds: snapshot.queue.map((entry) => entry.entryId),
            },
          });
        } finally {
          this.applying = false;
        }
        this.tracks = snapshot.queue;
        this.revision = snapshot.revision;
        this.key = stateQueueKey(this.store.getSnapshot());
        this.pending = false;
        this.ready = true;
        // Rehydrating an already audible entry must not create another play.
        if (snapshot.playing && snapshot.position > 0)
          this.startedEntry = snapshot.entryId;
        this.receive(snapshot);
      } else {
        // Never reconstruct another account's queue or unknown database tracks.
        if (snapshot?.revision)
          await bounded(this.bridge.stop({ revision: snapshot.revision }));
        if (this.disposed) return;
        this.ready = true;
        this.sync();
      }
    } catch {
      this.unavailable = true;
      this.registrationAbandoned = true;
      if (this.handle) {
        this.releaseHandle(this.handle);
        this.handle = null;
      }
      if (!this.disposed) this.failure(UNAVAILABLE);
    }
  }
  private failure(message: string) {
    if (this.disposed) return;
    this.status({ state: "error", message });
    this.fail(message);
    this.applying = true;
    try {
      this.store.dispatch({ type: "pause" });
    } finally {
      this.applying = false;
    }
  }
  private supportsQueue(tracks: readonly { provider: string }[]) {
    return (
      new Set(tracks.map((track) => track.provider)).size === 1 &&
      tracks.every((track) => this.supportedProviders.has(track.provider))
    );
  }
  private unsupportedMessage(tracks: readonly { provider: string }[]) {
    return tracks.some(
      (track) =>
        (track.provider === "youtube" || track.provider === "studio") &&
        !this.supportedProviders.has(track.provider) &&
        this.providerReasons[track.provider] === "source-unverified",
    )
      ? SOURCE_UNVERIFIED
      : UNSUPPORTED;
  }
  private validSnapshot(value: unknown): DeviceSnapshot | null {
    const parsed = DeviceSnapshotSchema.safeParse(value);
    if (!parsed.success) return null;
    const snapshot = parsed.data;
    if (
      snapshot.ownerId !== this.ownerId ||
      !this.revision ||
      snapshot.revision !== this.revision ||
      snapshot.sequence <= this.sequence
    )
      return null;
    if (snapshot.index === null) return null;
    const entry = this.tracks[snapshot.index];
    if (
      !entry ||
      entry.entryId !== snapshot.entryId ||
      entry.trackId !== snapshot.trackId
    )
      return null;
    if (
      snapshot.queue &&
      (deviceQueueKey(snapshot.queue) !== this.key ||
        snapshot.queue.some(
          (track, index) => track.entryId !== this.tracks[index]?.entryId,
        ))
    )
      return null;
    if (stateQueueKey(this.store.getSnapshot()) !== this.key) return null;
    return snapshot;
  }
  private receive = (value: unknown) => {
    if (this.disposed) return;
    if (!this.ready) {
      const parsed = DeviceSnapshotSchema.safeParse(value);
      if (parsed.success) {
        this.early = parsed.data;
        this.earlyVersion++;
      }
      return;
    }
    const snapshot = this.validSnapshot(value);
    if (!snapshot) return;
    if (this.busy || this.pending) {
      if (!this.buffered || snapshot.sequence > this.buffered.sequence)
        this.buffered = snapshot;
      return;
    }
    this.applySnapshot(snapshot);
  };
  private applySnapshot(snapshot: DeviceSnapshot) {
    // Recheck after awaits/buffering: queue changes and disposal invalidate it.
    if (this.disposed || !this.validSnapshot(snapshot)) return;
    this.sequence = snapshot.sequence;
    const previous = this.store.getSnapshot();
    const entry = this.tracks[snapshot.index!];
    const previousPosition =
      this.last?.index === snapshot.index ? this.last.position : 0;
    if (
      snapshot.status === "playing" &&
      snapshot.position > previousPosition &&
      snapshot.position > 0 &&
      this.startedEntry !== entry.entryId
    ) {
      const track = previous.queue[snapshot.index!];
      if (track)
        this.event({
          track,
          playId: entry.entryId,
          kind: "play",
          completion: 0,
        });
      this.startedEntry = entry.entryId;
    }
    this.last = {
      ...previous,
      index: snapshot.index!,
      position: snapshot.position,
      duration: snapshot.duration,
      playing:
        snapshot.status === "loading" ? previous.playing : snapshot.playing,
      repeat: snapshot.repeat,
      shuffle: snapshot.shuffle,
      volume: snapshot.volume,
      mode: "audio",
    };
    this.applying = true;
    try {
      this.store.dispatch({ type: "native-state", state: this.last });
    } finally {
      this.applying = false;
    }
    this.status({
      state:
        snapshot.status === "failed"
          ? "error"
          : snapshot.status === "loading"
            ? "loading"
            : "ready",
      ...(snapshot.status === "failed" ? { message: FAILED } : {}),
    });
  }
  private flushSnapshot() {
    const snapshot = this.buffered;
    this.buffered = null;
    if (!this.pending && snapshot) this.applySnapshot(snapshot);
  }
  private resume = () => {
    if (document.hidden || !this.ready || this.disposed) return;
    void bounded(Promise.resolve().then(() => this.bridge.getSnapshot()))
      .then(this.receive)
      .catch(() => {
        if (!this.disposed) this.status({ state: "error", message: FAILED });
      });
  };
  private sync = () => {
    if (this.disposed || this.applying) return;
    if (this.unavailable) {
      this.failure(this.unavailableMessage);
      return;
    }
    this.intent++;
    this.pending = true;
    if (this.ready && !this.running) void this.drain();
  };
  private clearOwnership() {
    this.revision = "";
    this.sequence = -1;
    this.key = "";
    this.tracks = [];
    this.last = null;
    this.buffered = null;
    this.startedEntry = null;
  }
  private async stopCurrent() {
    const revision = this.revision;
    this.clearOwnership();
    if (revision) await bounded(this.bridge.stop({ revision }));
  }
  private stopDetached(revision: string) {
    void bounded(
      Promise.resolve().then(() => this.bridge.stop({ revision })),
    ).catch(() => {});
  }
  private async command(
    work: Promise<unknown>,
    revision: string,
    intent: number,
    apply = true,
  ) {
    const value = await bounded(work);
    if (this.disposed || revision !== this.revision || intent !== this.intent)
      return;
    const parsed = DeviceSnapshotSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid native command response");
    if (parsed.data.sequence <= this.sequence) return;
    if (!this.validSnapshot(parsed.data))
      throw new Error("Invalid native command ownership");
    if (apply) this.receive(parsed.data);
    return parsed.data;
  }
  private async drain() {
    this.running = true;
    try {
      while (this.pending && !this.disposed) {
        this.pending = false;
        const intent = this.intent;
        const state = this.store.getSnapshot();
        const key = stateQueueKey(state);
        let mutationPreviousRevision = "";
        this.busy = true;
        try {
          if (!state.queue.length || state.index < 0) {
            await this.stopCurrent();
            if (!this.disposed && this.intent === intent)
              this.status({ state: "idle" });
            continue;
          }
          const rows = state.queue.map((track, index) => ({
            entryId: state.entryIds?.[index] ?? crypto.randomUUID(),
            trackId: track.id,
            provider: track.provider,
            externalId: track.externalId,
            title: track.title,
            artist: track.artist,
          }));
          const valid = z.array(DeviceTrackSchema).max(500).safeParse(rows);
          if (
            !valid.success ||
            state.index >= rows.length ||
            !this.supportsQueue(state.queue)
          ) {
            await this.stopCurrent();
            if (!this.disposed && this.intent === intent)
              this.failure(this.unsupportedMessage(state.queue));
            continue;
          }
          if (key !== this.key || state.index !== this.last?.index) {
            const previousRevision = this.revision;
            if (
              previousRevision &&
              key !== this.key &&
              this.queueMutation &&
              valid.data.some((entry) =>
                this.tracks.some((old) => old.entryId === entry.entryId),
              )
            ) {
              mutationPreviousRevision = previousRevision;
              this.tracks = valid.data;
              this.key = key;
              this.revision = crypto.randomUUID();
              const revision = this.revision;
              const previous = this.last!;
              // A queue-only CAS does not acknowledge pending transport changes.
              // Keep that baseline across further edits until those commands complete.
              this.last = {
                ...state,
                position: previous.position,
                playing: previous.playing,
                repeat: previous.repeat,
                shuffle: previous.shuffle,
                volume: previous.volume,
              };
              let result = await this.command(
                this.bridge.mutateQueue({
                  ownerId: this.ownerId,
                  expectedRevision: previousRevision,
                  revision,
                  tracks: this.tracks,
                }),
                revision,
                intent,
                false,
              );
              if (!result) continue;
              const nativePlaying =
                result.status === "loading" ? previous.playing : result.playing;
              this.last = {
                ...this.last!,
                playing: nativePlaying,
                repeat: result.repeat,
                shuffle: result.shuffle,
                volume: result.volume,
              };
              const controls: Array<{
                run: () => Promise<unknown>;
                issued: Partial<PlayerSnapshot>;
              }> = [];
              if (state.playing !== nativePlaying && !state.playing)
                controls.push({
                  run: () => this.bridge.pause({ revision }),
                  issued: { playing: false },
                });
              if (Math.abs(state.position - previous.position) > 1)
                controls.push({
                  run: () =>
                    this.bridge.seek({ revision, position: state.position }),
                  issued: { position: state.position },
                });
              if (state.repeat !== result.repeat)
                controls.push({
                  run: () =>
                    this.bridge.setRepeat({ revision, mode: state.repeat }),
                  issued: { repeat: state.repeat },
                });
              if (state.shuffle !== result.shuffle)
                controls.push({
                  run: () =>
                    this.bridge.setShuffle({
                      revision,
                      enabled: state.shuffle,
                    }),
                  issued: { shuffle: state.shuffle },
                });
              if (state.volume !== result.volume)
                controls.push({
                  run: () =>
                    this.bridge.setVolume({ revision, value: state.volume }),
                  issued: { volume: state.volume },
                });
              if (state.playing !== nativePlaying && state.playing)
                controls.push({
                  run: () => this.bridge.play({ revision }),
                  issued: { playing: true },
                });
              for (const control of controls) {
                if (this.disposed || this.intent !== intent) break;
                // Record each issued command separately: its success can be superseded
                // while awaiting the reply, but not-yet-issued controls are still pending.
                this.last = { ...this.last!, ...control.issued };
                result = await this.command(
                  control.run(),
                  revision,
                  intent,
                  false,
                );
                if (!result) break;
              }
              if (result && !this.disposed && this.intent === intent)
                this.receive(result);
              continue;
            }
            this.clearOwnership();
            // If a replacement load fails before native ownership changes, the
            // previous revision must not keep playing an unrelated queue.
            if (previousRevision) {
              try {
                await bounded(this.bridge.stop({ revision: previousRevision }));
              } catch {
                /* loadQueue also replaces ownership atomically. */
              }
            }
            if (this.disposed || this.intent !== intent) continue;
            this.tracks = valid.data;
            this.key = key;
            this.revision = crypto.randomUUID();
            const revision = this.revision;
            this.last = state;
            this.status({ state: "loading" });
            await this.command(
              this.bridge.loadQueue({
                ownerId: this.ownerId,
                revision,
                tracks: this.tracks,
                index: state.index,
                position: state.position,
                playing: state.playing,
                repeat: state.repeat,
                shuffle: state.shuffle,
                volume: state.volume,
              }),
              revision,
              intent,
            );
            continue;
          }
          const revision = this.revision;
          const previous = this.last!;
          this.last = state;
          if (Math.abs(state.position - previous.position) > 1)
            await this.command(
              this.bridge.seek({ revision, position: state.position }),
              revision,
              intent,
            );
          if (this.disposed || this.intent !== intent) continue;
          if (state.repeat !== previous.repeat)
            await this.command(
              this.bridge.setRepeat({ revision, mode: state.repeat }),
              revision,
              intent,
            );
          if (this.disposed || this.intent !== intent) continue;
          if (state.shuffle !== previous.shuffle)
            await this.command(
              this.bridge.setShuffle({ revision, enabled: state.shuffle }),
              revision,
              intent,
            );
          if (this.disposed || this.intent !== intent) continue;
          if (state.volume !== previous.volume)
            await this.command(
              this.bridge.setVolume({ revision, value: state.volume }),
              revision,
              intent,
            );
          if (this.disposed || this.intent !== intent) continue;
          if (state.playing !== previous.playing)
            await this.command(
              state.playing
                ? this.bridge.play({ revision })
                : this.bridge.pause({ revision }),
              revision,
              intent,
            );
        } catch {
          const revision = this.revision;
          this.clearOwnership();
          // Expected revision makes this harmless if a newer engine took over.
          if (revision) this.stopDetached(revision);
          // Rejection before native CAS committed still leaves the captured old owner active.
          if (mutationPreviousRevision)
            this.stopDetached(mutationPreviousRevision);
          if (!this.disposed && this.intent === intent) this.failure(FAILED);
        } finally {
          this.busy = false;
          if (!this.disposed && this.intent === intent) this.flushSnapshot();
        }
      }
    } finally {
      this.running = false;
      if (this.pending && !this.disposed) void this.drain();
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.registrationAbandoned = true;
    this.unsubscribe();
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", this.resume);
    if (this.handle) {
      this.releaseHandle(this.handle);
      this.handle = null;
    }
    const revision = this.revision;
    this.clearOwnership();
    if (revision) this.stopDetached(revision);
  }
}
