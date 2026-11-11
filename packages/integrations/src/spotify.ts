import { z } from "zod";
import { AppError, type Track } from "@aurelia/core";
import type { ImportTrack } from "./matching";
export interface ImportSnapshot {
  provider: "spotify" | "file" | "fixture" | "aurelia";
  tracks: (ImportTrack & {
    provider?: Track["provider"];
    externalId?: string;
    history?: ImportedHistory[];
  })[];
  likes: string[];
  playlists: {
    id: string;
    name: string;
    description: string;
    trackIds: string[];
  }[];
  artists: { id: string; name: string }[];
  notices: string[];
  searches?: string[];
}
export interface ImportedHistory {
  id: string;
  playedAt: string;
  completion: number;
}
export interface ImportProvider {
  read(): Promise<ImportSnapshot>;
}
const SpotifyTrack = z.object({
  id: z.string().min(1).max(160).nullable(),
  name: z.string().min(1).max(500),
  artists: z
    .array(z.object({ name: z.string().min(1).max(500) }))
    .min(1)
    .max(30),
  album: z.object({ name: z.string().max(500) }).optional(),
  duration_ms: z.number().finite().min(0).max(86_400_000).optional(),
  external_ids: z.object({ isrc: z.string().max(30).optional() }).optional(),
  is_local: z.boolean().optional(),
});
export class SpotifyImportProvider implements ImportProvider {
  private requests = 0;
  private deadline = 0;
  private reading = false;
  constructor(private readonly accessToken: string) {}
  private url(path: string) {
    let url: URL;
    try {
      url = new URL(path, "https://api.spotify.com/v1/");
    } catch {
      throw new AppError(502, "Invalid Spotify pagination URL");
    }
    if (
      path.length > 4096 ||
      url.origin !== "https://api.spotify.com" ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith("/v1/")
    )
      throw new AppError(502, "Invalid Spotify pagination URL");
    return url;
  }
  private async get(path: string, retry = 0): Promise<unknown> {
    const url = this.url(path);
    const remaining = this.deadline - Date.now();
    if (remaining <= 0)
      throw new AppError(
        504,
        "Spotify import reached its two-minute deadline. Import a smaller collection.",
      );
    if (++this.requests > 128)
      throw new AppError(
        422,
        "Spotify import exceeded 128 requests. Import a smaller collection.",
      );
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(15_000, remaining),
    );
    let retryDelay: number | null = null;
    try {
      // No redirect can ever forward or reuse the bearer, including a same-host redirect.
      const response = await fetch(url, {
        redirect: "error",
        credentials: "omit",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400) ||
        (response.url && response.url !== url.href)
      )
        throw new AppError(502, "Spotify redirect was rejected");
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after") ?? 1);
        void response.body?.cancel().catch(() => {});
        if (
          retry >= 2 ||
          !Number.isFinite(seconds) ||
          seconds < 0 ||
          seconds > 5 ||
          seconds * 1000 >= this.deadline - Date.now()
        )
          throw new AppError(
            429,
            "Spotify requested a pause. Please try the import later.",
          );
        retryDelay = Math.max(1, seconds) * 1000;
      } else {
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new AppError(
            response.status === 403 ? 503 : 502,
            "Spotify access is unavailable for this collection.",
          );
        }
        return await this.readJson(response, controller.signal);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        502,
        "Spotify could not be read. Please try again later.",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    if (retryDelay !== null)
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    return this.get(path, retry + 1);
  }
  private async readJson(
    response: Response,
    signal: AbortSignal,
  ): Promise<unknown> {
    const cap = 2_000_000;
    const reader = response.body?.getReader();
    if (!reader) throw new AppError(502, "Spotify returned an empty response");
    let total = 0;
    const chunks: Uint8Array[] = [];
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void reader.cancel().catch(() => {});
        reject(new AppError(504, "Spotify response timed out"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      if (Number(response.headers.get("content-length")) > cap)
        throw new AppError(413, "Spotify response exceeds 2,000,000 bytes");
      while (true) {
        const result = await Promise.race([reader.read(), aborted]);
        if (signal.aborted)
          throw new AppError(504, "Spotify response timed out");
        if (result.done) break;
        total += result.value.byteLength;
        if (total > cap)
          throw new AppError(413, "Spotify response exceeds 2,000,000 bytes");
        chunks.push(result.value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
    } finally {
      signal.removeEventListener("abort", onAbort);
      // The owning request's controller is aborted in get(). Cleanup must not extend its deadline.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  private async pages(
    path: string,
    limit = 1000,
    select: (value: unknown) => unknown = (value) => value,
  ) {
    const all: unknown[] = [];
    const visited = new Set<string>();
    let next: string | null = path;
    while (next) {
      const canonical = this.url(next);
      canonical.searchParams.sort();
      if (visited.has(canonical.href))
        throw new AppError(502, "Spotify pagination cycle was rejected");
      visited.add(canonical.href);
      const page = z
        .object({
          items: z.array(z.unknown()).max(1000),
          next: z.string().max(4096).nullable(),
        })
        .parse(select(await this.get(next)));
      if (page.items.length === 0 && page.next)
        throw new AppError(
          502,
          "Spotify returned an empty page with another page",
        );
      if (all.length + page.items.length > limit)
        throw new AppError(
          422,
          `The MVP supports up to ${limit} entries per collection. Import a smaller collection.`,
        );
      all.push(...page.items);
      next = page.next;
    }
    return all;
  }
  async read(): Promise<ImportSnapshot> {
    if (this.reading)
      throw new AppError(409, "Spotify import is already running");
    if (
      this.accessToken.length > 4096 ||
      !/^[A-Za-z0-9._~+/-]{16,4096}=*$/.test(this.accessToken)
    )
      throw new AppError(502, "Invalid Spotify credential");
    this.reading = true;
    this.requests = 0;
    this.deadline = Date.now() + 120_000;
    try {
      return await this.readSnapshot();
    } finally {
      this.reading = false;
    }
  }
  private async readSnapshot(): Promise<ImportSnapshot> {
    const tracks = new Map<string, ImportTrack>();
    const notices: string[] = [];
    let skipped = 0;
    const ingest = (value: unknown) => {
      const result = SpotifyTrack.safeParse(value);
      if (!result.success || !result.data.id || result.data.is_local) {
        skipped++;
        return null;
      }
      const t = result.data;
      if (!tracks.has(t.id!) && tracks.size >= 1000)
        throw new AppError(
          422,
          "The MVP supports at most 1,000 unique tracks per import.",
        );
      const artist = t.artists.map((entry) => entry.name).join(", ");
      if (artist.length > 500)
        throw new AppError(422, "Spotify artist metadata is too large");
      tracks.set(t.id!, {
        id: t.id!,
        title: t.name,
        artist,
        album: t.album?.name ?? "",
        duration: (t.duration_ms ?? 0) / 1000,
        isrc: t.external_ids?.isrc,
      });
      return t.id!;
    };
    const saved = await this.pages("me/tracks?limit=50");
    const likes = saved
      .map((x) => ingest(z.object({ track: z.unknown() }).parse(x).track))
      .filter((x): x is string => !!x);
    const list = await this.pages("me/playlists?limit=50", 100);
    const playlists: ImportSnapshot["playlists"] = [];
    for (const raw of list) {
      const p = z
        .object({
          id: z.string().min(1).max(160),
          name: z.string().min(1).max(120),
          description: z.string().max(1000).nullable().optional(),
        })
        .parse(raw);
      try {
        const entries = await this.pages(
          `playlists/${encodeURIComponent(p.id)}/items?limit=50`,
        );
        const trackIds = entries
          .map((x) => {
            const entry = z
              .object({
                item: z.unknown().optional(),
                track: z.unknown().optional(),
              })
              .parse(x);
            return ingest(entry.item ?? entry.track);
          })
          .filter((x): x is string => !!x);
        playlists.push({
          id: p.id,
          name: p.name,
          description: p.description ?? "",
          trackIds,
        });
      } catch (e) {
        if (!(e instanceof AppError) || e.status !== 503) throw e;
        notices.push(
          "A Spotify playlist was unavailable for this account and was not imported.",
        );
      }
    }
    const artists: ImportSnapshot["artists"] = [];
    try {
      const entries = await this.pages(
        "me/following?type=artist&limit=50",
        1000,
        (value) => z.object({ artists: z.unknown() }).parse(value).artists,
      );
      artists.push(
        ...z
          .array(
            z.object({
              id: z.string().min(1).max(160),
              name: z.string().min(1).max(500),
            }),
          )
          .parse(entries),
      );
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 503) throw error;
      notices.push(
        "Followed artists were not available for this Spotify account.",
      );
    }
    if (skipped)
      notices.push(
        `${skipped} unavailable, local or invalid Spotify entries were not imported.`,
      );
    return {
      provider: "spotify",
      tracks: [...tracks.values()],
      likes,
      playlists,
      artists,
      notices,
    };
  }
}
export const FileImportSchema = z.object({
  provider: z.enum(["file", "fixture"]).default("file"),
  tracks: z
    .array(
      z.object({
        id: z.string().min(1).max(160),
        title: z.string().min(1).max(500),
        artist: z.string().min(1).max(500),
        album: z.string().max(500).default(""),
        duration: z.number().nonnegative().max(86400).default(0),
        isrc: z.string().max(30).optional(),
        sourceUrl: z.url().optional(),
      }),
    )
    .min(1)
    .max(1000),
  likes: z.array(z.string()).max(1000).default([]),
  playlists: z
    .array(
      z.object({
        id: z.string().max(160),
        name: z.string().min(1).max(120),
        description: z.string().max(1000).default(""),
        trackIds: z.array(z.string()).max(1000),
      }),
    )
    .max(100)
    .default([]),
  artists: z
    .array(z.object({ id: z.string().max(160), name: z.string().max(500) }))
    .max(1000)
    .default([]),
  notices: z.array(z.string()).max(20).default([]),
});
