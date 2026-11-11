// Anonymous music metadata only. The parent starts this entry with a stripped
// environment, dependency/entry read grants, a 15 s deadline and bounded stdout.
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Innertube, Log, YTNodes, Parser } from "youtubei.js";

const MiB = 1024 * 1024;
const origins = new Set(["https://www.youtube.com", "https://music.youtube.com", "https://youtubei.googleapis.com"]);
const kinds = new Set(["songs", "albums", "artists", "playlists"]);
const browseKinds = new Set(["album", "artist", "playlist"]);
let phase = "input";
const ids = {
  album: /^MPRE[bB]_[A-Za-z0-9_-]{1,150}$/,
  artist: /^UC[A-Za-z0-9_-]{22}$/,
  playlist: /^(?:VL)?(?:PL|OLAK5uy_|RDCLAK5uy_|UU)[A-Za-z0-9_-]{6,150}$/,
};

export function validateTask(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task");
  if (value.operation === "search" && kinds.has(value.kind) && typeof value.query === "string"
    && value.query === value.query.trim() && value.query.length >= 1 && value.query.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(value.query)
    && Object.keys(value).sort().join() === "kind,operation,query") return value;
  if (value.operation === "browse" && browseKinds.has(value.kind) && typeof value.id === "string"
    && ids[value.kind].test(value.id) && Object.keys(value).sort().join() === "id,kind,operation") return value;
  if (value.operation === "charts" && typeof value.country === "string" && /^[A-Z]{2}$/.test(value.country)
    && Object.keys(value).sort().join() === "country,operation") return value;
  throw new Error("Invalid task");
}

export function catalogueFetch(signal, upstream = fetch) {
  let total = 0, requests = 0;
  return async (input, init) => {
    signal.throwIfAborted();
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    if (!origins.has(url.origin) || url.username || url.password || url.hash || ++requests > 8
      || !(/^\/youtubei\/v1\/(search|browse|config)$/.test(url.pathname) || url.pathname === "/sw.js_data")) throw new Error("Metadata request rejected");
    const headers = new Headers(init?.headers ?? request?.headers);
    for (const name of ["Cookie", "Authorization", "Proxy-Authorization"]) headers.delete(name);
    const combined = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : []), ...(request ? [request.signal] : [])]);
    const response = await upstream(input, { ...init, headers, credentials: "omit", redirect: "error", signal: combined });
    let reader;
    try {
      const length = response.headers.get("content-length");
      if (!response.ok || (length !== null && (!/^\d+$/.test(length) || Number(length) > 4 * MiB || Number(length) > 8 * MiB - total))) throw new Error("Metadata response rejected");
      reader = response.body?.getReader();
      const chunks = []; let size = 0;
      if (reader) for (;;) {
        combined.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength; total += chunk.value.byteLength;
        if (size > 4 * MiB || total > 8 * MiB) throw new Error("Metadata response too large");
        chunks.push(chunk.value);
      }
      combined.throwIfAborted();
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("set-cookie"); responseHeaders.delete("content-encoding"); responseHeaders.set("content-length", String(size));
      return new Response(bytes, { status: response.status, headers: responseHeaders });
    } catch (error) {
      if (reader) await reader.cancel().catch(() => {}); else await response.body?.cancel().catch(() => {});
      throw error;
    } finally { reader?.releaseLock(); }
  };
}

const text = (value, maximum = 1000) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum)
  : value?.toString ? text(value.toString(), maximum) : "";
export function metadataItem(node) {
  const kind = node.item_type;
  if (!["song", "video", "album", "artist", "playlist"].includes(kind)) return null;
  const payload = node.endpoint?.payload;
  const names = node.artists ?? node.authors ?? (node.author ? [node.author] : []);
  const thumbnails = node.thumbnails ?? node.thumbnail?.contents ?? node.thumbnail ?? [];
  return {
    kind, id: node.id ?? payload?.browseId ?? payload?.videoId,
    title: text(node.title ?? node.name, 500), subtitle: text(node.subtitle, 1000),
    artist: text(names.map((artist) => artist.name).filter(Boolean).join(", "), 500),
    artistId: text(names[0]?.channel_id, 160), album: text(node.album?.name, 500), albumId: text(node.album?.id, 160),
    duration: Number.isFinite(node.duration?.seconds) && node.duration.seconds >= 0 && node.duration.seconds <= 86400 ? node.duration.seconds : 0,
    artwork: Array.isArray(thumbnails) ? text(thumbnails[0]?.url, 2048) : "",
  };
}
const items = (nodes = []) => nodes.slice(0, 1100).map(metadataItem).filter(Boolean);
const section = (node, index) => ({ id: `section-${index}`, title: text(node.header?.title ?? node.title, 120), items: items(node.contents) });
const header = (page) => {
  const value = page.header?.header ?? page.header;
  return { title: text(value?.title, 500), subtitle: text(value?.subtitle ?? value?.strapline_text_one, 1000) };
};

/** Album rows can omit their shared artist. Inherit only linked album authors,
 * never an arbitrary subtitle (which can instead be a year or song count). */
