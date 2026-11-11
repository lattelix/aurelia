declare const __AURELIA_PUBLIC_METADATA__: boolean;
export const publicMetadataEnabled =
  typeof __AURELIA_PUBLIC_METADATA__ !== "undefined" && __AURELIA_PUBLIC_METADATA__;

export function previewStatus(input: {
  profileMode: boolean;
  nativeSession: boolean;
  signedIn: boolean;
  loading: boolean;
  failed: boolean;
}): { title: string; description: string } {
  if (!input.profileMode)
    return {
      title: "Private bundled UI preview",
      description: "Guest preview · original Studio catalogue. Cloud sign-in is disabled in this build.",
    };
  if (!input.nativeSession)
    return {
      title: "Aurelia native preview",
      description: "Guest preview · public search. Account sign-in requires the native app session bridge.",
    };
  if (input.loading)
    return { title: "Aurelia native preview", description: "Connecting to your Aurelia profile…" };
  if (input.failed)
    return { title: "Aurelia native preview", description: "Cloud connection unavailable. Reconnect to load your profile; your saved sign-in stays on this device." };
  return {
    title: "Aurelia native preview",
    description: input.signedIn
      ? "Cloud profile connected · likes and playlists sync. Playback stays on this device."
      : "Sign in through your browser to connect your Aurelia library, or explore as a guest.",
  };
}
