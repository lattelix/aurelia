import { AppError } from "@aurelia/core";
import { MediaCache } from "./cache";
import { CatalogueTaskSchema, type CatalogueTask, type MusicCataloguePage } from "./catalogue-contracts";
import { normalizeMusicCatalogue } from "./catalogue-metadata";
import { runMusicCatalogue } from "./catalogue-runtime";

const cache = new MediaCache<MusicCataloguePage>(64);
export function getMusicCatalogue(input: CatalogueTask): Promise<MusicCataloguePage> {
  const task = CatalogueTaskSchema.parse(input);
  return cache.resolve(JSON.stringify(task), task.operation === "charts" ? 15 * 60_000 : 5 * 60_000, async () => {
    try {
      const result = normalizeMusicCatalogue(await runMusicCatalogue(task), task);
      if (task.operation !== "search" && result.tracks.length + result.collections.length + result.sections.length === 0)
        throw new Error("Empty catalogue page");
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, "YouTube Music catalogue is temporarily unavailable. Please retry.");
    }
  });
}
