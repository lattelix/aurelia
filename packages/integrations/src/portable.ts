import { z } from "zod";
import { AppError, type Library } from "@aurelia/core";
import { FileImportSchema, type ImportSnapshot } from "./spotify";

export const IMPORT_TRACK_LIMIT = 1000;
export const IMPORT_BYTE_LIMIT = 2_000_000;
const identifier = z.string().min(1).max(160);
const track = z
  .object({
    id: identifier,
    provider: z.enum(["studio", "youtube"]),
    externalId: z.string().min(1).max(160),
    title: z.string().min(1).max(500),
    artist: z.string().min(1).max(500),
    album: z.string().max(500),
    duration: z.number().finite().nonnegative().max(86400),
    isrc: z.string().max(30).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.provider === "youtube" &&
        (!/^[A-Za-z0-9_-]{11}$/.test(value.externalId) ||
          value.id !== `youtube:${value.externalId}`)) ||
      (value.provider === "studio" &&
        (!/^(?:[1-9]|1[0-2])$/.test(value.externalId) ||
          !/^studio:[A-Za-z0-9_-]+$/.test(value.id)))
    )
      context.addIssue({
        code: "custom",
        message: "Invalid provider track identity",
      });
  });

/** Metadata transfer, not an account backup or a source of trusted media URLs. */
export const PortableLibrarySchema = z
  .object({
    format: z.literal("aurelia-library"),
    version: z.literal(1),
    exportedAt: z.iso.datetime(),
    tracks: z.array(track).max(IMPORT_TRACK_LIMIT),
    likes: z.array(identifier).max(IMPORT_TRACK_LIMIT),
    playlists: z
      .array(
        z
          .object({
            id: identifier,
            name: z.string().min(1).max(120),
            description: z.string().max(1000),
            trackIds: z.array(identifier).max(IMPORT_TRACK_LIMIT),
          })
          .strict(),
      )
      .max(100),
    artists: z
      .array(
        z.object({ id: identifier, name: z.string().min(1).max(500) }).strict(),
      )
      .max(IMPORT_TRACK_LIMIT)
      .default([]),
    history: z
      .array(
        z
          .object({
            id: identifier,
            trackId: identifier,
            playedAt: z.iso.datetime(),
            completion: z.number().finite().min(0).max(1),
          })
          .strict(),
      )
      .max(1000)
      .default([]),
    searches: z.array(z.string().trim().min(1).max(200)).max(1000).default([]),
    notices: z.array(z.string().max(1000)).max(20).default([]),
  })
  .strict();
export type PortableLibrary = z.infer<typeof PortableLibrarySchema>;

function bounded(value: unknown, pretty = false) {
  let json: string | undefined;
  try {
    json = JSON.stringify(value, null, pretty ? 2 : undefined);
  } catch {
    throw new AppError(400, "Invalid library file");
  }
  if (!json || new TextEncoder().encode(json).byteLength > IMPORT_BYTE_LIMIT)
    throw new AppError(
      413,
      "Library files must be at most 2,000,000 bytes. Split a larger library before importing.",
    );
}

function references(
  snapshot: Pick<ImportSnapshot, "tracks" | "likes" | "playlists" | "artists">,
) {
  const ids = new Set(snapshot.tracks.map((value) => value.id));
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (
    ids.size !== snapshot.tracks.length ||
    !unique(snapshot.likes) ||
    !unique(snapshot.playlists.map((p) => p.id)) ||
    !unique(snapshot.artists.map((artist) => artist.id)) ||
    snapshot.likes.some((id) => !ids.has(id)) ||
    snapshot.playlists.some(
      (p) => !unique(p.trackIds) || p.trackIds.some((id) => !ids.has(id)),
    )
  )
    throw new AppError(
      400,
      "Library files require unique IDs and valid track references.",
    );
}

export function createPortableLibrary(
  library: Library,
  artists: PortableLibrary["artists"] = [],
  exportedAt = new Date().toISOString(),
): PortableLibrary {
  const tracks = new Map(library.likes.map((value) => [value.id, value]));
  for (const playlist of library.playlists)
    for (const value of playlist.tracks) tracks.set(value.id, value);
  for (const entry of library.history) tracks.set(entry.track.id, entry.track);
  const result = PortableLibrarySchema.parse({
    format: "aurelia-library",
    version: 1,
    exportedAt,
    tracks: [...tracks.values()].map((value) => ({
      id: value.id,
      provider: value.provider,
      externalId: value.externalId,
      title: value.title,
      artist: value.artist,
      album: value.album,
      duration: value.duration,
      ...(value.isrc ? { isrc: value.isrc } : {}),
    })),
    likes: library.likes.map((value) => value.id),
    playlists: library.playlists.map((value) => ({
      id: value.id,
      name: value.name,
      description: value.description,
      trackIds: value.tracks.map((entry) => entry.id),
    })),
    artists,
    history: library.history.map((entry) => ({
      id: entry.id,
      trackId: entry.track.id,
      playedAt: entry.playedAt,
      completion: entry.completion,
    })),
    searches: library.searches,
    notices: [
      "History covers the latest 100 plays and searches the latest 8 queries exposed by the library view. Queue, account identity and audio are excluded.",
    ],
  });
  references(result);
  // The Account screen downloads pretty JSON; that exact file must also fit the upload cap.
  bounded(result, true);
  return result;
}

/** Both uploads normalize into the existing review/job engine; no uploaded account data is accepted. */
export function parseLibraryImport(value: unknown): ImportSnapshot {
  bounded(value);
  if (
    value !== null &&
    typeof value === "object" &&
    ("format" in value || "version" in value)
  ) {
    const data = PortableLibrarySchema.parse(value);
    references(data);
    const ids = new Set(data.tracks.map((entry) => entry.id));
    if (
      new Set(data.history.map((entry) => entry.id)).size !==
        data.history.length ||
      data.history.some((entry) => !ids.has(entry.trackId))
    )
      throw new AppError(
        400,
        "History requires unique IDs and valid track references.",
      );
    return {
      provider: "aurelia",
      tracks: data.tracks.map((entry) => ({
        ...entry,
        history: data.history
          .filter((event) => event.trackId === entry.id)
          .map((event) => ({
            id: event.id,
            playedAt: event.playedAt,
            completion: event.completion,
          })),
      })),
      likes: data.likes,
      playlists: data.playlists,
      artists: data.artists,
      searches: [...new Set(data.searches)],
      notices: [
        "Metadata transfer. Unknown provider IDs require review; account identity, queue and audio are excluded.",
        ...data.notices,
      ],
    };
  }
  const data = FileImportSchema.parse(value);
  references(data);
  return {
    ...data,
    tracks: data.tracks.map((entry) => ({
      id: entry.id,
      title: entry.title,
      artist: entry.artist,
      album: entry.album,
      duration: entry.duration,
      ...(entry.isrc ? { isrc: entry.isrc } : {}),
    })),
    notices: [
      ...data.notices,
      ...(data.tracks.some((entry) => entry.sourceUrl)
        ? ["Source URLs are ignored; imports contain metadata only."]
        : []),
    ],
  };
}
