import { z } from "zod";
import { Innertube } from "youtubei.js";
import { MediaCache } from "./cache";
import { runYoutubeRuntime } from "./runtime";

const ProofSchema = z.object({
  token: z.string().min(32).max(8192).regex(/^[A-Za-z0-9_-]+=*$/),
  visitorData: z.string().min(1).max(8192).optional(),
  userAgent: z.string().min(1).max(1000),
  expiresAt: z.number().finite(),
});
const sessions = new MediaCache<{
  client: Innertube;
  token: string;
  expiresAt: number;
}>(48);
export async function attestedClient(videoId: string, refresh = false) {
  if (refresh) sessions.delete(videoId);
  const cached = sessions.get(videoId);
  if (cached && cached.expiresAt <= Date.now() + 30_000) sessions.delete(videoId);
  return sessions.resolve(videoId, 10 * 60_000, async () => {
    const proof = ProofSchema.parse(await runYoutubeRuntime({ kind: "attestation", id: videoId }));
    if (proof.expiresAt <= Date.now()) throw new Error("Expired proof");
    const client = await Innertube.create({
      visitor_data: proof.visitorData,
      user_agent: proof.userAgent,
      fetch: (url, init) => fetch(url, {
        ...init,
        signal: AbortSignal.any([
          AbortSignal.timeout(10_000),
          ...(init?.signal ? [init.signal] : []),
        ]),
      }),
    });
    return { client, token: proof.token, expiresAt: proof.expiresAt };
  });
}
