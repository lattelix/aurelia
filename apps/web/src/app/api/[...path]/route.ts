import { z } from "zod";
import { AppError } from "@aurelia/core";
import { getDatabase } from "@aurelia/database";
import { json, assertOrigin, assertAccountOwner } from "@/lib/http";
import { authApi } from "@/lib/api-auth";
import { musicApi } from "@/lib/api-music";
import { libraryApi } from "@/lib/api-library";
import { importApi } from "@/lib/api-import";
import { startOAuth, finishOAuth } from "@/lib/oauth";
import { audioApi } from "@/lib/youtube-media/audio-api";
import { lyricsApi } from "@/lib/api-lyrics";
import { publicDeviceAuth, privateDeviceAuth } from "@/lib/native-auth";
import { guestApi } from "@/lib/api-guest";
import { productApi } from "@/lib/api-product";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
async function handle(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await context.params;
    if (path.length === 1 && path[0] === "lyrics" && request.method === "GET")
      return await lyricsApi(request);
    if (path.length === 1 && path[0] === "audio")
      return (
        (await audioApi(request)) ?? json({ error: "Method not allowed" }, 405)
      );
    if (
      path.length === 3 &&
      path[0] === "auth" &&
      path[1] === "device" &&
      ["start", "token"].includes(path[2])
    )
      return await publicDeviceAuth(path[2], request);
    if (path.length === 3 && path[0] === "auth" && path[2] === "callback")
      return await finishOAuth(path[1], request);
    if (!["GET", "HEAD"].includes(request.method)) await assertOrigin(request);
    if (path.length === 1 && path[0] === "guest")
      return await guestApi(request);
    if (path.length === 3 && path[0] === "auth" && path[1] === "device")
      return await privateDeviceAuth(path[2], request);
    if (
      path.length === 3 &&
      path[0] === "auth" &&
      path[2] === "start" &&
      ["GET", "POST"].includes(request.method)
    )
      return await startOAuth(path[1], request);
    if (["library", "import"].includes(path[0]))
      await assertAccountOwner(request);
    if (path[0] === "health" && request.method === "GET") {
      const db = await getDatabase();
      await db.query("SELECT 1");
      return json({
        status: "ok",
        database: process.env.DATABASE_URL ? "postgresql" : "pglite",
        version: "0.1.0",
      });
    }
    const response =
      path[0] === "auth"
        ? await authApi(path.slice(1), request)
        : path[0] === "product"
          ? await productApi(path.slice(1), request)
          : path[0] === "library"
            ? await libraryApi(path.slice(1), request)
            : path[0] === "import"
              ? await importApi(path.slice(1), request)
              : await musicApi(path, request);
    return response ?? json({ error: "Endpoint not found" }, 404);
  } catch (error) {
    if (error instanceof z.ZodError)
      return json(
        {
          error: "Please check the input values.",
          fields: error.issues.map((x) => ({
            path: x.path.join("."),
            message: x.message,
          })),
        },
        400,
      );
    if (error instanceof AppError)
      return json({ error: error.message }, error.status);
    // Deliberately avoid logging request bodies, cookies, OAuth codes or secrets.
    console.error("API failure", {
      name: error instanceof Error ? error.name : "Unknown",
      requestId: crypto.randomUUID(),
    });
    return json({ error: "Something went wrong. Please retry." }, 500);
  }
}
export {
  handle as GET,
  handle as HEAD,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
};
