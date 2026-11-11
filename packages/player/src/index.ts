import {
  AudioQualitySchema,
  TrackSchema,
  type Track,
  type AudioQuality,
} from "@aurelia/core";
import { z } from "zod";
export * from "./browser-engine";
export * from "./native-engine";
export * from "./device-engine";
export const PlayerSnapshotSchema = z
  .object({
    queue: z.array(TrackSchema).max(500),
    // Parallel occurrence identities; omitted only by pre-migration snapshots.
    entryIds: z.array(z.uuid()).max(500).optional(),
    index: z.number().int().min(-1),
    position: z.number().nonnegative(),
    duration: z.number().nonnegative(),
    playing: z.boolean(),
    shuffle: z.boolean(),
    repeat: z.enum(["off", "all", "one"]),
    volume: z.number().min(0).max(1),
    autoplay: z.boolean(),
    mode: z.enum(["audio", "video"]).default("audio"),
    quality: AudioQualitySchema.default("balanced"),
  })
  .superRefine((value, context) => {
    if (
      value.entryIds &&
      (value.entryIds.length !== value.queue.length ||
        new Set(value.entryIds).size !== value.entryIds.length)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid queue occurrence identities",
      });
  });
export type PlayerSnapshot = z.infer<typeof PlayerSnapshotSchema>;
export type PlayerEvent =
  | { type: "play"; tracks: Track[]; index?: number }
  | { type: "toggle" }
  | { type: "pause" }
  | { type: "next"; ended?: boolean }
  | { type: "previous" }
  | { type: "seek"; position: number }
  | { type: "progress"; position: number; duration: number }
  | { type: "queue"; track: Track }
  | { type: "play-next"; track: Track }
  | { type: "clear-upcoming" }
  | { type: "clear" }
  | { type: "remove"; index: number }
  | { type: "move"; from: number; to: number }
  | { type: "shuffle" }
  | { type: "repeat" }
  | { type: "volume"; volume: number }
  | { type: "autoplay"; enabled: boolean }
  | { type: "mode"; mode: "audio" | "video" }
  | { type: "quality"; quality: AudioQuality }
  | { type: "native-state"; state: unknown }
  | { type: "restore"; state: unknown };
