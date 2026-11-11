const allowedOrigins = new Set([
  "https://www.youtube.com", "https://music.youtube.com", "https://youtubei.googleapis.com",
]);
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const TOTAL_LIMIT = 6 * 1024 * 1024;

/** One anonymous metadata load. Bounds decoded bytes before the SDK calls text()/json(). */
export function discoveryFetch(signal: AbortSignal, upstream: typeof fetch = fetch): typeof fetch {
  let total = 0;
  let requests = 0;
  return async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    if (!allowedOrigins.has(url.origin) || url.username || url.password || ++requests > 6)
      throw new Error("Discovery metadata request rejected");
    const headers = new Headers(init?.headers ?? request?.headers);
    headers.delete("Cookie");
    headers.delete("Authorization");
    headers.delete("Proxy-Authorization");
    const combined = AbortSignal.any([
      signal, AbortSignal.timeout(12_000),
      ...(init?.signal ? [init.signal] : []), ...(request ? [request.signal] : []),
    ]);
    const response = await upstream(input, {
      ...init, headers, credentials: "omit", redirect: "error", signal: combined,
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const length = response.headers.get("content-length");
      if (!response.ok || (length !== null && (!/^\d+$/.test(length) ||
          Number(length) > RESPONSE_LIMIT || Number(length) > TOTAL_LIMIT - total)))
        throw new Error("Discovery metadata response rejected");
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) for (;;) {
        combined.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        total += chunk.value.byteLength;
        if (size > RESPONSE_LIMIT || total > TOTAL_LIMIT)
          throw new Error("Discovery metadata response too large");
        chunks.push(chunk.value);
      }
      combined.throwIfAborted();
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("set-cookie");
      responseHeaders.set("content-length", String(size));
      return new Response(bytes, { status: response.status, headers: responseHeaders });
    } catch (error) {
      if (reader) await reader.cancel().catch(() => {});
      else await response.body?.cancel().catch(() => {});
      throw error;
    } finally { reader?.releaseLock(); }
  };
}