export function albumMetadataItems(page) {
  const value = page.header?.header ?? page.header;
  const linkedArtists = (label) => (label?.runs ?? []).flatMap((run) => {
    const id = run.endpoint?.payload?.browseId, name = text(run.text, 500);
    return ids.artist.test(id ?? "") && name ? [{ id, name }] : [];
  });
  const author = value?.author;
  const candidates = [linkedArtists(value?.strapline_text_one),
    ids.artist.test(author?.channel_id ?? "") && text(author?.name, 500) ? [{ id: author.channel_id, name: text(author.name, 500) }] : [],
    linkedArtists(value?.subtitle)].find((artists) => artists.length) ?? [];
  const artists = [...new Map(candidates.map((artist) => [artist.id, artist])).values()];
  const artist = text(artists.map((entry) => entry.name).join(", "), 500);
  return items(page.contents).map((item) => {
    // A different explicit row artist ID is conflicting metadata, even if its
    // display name is absent. Do not attach that row to the album author.
    if (!artist || !["song", "video"].includes(item.kind) || text(item.artist, 500)
      || (ids.artist.test(item.artistId) && !artists.some((entry) => entry.id === item.artistId))) return item;
    const linkedRowArtist = artists.find((entry) => entry.id === item.artistId);
    return { ...item, artist: linkedRowArtist?.name ?? artist, artistId: linkedRowArtist?.id ?? artists[0].id };
  });
}

export async function runCatalogue(input, signal) {
  const task = validateTask(input);
  Log.setLevel(Log.Level.NONE);
  phase = "session";
  const client = await Innertube.create({ lang: "en", location: task.country === "ZZ" ? "US" : task.country ?? "US", retrieve_player: false,
    enable_session_cache: false, fetch: catalogueFetch(signal) });
  phase = task.operation;
  if (task.operation === "search") {
    const page = await client.music.search(task.query, { type: task.kind.slice(0, -1) });
    const shelves = page.contents?.filterType(YTNodes.MusicShelf) ?? [];
    return { operation: task.operation, kind: task.kind, title: "Music search", subtitle: "YouTube Music", query: task.query,
      items: items(shelves.flatMap((shelf) => shelf.contents)), sections: [], truncated: page.has_continuation };
  }
  if (task.operation === "browse") {
    if (task.kind === "album") {
      const page = await client.music.getAlbum(task.id);
      return { operation: task.operation, kind: task.kind, ...header(page), items: albumMetadataItems(page), sections: [], truncated: page.contents.length > 1000 };
    }
    if (task.kind === "artist") {
      const page = await client.music.getArtist(task.id);
      return { operation: task.operation, kind: task.kind, ...header(page), items: [], sections: page.sections.slice(0, 12).map(section), truncated: page.sections.length > 12 };
    }
    let page = await client.music.getPlaylist(task.id);
    const details = header(page), result = [...items(page.items)];
    let continuations = 0;
    while (page.has_continuation && result.length < 1000 && continuations < 3) {
      signal.throwIfAborted(); page = await page.getContinuation(); continuations++; result.push(...items(page.items));
    }
    return { operation: task.operation, kind: task.kind, ...details, items: result.slice(0, 1000), sections: [], truncated: page.has_continuation || result.length > 1000 };
  }
  // YouTube.js has no getCharts() in pinned18.1.0. Follow Explore's actual
  // browse endpoint, using YouTube Music's country form (no account session).
  const explore = await client.music.getExplore();
  const endpoint = explore.top_buttons.find((button) => button.endpoint.payload?.browseId === "FEmusic_charts")?.endpoint;
  if (!endpoint) throw new Error("Charts unavailable");
  const response = await endpoint.call(client.actions, { client: "YTMUSIC", formData: { selectedValues: [task.country] } });
  const page = Parser.parseResponse(response.data);
  const countryName = text(page.contents_memo?.getType(YTNodes.MusicSortFilterButton)?.[0]?.title, 120);
  const expectedName = task.country === "ZZ" ? "Global" : new Intl.DisplayNames(["en"], { type: "region" }).of(task.country);
  const shelves = page.contents_memo?.getType(YTNodes.MusicCarouselShelf) ?? [];
  if (!countryName || countryName.toLowerCase() !== expectedName?.toLowerCase() || shelves.length === 0) throw new Error("Charts unavailable");
  return { operation: "charts", kind: "charts", country: task.country, countryName, title: "YouTube Music charts", subtitle: countryName,
    items: [], sections: shelves.slice(0, 12).map(section), truncated: shelves.length > 12 };
}

async function main() {
  try {
    let input = "";
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 1024) throw new Error("Invalid task"); }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 14_000);
    try {
      const result = await runCatalogue(JSON.parse(input), controller.signal);
      let output = JSON.stringify(result);
      while (Buffer.byteLength(output) > 8 * MiB) {
        const tail = result.sections.findLast((section) => section.items.length);
        const items = tail?.items ?? result.items;
        if (!items.length) throw new Error("Metadata output too large");
        items.splice(-10); result.truncated = true; output = JSON.stringify(result);
      }
      process.stdout.write(output);
    } finally { clearTimeout(timer); controller.abort(); }
  } catch (error) {
    const allowed = new Set(["ERR_ACCESS_DENIED", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);
    const code = [error?.code, error?.cause?.code].find((value) => allowed.has(value));
    process.stderr.write(JSON.stringify({ reason: "METADATA_UNAVAILABLE", phase, ...(code ? { code } : {}) })); process.exitCode = 1;
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
