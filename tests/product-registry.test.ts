import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformsPage } from "../apps/web/src/components/website/product-pages";
import {
  ProductPlatformSchema,
  ProductRegistryV1Schema,
  canVote,
  getFeatureSupport,
  productRegistryV1,
  type ProductFeature,
  type ProductRegistryV1,
} from "@aurelia/core";

const snapshot = () => structuredClone(productRegistryV1);
const first = (value: ProductRegistryV1) => value.features[0];
function releaseFixture() {
  const value = snapshot();
  value.distributions.ios = {
    status: "public-release",
    channel: "stable",
    version: "1.2.3",
    releasedAt: "2026-11-10",
    artifact: {
      kind: "installer",
      url: "https://github.com/lattelix/aurelia-music/releases/download/v1.2.3/synthetic-fixture.zip",
    },
  };
  for (const record of value.evidence)
    if (record.platforms.includes("ios")) record.version = "1.2.3";
  return value;
}
function reviewedFeature(): ProductFeature["assessment"] {
  const dimension = {
    assessment: "reviewed" as const,
    result: "unknown" as const,
    summary:
      "A bounded prototype is required before selecting a defensible estimate.",
    assumptions:
      "The assessment assumes reuse of the current application stack.",
    risks:
      "Provider behavior and platform acceptance may change the implementation scope.",
  };
  return {
    status: "reviewed",
    reviewedAt: "2026-11-10",
    effort: { ...dimension },
    runningCash: { ...dimension },
    maintenance: { ...dimension },
  };
}

