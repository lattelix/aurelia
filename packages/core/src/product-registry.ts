import { z } from "zod";

// Public product facts only; implementation, verification and distribution are independent.
export const ProductPlatformSchema = z.enum([
  "web",
  "android",
  "ios",
  "macos",
  "windows",
  "linux",
]);
export type ProductPlatform = z.infer<typeof ProductPlatformSchema>;
const platforms = ProductPlatformSchema.options;
const id = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(80);
const date = z.iso.date();
const privateText =
  /[\\/\u0000-\u001f\u007f]|\.runtime|\.env\b|dpl_[\w-]+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|\b[a-f0-9]{32,}\b|\b(?:bearer\s+\S+|(?:token|secret|password|cookie|authorization|udid|serial|device.?id|account.?id)\s*[:=])/i;
const text = z
  .string()
  .trim()
  .min(1)
  .max(600)
  .refine(
    (value) => !privateText.test(value),
    "Public text contains private or locator-shaped data",
  );
const rationale = text.refine(
  (value) => value.length >= 20,
  "A substantive assessment rationale is required",
);
const semver = z
  .string()
  .max(80)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/,
  );

const artifact = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("website"),
      url: z.literal("https://aurelia.lattelix.com/"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("installer"),
      url: z
        .string()
        .max(400)
        .refine(
          (value) =>
            /^https:\/\/github\.com\/lattelix\/aurelia-music\/releases\/download\/v[0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
              value,
            ) &&
            !/(?:dpl_|\.runtime|\.env|credential|token|secret)/i.test(value),
          "Expected an approved public release artifact",
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("store"),
      url: z
        .string()
        .max(400)
        .refine(
          (value) =>
            /^https:\/\/apps\.apple\.com\/[a-z]{2}\/app\/[a-z0-9-]+\/id[0-9]{6,12}$/.test(
              value,
            ),
          "Expected an approved public store listing",
        ),
    })
    .strict(),
]);
const distribution = z
  .object({
    status: z.enum([
      "hosted",
      "private-build",
      "public-release",
      "planned",
      "unavailable",
      "unknown",
    ]),
    channel: z.enum([
      "production",
      "development",
      "preview",
      "stable",
      "unknown",
    ]),
    version: semver.nullable(),
    releasedAt: date.nullable(),
    artifact: artifact.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (
      value.status === "public-release" &&
      (!value.artifact ||
        !value.version ||
        !value.releasedAt ||
        !["stable", "preview"].includes(value.channel))
    )
      issue(
        "A public release needs its artifact, formal version, release date and release channel",
      );
    if (
      value.status === "public-release" &&
      value.artifact?.kind === "installer" &&
      value.artifact.url.split("/").at(-2) !== `v${value.version}`
    )
      issue("The artifact release tag must match the formal version");
    if (
      value.status === "hosted" &&
      (value.channel !== "production" ||
        value.artifact?.kind !== "website" ||
        value.releasedAt !== null)
    )
      issue(
        "A hosted service needs its website and production channel; it is not a formal release",
      );
    if (
      value.status === "private-build" &&
      (!["development", "preview"].includes(value.channel) ||
        value.artifact !== null ||
        value.releasedAt !== null)
    )
      issue(
        "A private build cannot advertise a public artifact or release date",
      );
    if (
      ["planned", "unavailable", "unknown"].includes(value.status) &&
      (value.channel !== "unknown" ||
        value.version !== null ||
        value.releasedAt !== null ||
        value.artifact !== null)
    )
      issue(
        "An unavailable or unknown distribution cannot advertise a build or artifact",
      );
  });
const implementation = z
  .object({
    status: z.enum(["implemented", "partial", "planned", "absent", "unknown"]),
    note: text,
  })
  .strict();
const verification = z
  .object({
    status: z.enum(["verified", "partial", "unverified", "unknown"]),
    evidenceIds: z.array(id).max(12),
  })
  .strict();
const featurePlatform = z.object({ implementation, verification }).strict();
const featurePlatforms = z
  .object({
    web: featurePlatform,
    android: featurePlatform,
    ios: featurePlatform,
    macos: featurePlatform,
    windows: featurePlatform,
    linux: featurePlatform,
  })
  .strict();