export const initialPlayer: PlayerSnapshot = {
  queue: [],
  index: -1,
  position: 0,
  duration: 0,
  playing: false,
  shuffle: false,
  repeat: "off",
  volume: 0.75,
  autoplay: true,
  mode: "audio",
  quality: "balanced",
};
export function transition(
  s: PlayerSnapshot,
  e: PlayerEvent,
  random: () => number = Math.random,
): PlayerSnapshot {
  switch (e.type) {
    case "play": {
      if (!e.tracks.length || e.tracks.length > 500) return s;
      const queue = [...e.tracks];
      const index = Math.max(0, Math.min(e.index ?? 0, queue.length - 1));
      return {
        ...s,
        queue,
        entryIds: queue.map(() => crypto.randomUUID()),
        index,
        position: 0,
        duration: queue[index].duration,
        playing: true,
        mode: "audio",
      };
    }
    case "toggle":
      return s.index < 0
        ? s
        : {
            ...s,
            playing: !s.playing,
            position: !s.playing && s.position >= s.duration ? 0 : s.position,
          };
    case "pause":
      return { ...s, playing: false };
    case "seek":
      return { ...s, position: Math.max(0, Math.min(e.position, s.duration)) };
    case "progress":
      return { ...s, position: e.position, duration: e.duration || s.duration };
    case "next": {
      if (s.index < 0) return s;
      // Restored/paused media may emit a stale ended event after a seek/load.
      // Only active playback may naturally advance or repeat.
      if (e.ended && !s.playing) return s;
      if (e.ended && s.repeat === "one")
        return { ...s, position: 0, playing: true };
      let index = s.index + 1;
      if (s.shuffle && s.queue.length > 1) {
        const offset = 1 + Math.floor(random() * (s.queue.length - 1));
        index = (s.index + offset) % s.queue.length;
      }
      if (index >= s.queue.length) {
        if (s.repeat === "all") index = 0;
        else return { ...s, playing: false, position: s.duration };
      }
      return {
        ...s,
        index,
        position: 0,
        duration: s.queue[index].duration,
        playing: true,
      };
    }
    case "previous": {
      if (s.position > 3) return { ...s, position: 0 };
      const index = Math.max(0, s.index - 1);
      return s.index < 0
        ? s
        : {
            ...s,
            index,
            position: 0,
            duration: s.queue[index].duration,
            playing: true,
          };
    }
    case "queue":
    case "play-next": {
      if (s.queue.length >= 500) return s;
      const at =
        e.type === "play-next" ? Math.max(0, s.index + 1) : s.queue.length;
      const queue = [...s.queue];
      const entryIds = occurrenceIds(s);
      queue.splice(at, 0, e.track);
      entryIds.splice(at, 0, crypto.randomUUID());
      return {
        ...s,
        queue,
        entryIds,
        ...(s.index < 0
          ? {
              index: 0,
              position: 0,
              duration: queue[0].duration,
              playing: false,
            }
          : {}),
      };
    }
    case "clear":
      return {
        ...s,
        queue: [],
        entryIds: [],
        index: -1,
        position: 0,
        duration: 0,
        playing: false,
      };
    case "clear-upcoming":
      return {
        ...s,
        queue: s.queue.slice(0, s.index + 1),
        entryIds: occurrenceIds(s).slice(0, s.index + 1),
      };
    case "remove": {
      if (e.index < 0 || e.index >= s.queue.length) return s;
      const queue = s.queue.filter((_, i) => i !== e.index);
      if (!queue.length)
        return {
          ...s,
          queue: [],
          entryIds: [],
          index: -1,
          position: 0,
          duration: 0,
          playing: false,
        };
      const index = Math.min(
        s.index - (e.index < s.index ? 1 : 0),
        queue.length - 1,
      );
      return {
        ...s,
        queue,
        entryIds: occurrenceIds(s).filter((_, i) => i !== e.index),
        index,
        ...(e.index === s.index
          ? { position: 0, duration: queue[Math.max(0, index)].duration }
          : {}),
      };
    }
    case "move": {
      if (
        e.from < 0 ||
        e.to < 0 ||
        e.from >= s.queue.length ||
        e.to >= s.queue.length
      )
        return s;
      const ids = occurrenceIds(s);
      const entries = s.queue.map((track, index) => ({
        track,
        index,
        entryId: ids[index],
      }));
      const [entry] = entries.splice(e.from, 1);
      entries.splice(e.to, 0, entry);
      return {
        ...s,
        queue: entries.map((x) => x.track),
        entryIds: entries.map((x) => x.entryId),
        index: entries.findIndex((x) => x.index === s.index),
      };
    }
    case "shuffle":
      return { ...s, shuffle: !s.shuffle };
    case "repeat":
      return {
        ...s,
        repeat: s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off",
      };
    case "volume":
      return { ...s, volume: Math.max(0, Math.min(1, e.volume)) };
    case "autoplay":
      return { ...s, autoplay: e.enabled };
    case "mode":
      return { ...s, mode: e.mode };
    case "quality":
      return { ...s, quality: e.quality };
    case "native-state": {
      const parsed = PlayerSnapshotSchema.safeParse(e.state);
      if (!parsed.success) return s;
      const value = parsed.data;
      // Native events may advance an existing queue, never replace its catalogue records.
      if (
        value.queue.length !== s.queue.length ||
        value.queue.some((track, index) => track.id !== s.queue[index]?.id) ||
        (value.entryIds &&
          s.entryIds &&
          value.entryIds.some((id, index) => id !== s.entryIds![index])) ||
        value.index >= s.queue.length ||
        (value.index < 0 && value.playing) ||
        !Number.isFinite(value.position) ||
        !Number.isFinite(value.duration)
      )
        return s;
      return {
        ...s,
        index: value.index,
        position: Math.min(value.position, value.duration),
        duration: value.duration,
        playing: value.playing,
        repeat: value.repeat,
        shuffle: value.shuffle,
        volume: value.volume,
        mode: "audio",
      };
    }
    case "restore": {
      const parsed = PlayerSnapshotSchema.safeParse(e.state);
      if (!parsed.success) return initialPlayer;
      const value = parsed.data;
      const index = value.queue.length
        ? Math.max(0, Math.min(value.index, value.queue.length - 1))
        : -1;
      const duration =
        index < 0 ? 0 : value.duration || value.queue[index].duration;
      return {
        ...value,
        entryIds: occurrenceIds(value),
        index,
        duration,
        position: Math.min(value.position, duration),
        playing: false,
        mode: "audio",
      };
    }
  }
}
function occurrenceIds(state: PlayerSnapshot): string[] {
  return state.entryIds
    ? [...state.entryIds]
    : state.queue.map(() => crypto.randomUUID());
}
export type PlayerActionResult =
  { ok: true } | { ok: false; code: "queue-full" };
export class PlayerStore {
  private state: PlayerSnapshot = initialPlayer;
  private playRequested = false;
  private intentRevision = 0;
  private readonly listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  getServerSnapshot = () => initialPlayer;
  /** Only a direct track/mix Play action may survive initial async bootstrap. */
  hasPlayRequest = () => this.playRequested;
  /** User actions invalidate async continuations; progress/native observations do not. */
  getIntentRevision = () => this.intentRevision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  dispatch = (event: PlayerEvent): PlayerActionResult => {
    if (
      ((event.type === "queue" || event.type === "play-next") &&
        this.state.queue.length >= 500) ||
      (event.type === "play" && event.tracks.length > 500)
    )
      return { ok: false, code: "queue-full" };
    if (event.type === "restore") this.playRequested = false;
    else if (event.type === "play" && event.tracks.length > 0)
      this.playRequested = true;
    if (event.type !== "progress" && event.type !== "native-state")
      this.intentRevision++;
    this.state = transition(this.state, event);
    this.listeners.forEach((f) => f());
    return { ok: true };
  };
}