describe("public product registry v1", () => {
  it("publishes one validated feature pool with explicit platform and distribution facts", () => {
    const value = ProductRegistryV1Schema.parse(snapshot());
    expect(value.schemaVersion).toBe(1);
    expect(value.reviewedAt).toBe("2026-11-11");
    expect(value.features).toHaveLength(24);
    expect(Object.keys(value.distributions).sort()).toEqual(
      [...ProductPlatformSchema.options].sort(),
    );
    expect(value.distributions.web).toEqual({
      status: "hosted",
      channel: "production",
      version: null,
      releasedAt: null,
      artifact: { kind: "website", url: "https://aurelia.lattelix.com/" },
    });
    for (const platform of ["android", "ios", "macos"] as const)
      expect(value.distributions[platform]).toEqual({
        status: "private-build",
        channel: "development",
        version: null,
        releasedAt: null,
        artifact: null,
      });
    for (const platform of ["windows", "linux"] as const)
      expect(value.distributions[platform].status).toBe("planned");
    expect(value.source).toEqual({
      visibility: "public-source-preview",
      license: "GPL-3.0-only",
      repositoryUrl: "https://github.com/lattelix/aurelia",
      sourceBuildVerified: false,
      binaryReleaseVerified: false,
      releaseReady: false,
    });
    expect(JSON.stringify(value)).not.toContain("0.1.0");
  });

  it("preserves the exact private source variant without admitting preview fields", () => {
    const value = snapshot();
    value.source = { visibility: "private", license: "pending" };
    expect(ProductRegistryV1Schema.parse(value).source).toEqual(value.source);
    expect(
      ProductRegistryV1Schema.safeParse({
        ...value,
        source: {
          ...value.source,
          repositoryUrl: "https://github.com/lattelix/aurelia",
        },
      }).success,
    ).toBe(false);
    expect(
      ProductRegistryV1Schema.safeParse({
        ...value,
        source: { visibility: "private", license: "GPL-3.0-only" },
      }).success,
    ).toBe(false);
  });

  it.each([
    "sourceBuildVerified",
    "binaryReleaseVerified",
    "releaseReady",
  ] as const)(
    "requires the preview to retain explicit false %s rather than implying release acceptance",
    (key) => {
      const value = snapshot();
      expect(
        ProductRegistryV1Schema.safeParse({
          ...value,
          source: { ...value.source, [key]: true },
        }).success,
      ).toBe(false);
      const incomplete: Record<string, unknown> = { ...value.source };
      delete incomplete[key];
      expect(
        ProductRegistryV1Schema.safeParse({ ...value, source: incomplete })
          .success,
      ).toBe(false);
    },
  );

  it.each([
    "https://github.com/lattelix/aurelia-music",
    "https://github.com/lattelix/aurelia/releases",
    "https://github.com/lattelix/aurelia?token=synthetic",
    "https://github.com/lattelix/aurelia#synthetic",
    "https://user:password@github.com/lattelix/aurelia",
    "https://github.com/lattelix/aurelia/",
    "https://untrusted.invalid/lattelix/aurelia",
  ])("rejects unapproved source-preview repository URL %s", (repositoryUrl) => {
    const value = snapshot();
    expect(
      ProductRegistryV1Schema.safeParse({
        ...value,
        source: { ...value.source, repositoryUrl },
      }).success,
    ).toBe(false);
  });

  it.each(["GPL-3.0-or-later", "MIT", "pending"])(
    "rejects an unapproved source-preview license %s",
    (license) => {
      const value = snapshot();
      expect(
        ProductRegistryV1Schema.safeParse({
          ...value,
          source: { ...value.source, license },
        }).success,
      ).toBe(false);
    },
  );

  it("links the experimental source preview accessibly while keeping native installers unavailable", () => {
    const html = renderToStaticMarkup(createElement(PlatformsPage));
    expect(html).toContain("Экспериментальный публичный срез исходников.");
    expect(html).toContain('href="https://github.com/lattelix/aurelia"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain(
      'aria-label="Исходники Aurelia на GitHub (новая вкладка)"',
    );
    expect(html).toContain("GPL-3.0-only");
    expect(html).toContain("Web-проверки прошли.");
    expect(html).toContain("Нативные установщики пока не опубликованы.");
    expect(html).not.toContain("Исходный код закрыт.");
    expect(html).not.toContain("/releases/download/");
  });

  it("keeps API evidence distinct from application completeness and public distribution", () => {
    expect(
      getFeatureSupport(productRegistryV1, "music-metadata-api", "web"),
    ).toBe("verified");
    expect(
      getFeatureSupport(productRegistryV1, "music-catalogue-browse", "web"),
    ).toBe("partial");
    expect(
      productRegistryV1.features.find(
        (value) => value.id === "music-metadata-api",
      )?.surface,
    ).toBe("service");
    expect(productRegistryV1.distributions.ios.status).toBe("private-build");
    expect(productRegistryV1.distributions.ios.artifact).toBeNull();
  });

  it("does not promote an implemented feature without verification", () => {
    const value = snapshot();
    first(value).platforms.web.verification = {
      status: "unknown",
      evidenceIds: [],
    };
    const parsed = ProductRegistryV1Schema.parse(value);
    expect(getFeatureSupport(parsed, first(value).id, "web")).toBe("unknown");
    first(value).platforms.web.verification.status = "unverified";
    expect(
      getFeatureSupport(
        ProductRegistryV1Schema.parse(value),
        first(value).id,
        "web",
      ),
    ).toBe("unverified");
    first(value).platforms.web.verification.status = "verified";
    expect(ProductRegistryV1Schema.safeParse(value).success).toBe(false);
  });

  it("distinguishes unknown scope, planned work and explicitly absent capabilities", () => {
    expect(
      getFeatureSupport(productRegistryV1, "queue-editing", "windows"),
    ).toBe("unknown");
    expect(
      getFeatureSupport(productRegistryV1, "platform-applications", "windows"),
    ).toBe("planned");
    expect(
      getFeatureSupport(productRegistryV1, "managed-offline-audio", "web"),
    ).toBe("unsupported");
    expect(
      getFeatureSupport(productRegistryV1, "not-a-known-feature", "web"),
    ).toBe("unknown");
  });

  it("never reuses positive evidence after the distribution version changes", () => {
    const value = snapshot();
    value.distributions.web.version = "1.2.3";
    expect(ProductRegistryV1Schema.safeParse(value).success).toBe(false);
    expect(getFeatureSupport(value, "music-metadata-api", "web")).toBe(
      "unverified",
    );
    for (const record of value.evidence)
      if (record.platforms.includes("web")) record.version = "1.2.3";
    expect(
      getFeatureSupport(
        ProductRegistryV1Schema.parse(value),
        "music-metadata-api",
        "web",
      ),
    ).toBe("verified");
    value.distributions.web.version = "1.2.4";
    expect(ProductRegistryV1Schema.safeParse(value).success).toBe(false);
    expect(getFeatureSupport(value, "music-metadata-api", "web")).toBe(
      "unverified",
    );
    const native = releaseFixture();
    expect(
      getFeatureSupport(
        ProductRegistryV1Schema.parse(native),
        "managed-offline-audio",
        "ios",
      ),
    ).toBe("partial");
    native.evidence.find((record) => record.id === "ios-offline")!.version =
      null;
    expect(ProductRegistryV1Schema.safeParse(native).success).toBe(false);
    expect(getFeatureSupport(native, "managed-offline-audio", "ios")).toBe(
      "unverified",
    );
  });

  it.each(["features", "categories", "evidence"] as const)(
    "rejects duplicate stable IDs in %s",
    (key) => {
      const value = snapshot();
      if (key === "features")
        value.features.push(structuredClone(value.features[0]));
      if (key === "categories")
        value.categories.push(structuredClone(value.categories[0]));
      if (key === "evidence")
        value.evidence.push(structuredClone(value.evidence[0]));
      expect(ProductRegistryV1Schema.safeParse(value).success).toBe(false);
    },
  );

  it("rejects unknown category and evidence cross references", () => {
    const category = snapshot();
    first(category).categoryId = "missing-category";
    expect(ProductRegistryV1Schema.safeParse(category).success).toBe(false);
    const evidence = snapshot();
    first(evidence).platforms.web.verification.evidenceIds = [
      "missing-evidence",
    ];
    expect(ProductRegistryV1Schema.safeParse(evidence).success).toBe(false);
    first(evidence).platforms.web.verification.evidenceIds = ["ios-ui"];
    expect(ProductRegistryV1Schema.safeParse(evidence).success).toBe(false);
  });

  it("rejects duplicate, failed and future verification claims", () => {
    const duplicate = snapshot();
    first(duplicate).platforms.web.verification.evidenceIds = [
      "web-checks",
      "web-checks",
    ];
    expect(ProductRegistryV1Schema.safeParse(duplicate).success).toBe(false);
    const failed = snapshot();
    failed.evidence.find((value) => value.id === "metadata-http")!.outcome =
      "failed";
    expect(ProductRegistryV1Schema.safeParse(failed).success).toBe(false);
    const future = snapshot();
    future.evidence[0].checkedAt = "2026-11-12";
    expect(ProductRegistryV1Schema.safeParse(future).success).toBe(false);
    const absent = snapshot();
    first(absent).platforms.web.implementation.status = "unknown";
    expect(ProductRegistryV1Schema.safeParse(absent).success).toBe(false);
    const blocked = snapshot();
    first(blocked).platforms.web.verification.evidenceIds = ["web-checks"];
    blocked.evidence[0].outcome = "blocked";
    expect(ProductRegistryV1Schema.safeParse(blocked).success).toBe(false);
  });

  it("requires an actual artifact, formal version, release date and channel for a release claim", () => {
    expect(ProductRegistryV1Schema.safeParse(releaseFixture()).success).toBe(
      true,
    );
    for (const key of ["artifact", "version", "releasedAt"] as const) {
      const value = releaseFixture();
      value.distributions.ios[key] = null;
      expect(ProductRegistryV1Schema.safeParse(value).success).toBe(false);
    }
    const channel = releaseFixture();
    channel.distributions.ios.channel = "development";
    expect(ProductRegistryV1Schema.safeParse(channel).success).toBe(false);
    const mismatch = releaseFixture();
    mismatch.distributions.ios.version = "2.0.0";
    expect(ProductRegistryV1Schema.safeParse(mismatch).success).toBe(false);
    const future = releaseFixture();
    future.distributions.ios.releasedAt = "2026-11-12";
    expect(ProductRegistryV1Schema.safeParse(future).success).toBe(false);
  });

  it("does not relabel a private artifact or unknown build as public availability", () => {
    const privateBuild = snapshot();
    privateBuild.distributions.ios.artifact =
      releaseFixture().distributions.ios.artifact;
    expect(ProductRegistryV1Schema.safeParse(privateBuild).success).toBe(false);
    const unknown = snapshot();
    unknown.distributions.windows.version = "0.1.0";
    expect(ProductRegistryV1Schema.safeParse(unknown).success).toBe(false);
    const homepage = releaseFixture();
    homepage.distributions.ios.artifact = {
      kind: "website",
      url: "https://aurelia.lattelix.com/",
    };
    expect(ProductRegistryV1Schema.safeParse(homepage).success).toBe(false);
    const wrongStore = releaseFixture();
    wrongStore.distributions.android = {
      ...wrongStore.distributions.ios,
      artifact: {
        kind: "store",
        url: "https://apps.apple.com/us/app/synthetic-fixture/id1234567890",
      },
    };
    for (const record of wrongStore.evidence)
      if (record.platforms.includes("android")) record.version = "1.2.3";
    expect(ProductRegistryV1Schema.safeParse(wrongStore).success).toBe(false);
  });

  it.each([
    "https://user:password@github.com/lattelix/aurelia-music/releases/download/v1.2.3/app.zip",
    "https://github.com/lattelix/aurelia-music/releases/download/v1.2.3/app.zip?token=synthetic",
    "https://github.com/lattelix/aurelia-music/releases/download/v1.2.3/app.zip#synthetic",
    "https://github.com/lattelix/aurelia-music/releases/download/v1.2.3/dpl_synthetic.zip",
    "https://github.com/lattelix/aurelia-music/releases/download/v1.2.3/.runtime.zip",
    "https://untrusted.invalid/download/app.zip",
    "file:///private/example/app.zip",
  ])(
    "rejects private, credential-bearing or unapproved artifact URL %s",
    (url) => {
      const value = releaseFixture();
      value.distributions.ios.artifact = { kind: "installer", url };
      expect(ProductRegistryV1Schema.safeParse(value).success).toBe(false);
    },
  );

  it("rejects extra projection fields rather than stripping private data silently", () => {
    const value = snapshot();
    expect(
      ProductRegistryV1Schema.safeParse({ ...value, deploymentId: "synthetic" })
        .success,
    ).toBe(false);
    expect(
      ProductRegistryV1Schema.safeParse({
        ...value,
        source: { ...value.source, repositoryPath: "private" },
      }).success,
    ).toBe(false);
    expect(
      ProductRegistryV1Schema.safeParse({
        ...value,
        features: [{ ...first(value), deviceId: "synthetic" }],
      }).success,
    ).toBe(false);
    expect(
      ProductRegistryV1Schema.safeParse({
        ...value,
        evidence: [
          {
            ...value.evidence[0],
            url: "https://untrusted.invalid/private-log",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ProductRegistryV1Schema.safeParse({
        ...value,
        services: {
          ...value.services,
          funding: { status: "not-connected", collected: 0 },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    "A private path at /Users/example/project is not public evidence.",
    "A receipt in .runtime must not become public evidence.",
    "An internal deployment dpl_synthetic must not become public evidence.",
    "Contact listener@example.test for a synthetic report.",
    "Account 11111111-1111-4111-8111-111111111111 is synthetic.",
    "Authorization: Bearer synthetic-private-value",
  ])("rejects private-shaped free text %s", (scope) => {
    const value = snapshot();
    value.evidence[0].scope = scope;
    expect(ProductRegistryV1Schema.safeParse(value).success).toBe(false);
  });

  it("keeps unestimated ideas read-only and funding disconnected while three proposals have bounded assessments", () => {
    expect(productRegistryV1.services.funding).toEqual({
      status: "not-connected",
    });
    for (const value of productRegistryV1.features) {
      if (value.assessment.status === "unestimated")
        expect(value.voting.enabled).toBe(false);
      expect(canVote(productRegistryV1, value.id)).toBe(
        value.assessment.status === "reviewed",
      );
    }
    expect(
      productRegistryV1.features
        .filter((item) => item.assessment.status === "reviewed")
        .map((item) => item.id),
    ).toEqual([
      "appearance-account-sync",
      "listening-rooms",
      "app-store-distribution",
    ]);
    const connected = snapshot();
    connected.services.voting = "connected";
    for (const item of connected.features)
      expect(canVote(connected, item.id)).toBe(
        item.assessment.status === "reviewed",
      );
    first(connected).voting.enabled = true;
    expect(ProductRegistryV1Schema.safeParse(connected).success).toBe(false);
  });

  it("requires reviewed effort, running cash and maintenance before voting eligibility", () => {
    const value = snapshot();
    value.services.voting = "not-connected";
    first(value).assessment = reviewedFeature();
    first(value).voting.enabled = true;
    expect(canVote(ProductRegistryV1Schema.parse(value), first(value).id)).toBe(
      false,
    );
    value.services.voting = "connected";
    expect(canVote(ProductRegistryV1Schema.parse(value), first(value).id)).toBe(
      true,
    );
    const reviewed = first(value).assessment;
    if (reviewed.status !== "reviewed")
      throw new Error("Expected reviewed fixture");
    reviewed.runningCash.risks = "0";
    expect(ProductRegistryV1Schema.safeParse(value).success).toBe(false);
    reviewed.runningCash.risks =
      "An external provider may introduce ongoing usage charges.";
    reviewed.reviewedAt = "2026-11-12";
    expect(ProductRegistryV1Schema.safeParse(value).success).toBe(false);
    const noMaintenance = {
      ...reviewed,
      reviewedAt: "2026-11-10",
      maintenance: { assessment: "unestimated" },
    };
    expect(
      ProductRegistryV1Schema.safeParse({
        ...value,
        features: [{ ...first(value), assessment: noMaintenance }],
      }).success,
    ).toBe(false);
  });

  it("keeps money separate from the one-account one-vote policy", () => {
    const value = snapshot();
    expect(
      ProductRegistryV1Schema.safeParse({
        ...value,
        services: { ...value.services, donationsAffectVotes: true },
      }).success,
    ).toBe(false);
    expect(
      ProductRegistryV1Schema.safeParse({
        ...value,
        services: { ...value.services, votingRule: "funding-weighted" },
      }).success,
    ).toBe(false);
  });
});
