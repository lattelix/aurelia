import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { RequestListener } from "node:http";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayAudio, gatewayConfig, gatewayStream } from "../apps/web/src/lib/youtube-media/gateway-client";
import { gatewayFetch } from "../apps/web/src/lib/youtube-media/gateway-fetch";
import { catalogue } from "@aurelia/music";

const token = "a".repeat(64);
const track = { ...catalogue[0], provider: "youtube" as const, externalId: "abcdefghijk" };
const descriptor = {
  kind: "audio",
  url: "/api/audio?id=abcdefghijk&variant=MWEB.140&version=1",
  capabilities: { background: true, seek: true, mediaSession: true },
};
let folder: string;
let ca: string;
let otherCa: string;
let key: string;
let certificate: string;
let wrongNameCertificate: string;
const servers: { server: Server; sockets: Set<Duplex> }[] = [];

beforeAll(() => {
  // These keys exist only in a freshly generated test directory, never in the
  // application configuration or repository. OpenSSL output is not logged.
  folder = mkdtempSync(join(tmpdir(), "aurelia-gateway-tls-test-"));
  chmodSync(folder, 0o700);
  const openssl = (...args: string[]) =>
    execFileSync("openssl", args, { cwd: folder, stdio: "pipe", timeout: 20_000 });
  for (const name of ["ca", "other-ca"]) {
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
      "-subj", `/CN=Aurelia ${name} test`, "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", `${name}.key`, "-out", `${name}.pem`);
  }
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Aurelia loopback test",
    "-keyout", "server.key", "-out", "server.csr");
  for (const [name, subjectAltName] of [["server", "IP:127.0.0.1"], ["wrong-name", "DNS:wrong.example"]]) {
    writeFileSync(join(folder, `${name}.ext`), [
      "basicConstraints=CA:FALSE", "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth", `subjectAltName=${subjectAltName}`,
    ].join("\n"));
    openssl("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
      "-CAcreateserial", "-days", "2", "-sha256", "-extfile", `${name}.ext`, "-out", `${name}.pem`);
  }
  ca = readFileSync(join(folder, "ca.pem"), "utf8");
  otherCa = readFileSync(join(folder, "other-ca.pem"), "utf8");
  for (const name of ["ca", "other-ca", "server"])
    chmodSync(join(folder, `${name}.key`), 0o600);
  key = readFileSync(join(folder, "server.key"), "utf8");
  certificate = readFileSync(join(folder, "server.pem"), "utf8");
  wrongNameCertificate = readFileSync(join(folder, "wrong-name.pem"), "utf8");
});

