import { Innertube, Log, Platform, type Types } from "youtubei.js";
import { z } from "zod";
import { runYoutubeRuntime } from "./runtime";

// Upstream debug output can contain signed media URLs. Keep it out of app logs.
Log.setLevel(Log.Level.NONE);
export async function evaluatePlayerScript(data: Types.BuildScriptResult) {
  if (data.output.length > 4_000_000)
    throw new Error("Player script too large");
  return z.object({ sig: z.string().optional(), n: z.string().optional() }).parse(
    await runYoutubeRuntime({ kind: "player", script: data.output }),
  );
}
Platform.shim.eval = evaluatePlayerScript;

let session: { expires: number; client: Promise<Innertube> } | undefined;
export async function youtubeClient() {
  if (!session || session.expires <= Date.now()) {
    const client = Innertube.create({
      lang: "en",
      location: "US",
      fetch: (input, init) => {
        const signals = [AbortSignal.timeout(15000)];
        if (init?.signal) signals.push(init.signal);
        if (input instanceof Request) signals.push(input.signal);
        return fetch(input, { ...init, signal: AbortSignal.any(signals) });
      },
    });
    session = { expires: Date.now() + 20 * 60_000, client };
    // A transient session failure must be retryable on the next request.
    void client.catch(() => {
      if (session?.client === client) session = undefined;
    });
  }
  return session.client;
}