const unestimated = z.object({ assessment: z.literal("unestimated") }).strict();
const reviewedAssessment = z
  .object({
    assessment: z.literal("reviewed"),
    result: z.enum(["estimated", "unknown"]),
    summary: rationale,
    assumptions: rationale,
    risks: rationale,
  })
  .strict();
const assessment = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("unestimated"),
      effort: unestimated,
      runningCash: unestimated,
      maintenance: unestimated,
    })
    .strict(),
  z
    .object({
      status: z.literal("reviewed"),
      reviewedAt: date,
      effort: reviewedAssessment,
      runningCash: reviewedAssessment,
      maintenance: reviewedAssessment,
    })
    .strict(),
]);
const feature = z
  .object({
    id,
    categoryId: id,
    surface: z.enum(["application", "service"]),
    title: text,
    description: text,
    platforms: featurePlatforms,
    assessment,
    voting: z.object({ enabled: z.boolean() }).strict(),
  })
  .strict();

const source = z.discriminatedUnion("visibility", [
  z
    .object({
      visibility: z.literal("private"),
      license: z.literal("pending"),
    })
    .strict(),
  z
    .object({
      visibility: z.literal("public-source-preview"),
      license: z.literal("GPL-3.0-only"),
      repositoryUrl: z.literal("https://github.com/lattelix/aurelia"),
      sourceBuildVerified: z.literal(false),
      binaryReleaseVerified: z.literal(false),
      releaseReady: z.literal(false),
    })
    .strict(),
]);

export const ProductRegistryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    reviewedAt: date,
    source,
    services: z
      .object({
        voting: z.enum(["not-connected", "connected"]),
        votingRule: z.literal("one-account-one-vote"),
        donationsAffectVotes: z.literal(false),
        funding: z.object({ status: z.literal("not-connected") }).strict(),
      })
      .strict(),
    categories: z
      .array(z.object({ id, title: text, description: text }).strict())
      .min(1)
      .max(20),
    distributions: z
      .object({
        web: distribution,
        android: distribution,
        ios: distribution,
        macos: distribution,
        windows: distribution,
        linux: distribution,
      })
      .strict(),
    evidence: z
      .array(
        z
          .object({
            id,
            platforms: z.array(ProductPlatformSchema).min(1).max(6),
            version: semver.nullable(),
            kind: z.enum([
              "automated-checks",
              "browser-check",
              "http-check",
              "build",
              "device-check",
              "code-review",
            ]),
            checkedAt: date,
            outcome: z.enum(["passed", "partial", "blocked", "failed"]),
            scope: text,
          })
          .strict(),
      )
      .max(200),
    features: z.array(feature).min(1).max(100),
  })
  .strict()
  .superRefine((registry, context) => {
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    const unique = (values: string[], path: (string | number)[]) => {
      if (new Set(values).size !== values.length)
        issue(path, "Identifiers must be unique");
    };
    unique(
      registry.categories.map((value) => value.id),
      ["categories"],
    );
    unique(
      registry.evidence.map((value) => value.id),
      ["evidence"],
    );
    unique(
      registry.features.map((value) => value.id),
      ["features"],
    );
    const categories = new Set(registry.categories.map((value) => value.id));
    const evidenceById = new Map(
      registry.evidence.map((value) => [value.id, value]),
    );
    registry.evidence.forEach((value, index) => {
      unique(value.platforms, ["evidence", index, "platforms"]);
      if (value.checkedAt > registry.reviewedAt)
        issue(
          ["evidence", index, "checkedAt"],
          "Evidence cannot postdate the snapshot",
        );
    });
    for (const platform of platforms) {
      const value = registry.distributions[platform];
      if (value.status === "hosted" && platform !== "web")
        issue(
          ["distributions", platform],
          "Only the web platform is a hosted service",
        );
      if (
        value.status === "public-release" &&
        ((platform === "web" && value.artifact?.kind !== "website") ||
          (platform !== "web" && value.artifact?.kind === "website") ||
          (value.artifact?.kind === "store" &&
            !["ios", "macos"].includes(platform)))
      )
        issue(
          ["distributions", platform, "artifact"],
          "The public artifact must match the distribution platform",
        );
      if (value.releasedAt && value.releasedAt > registry.reviewedAt)
        issue(
          ["distributions", platform, "releasedAt"],
          "A release cannot postdate the snapshot",
        );
    }
    registry.features.forEach((value, index) => {
      if (!categories.has(value.categoryId))
        issue(["features", index, "categoryId"], "Unknown category");
      if (value.voting.enabled && value.assessment.status !== "reviewed")
        issue(
          ["features", index, "voting"],
          "Assess effort, running cash and maintenance before enabling votes",
        );
      if (
        value.assessment.status === "reviewed" &&
        value.assessment.reviewedAt > registry.reviewedAt
      )
        issue(
          ["features", index, "assessment"],
          "An assessment cannot postdate the snapshot",
        );
      for (const platform of platforms) {
        const state = value.platforms[platform];
        const path = ["features", index, "platforms", platform, "verification"];
        unique(state.verification.evidenceIds, [...path, "evidenceIds"]);
        const records = state.verification.evidenceIds.map((reference) =>
          evidenceById.get(reference),
        );
        if (
          records.some(
            (record) => !record || !record.platforms.includes(platform),
          )
        )
          issue(path, "Evidence must exist and cover this platform");
        if (
          ["verified", "partial"].includes(state.verification.status) &&
          !records.length
        )
          issue(path, "Verification requires evidence");
        if (state.verification.status === "unknown" && records.length)
          issue(path, "Unknown verification cannot claim evidence");
        if (
          state.verification.status === "verified" &&
          records.some((record) => record?.outcome !== "passed")
        )
          issue(path, "Verified status requires passing evidence");
        const version = registry.distributions[platform].version;
        if (
          ["verified", "partial"].includes(state.verification.status) &&
          version !== null &&
          records.some((record) => record?.version !== version)
        )
          issue(
            path,
            "Positive verification evidence must match the current distribution version",
          );
        if (
          state.verification.status === "partial" &&
          !records.some(
            (record) =>
              record?.outcome === "passed" || record?.outcome === "partial",
          )
        )
          issue(
            path,
            "Partial verification needs at least some successful evidence",
          );
        if (
          ["planned", "absent", "unknown"].includes(
            state.implementation.status,
          ) &&
          ["verified", "partial"].includes(state.verification.status)
        )
          issue(
            path,
            "Verification cannot imply an implementation that is absent or unknown",
          );
      }
    });
  });
