import { readFileSync } from "node:fs";
import { createMediaGateway } from "../apps/web/src/lib/youtube-media/gateway-server";

const port = Number(process.env.PORT ?? 3103);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const certFile = process.env.MEDIA_GATEWAY_TLS_CERT_FILE?.trim();
const keyFile = process.env.MEDIA_GATEWAY_TLS_KEY_FILE?.trim();
if (Boolean(certFile) !== Boolean(keyFile))
  throw new Error("Set MEDIA_GATEWAY_TLS_CERT_FILE and MEDIA_GATEWAY_TLS_KEY_FILE together");
const tlsOptions = certFile && keyFile ? {
  cert: readFileSync(certFile),
  key: readFileSync(keyFile),
} : undefined;
const server = createMediaGateway(process.env.MEDIA_GATEWAY_TOKEN ?? "", tlsOptions);
server.headersTimeout = 10_000;
server.requestTimeout = 10_000;
server.keepAliveTimeout = 5000;
server.listen(port, process.env.HOSTNAME ?? "127.0.0.1", () => {
  console.log(`Aurelia media gateway listening on port ${port}`);
});
const shutdown = () => { server.close(); setTimeout(() => process.exit(0), 5000).unref(); };
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
