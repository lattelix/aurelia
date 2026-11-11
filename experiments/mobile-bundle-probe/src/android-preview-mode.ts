export interface AndroidPreviewMode {
  appId: string;
  appName: string;
  requiredUiMode: "private-bundled-profile-preview" | "private-bundled-offline-guest";
  forceSilent: boolean;
  forceYoutubeSource: boolean;
  mainApplication: boolean;
}
export function androidPreviewMode(input: {
  nightQa: boolean;
  profilePreview: boolean;
}): AndroidPreviewMode {
  if (input.nightQa && input.profilePreview)
    throw new Error("--night-qa and --profile-preview are mutually exclusive.");
  return {
    appId: input.nightQa ? "com.lattelix.aurelia.nightqa"
      : input.profilePreview ? "com.lattelix.aurelia" : "com.lattelix.aurelia.bundledprobe",
    appName: input.nightQa ? "Aurelia Silent QA"
      : input.profilePreview ? "Aurelia" : "Aurelia Bundled Probe",
    requiredUiMode: input.nightQa || input.profilePreview
      ? "private-bundled-profile-preview" : "private-bundled-offline-guest",
    forceSilent: input.nightQa,
    forceYoutubeSource: input.nightQa,
    mainApplication: input.profilePreview,
  };
}
