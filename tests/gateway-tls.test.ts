import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// TLS tests exercise real loopback sockets and certificates, not extraction.
vi.mock("../apps/web/src/lib/youtube-media/provider", () => ({ YouTubeAudioProvider: class {} }));
vi.mock("../apps/web/src/lib/youtube-media/audio-response", () => ({ audioResponse: vi.fn() }));
import { createMediaGateway } from "../apps/web/src/lib/youtube-media/gateway-server";

const token = "synthetic-gateway-tls-test-token-0123456789";
const servers = new Set<ReturnType<typeof createMediaGateway>>();
const clients = new Set<ClientRequest>();
let fixtureDirectory: string;
let cert: Buffer;
let key: Buffer;
let unrelatedCert: Buffer;

function certificate(name: string) {
  const certFile = join(fixtureDirectory, `${name}.crt`);
  const keyFile = join(fixtureDirectory, `${name}.key`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    "-keyout", keyFile, "-out", certFile,
  ], { stdio: "ignore", timeout: 10_000 });
  chmodSync(keyFile, 0o600);
  return { cert: readFileSync(certFile), key: readFileSync(keyFile) };
}

beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "aurelia-gateway-tls-test-"));
  chmodSync(fixtureDirectory, 0o700);
  ({ cert, key } = certificate("gateway"));
  unrelatedCert = certificate("unrelated").cert;
});
afterEach(async () => {
  for (const client of clients) client.destroy();
  clients.clear();
  await Promise.all(Array.from(servers, (server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  servers.clear();
});
afterAll(() => {
  if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
});

async function listen(server: ReturnType<typeof createMediaGateway>) {
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback listener");
  return address.port;
}
function health(port: number, options: { secure?: boolean; ca?: Buffer; servername?: string; authorization?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const send = options.secure === false ? httpRequest : httpsRequest;
    const client = send({
      hostname: "127.0.0.1", port, path: "/health", method: "GET", agent: false,
      ca: options.ca ?? cert,
      servername: options.servername ?? "localhost",
      headers: { Authorization: options.authorization ?? `Bearer ${token}` },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () => resolve({ status: incoming.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    clients.add(client);
    client.once("error", reject);
    client.once("close", () => clients.delete(client));
    client.end();
  });
}

describe("optional media gateway TLS", () => {
  it("serves authenticated health through a real certificate-verified TLS connection", async () => {
    const port = await listen(createMediaGateway(token, { cert, key }));
    const response = await health(port);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "ok", service: "aurelia-media" });
    const unauthorized = await health(port, { authorization: "Bearer wrong" });
    expect(unauthorized.status).toBe(401);
    expect(JSON.parse(unauthorized.body)).toEqual({ error: "Unauthorized" });
  });

  it("rejects an unrelated certificate authority before processing HTTP", async () => {
    const server = createMediaGateway(token, { cert, key });
    const received = vi.fn();
    server.on("request", received);
    const port = await listen(server);
    await expect(health(port, { ca: unrelatedCert })).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect(received).not.toHaveBeenCalled();
  });

  it("rejects a certificate hostname mismatch even when its CA is trusted", async () => {
    const server = createMediaGateway(token, { cert, key });
    const received = vi.fn();
    server.on("request", received);
    const port = await listen(server);
    await expect(health(port, { servername: "wrong.example" })).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(received).not.toHaveBeenCalled();
  });

  it("preserves the HTTP gateway when no TLS options are supplied", async () => {
    const port = await listen(createMediaGateway(token));
    const response = await health(port, { secure: false });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "ok", service: "aurelia-media" });
    expect((await health(port, { secure: false, authorization: "Bearer wrong" })).status).toBe(401);
  });

  it.each(["MEDIA_GATEWAY_TLS_CERT_FILE", "MEDIA_GATEWAY_TLS_KEY_FILE"])(
    "fails entrypoint startup if only %s is configured",
    (variable) => {
      const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/media-gateway.ts"], {
        env: {
          PATH: process.env.PATH, NODE_ENV: "test", MEDIA_GATEWAY_TOKEN: token,
          [variable]: join(fixtureDirectory, variable.endsWith("CERT_FILE") ? "gateway.crt" : "gateway.key"),
        },
        encoding: "utf8", timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Set MEDIA_GATEWAY_TLS_CERT_FILE and MEDIA_GATEWAY_TLS_KEY_FILE together");
      expect(result.stdout).not.toContain("listening");
      expect(`${result.stdout}${result.stderr}`).not.toContain(key.toString());
    },
  );
});
