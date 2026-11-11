import { z } from "zod";
import { getDatabase, getLibrary, getSignals } from "@aurelia/database";
import { rateLimit } from "@aurelia/auth";
import { catalogue, albums, artists, editorialPlaylists } from "@aurelia/music";
import { recommend } from "@aurelia/recommendations";
import { AppError, AudioQualitySchema, type Library } from "@aurelia/core";
import { PlayerSnapshotSchema } from "@aurelia/player";
import { account, json } from "./http";
import { studio, youtube, trustedTrack, providerFor } from "./providers";
import { capabilities } from "./env";
import { getMusicDiscovery } from "./youtube-media/discovery";
import { getMusicCatalogue } from "./youtube-media/catalogue";
import { catalogueRequest } from "./youtube-media/catalogue-contracts";
import { mediaRequestBudget } from "./guest-policy";
function candidatePool(library: Library | null) {
  return [
    ...(capabilities.demoCatalogue ? catalogue : []),
    ...(library?.likes ?? []),
    ...(library?.history.map((h) => h.track) ?? []),
    ...(library?.playlists.flatMap((p) => p.tracks) ?? []),
  ].filter(
    (track) => capabilities.demoCatalogue || track.provider === "youtube",
  );
}
function recommendationContext(library: Library | null) {
  const queue = PlayerSnapshotSchema.safeParse(library?.queue);
  return {
    followedArtists: library?.followedArtists,
    queuedTrackIds: queue.success ? queue.data.queue.map((t) => t.id) : [],
  };
}
export async function musicApi(path: string[], request: Request) {
  if (request.method !== "GET") return null;
  const db = await getDatabase();
  const user = await account();
  const url = new URL(request.url);
  if (path.length === 3 && path[0] === "music" && path[1] === "catalogue") {
    const task = catalogueRequest(path[2], url);
    await rateLimit(db, `music-catalogue:${user?.id ?? "guest"}`, 30);
    return json(await getMusicCatalogue(task));
  }
  if (path[0] === "bootstrap") {
    const library = user ? await getLibrary(db, user.id) : null;
    const signals = user ? await getSignals(db, user.id) : [];
    return json({
      user,
      library,
      catalogue: capabilities.demoCatalogue ? catalogue : [],
      albums: capabilities.demoCatalogue ? albums : [],
      artists: capabilities.demoCatalogue ? artists : [],
      editorialPlaylists: capabilities.demoCatalogue ? editorialPlaylists : [],
      capabilities,
      recommendations: recommend(
        candidatePool(library),
        signals,
        12,
        Date.now(),
        recommendationContext(library),
      ),
    });
  }
  if (path[0] === "discovery" && path.length === 1) {
    if (url.search)
      throw new AppError(400, "Discovery does not accept query parameters");
    await rateLimit(db, `discovery:${user?.id ?? "guest"}`, 30);
    if (capabilities.demoCatalogue)
      return json({
        source: "youtube-music",
        fetchedAt: new Date().toISOString(),
        sections: [],
      });
    return json(await getMusicDiscovery());
  }
  if (path[0] === "search") {
    const query = z
      .string()
      .trim()
      .max(200)
      .parse(url.searchParams.get("q") ?? "");
    const provider =
      url.searchParams.get("provider") === "youtube" ? youtube : studio;
    await rateLimit(
      db,
      `search:${provider === youtube ? "youtube" : "studio"}:${user?.id ?? "guest"}`,
      provider === youtube ? 30 : 90,
    );
    return json(await provider.search(query));
  }
  if (path[0] === "autocomplete") {
    return json({
      suggestions: await studio.autocomplete(
        (url.searchParams.get("q") ?? "").slice(0, 200),
      ),
    });
  }
  if (path[0] === "stream") {
    const id = url.searchParams.get("id");
    if (!id) throw new AppError(400, "Missing track ID");
    if (id.startsWith("studio:"))
      await rateLimit(db, `resolve:${user?.id ?? "guest"}`, 30);
    else await mediaRequestBudget(user, "resolve", 30);
    const track = await trustedTrack(id);
    const quality = AudioQualitySchema.parse(
      url.searchParams.get("quality") ?? "balanced",
    );
    return json(await providerFor(track).getStream(track, quality));
  }
  if (path[0] === "recommendations") {
    await rateLimit(db, `recommendations:${user?.id ?? "guest"}`, 20);
    const library = user ? await getLibrary(db, user.id) : null;
    const candidates = candidatePool(library);
    const seeds = [
      ...new Map(
        [
          ...(library?.likes ?? []),
          ...(library?.history.map((h) => h.track) ?? []),
          ...(library?.playlists.flatMap((p) => p.tracks) ?? []),
        ]
          .filter((track) => track.provider === "youtube")
          .map((track) => [track.id, track]),
      ).values(),
    ].slice(0, 2);
    const discovery = await Promise.allSettled(
      seeds.map((track) => youtube.getRelated(track)),
    );
    for (const result of discovery)
      if (result.status === "fulfilled") candidates.push(...result.value);
    if (
      !capabilities.demoCatalogue &&
      new Set(candidates.map((track) => track.id)).size < 12
    ) {
      try {
        const explore = await getMusicDiscovery();
        candidates.push(
          ...explore.sections.flatMap((section) => section.tracks),
        );
      } catch {
        /* Keep the account's available music when public discovery is unavailable. */
      }
    }
    return json(
      recommend(
        candidates,
        user ? await getSignals(db, user.id) : [],
        12,
        Date.now(),
        recommendationContext(library),
      ),
    );
  }
  if (path[0] === "related") {
    await rateLimit(db, `related:${user?.id ?? "guest"}`, 30);
    const track = await trustedTrack(url.searchParams.get("id") ?? "");
    return json(await providerFor(track).getRelated(track));
  }
  if (path[0] === "album") return json(await studio.getAlbum(path[1]));
  if (path[0] === "artist") return json(await studio.getArtist(path[1]));
  if (path[0] === "playlist") return json(await studio.getPlaylist(path[1]));
  return null;
}
