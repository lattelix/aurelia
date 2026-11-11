import { AppError } from "@aurelia/core";
import { account } from "../http";
import { mediaRequestBudget } from "../guest-policy";
import { audioResponse } from "./audio-response";
import { gatewayAudio } from "./gateway-client";

export async function audioApi(request: Request) {
  if (!["GET", "HEAD"].includes(request.method)) return null;
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new AppError(403, "Open this recording in Aurelia");
  const user = await account();
  await mediaRequestBudget(user, "audio", 120);
  return (await gatewayAudio(request)) ?? audioResponse(request);
}
