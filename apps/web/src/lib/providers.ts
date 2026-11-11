import { StudioProvider } from "@aurelia/music";
import { AppError, type Track, type MusicProvider } from "@aurelia/core";
import { env } from "./env";
import { YouTubeAudioProvider } from "./youtube-media/provider";
export const studio = new StudioProvider();
export const youtube = new YouTubeAudioProvider(
  env.YOUTUBE_API_KEY ?? "",
  env.YOUTUBE_PLAYBACK === "audio",
);
export function providerFor(track: Pick<Track, "provider">): MusicProvider {
  return track.provider === "studio" ? studio : youtube;
}
export async function trustedTrack(id: string) {
  const provider = id.startsWith("studio:") ? studio : youtube;
  const track = await provider.getTrack(id);
  if (!track) throw new AppError(404, "Track not found");
  return track;
}