export type ProductRegistryV1 = z.infer<typeof ProductRegistryV1Schema>;
export type ProductFeature = ProductRegistryV1["features"][number];
export type FeatureSupport =
  "verified" | "partial" | "planned" | "unsupported" | "unverified" | "unknown";

export function getFeatureSupport(
  registry: ProductRegistryV1,
  featureId: string,
  platform: ProductPlatform,
): FeatureSupport {
  const value = registry.features.find((item) => item.id === featureId)
    ?.platforms[platform];
  if (!value) return "unknown";
  if (value.implementation.status === "absent") return "unsupported";
  if (value.implementation.status === "planned") return "planned";
  if (value.implementation.status === "unknown") return "unknown";
  if (
    value.verification.status === "unknown" ||
    value.verification.status === "unverified"
  )
    return value.verification.status;
  const version = registry.distributions[platform].version;
  if (version !== null) {
    const records = value.verification.evidenceIds.map((reference) =>
      registry.evidence.find((record) => record.id === reference),
    );
    if (
      !records.length ||
      records.some(
        (record) =>
          record?.version !== version ||
          (value.verification.status === "verified" &&
            record.outcome !== "passed"),
      )
    )
      return "unverified";
    if (
      !records.some(
        (record) =>
          record?.outcome === "passed" || record?.outcome === "partial",
      )
    )
      return "unverified";
  }
  return value.implementation.status === "partial" ||
    value.verification.status === "partial"
    ? "partial"
    : "verified";
}

// Eligibility only; the eventual voting service must authenticate each account.
export function canVote(
  registry: ProductRegistryV1,
  featureId: string,
): boolean {
  const value = registry.features.find((item) => item.id === featureId);
  return (
    registry.services.voting === "connected" &&
    value?.voting.enabled === true &&
    value.assessment.status === "reviewed"
  );
}

