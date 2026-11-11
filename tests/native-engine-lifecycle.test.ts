import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogue } from "@aurelia/music";

const { listeners, bridge } = vi.hoisted(() => {
  const listeners = new Map<string, (event?: unknown) => void>();
  const ok = () => Promise.resolve();
  return {
    listeners,
    bridge: {
      addListener: vi.fn(
        (name: string, listener: (event?: unknown) => void) => {
          listeners.set(name, listener);
          return Promise.resolve({ remove: vi.fn(ok) });
        },
      ),
      load: vi.fn(ok),
      play: vi.fn(ok),
      pause: vi.fn(ok),
      seek: vi.fn(ok),
      volume: vi.fn(ok),
      stop: vi.fn(ok),
    },
  };
});
vi.mock("@capacitor/core", () => ({ registerPlugin: () => bridge }));

import { NativeAudioEngine, PlayerStore } from "@aurelia/player";

describe("native bridge handoff lifecycle", () => {
  beforeEach(() => {
    listeners.clear();
    vi.clearAllMocks();
  });
  for (const [event, payload] of [
    ["progress", { position: 42, duration: 72, playing: false, audible: true }],
    ["ended", undefined],
    ["control", { action: "next" }],
  ] as const) {
    it(`ignores queued ${event} events after disposal to another engine`, () => {
      const store = new PlayerStore();
      store.dispatch({ type: "play", tracks: catalogue.slice(0, 2) });
      const report = vi.fn();
      const engine = new NativeAudioEngine(
        store,
        async () => ({
          kind: "audio",
          url: "/audio/1.mp3",
          capabilities: { background: true, seek: true, mediaSession: true },
        }),
        report,
        vi.fn(),
      );
      const callback = listeners.get(event);
      expect(callback).toBeTypeOf("function");
      engine.dispose();
      const current = store.getSnapshot();
      const events = report.mock.calls.length;
      callback?.(payload);
      expect(store.getSnapshot()).toBe(current);
      expect(report.mock.calls).toHaveLength(events);
    });
  }
});
