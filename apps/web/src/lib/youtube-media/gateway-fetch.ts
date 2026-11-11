import { X509Certificate } from "node:crypto";
import { checkServerIdentity } from "node:tls";
import { Pool, fetch as tlsFetch } from "undici";
import { AppError } from "@aurelia/core";

export interface GatewayTlsConfig {
  base: URL;
  caPem?: string;
}

const certificatePattern =
  /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g;

/** Accept only a small public certificate bundle, never a private key. */
export function gatewayCertificates(pem: string): string {
  const invalid = () => new AppError(503, "Invalid audio gateway certificate.");
  if (Buffer.byteLength(pem, "utf8") > 32 * 1024) throw invalid();
  const blocks = pem.match(certificatePattern);
  if (!blocks?.length || blocks.length > 4 || pem.replace(certificatePattern, "").trim())
    throw invalid();
  try {
    return blocks.map((block) => new X509Certificate(block).toString()).join("\n");
  } catch {
    throw invalid();
  }
}

let trustedPool:
  | { origin: string; caPem: string; pool: Pool }
  | undefined;

function gatewayPool(origin: string, caPem: string): Pool {
  if (trustedPool?.origin === origin && trustedPool.caPem === caPem)
    return trustedPool.pool;
  const previous = trustedPool?.pool;
  const pool = new Pool(origin, {
    connections: 8,
    connect: {
      ca: caPem,
      rejectUnauthorized: true,
      checkServerIdentity,
      minVersion: "TLSv1.2",
      timeout: 10_000,
    },
  });
  trustedPool = { origin, caPem, pool };
  // Configuration rotation does not interrupt bodies already being consumed.
  void previous?.close().catch(() => {});
  return pool;
}

/** The extra trust applies only to this configured gateway origin. */
export async function gatewayFetch(
  url: URL,
  config: GatewayTlsConfig,
  init: { method?: string; headers: HeadersInit; signal: AbortSignal },
): Promise<Response> {
  if (url.origin !== config.base.origin || url.username || url.password)
    throw new AppError(503, "Invalid audio gateway origin.");
  if (!config.caPem)
    return fetch(url, { ...init, redirect: "error", cache: "no-store" });
  if (url.protocol !== "https:")
    throw new AppError(503, "Gateway certificates require HTTPS.");
  const response = await tlsFetch(url, {
    ...init,
    headers: Array.from(new Headers(init.headers)),
    redirect: "error",
    cache: "no-store",
    dispatcher: gatewayPool(config.base.origin, config.caPem),
  });
  return new Response(
    response.body as unknown as ReadableStream<Uint8Array> | null,
    {
      status: response.status,
      statusText: response.statusText,
      headers: Array.from(response.headers),
    },
  );
}
