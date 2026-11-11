import { createServer, request } from "node:http";
import { request as secureRequest } from "node:https";
import type { AddressInfo } from "node:net";
export async function outageProxy(
  origin: string,
  options: { forwardOwnOrigin?: boolean } = {},
) {
  const delays = new Map<string, number>();
  const forward = origin.startsWith("https:") ? secureRequest : request;
  let proxyOrigin = "";
  const server = createServer(async (incoming, outgoing) => {
    const delay =
      delays.get(new URL(incoming.url ?? "/", origin).pathname) ?? 0;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const headers = { ...incoming.headers };
    if (options.forwardOwnOrigin && headers.origin === proxyOrigin)
      headers.origin = new URL(origin).origin;
    const upstream = forward(
      new URL(incoming.url ?? "/", origin),
      { method: incoming.method, headers },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  proxyOrigin = `http://localhost:${port}`;
  return {
    origin: proxyOrigin,
    restart: async () => {
      if (server.listening) return;
      await new Promise<void>((resolve) =>
        server.listen(port, "127.0.0.1", resolve),
      );
    },
    delay: (path: string, milliseconds: number) =>
      delays.set(path, milliseconds),
    stop: async () => {
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