beforeEach(() => {
  vi.stubEnv("MEDIA_GATEWAY_URL", "https://127.0.0.1:3103");
  vi.stubEnv("MEDIA_GATEWAY_TOKEN", token);
  vi.stubEnv("MEDIA_GATEWAY_CA_PEM", ca);
});
afterEach(async () => {
  for (const { server, sockets } of servers.splice(0)) {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => {
  if (folder) rmSync(folder, { recursive: true, force: true });
});

async function loopback(handler: RequestListener, cert = certificate) {
  const server = createServer({ key, cert }, handler);
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  servers.push({ server, sockets });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback TCP address");
  return `https://127.0.0.1:${address.port}`;
}

function browserRequest(signal?: AbortSignal, headers?: HeadersInit) {
  return new Request("https://aurelia.example/api/audio?id=abcdefghijk&variant=MWEB.140&version=1", {
    signal, headers,
  });
}

describe("gateway scoped certificate trust", () => {
  it("requires HTTPS when a gateway certificate is configured", () => {
    vi.stubEnv("MEDIA_GATEWAY_URL", "http://127.0.0.1:3103");
    expect(() => gatewayConfig()).toThrow("Gateway certificates require HTTPS");
  });

  it("parses a bounded public certificate bundle and rejects malformed, mixed or excessive PEM", () => {
    vi.stubEnv("MEDIA_GATEWAY_CA_PEM", `${ca}\n${otherCa}`);
    expect(gatewayConfig()?.caPem?.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    for (const pem of [" ", "-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----", `${ca}\n${key}`, ca.repeat(5), ca.repeat(40)]) {
      vi.stubEnv("MEDIA_GATEWAY_CA_PEM", pem);
      expect(() => gatewayConfig()).toThrow("Invalid audio gateway certificate");
    }
  });

  it("keeps existing global fetch behavior when CA is unset", async () => {
    vi.stubEnv("MEDIA_GATEWAY_CA_PEM", "");
    const load = vi.fn(async () => Response.json(descriptor));
    vi.stubGlobal("fetch", load);
    await expect(gatewayStream(track, "balanced")).resolves.toMatchObject(descriptor);
    expect(load).toHaveBeenCalledOnce();
    const [, options] = load.mock.calls[0] as unknown as [URL, RequestInit];
    expect(options).toMatchObject({ redirect: "error", cache: "no-store" });
    expect(options).not.toHaveProperty("dispatcher");
  });

  it("uses the configured CA for real TLS without changing global fetch trust", async () => {
    const received: string[] = [];
    const origin = await loopback((request, response) => {
      received.push(request.headers.authorization ?? "");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(descriptor));
    });
    vi.stubEnv("MEDIA_GATEWAY_URL", origin);
    await expect(gatewayStream(track, "balanced")).resolves.toMatchObject(descriptor);
    expect(received).toEqual([`Bearer ${token}`]);
    await expect(fetch(`${origin}/stream`)).rejects.toThrow();
    expect(received).toHaveLength(1);
  });

  it("rejects a certificate signed by an untrusted CA before sending Bearer", async () => {
    const received = vi.fn();
    const origin = await loopback(received);
    vi.stubEnv("MEDIA_GATEWAY_URL", origin);
    vi.stubEnv("MEDIA_GATEWAY_CA_PEM", otherCa);
    await expect(gatewayStream(track, "balanced")).rejects.toThrow();
    expect(received).not.toHaveBeenCalled();
  });

  it("keeps hostname verification even for certificates signed by the configured CA", async () => {
    const received = vi.fn();
    const origin = await loopback(received, wrongNameCertificate);
    vi.stubEnv("MEDIA_GATEWAY_URL", origin);
    await expect(gatewayStream(track, "balanced")).rejects.toMatchObject({
      cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
    });
    expect(received).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests and never follows a trusted server's redirect", async () => {
    const redirected = vi.fn((_request, response) => response.end(JSON.stringify(descriptor)));
    const target = await loopback(redirected);
    const origin = await loopback((_request, response) => {
      response.writeHead(302, { Location: `${target}/stream` });
      response.end();
    });
    vi.stubEnv("MEDIA_GATEWAY_URL", origin);
    const config = gatewayConfig()!;
    await expect(gatewayFetch(new URL(`${target}/stream`), config, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000),
    })).rejects.toThrow("Invalid audio gateway origin");
    await expect(gatewayStream(track, "balanced")).rejects.toThrow();
    expect(redirected).not.toHaveBeenCalled();
  });

  it("streams the complete Range body through native Response and forwards only the gateway headers", async () => {
    const data = Buffer.alloc(1024 * 1024 + 23, 7);
    let finish: (() => void) | undefined;
    let headers: import("node:http").IncomingHttpHeaders | undefined;
    const origin = await loopback((request, response) => {
      headers = request.headers;
      response.writeHead(206, {
        "Content-Type": "audio/mp4", "Content-Length": String(data.length),
        "Content-Range": `bytes 0-${data.length - 1}/${data.length}`, "Accept-Ranges": "bytes",
        "Set-Cookie": "remote=private",
      });
      response.write(data.subarray(0, 4096));
      finish = () => response.end(data.subarray(4096));
    });
    vi.stubEnv("MEDIA_GATEWAY_URL", origin);
    const range = `bytes=0-${data.length - 1}`;
    const response = await gatewayAudio(browserRequest(undefined, { Range: range, Cookie: "browser=private" }));
    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(206);
    expect(response?.headers.get("content-range")).toBe(`bytes 0-${data.length - 1}/${data.length}`);
    expect(response?.headers.has("set-cookie")).toBe(false);
    expect(headers?.authorization).toBe(`Bearer ${token}`);
    expect(headers?.range).toBe(range);
    expect(headers?.cookie).toBeUndefined();
    expect(finish).toBeTypeOf("function");
    finish!();
    expect(Buffer.from(await response!.arrayBuffer())).toEqual(data);
  });

  it("propagates cancellation of the returned body to the TLS connection", async () => {
    let disconnected = false;
    const origin = await loopback((request, response) => {
      request.socket.once("close", () => { disconnected = true; });
      response.writeHead(200, { "Content-Type": "audio/mp4", "Content-Length": "1048576" });
      response.write(Buffer.alloc(4));
    });
    vi.stubEnv("MEDIA_GATEWAY_URL", origin);
    const response = await gatewayAudio(browserRequest());
    const reader = response!.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(disconnected).toBe(true), { timeout: 1500 });
  });

  it("propagates caller abort after headers through a pending body read", async () => {
    let disconnected = false;
    const origin = await loopback((request, response) => {
      request.socket.once("close", () => { disconnected = true; });
      response.writeHead(200, { "Content-Type": "audio/mp4", "Content-Length": "1048576" });
      response.write(Buffer.alloc(4));
    });
    vi.stubEnv("MEDIA_GATEWAY_URL", origin);
    const controller = new AbortController();
    const response = await gatewayAudio(browserRequest(controller.signal));
    const reader = response!.body!.getReader();
    await reader.read();
    const pending = reader.read();
    controller.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(disconnected).toBe(true), { timeout: 1500 });
  });

  it("aborts the TLS request while waiting for response headers", async () => {
    let received = false;
    let disconnected = false;
    const origin = await loopback((request) => {
      received = true;
      request.socket.once("close", () => { disconnected = true; });
    });
    vi.stubEnv("MEDIA_GATEWAY_URL", origin);
    const controller = new AbortController();
    const pending = gatewayAudio(browserRequest(controller.signal));
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(received).toBe(true), { timeout: 1500 });
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(disconnected).toBe(true), { timeout: 1500 });
  });
});
