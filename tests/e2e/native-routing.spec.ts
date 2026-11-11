import { appHref } from "../../apps/web/src/lib/app-navigation";
import { test, expect, type Page } from "@playwright/test";

// Bridge fixtures verify JS routing/serialization only, never real device audio support.
for (const platform of ["ios", "android"]) {
  test(`${platform} missing device audio never uses web media or iframe`, async ({
    page,
  }) => {
    const media: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/(stream|audio)|youtube\.com\/iframe_api/.test(request.url()))
        media.push(request.url());
    });
    await page.addInitScript((platform) => {
      Reflect.set(window, "CapacitorCustomPlatform", { name: platform });
      localStorage.setItem(
        "aurelia.player.guest",
        JSON.stringify({
          queue: [
            {
              id: "youtube:jfKfPfyJRdk",
              externalId: "jfKfPfyJRdk",
              provider: "youtube",
              title: "Device routing fixture",
              artist: "Aurelia QA",
              artistId: "qa",
              album: "Routing",
              albumId: "qa",
              duration: 72,
              artwork: "/art/afterglow.svg",
              genre: "",
              year: 2026,
            },
          ],
          index: 0,
          position: 0,
          duration: 72,
          playing: false,
          shuffle: false,
          repeat: "off",
          volume: 0.75,
          autoplay: false,
        }),
      );
    }, platform);
    await page.goto(appHref("/"));
    await expect(page.locator(".playing-text strong")).toHaveText(
      "Device routing fixture",
    );
    await page
      .getByRole("button", { name: "Open now playing", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "native audio update is required",
    );
    await expect(
      page.getByRole("link", { name: "Watch on YouTube", exact: true }).last(),
    ).toHaveAttribute("href", "https://www.youtube.com/watch?v=jfKfPfyJRdk");
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(media).toEqual([]);
  });
}

test("iOS device queue receives IDs without media URLs and owns progress", async ({
  page,
}) => {
  const media: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(stream|audio)/.test(request.url())) media.push(request.url());
  });
  await page.addInitScript(() => {
    Reflect.set(window, "CapacitorCustomPlatform", { name: "ios" });
    const callbacks = new Map<string, (value: unknown) => void>();
    let snapshot: Record<string, unknown> = {
      apiVersion: 1,
      transport: "device",
      ownerId: null,
      revision: "",
      sequence: 0,
      index: null,
      entryId: null,
      trackId: null,
      position: 0,
      duration: 0,
      status: "idle",
      playing: false,
      repeat: "off",
      shuffle: false,
      volume: 0.75,
      error: null,
      queue: [],
    };
    Reflect.set(window, "Capacitor", {
      PluginHeaders: [
        {
          name: "AureliaDeviceAudio",
          methods: [
            ...[
              "capabilities",
              "getSnapshot",
              "loadQueue",
              "play",
              "pause",
              "seek",
              "stop",
              "setRepeat",
              "setShuffle",
              "setVolume",
              "removeListener",
            ].map((name) => ({ name, rtype: "promise" })),
            { name: "addListener", rtype: "callback" },
          ],
        },
      ],
      nativeCallback(
        _plugin: string,
        method: string,
        options: { eventName: string },
        callback: (value: unknown) => void,
      ) {
        if (method === "addListener")
          callbacks.set(options.eventName, callback);
        return options.eventName;
      },
      nativePromise(
        _plugin: string,
        method: string,
        options: Record<string, unknown> = {},
      ) {
        if (method === "capabilities")
          return Promise.resolve({
            apiVersion: 1,
            transport: "device",
            nativeQueue: true,
            available: true,
            supportedProviders: ["youtube"],
          });
        if (method === "loadQueue") {
          document.body.dataset.nativeQueue = JSON.stringify(options);
          const tracks = options.tracks as {
            entryId: string;
            trackId: string;
          }[];
          const entry = tracks[options.index as number];
          snapshot = {
            ...snapshot,
            ...options,
            queue: tracks,
            sequence: 1,
            entryId: entry.entryId,
            trackId: entry.trackId,
            duration: 72,
            status: "paused",
            error: null,
          };
        }
        if (method === "play") {
          snapshot = {
            ...snapshot,
            sequence: Number(snapshot.sequence) + 1,
            status: "playing",
            playing: true,
            position: 2,
          };
          callbacks.get("snapshot")?.(snapshot);
        }
        return Promise.resolve(snapshot);
      },
    });
    localStorage.setItem(
      "aurelia.player.guest",
      JSON.stringify({
        queue: [
          {
            id: "youtube:jfKfPfyJRdk",
            externalId: "jfKfPfyJRdk",
            provider: "youtube",
            title: "Device routing fixture",
            artist: "Aurelia QA",
            artistId: "qa",
            album: "Routing",
            albumId: "qa",
            duration: 72,
            artwork: "/art/afterglow.svg",
            genre: "",
            year: 2026,
          },
        ],
        index: 0,
        position: 0,
        duration: 72,
        playing: false,
        shuffle: false,
        repeat: "off",
        volume: 0.75,
        autoplay: false,
      }),
    );
  });
  await page.goto(appHref("/"));
  await expect(page.locator("body")).toHaveAttribute(
    "data-native-queue",
    /youtube/,
  );
  const payload = JSON.parse(
    (await page.locator("body").getAttribute("data-native-queue"))!,
  );
  expect(payload.tracks[0]).toMatchObject({
    trackId: "youtube:jfKfPfyJRdk",
    externalId: "jfKfPfyJRdk",
  });
  expect(JSON.stringify(payload)).not.toMatch(/https?:|url|token|cookie/i);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expect(
    page.getByRole("slider", { name: "Seek", exact: true }),
  ).toHaveValue("2");
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(media).toEqual([]);
});