type PlatformState = z.infer<typeof featurePlatform>;
function state(
  status: PlatformState["implementation"]["status"],
  note: string,
  evidenceIds: string[] = [],
  verified: "verified" | "partial" = "partial",
): PlatformState {
  return {
    implementation: { status, note },
    verification: {
      status: evidenceIds.length ? verified : "unknown",
      evidenceIds,
    },
  };
}
const planned = () =>
  state(
    "planned",
    "Planned work with scope and acceptance still to be assessed.",
  );
const unknown = () =>
  state("unknown", "This platform has not been assessed for this feature.");
const absent = () =>
  state("absent", "This capability is absent from the current application.");
const web = (note: string) =>
  state("implemented", note, ["web-checks", "web-browser"]);
const android = (note: string) =>
  state("implemented", note, ["android-checks", "android-device"]);
const apple = (note: string) => state("implemented", note, ["apple-checks"]);
const bothApple = (
  note: string,
): Partial<Record<ProductPlatform, PlatformState>> => ({
  ios: apple(note),
  macos: apple(note),
});
// Planning estimates, not release dates or spending authorizations.
const proposalAssessments: Partial<
  Record<string, ProductFeature["assessment"]>
> = {
  "appearance-account-sync": {
    status: "reviewed",
    reviewedAt: "2026-11-10",
    effort: {
      assessment: "reviewed",
      result: "estimated",
      summary:
        "6–10 engineering days for account preferences and integration in the existing web, Android and Apple clients.",
      assumptions:
        "Reuse current accounts and theme contracts; sync palette and mode only, with explicit local fallback and conflict handling.",
      risks:
        "Older client compatibility and account-switch races need cross-device testing; new interface layouts are excluded.",
    },
    runningCash: {
      assessment: "reviewed",
      result: "unknown",
      summary:
        "No additional paid service is planned; incremental database and request cost depends on actual usage and hosting quotas.",
      assumptions:
        "Store small preference records in the existing database and refresh during normal account synchronization.",
      risks:
        "Current free quotas can change or be exceeded; no zero-cost guarantee or budget commitment is made.",
    },
    maintenance: {
      assessment: "reviewed",
      result: "estimated",
      summary:
        "Around 0.5–1 engineering day per month during active client development, plus major platform changes.",
      assumptions:
        "One versioned preference contract and compatibility fixtures cover existing palettes and modes.",
      risks:
        "Adding renderers or layout presets increases the compatibility matrix beyond this estimate.",
    },
  },
  "listening-rooms": {
    status: "reviewed",
    reviewedAt: "2026-11-10",
    effort: {
      assessment: "reviewed",
      result: "estimated",
      summary:
        "15–30 engineering days for a small shared-room selection and queue prototype with roles and invitations.",
      assumptions:
        "Start with account members, metadata and commands; each participant resolves their own audio source. Tight playback synchronization is excluded.",
      risks:
        "Reconnects, concurrent edits, moderation and source availability may require a larger second phase.",
    },
    runningCash: {
      assessment: "reviewed",
      result: "unknown",
      summary:
        "Concurrent connections, command traffic and abuse controls must be measured before assigning an operating budget.",
      assumptions:
        "Begin with a bounded prototype on existing infrastructure; select any additional realtime service only after an architecture review.",
      risks:
        "Free serverless limits may not suit persistent connections; no provider purchase or fixed monthly amount is approved.",
    },
    maintenance: {
      assessment: "reviewed",
      result: "estimated",
      summary:
        "About 2–5 engineering days per month during an active pilot, excluding continuous moderation staffing.",
      assumptions:
        "Small invited rooms, bounded membership and one versioned command protocol limit the initial support surface.",
      risks:
        "Public rooms, abuse reports and tightly synchronized audio would add ongoing work and operating responsibility.",
    },
  },
  "app-store-distribution": {
    status: "reviewed",
    reviewedAt: "2026-11-10",
    effort: {
      assessment: "reviewed",
      result: "estimated",
      summary:
        "6–12 engineering days to prepare a first iOS submission after licensing and source permissions are resolved; review waiting time is separate.",
      assumptions:
        "Use an honestly documented build with local or authorized sources, complete reviewer access, privacy details and reproducible packaging.",
      risks:
        "Store acceptance and third-party rights are unresolved; redesign, legal work, other stores and review delays are outside this range.",
    },
    runningCash: {
      assessment: "reviewed",
      result: "estimated",
      summary:
        "Apple Developer Program lists USD 99 per year; local pricing and taxes vary. Legal and other operating costs remain unknown.",
      assumptions:
        "One individual developer membership is the initial known fee; enrollment, payments and fundraising are not connected here.",
      risks:
        "Membership does not guarantee approval; currency changes, regional eligibility and rights clearance may change the actual cost.",
    },
    maintenance: {
      assessment: "reviewed",
      result: "estimated",
      summary:
        "1–3 engineering days per release cycle for signing, store metadata, regression checks and review responses.",
      assumptions:
        "Reuse the existing iOS client and release checks; keep all reviewer-visible features accurately documented.",
      risks:
        "Policy or platform changes and provider breakage can require additional work; continuous source support is a separate obligation.",
    },
  },
};
function card(
  featureId: string,
  categoryId: string,
  title: string,
  description: string,
  states: Partial<Record<ProductPlatform, PlatformState>>,
  surface: ProductFeature["surface"] = "application",
): ProductFeature {
  return {
    id: featureId,
    categoryId,
    surface,
    title,
    description,
    platforms: {
      web: unknown(),
      android: unknown(),
      ios: unknown(),
      macos: unknown(),
      windows: unknown(),
      linux: unknown(),
      ...states,
    },
    assessment: proposalAssessments[featureId] ?? {
      status: "unestimated",
      effort: { assessment: "unestimated" },
      runningCash: { assessment: "unestimated" },
      maintenance: { assessment: "unestimated" },
    },
    voting: { enabled: proposalAssessments[featureId] !== undefined },
  };
}
const nativePrivate = () => ({
  status: "private-build" as const,
  channel: "development" as const,
  version: null,
  releasedAt: null,
  artifact: null,
});
const futureDistribution = () => ({
  status: "planned" as const,
  channel: "unknown" as const,
  version: null,
  releasedAt: null,
  artifact: null,
});

