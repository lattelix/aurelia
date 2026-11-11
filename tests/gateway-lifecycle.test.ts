import { request, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { AppError, type PlaybackSource, type Track } from "@aurelia/core";

const upstream = vi.hoisted(() => ({
  getTrack: vi.fn<(id: string) => Promise<Track | null>>(),
  getStream: vi.fn<(track: Track) => Promise<PlaybackSource>>(),
  audioResponse: vi.fn<(input: Request) => Promise<Response | null>>(),
}));
vi.mock("../apps/web/src/lib/youtube-media/provider", () => ({
  YouTubeAudioProvider: class {
    getTrack = upstream.getTrack;
    getStream = upstream.getStream;
  },
}));
vi.mock("../apps/web/src/lib/youtube-media/audio-response", () => ({ audioResponse: upstream.audioResponse }));
import { createMediaGateway } from "../apps/web/src/lib/youtube-media/gateway-server";

const token = "gateway-test-only-token-0123456789";
const authorization = `Bearer ${token}`;
const clients = new Set<ClientRequest>();
const servers = new Set<Server>();
const pendingCleanup = new Set<() => void>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function track(id: string): Track {
  return { id: `youtube:${id}`, externalId: id, provider: "youtube", title: "Loopback recording", artist: "Test", artistId: "test", album: "", albumId: "", duration: 60, artwork: "", genre: "", year: 2026 };
}
function descriptor(): PlaybackSource {
  return { kind: "audio", url: "/api/audio?id=abcdefghijk", capabilities: { background: true, seek: true, mediaSession: true } };
}
async function observed(condition: () => void) {
  // Real socket events need to flush; fake timers would not drive libuv here.
  await vi.waitFor(condition, { timeout: 2000, interval: 5 });
}
type ObservedResponse = {
  outgoing: ServerResponse;
  closed: Promise<void>;
  writeHead: MockInstance<ServerResponse["writeHead"]>;
};
async function gateway() {
  const responses = new Map<string, ObservedResponse>();
  const server = createMediaGateway(token);
  servers.add(server);
  server.on("request", (incoming, outgoing) => {
    const closed = deferred<void>();
    outgoing.once("close", () => closed.resolve());
    responses.set(incoming.url!, { outgoing, closed: closed.promise, writeHead: vi.spyOn(outgoing, "writeHead") });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback listener");
  const origin = `http://127.0.0.1:${address.port}`;
  function send(path: string, options: { method?: string; auth?: string; onData?: (chunk: Buffer) => void } = {}) {
    const reply = deferred<IncomingMessage>();
    const completion = deferred<{ status: number | null; body: string; failed: boolean }>();
    let response: IncomingMessage | undefined;
    const chunks: Buffer[] = [];
    const done = (failed: boolean) => completion.resolve({ status: response?.statusCode ?? null, body: Buffer.concat(chunks).toString(), failed });
    const client = request(`${origin}${path}`, {
      method: options.method ?? "GET",
      headers: { Authorization: options.auth ?? authorization },
      agent: false,
    }, (incoming) => {
      response = incoming;
      reply.resolve(incoming);
      incoming.on("data", (chunk: Buffer) => { chunks.push(chunk); options.onData?.(chunk); });
      incoming.once("end", () => done(false));
      incoming.once("aborted", () => done(true));
      incoming.once("error", () => done(true));
    });
    clients.add(client);
    client.once("error", () => done(true));
    client.once("close", () => clients.delete(client));
    client.end();
    return { client, reply: reply.promise, completion: completion.promise };
  }
  return { send, responses };
}
function holdTracks() {
  const pending = new Map<string, ReturnType<typeof deferred<Track | null>>>();
  upstream.getTrack.mockImplementation((id) => {
    const gate = deferred<Track | null>();
    pending.set(id, gate);
    pendingCleanup.add(() => gate.resolve(track(id)));
    return gate.promise;
  });
  return pending;
}

beforeEach(() => {
  vi.clearAllMocks();
  upstream.getTrack.mockImplementation(async (id) => track(id));
  upstream.getStream.mockImplementation(async () => descriptor());
  upstream.audioResponse.mockImplementation(async () => new Response("audio"));
});
afterEach(async () => {
  vi.useRealTimers();
  for (const finish of pendingCleanup) finish();
  pendingCleanup.clear();
  for (const client of clients) client.destroy();
  clients.clear();
  await Promise.all(Array.from(servers, (server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  servers.clear();
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.restoreAllMocks();
});

describe("media gateway HTTP lifecycle", () => {
  it("checks authorization and methods before admitting upstream work, and serves bodyless HEAD", async () => {
    const { send } = await gateway();
    expect((await send("/stream?id=abcdefghijk", { auth: "Bearer wrong" }).completion).status).toBe(401);
    expect((await send("/audio", { method: "POST" }).completion).status).toBe(405);
    expect((await send("/stream?id=bad").completion).status).toBe(400);
    expect((await send("/missing").completion).status).toBe(404);
    const head = await send("/health", { method: "HEAD" }).completion;
    expect(head).toMatchObject({ status: 200, body: "", failed: false });
    expect(upstream.getTrack).not.toHaveBeenCalled();
    expect(upstream.getStream).not.toHaveBeenCalled();
    expect(upstream.audioResponse).not.toHaveBeenCalled();
  });

  it("admits exactly eight concurrent operations and reopens a slot only after admitted work finishes", async () => {
    const pending = holdTracks();
    const { send } = await gateway();
    const active = Array.from({ length: 8 }, (_, index) => send(`/stream?id=abcdefghij${index}`));
    await observed(() => expect(pending.size).toBe(8));
    expect((await send("/stream?id=abcdefghij8").completion).status).toBe(429);
    expect(upstream.getTrack).toHaveBeenCalledTimes(8);
    pending.get("abcdefghij0")!.resolve(track("abcdefghij0"));
    expect((await active[0].completion).status).toBe(200);
    expect((await send("/missing").completion).status).toBe(404);
    const replacement = send("/stream?id=abcdefghij9");
    await observed(() => expect(pending.has("abcdefghij9")).toBe(true));
    expect((await send("/missing").completion).status).toBe(429);
    for (const [id, gate] of pending) gate.resolve(track(id));
    expect((await replacement.completion).status).toBe(200);
    await Promise.all(active.map((exchange) => exchange.completion));
    expect((await send("/missing").completion).status).toBe(404);
  });

  it("keeps authenticated health checks available while all media slots are occupied", async () => {
    const pending = holdTracks();
    const { send } = await gateway();
    const held = Array.from({ length: 8 }, (_, index) => send(`/stream?id=abcdefghij${index}`));
    await observed(() => expect(pending.size).toBe(8));
    expect((await send("/missing").completion).status).toBe(429);
    const health = await send("/health").completion;
    expect(health).toMatchObject({ status: 200, failed: false });
    expect(JSON.parse(health.body)).toEqual({ status: "ok", service: "aurelia-media" });
    expect(await send("/health", { method: "HEAD" }).completion).toMatchObject({ status: 200, body: "", failed: false });
    expect((await send("/health", { auth: "Bearer wrong" }).completion).status).toBe(401);
    expect((await send("/health", { method: "POST" }).completion).status).toBe(405);
    expect(upstream.getTrack).toHaveBeenCalledTimes(8);
    expect(upstream.getStream).not.toHaveBeenCalled();
    for (const [id, gate] of pending) gate.resolve(track(id));
    await Promise.all(held.map((exchange) => exchange.completion));
  });

  it("keeps a disconnected descriptor operation counted until it settles, then avoids starting another upstream stage", async () => {
    const pending = holdTracks();
    const { send, responses } = await gateway();
    const active = Array.from({ length: 8 }, (_, index) => send(`/stream?id=abcdefghij${index}`));
    await observed(() => expect(pending.size).toBe(8));
    const disconnected = responses.get("/stream?id=abcdefghij0")!;
    active[0].client.destroy();
    await disconnected.closed;
    expect((await send("/missing").completion).status).toBe(429);
    pending.get("abcdefghij0")!.resolve(track("abcdefghij0"));
    await observed(() => expect(disconnected.outgoing.destroyed).toBe(true));
    // A fresh admission probe lets the resumed handler settle before checking capacity.
    expect((await send("/missing").completion).status).toBe(404);
    expect(upstream.getStream).not.toHaveBeenCalled();
    expect(disconnected.writeHead).not.toHaveBeenCalled();
  });

  it("cancels a late audio body without writing headers after its requesting socket has closed", async () => {
    const ready = deferred<Response>();
    const cancel = vi.fn();
    pendingCleanup.add(() => ready.resolve(new Response(null)));
    upstream.audioResponse.mockReturnValue(ready.promise);
    const { send, responses } = await gateway();
    const exchange = send("/audio?id=abcdefghijk");
    await observed(() => expect(upstream.audioResponse).toHaveBeenCalledOnce());
    const input = upstream.audioResponse.mock.calls[0][0];
    const outgoing = responses.get("/audio?id=abcdefghijk")!;
    exchange.client.destroy();
    await outgoing.closed;
    expect(input.signal.aborted).toBe(true);
    ready.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await observed(() => expect(cancel).toHaveBeenCalledOnce());
    expect(outgoing.writeHead).not.toHaveBeenCalled();
    expect((await send("/missing").completion).status).toBe(404);
  });

  it("does not release a disconnected getStream operation prematurely or write its late descriptor", async () => {
    const pending = holdTracks();
    const stream = deferred<PlaybackSource>();
    pendingCleanup.add(() => stream.resolve(descriptor()));
    const { send, responses } = await gateway();
    const held = Array.from({ length: 7 }, (_, index) => send(`/stream?id=abcdefghij${index}`));
    await observed(() => expect(pending.size).toBe(7));
    upstream.getTrack.mockImplementationOnce(async (id) => track(id));
    upstream.getStream.mockReturnValueOnce(stream.promise);
    const path = "/stream?id=abcdefghij7";
    const exchange = send(path);
    await observed(() => expect(upstream.getStream).toHaveBeenCalledOnce());
    const outgoing = responses.get(path)!;
    exchange.client.destroy();
    await outgoing.closed;
    expect((await send("/missing").completion).status).toBe(429);
    stream.resolve(descriptor());
    expect((await send("/missing").completion).status).toBe(404);
    expect(outgoing.writeHead).not.toHaveBeenCalled();
    for (const [id, gate] of pending) gate.resolve(track(id));
    await Promise.all(held.map((item) => item.completion));
  });

  it("enforces the request deadline while keeping unfinished upstream operations counted", async () => {
    const pending = holdTracks();
    const { send, responses } = await gateway();
    // Only gateway deadlines are virtual. Native socket I/O and setImmediate
    // remain real, so every assertion follows the actual HTTP close event.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const active = Array.from({ length: 8 }, (_, index) => send(`/stream?id=abcdefghij${index}`));
    await observed(() => expect(pending.size).toBe(8));
    await vi.advanceTimersByTimeAsync(250_000);
    await Promise.all(Array.from(responses.values(), (response) => response.closed));
    expect((await send("/missing").completion).status).toBe(429);
    for (const [id, gate] of pending) gate.resolve(track(id));
    expect((await send("/missing").completion).status).toBe(404);
    expect(upstream.getStream).not.toHaveBeenCalled();
    for (let index = 0; index < active.length; index++) {
      expect(responses.get(`/stream?id=abcdefghij${index}`)!.writeHead).not.toHaveBeenCalled();
      expect((await active[index].completion).failed).toBe(true);
    }
  });

  it("cancels an active response body on client disconnect and releases its slot after the pipeline ends", async () => {
    const pending = holdTracks();
    const cancel = vi.fn();
    upstream.audioResponse.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); }, cancel,
    })));
    const { send, responses } = await gateway();
    const held = Array.from({ length: 7 }, (_, index) => send(`/stream?id=abcdefghij${index}`));
    await observed(() => expect(pending.size).toBe(7));
    const received = deferred<void>();
    const audio = send("/audio?id=abcdefghijk", { onData: () => received.resolve() });
    await received.promise;
    expect((await send("/missing").completion).status).toBe(429);
    const input = upstream.audioResponse.mock.calls[0][0];
    audio.client.destroy();
    await responses.get("/audio?id=abcdefghijk")!.closed;
    await observed(() => expect(cancel).toHaveBeenCalledOnce());
    expect(input.signal.aborted).toBe(true);
    expect((await send("/missing").completion).status).toBe(404);
    for (const [id, gate] of pending) gate.resolve(track(id));
    await Promise.all(held.map((exchange) => exchange.completion));
  });

  it("releases capacity after getTrack, getStream and audio setup reject without exposing internal error text", async () => {
    const pending = holdTracks();
    const { send } = await gateway();
    const held = Array.from({ length: 7 }, (_, index) => send(`/stream?id=abcdefghij${index}`));
    await observed(() => expect(pending.size).toBe(7));
    upstream.getTrack.mockImplementationOnce(async () => { throw new AppError(404, "Recording unavailable"); });
    expect(await send("/stream?id=abcdefghij7").completion).toMatchObject({ status: 404, body: JSON.stringify({ error: "Recording unavailable" }) });
    expect((await send("/missing").completion).status).toBe(404);
    upstream.getTrack.mockImplementationOnce(async (id) => track(id));
    upstream.getStream.mockRejectedValueOnce(new Error("internal descriptor diagnostic"));
    const rejectedDescriptor = await send("/stream?id=abcdefghij8").completion;
    expect(rejectedDescriptor.status).toBe(502);
    expect(rejectedDescriptor.body).not.toContain("internal descriptor diagnostic");
    expect((await send("/missing").completion).status).toBe(404);
    upstream.audioResponse.mockRejectedValueOnce(new Error("internal upstream diagnostic"));
    const rejectedAudio = await send("/audio?id=abcdefghijk").completion;
    expect(rejectedAudio.status).toBe(502);
    expect(rejectedAudio.body).not.toContain("internal upstream diagnostic");
    expect((await send("/missing").completion).status).toBe(404);
    for (const [id, gate] of pending) gate.resolve(track(id));
    await Promise.all(held.map((exchange) => exchange.completion));
  });

  it("cancels a body supplied for HEAD instead of streaming it and completes ordinary bodies", async () => {
    const cancel = vi.fn();
    upstream.audioResponse.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel })));
    const { send } = await gateway();
    expect(await send("/audio?id=abcdefghijk", { method: "HEAD" }).completion).toMatchObject({ status: 200, body: "", failed: false });
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstream.audioResponse.mock.calls[0][0].method).toBe("HEAD");
    expect(await send("/audio?id=abcdefghijk").completion).toMatchObject({ status: 200, body: "audio", failed: false });
    expect((await send("/missing").completion).status).toBe(404);
  });

  it("allows cold descriptor setup to take longer than the streaming idle timeout", async () => {
    const ready = deferred<Track | null>();
    upstream.getTrack.mockReturnValueOnce(ready.promise);
    const { send } = await gateway();
    const exchange = send("/stream?id=abcdefghijk");
    await observed(() => expect(upstream.getTrack).toHaveBeenCalledOnce());
    // Use a real 31-second delay: Node socket idle timers do not follow Vitest's
    // global fake clock. The pre-header phase must survive the old 30s timeout.
    const timer = setTimeout(() => ready.resolve(track("abcdefghijk")), 31_000);
    pendingCleanup.add(() => { clearTimeout(timer); ready.resolve(track("abcdefghijk")); });
    const response = await exchange.completion;
    expect(response).toMatchObject({ status: 200, failed: false });
    expect(JSON.parse(response.body)).toEqual(descriptor());
    expect(upstream.getStream).toHaveBeenCalledOnce();
  }, 45_000);
});