async function installAndroidFixture(
  page: Page,
  kind: "studio" | "youtube" | "mixed",
) {
  const media: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(stream|audio)|youtube\.com\/iframe_api/.test(request.url()))
      media.push(request.url());
  });
  await page.addInitScript((kind) => {
    Reflect.set(window, "CapacitorCustomPlatform", { name: "android" });
    let callback: (value: unknown) => void = () => {};
    let snapshot: Record<string, unknown> = {
      apiVersion: 1,
      transport: "device",
      ownerId: null,
      revision: "",
      sequence: 0,
      index: null,
      entryId: null,
      trackId: null,
      position: 0,
      duration: 0,
      status: "idle",
      playing: false,
      repeat: "off",
      shuffle: false,
      volume: 0.75,
      error: null,
      queue: [],
    };
    let previous = snapshot;
    let loads = 0;
    let capabilities = 0;
    const publish = (change: Record<string, unknown>) => {
      snapshot = {
        ...snapshot,
        ...change,
        sequence: Number(snapshot.sequence) + 1,
      };
      callback(snapshot);
    };
    Reflect.set(window, "aureliaDeviceFixture", {
      next() {
        const queue = snapshot.queue as { entryId: string; trackId: string }[];
        const next = queue[1];
        publish({
          index: 1,
          entryId: next.entryId,
          trackId: next.trackId,
          position: 4,
          status: "playing",
          playing: true,
        });
      },
      stale() {
        callback({
          ...previous,
          sequence: Number(snapshot.sequence) + 100,
          position: 61,
        });
      },
      foreign() {
        callback({
          ...snapshot,
          ownerId: "another-account",
          sequence: Number(snapshot.sequence) + 100,
          position: 61,
        });
      },
    });
    Reflect.set(window, "Capacitor", {
      PluginHeaders: [
        {
          name: "AureliaDeviceAudio",
          methods: [
            ...[
              "capabilities",
              "getSnapshot",
              "loadQueue",
              "play",
              "pause",
              "seek",
              "stop",
              "setRepeat",
              "setShuffle",
              "setVolume",
              "removeListener",
            ].map((name) => ({ name, rtype: "promise" })),
            { name: "addListener", rtype: "callback" },
          ],
        },
      ],
      nativeCallback(
        _plugin: string,
        method: string,
        options: { eventName: string },
        listener: (value: unknown) => void,
      ) {
        if (method === "addListener") callback = listener;
        return options.eventName;
      },
      nativePromise(
        _plugin: string,
        method: string,
        options: Record<string, unknown> = {},
      ) {
        if (method === "capabilities") {
          document.body.dataset.nativeCapabilities = String(++capabilities);
          return Promise.resolve({
            apiVersion: 1,
            transport: "device",
            nativeQueue: true,
            available: true,
            supportedProviders: ["studio"],
            reason: null,
            providerReasons: { youtube: "source-unverified" },
            coverage: "bundled-studio-only",
          });
        }
        if (method === "loadQueue") {
          document.body.dataset.nativeQueue = JSON.stringify(options);
          document.body.dataset.nativeLoads = String(++loads);
          const queue = options.tracks as {
            entryId: string;
            trackId: string;
          }[];
          const entry = queue[Number(options.index)];
          snapshot = {
            ...snapshot,
            ...options,
            queue,
            entryId: entry.entryId,
            trackId: entry.trackId,
            duration: 72,
            sequence: Number(snapshot.sequence) + 1,
            status: options.playing ? "playing" : "paused",
            error: null,
          };
          previous = snapshot;
        }
        if (method === "play")
          publish({ playing: true, status: "playing", position: 2 });
        if (method === "pause") publish({ playing: false, status: "paused" });
        if (method === "seek") publish({ position: options.position });
        if (method === "setRepeat") publish({ repeat: options.mode });
        if (method === "setShuffle") publish({ shuffle: options.enabled });
        if (method === "setVolume") publish({ volume: options.value });
        if (method === "stop") {
          document.body.dataset.nativeStopped = String(options.revision);
          snapshot = {
            ...snapshot,
            ownerId: null,
            revision: "",
            queue: [],
            index: null,
            entryId: null,
            trackId: null,
            position: 0,
            duration: 0,
            playing: false,
            status: "idle",
            sequence: Number(snapshot.sequence) + 1,
          };
        }
        if (method === "removeListener")
          document.body.dataset.nativeRemoved = "true";
        return Promise.resolve(snapshot);
      },
    });
    const base = {
      artist: "Aurelia QA",
      artistId: "qa",
      album: "Routing",
      albumId: "afterglow",
      duration: 72,
      artwork: "/art/afterglow.svg",
      genre: "",
      year: 2026,
    };
    const studio = [1, 2].map((id) => ({
      ...base,
      provider: "studio",
      externalId: String(id),
      id: `studio:afterglow-${id}`,
      title: `Studio routing fixture ${id}`,
    }));
    const youtube = {
      ...base,
      provider: "youtube",
      externalId: "jfKfPfyJRdk",
      id: "youtube:jfKfPfyJRdk",
      title: "Unverified routing fixture",
    };
    localStorage.setItem(
      "aurelia.player.guest",
      JSON.stringify({
        queue:
          kind === "youtube"
            ? [youtube]
            : kind === "mixed"
              ? [studio[0], youtube]
              : studio,
        index: 0,
        position: 0,
        duration: 72,
        playing: false,
        shuffle: false,
        repeat: "off",
        volume: 0.75,
        autoplay: false,
      }),
    );
  }, kind);
  return media;
}