export const productRegistryV1: ProductRegistryV1 =
  ProductRegistryV1Schema.parse({
    schemaVersion: 1,
    reviewedAt: "2026-11-11",
    source: {
      visibility: "public-source-preview",
      license: "GPL-3.0-only",
      repositoryUrl: "https://github.com/lattelix/aurelia",
      sourceBuildVerified: false,
      binaryReleaseVerified: false,
      releaseReady: false,
    },
    services: {
      voting: "connected",
      votingRule: "one-account-one-vote",
      donationsAffectVotes: false,
      funding: { status: "not-connected" },
    },
    categories: [
      {
        id: "playback",
        title: "Playback",
        description: "Playing recordings and controlling the active queue.",
      },
      {
        id: "library",
        title: "Library and files",
        description: "Personal collections, managed copies and device files.",
      },
      {
        id: "discovery",
        title: "Music discovery",
        description: "Music metadata, charts and recommendations.",
      },
      {
        id: "account",
        title: "Account",
        description:
          "Identity and refresh-based personal metadata synchronization.",
      },
      {
        id: "appearance",
        title: "Appearance",
        description: "Local visual choices and future shared preferences.",
      },
      {
        id: "community",
        title: "Community",
        description: "Future shared listening and participation.",
      },
      {
        id: "platform",
        title: "Platforms and distribution",
        description:
          "Application coverage and separately verified release channels.",
      },
    ],
    distributions: {
      web: {
        status: "hosted",
        channel: "production",
        version: null,
        releasedAt: null,
        artifact: { kind: "website", url: "https://aurelia.lattelix.com/" },
      },
      android: nativePrivate(),
      ios: nativePrivate(),
      macos: nativePrivate(),
      windows: futureDistribution(),
      linux: futureDistribution(),
    },
    evidence: [
      {
        id: "web-checks",
        platforms: ["web"],
        kind: "automated-checks",
        version: null,
        checkedAt: "2026-11-10",
        outcome: "passed",
        scope:
          "Web and API unit checks, type checks, lint and a production build.",
      },
      {
        id: "web-browser",
        platforms: ["web"],
        kind: "browser-check",
        version: null,
        checkedAt: "2026-11-08",
        outcome: "passed",
        scope:
          "Focused browser checks covered playlist editing, filtering, lyrics, account ownership and responsive views.",
      },
      {
        id: "metadata-http",
        platforms: ["web"],
        kind: "http-check",
        version: null,
        checkedAt: "2026-11-10",
        outcome: "passed",
        scope:
          "Public music metadata search, collection browsing and source chart selections were checked through HTTP.",
      },
      {
        id: "android-checks",
        platforms: ["android"],
        kind: "automated-checks",
        version: null,
        checkedAt: "2026-11-08",
        outcome: "passed",
        scope:
          "Native source and application tests, lint and private application packaging.",
      },
      {
        id: "android-device",
        platforms: ["android"],
        kind: "device-check",
        version: null,
        checkedAt: "2026-11-08",
        outcome: "partial",
        scope:
          "Private application playback, queue changes and library synchronization after refresh; long renewal remains open.",
      },
      {
        id: "apple-checks",
        platforms: ["ios", "macos"],
        kind: "automated-checks",
        version: null,
        checkedAt: "2026-11-10",
        outcome: "passed",
        scope:
          "Shared Apple model, cloud, offline and export checks ran on macOS; the iOS application compiled separately.",
      },
      {
        id: "ios-ui",
        platforms: ["ios"],
        kind: "device-check",
        version: null,
        checkedAt: "2026-11-10",
        outcome: "partial",
        scope:
          "Catalogue browsing, one manual offline save and playback, one direct file copy, cancellation feedback and mini-player layout; broader ordinary UI acceptance remains open.",
      },
      {
        id: "ios-offline",
        platforms: ["ios"],
        kind: "device-check",
        version: null,
        checkedAt: "2026-11-10",
        outcome: "passed",
        scope:
          "Isolated single-recording cold offline playback, seek, saved assets and owner revocation.",
      },
      {
        id: "mac-offline",
        platforms: ["macos"],
        kind: "device-check",
        version: null,
        checkedAt: "2026-11-10",
        outcome: "passed",
        scope:
          "Single-recording cold offline native playback and seek with owner revocation and bounded cleanup.",
      },
    ],
    features: [
      card(
        "music-playback",
        "playback",
        "Music playback",
        "Explicit playback, seeking and background behavior with source-specific availability.",
        {
          web: web(
            "Browser audio with video fallback; background support depends on the source and browser.",
          ),
          android: android(
            "Private native audio playback; broader renewal acceptance remains open.",
          ),
          ...bothApple(
            "Native audio playback with bounded source and interruption acceptance still open.",
          ),
        },
      ),
      card(
        "queue-editing",
        "playback",
        "Queue editing",
        "Play next, add, move and remove occurrences while retaining the active recording.",
        {
          web: web(
            "Queue edits are implemented; shuffle-specific acceptance is separate.",
          ),
          android: android(
            "Private native queue mutation is checked with stable duplicate occurrences.",
          ),
          ...bothApple(
            "Stable occurrence queues and paused metadata restoration are covered by shared model checks.",
          ),
        },
      ),
      card(
        "sleep-timer",
        "playback",
        "Sleep timer",
        "Stop after a duration or at the end of the current recording.",
        {
          web: planned(),
          android: planned(),
          ...bothApple(
            "Duration and track-end timers are implemented; full device lifecycle acceptance remains open.",
          ),
        },
      ),
      card(
        "synchronized-lyrics",
        "playback",
        "Lyrics and timing",
        "Static and synchronized lyrics with manual version selection, offset and seeking.",
        {
          web: web(
            "Lyrics selection, highlight and click-to-seek are implemented.",
          ),
          android: android(
            "Shared lyrics UI is present; broader native timing acceptance remains open.",
          ),
          ...bothApple(
            "Managed text restore and manual selection are implemented; full device timing acceptance remains open.",
          ),
        },
      ),
      card(
        "managed-offline-audio",
        "library",
        "Managed offline audio",
        "Owner-scoped verified audio copies with bounded storage and explicit download controls.",
        {
          web: absent(),
          android: planned(),
          ios: state(
            "implemented",
            "One manual save and isolated cold playback passed; full scopes and resume acceptance remain open.",
            ["apple-checks", "ios-ui", "ios-offline"],
          ),
          macos: state(
            "implemented",
            "Cold offline playback passed for one recording; broader library acceptance remains open.",
            ["apple-checks", "mac-offline"],
          ),
        },
      ),
      card(
        "managed-offline-assets",
        "library",
        "Saved artwork and lyrics",
        "Album metadata, artwork and selected lyrics accompany managed offline recordings.",
        {
          web: absent(),
          android: planned(),
          ...bothApple(
            "Bounded owner assets with integrity checks and manual text priority are implemented.",
          ),
        },
      ),
      card(
        "local-audio-files",
        "library",
        "Device audio files",
        "Opt-in private copies of selected MP3, M4A and FLAC files in a separate device library.",
        {
          web: absent(),
          android: planned(),
          ...bothApple(
            "Local import and integrity checks are implemented; full picker and format acceptance remains open.",
          ),
        },
      ),
      card(
        "audio-file-export",
        "library",
        "Audio file export",
        "Export an available managed recording with metadata, artwork and lyric sidecars.",
        {
          web: absent(),
          android: planned(),
          macos: apple(
            "Local codec checks passed; completed ordinary end-user export remains unverified.",
          ),
          ios: state(
            "implemented",
            "One direct audio and artwork copy to Files and cancellation feedback were checked; broader export acceptance remains open.",
            ["apple-checks", "ios-ui"],
          ),
        },
      ),
      card(
        "playlist-management",
        "library",
        "Playlist management",
        "Create and edit playlists, filter collections and preserve explicit server ordering.",
        {
          web: web(
            "Playlist editing, filters and expected-order conflict handling are implemented.",
          ),
          android: android(
            "Shared playlist controls were checked in a private application.",
          ),
          ...bothApple(
            "Collection filters, sorting and metadata actions are implemented; full account writes remain open.",
          ),
        },
      ),
      card(
        "metadata-transfer",
        "library",
        "Metadata transfer",
        "Review and transfer library metadata with conservative matching for uncertain recordings.",
        {
          web: web("File-based metadata transfer and review are implemented."),
          android: android(
            "Metadata transfer uses the account-bound shared API.",
          ),
          ...bothApple(
            "Bounded metadata transfer and review are implemented; broader real account acceptance remains open.",
          ),
        },
      ),
      card(
        "account-library-sync",
        "account",
        "Account library synchronization",
        "Use one identity for saved music and synchronize metadata after refresh or foreground return.",
        {
          web: web(
            "Account ownership fences and metadata persistence are implemented.",
          ),
          android: android(
            "Private device and browser changes were verified after refresh.",
          ),
          ios: state(
            "partial",
            "Account model and API checks passed; full live cloud write and secure storage acceptance remain open.",
            ["apple-checks"],
          ),
          macos: state(
            "partial",
            "Account model and API checks passed; full live cloud write and secure storage acceptance remain open.",
            ["apple-checks"],
          ),
        },
      ),
      card(
        "music-metadata-api",
        "discovery",
        "Typed music metadata API",
        "Shared public songs, albums, artists, playlists and country chart metadata service.",
        {
          web: state(
            "implemented",
            "The production metadata API was checked independently of browser feature coverage.",
            ["web-checks", "metadata-http"],
            "verified",
          ),
        },
        "service",
      ),
      card(
        "music-catalogue-browse",
        "discovery",
        "Music catalogue browsing",
        "Music-focused typed search and album, artist and playlist browsing in each application.",
        {
          web: state(
            "partial",
            "The shared API exists; the browser still uses the older general search interface.",
            ["web-checks"],
          ),
          android: state(
            "partial",
            "The shared search interface is present; typed catalogue integration remains unfinished.",
            ["android-checks"],
          ),
          ...bothApple(
            "Typed music search and collection pages are implemented; broader catalogue acceptance remains open.",
          ),
        },
      ),
      card(
        "regional-charts",
        "discovery",
        "Regional chart selections",
        "Browse source chart selections by country and follow their music collections.",
        {
          web: state(
            "partial",
            "Country chart metadata is available through the API; dedicated browser chart UI remains unfinished.",
            ["metadata-http"],
          ),
          android: planned(),
          ios: state(
            "implemented",
            "Global chart selections and one daily playlist were checked in the ordinary UI.",
            ["apple-checks", "ios-ui"],
          ),
          macos: apple(
            "Chart selection views are implemented; ordinary Mac chart acceptance remains open.",
          ),
        },
      ),
      card(
        "listening-history",
        "discovery",
        "Listening history",
        "Account-scoped listening history from actual progress with bounded completion updates.",
        {
          web: web("History and listening event persistence are implemented."),
          android: state(
            "partial",
            "History views exist; complete native progress telemetry remains unfinished.",
            ["android-checks"],
          ),
          ...bothApple(
            "Bounded progress recording and owner-isolated outboxes are covered by model checks.",
          ),
        },
      ),
      card(
        "music-recommendations",
        "discovery",
        "Recommendations",
        "Personal music suggestions from library metadata and listening signals.",
        {
          web: web(
            "Deterministic recommendations and public discovery fallback are implemented.",
          ),
          android: android(
            "Shared recommendations are available after metadata refresh.",
          ),
          ...bothApple(
            "Recommendation views and scoped signals are implemented; live account acceptance remains open.",
          ),
        },
      ),
      card(
        "appearance-palettes",
        "appearance",
        "Local appearance",
        "Choose local palettes and system, light or dark appearance independently.",
        {
          web: web("Local skins and appearance modes are implemented."),
          android: android(
            "Local appearance and native system bar contrast were checked.",
          ),
          ...bothApple(
            "Local Base, Rainbow and Midnight palettes are implemented with contrast checks.",
          ),
        },
      ),
      card(
        "appearance-account-sync",
        "appearance",
        "Synchronized appearance",
        "Save appearance preferences in the account for consistent choices across devices.",
        {
          web: planned(),
          android: planned(),
          ios: planned(),
          macos: planned(),
        },
      ),
      card(
        "layout-presets",
        "appearance",
        "Layout presets",
        "Choose an agreed common layout with platform-specific accessibility and sizing.",
        {
          web: planned(),
          android: planned(),
          ios: planned(),
          macos: planned(),
        },
      ),
      card(
        "listening-rooms",
        "community",
        "Shared listening rooms",
        "Shared selections, roles, invitations and later synchronized listening with independent sources.",
        {
          web: planned(),
          android: planned(),
          ios: planned(),
          macos: planned(),
          windows: planned(),
          linux: planned(),
        },
      ),
      card(
        "music-recognition",
        "discovery",
        "Music recognition",
        "Identify a recording and review a conservative match in the music catalogue.",
        {
          web: planned(),
          android: planned(),
          ios: planned(),
          macos: planned(),
        },
      ),
      card(
        "platform-applications",
        "platform",
        "Platform applications",
        "Maintain separately verified web, mobile and desktop applications.",
        {
          web: web(
            "A hosted production application exists without a declared formal release version.",
          ),
          android: android(
            "A private development application exists; no public installer release is declared.",
          ),
          ...bothApple(
            "Private native applications exist; public release packaging remains open.",
          ),
          windows: planned(),
          linux: planned(),
        },
      ),
      card(
        "public-installers",
        "platform",
        "Public installer releases",
        "Publish reviewed packages with checksums and installation guidance for supported native platforms.",
        {
          web: absent(),
          android: planned(),
          ios: planned(),
          macos: planned(),
          windows: planned(),
          linux: planned(),
        },
      ),
      card(
        "app-store-distribution",
        "platform",
        "Store distribution",
        "Prepare platform review, licensing and packaging before publishing actual store listings.",
        { web: absent(), android: planned(), ios: planned(), macos: planned() },
      ),
    ],
  });
