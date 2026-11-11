import type { CatalogueTask } from "../src/lib/youtube-media/catalogue-contracts";
export function validateTask(value: unknown): CatalogueTask;
export function catalogueFetch(signal: AbortSignal, upstream?: typeof fetch): typeof fetch;
export function metadataItem(value: Record<string, unknown>): Record<string, unknown> | null;
export function albumMetadataItems(page: Record<string, unknown>): Record<string, unknown>[];
export function runCatalogue(task: CatalogueTask, signal: AbortSignal): Promise<unknown>;