test("Android Studio sends only bundled IDs and follows native next while ignoring stale ownership", async ({
  page,
}) => {
  const media = await installAndroidFixture(page, "studio");
  await page.goto(appHref("/"));
  await expect(page.locator("body")).toHaveAttribute("data-native-loads", "1");
  const payload = JSON.parse(
    (await page.locator("body").getAttribute("data-native-queue"))!,
  );
  expect(
    payload.tracks.map((track: { provider: string; externalId: string }) => [
      track.provider,
      track.externalId,
    ]),
  ).toEqual([
    ["studio", "1"],
    ["studio", "2"],
  ]);
  for (const track of payload.tracks)
    expect(Object.keys(track).sort()).toEqual([
      "artist",
      "entryId",
      "externalId",
      "provider",
      "title",
      "trackId",
    ]);
  expect(JSON.stringify(payload)).not.toMatch(/https?:|url|token|cookie/i);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expect(
    page.getByRole("slider", { name: "Seek", exact: true }),
  ).toHaveValue("2");
  await page.evaluate(() => Reflect.get(window, "aureliaDeviceFixture").next());
  await expect(page.locator(".playing-text strong")).toHaveText(
    "Studio routing fixture 2",
  );
  await expect(
    page.getByRole("slider", { name: "Seek", exact: true }),
  ).toHaveValue("4");
  await expect(page.locator("body")).toHaveAttribute("data-native-loads", "1");
  await page.evaluate(() =>
    Reflect.get(window, "aureliaDeviceFixture").foreign(),
  );
  await expect(
    page.getByRole("slider", { name: "Seek", exact: true }),
  ).toHaveValue("4");
  await page.getByRole("link", { name: "Open queue", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Remove Studio routing fixture 1 from queue",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: "Remove Studio routing fixture 2 from queue",
      exact: true,
    })
    .click();
  await expect(page.locator(".queue-row")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute(
    "data-native-stopped",
    /.+/,
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-native-removed",
    "true",
  );
  await page.evaluate(() =>
    Reflect.get(window, "aureliaDeviceFixture").stale(),
  );
  await expect(page.locator(".queue-row")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(media).toEqual([]);
});

for (const kind of ["youtube", "mixed"] as const) {
  test(`Android rejects ${kind} queue as source-unverified and later loads Studio without a web fallback`, async ({
    page,
  }) => {
    const media = await installAndroidFixture(page, kind);
    await page.goto(appHref("/"));
    await expect(page.locator("body")).toHaveAttribute(
      "data-native-capabilities",
      "1",
    );
    await page
      .getByRole("button", { name: "Open now playing", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "native audio source has not been verified",
    );
    await expect(page.locator("body")).not.toHaveAttribute(
      "data-native-loads",
      /.+/,
    );
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Play golden hour", exact: true })
      .first()
      .click();
    await expect(page.locator("body")).toHaveAttribute(
      "data-native-loads",
      "1",
    );
    await expect(page.locator("body")).toHaveAttribute(
      "data-native-capabilities",
      "1",
    );
    const payload = JSON.parse(
      (await page.locator("body").getAttribute("data-native-queue"))!,
    );
    expect(
      payload.tracks.every(
        (track: { provider: string }) => track.provider === "studio",
      ),
    ).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/https?:|url|token|cookie/i);
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(media).toEqual([]);
  });
}
