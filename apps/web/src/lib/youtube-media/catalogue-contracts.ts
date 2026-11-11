import { z } from "zod";
import { AppError, TrackSchema } from "@aurelia/core";

export const catalogueIDs = {
  album: /^MPRE[bB]_[A-Za-z0-9_-]{1,150}$/,
  artist: /^UC[A-Za-z0-9_-]{22}$/,
  playlist: /^(?:VL)?(?:PL|OLAK5uy_|RDCLAK5uy_|UU)[A-Za-z0-9_-]{6,150}$/,
} as const;
export const MusicCollectionKind = z.enum(["album", "artist", "playlist"]);
export const MusicSearchKind = z.enum(["songs", "albums", "artists", "playlists"]);
const countryCodes = new Set(("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW ZZ").split(" "));
export const validCatalogueCountry = (value: string) => countryCodes.has(value);
export const CatalogueTaskSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("search"), kind: MusicSearchKind, query: z.string().trim().min(1).max(200)
    .refine((query) => !/[\u0000-\u001f\u007f]/.test(query)) }).strict(),
  z.object({ operation: z.literal("browse"), kind: MusicCollectionKind, id: z.string().min(1).max(160) }).strict()
    .refine((value) => catalogueIDs[value.kind].test(value.id)),
  z.object({ operation: z.literal("charts"), country: z.string().regex(/^[A-Z]{2}$/).refine(validCatalogueCountry) }).strict(),
]);
export type CatalogueTask = z.infer<typeof CatalogueTaskSchema>;

const artHosts = new Set(["lh3.googleusercontent.com", "yt3.googleusercontent.com", "yt3.ggpht.com", "i.ytimg.com"]);
export function safeCatalogueArtwork(value: string): string {
  try {
    const url = new URL(value);
    return value.length <= 2048 && url.protocol === "https:" && artHosts.has(url.hostname)
      && !url.username && !url.password && !url.port && !url.hash ? url.href : "";
  } catch { return ""; }
}
export const MusicCollectionSchema = z.object({
  id: z.string().max(160), kind: MusicCollectionKind, title: z.string().min(1).max(500),
  subtitle: z.string().max(1000), artwork: z.string().max(2048),
}).strict().refine((value) => catalogueIDs[value.kind].test(value.id)
  && (!value.artwork || safeCatalogueArtwork(value.artwork) === value.artwork));
const MusicTrackSchema = TrackSchema.extend({ provider: z.literal("youtube"), externalId: z.string().regex(/^[A-Za-z0-9_-]{11}$/) })
  .refine((track) => track.id === `youtube:${track.externalId}`
    && track.artwork === `https://i.ytimg.com/vi/${track.externalId}/hqdefault.jpg`
    && track.sourceUrl === `https://www.youtube.com/watch?v=${track.externalId}`);
const unique = <T extends { id: string }>(items: T[]) => new Set(items.map((item) => item.id)).size === items.length;
export const MusicCatalogueSectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/), title: z.string().min(1).max(120),
  tracks: z.array(MusicTrackSchema).max(1000).refine(unique),
  collections: z.array(MusicCollectionSchema).max(100).refine(unique),
}).strict();
export const MusicCataloguePageSchema = z.object({
  source: z.literal("youtube-music"), fetchedAt: z.iso.datetime(),
  kind: z.enum(["songs", "albums", "artists", "playlists", "album", "artist", "playlist", "charts"]),
  title: z.string().min(1).max(500), subtitle: z.string().max(1000),
  tracks: z.array(MusicTrackSchema).max(1000).refine(unique),
  collections: z.array(MusicCollectionSchema).max(100).refine(unique),
  sections: z.array(MusicCatalogueSectionSchema).max(12).refine(unique), truncated: z.boolean(),
  query: z.string().min(1).max(200).optional(), country: z.string().regex(/^[A-Z]{2}$/).optional(), countryName: z.string().min(1).max(120).optional(),
}).strict().superRefine((page, context) => {
  const tracks = page.tracks.length + page.sections.reduce((sum, section) => sum + section.tracks.length, 0);
  const collections = page.collections.length + page.sections.reduce((sum, section) => sum + section.collections.length, 0);
  const search = MusicSearchKind.safeParse(page.kind).success;
  if (tracks > (search ? 100 : 1000) || collections > 100 || (search && tracks + collections > 100))
    context.addIssue({ code: "custom", message: "Catalogue item budget exceeded" });
});
export type MusicCataloguePage = z.infer<typeof MusicCataloguePageSchema>;

export function catalogueRequest(operation: string, url: URL): CatalogueTask {
  const keys = [...url.searchParams.keys()];
  const expected = operation === "search" ? ["q", "kind"] : operation === "browse" ? ["kind", "id"] : operation === "charts" ? ["country"] : [];
  if (!expected.length || keys.some((key) => !expected.includes(key)) || new Set(keys).size !== keys.length) throw new AppError(400, "Invalid music catalogue query.");
  return CatalogueTaskSchema.parse(operation === "search"
    ? { operation, kind: url.searchParams.get("kind") ?? "songs", query: url.searchParams.get("q") ?? "" }
    : operation === "browse" ? { operation, kind: url.searchParams.get("kind"), id: url.searchParams.get("id") }
    : { operation, country: url.searchParams.get("country") ?? "ZZ" });
}
