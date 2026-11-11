import { test, expect, type APIRequestContext } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const origin = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/** Disposable local accounts only. No provider credentials or audio transport. */
test("browser approval creates a separate native session sharing only its owner's library", async ({ playwright }) => {
  test.setTimeout(60000);
  const browserA = await playwright.request.newContext({ baseURL: origin });
  const browserB = await playwright.request.newContext({ baseURL: origin });
  const device = await playwright.request.newContext({ baseURL: origin });
  const accounts: { client: APIRequestContext; id: string }[] = [];
  let nativeToken: string | undefined;
  async function register(client: APIRequestContext, name: string) {
    const response = await client.post("/api/auth/register", {
      headers: { Origin: origin },
      data: { name, email: `device-${randomUUID()}@example.test`, password: randomUUID() },
    });
    expect(response.status()).toBe(200);
    const id = (await response.json()).user.id as string;
    accounts.push({ client, id });
    return id;
  }
  try {
    const idA = await register(browserA, "Native profile A");
    const idB = await register(browserB, "Native profile B");
    const ownerA = { Origin: origin, "X-Aurelia-Account": idA };
    const ownerB = { Origin: origin, "X-Aurelia-Account": idB };
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    // A browser cookie does not approve or select a user for the public grant.
    const started = await browserB.post("/api/auth/device/start", {
      data: { codeChallenge: challenge, deviceName: "Disposable native QA" },
    });
    expect(started.status()).toBe(200);
    const grant = await started.json();
    expect(grant.verificationUri).toBe(`${origin}/account?connect=${grant.userCode}`);
    expect((await device.post("/api/auth/device/token", {
      data: { deviceCode: grant.deviceCode, codeVerifier: verifier },
    })).status()).toBe(200);
    expect((await browserA.get(`/api/auth/device/grant?userCode=${grant.userCode}`, {
      headers: { "X-Aurelia-Account": idB },
    })).status()).toBe(409);
    expect((await browserA.post("/api/auth/device/approve", {
      headers: ownerA, data: { userCode: grant.userCode },
    })).status()).toBe(200);
    // Poll only after the server's minimum interval, never busy-spin.
    await new Promise((resolve) => setTimeout(resolve, (grant.interval + 0.1) * 1000));
    const redeemed = await device.post("/api/auth/device/token", {
      data: { deviceCode: grant.deviceCode, codeVerifier: verifier },
    });
    expect(redeemed.status()).toBe(200);
    const approved = await redeemed.json();
    expect(approved).toMatchObject({ status: "approved", user: { id: idA } });
    nativeToken = approved.token;
    const nativeA = { Authorization: `Bearer ${nativeToken}`, "X-Aurelia-Account": idA };
    expect((await browserB.get("/api/auth/me", { headers: nativeA }).then((r) => r.json())).user.id).toBe(idA);
    expect((await browserA.post("/api/library/likes", {
      headers: ownerA, data: { trackId: "studio:afterglow-1", liked: true },
    })).status()).toBe(200);
    const synced = await device.get("/api/library", { headers: nativeA });
    expect(synced.status()).toBe(200);
    expect((await synced.json()).likes.map((track: { id: string }) => track.id)).toContain("studio:afterglow-1");
    expect((await device.post("/api/library/playlists", {
      headers: nativeA, data: { name: "Shared native QA" },
    })).status()).toBe(201);
    expect((await browserA.get("/api/library", { headers: ownerA }).then((r) => r.json())).playlists.some(
      (item: { name: string }) => item.name === "Shared native QA",
    )).toBe(true);
    expect((await browserB.get("/api/library", { headers: ownerB }).then((r) => r.json())).playlists).toHaveLength(0);
    expect((await browserB.get("/api/library", { headers: { ...ownerB, Authorization: `Bearer ${nativeToken}` } })).status()).toBe(409);
    expect((await browserB.get("/api/bootstrap", { headers: { Authorization: `Bearer ${"z".repeat(43)}` } })).status()).toBe(401);
    expect((await device.delete("/api/auth/account", { headers: nativeA })).status()).toBe(403);
    expect((await device.post("/api/auth/device/approve", { headers: nativeA, data: { userCode: grant.userCode } })).status()).toBe(403);
    expect((await device.post("/api/auth/device/token", {
      data: { deviceCode: grant.deviceCode, codeVerifier: verifier },
    })).status()).not.toBe(200);
    expect((await device.post("/api/auth/logout", { headers: nativeA })).status()).toBe(200);
    expect((await device.get("/api/bootstrap", { headers: nativeA })).status()).toBe(401);
    nativeToken = undefined;
    expect((await browserA.get("/api/auth/me").then((r) => r.json())).user.id).toBe(idA);
  } finally {
    if (nativeToken) await device.post("/api/auth/logout", { headers: { Authorization: `Bearer ${nativeToken}` } });
    for (const { client, id } of accounts) {
      expect((await client.delete("/api/auth/account", { headers: { Origin: origin, "X-Aurelia-Account": id } })).status()).toBe(200);
    }
    await Promise.all([browserA.dispose(), browserB.dispose(), device.dispose()]);
  }
});

test("the browser shows a comparison code and requires the signed-in user to approve the device", async ({ page, playwright }) => {
  const device = await playwright.request.newContext({ baseURL: origin });
  const registered = await page.request.post("/api/auth/register", {
    headers: { Origin: origin },
    data: { name: "Browser approval QA", email: `approval-${randomUUID()}@example.test`, password: randomUUID() },
  });
  expect(registered.status()).toBe(200);
  const id = (await registered.json()).user.id;
  let nativeToken: string | undefined;
  try {
    const verifier = randomBytes(32).toString("base64url");
    const start = await device.post("/api/auth/device/start", {
      data: { codeChallenge: createHash("sha256").update(verifier).digest("base64url"), deviceName: "Browser confirmation fixture" },
    });
    expect(start.status()).toBe(200);
    const grant = await start.json();
    expect(grant.verificationUri).toBe(`${origin}/account?connect=${grant.userCode}`);
    await page.goto(grant.verificationUri);
    const section = page.getByRole("region", { name: "Connect your app" });
    await expect(section.getByText(grant.userCode, { exact: true })).toBeVisible();
    await expect(section.getByText("Browser confirmation fixture", { exact: true })).toBeVisible();
    const owner = { "X-Aurelia-Account": id };
    expect((await page.request.get(`/api/auth/device/grant?userCode=${grant.userCode}`, { headers: owner }).then((r) => r.json())).status).toBe("pending");
    await section.getByRole("button", { name: "Connect as Browser approval QA", exact: true }).click();
    await expect(section.getByRole("status")).toContainText("Connected");
    const issued = await device.post("/api/auth/device/token", { data: { deviceCode: grant.deviceCode, codeVerifier: verifier } });
    expect(issued.status()).toBe(200);
    const approved = await issued.json();
    expect(approved.status).toBe("approved"); nativeToken = approved.token;
  } finally {
    if (nativeToken) await device.post("/api/auth/logout", { headers: { Authorization: `Bearer ${nativeToken}` } });
    expect((await page.request.delete("/api/auth/account", { headers: { Origin: origin, "X-Aurelia-Account": id } })).status()).toBe(200);
    await device.dispose();
  }
});

test("portable export transfers metadata to a second account without moving identity or replaying duplicates", async ({ playwright }) => {
  const clients = await Promise.all([0, 1].map(() => playwright.request.newContext({ baseURL: origin })));
  const ids: string[] = [];
  const owner = (index: number) => ({ Origin: origin, "X-Aurelia-Account": ids[index] });
  try {
    for (const [index, client] of clients.entries()) {
      const result = await client.post("/api/auth/register", {
        headers: { Origin: origin },
        data: { name: `Portable ${index}`, email: `portable-${randomUUID()}@example.test`, password: randomUUID() },
      });
      expect(result.status()).toBe(200); ids.push((await result.json()).user.id);
    }
    expect((await clients[0].post("/api/library/likes", { headers: owner(0), data: { trackId: "studio:afterglow-1" } })).status()).toBe(200);
    const created = await clients[0].post("/api/library/playlists", { headers: owner(0), data: { name: "Portable example" } });
    expect(created.status()).toBe(201);
    const playlistId = (await created.json()).id;
    expect((await clients[0].post(`/api/library/playlists/${playlistId}/tracks`, { headers: owner(0), data: { trackId: "studio:afterglow-1" } })).status()).toBe(200);
    const exported = await clients[0].get("/api/library/export", { headers: owner(0) });
    expect(exported.status()).toBe(200);
    const file = await exported.json();
    expect(file).toMatchObject({ format: "aurelia-library", version: 1 });
    expect(file.user).toBeUndefined(); expect(file.queue).toBeUndefined();
    const first = await clients[1].post("/api/import/file", { headers: owner(1), data: file });
    expect(first.status()).toBe(200);
    const job = (await first.json()).id;
    const repeated = await clients[1].post("/api/import/file", { headers: owner(1), data: file });
    expect(repeated.status()).toBe(200); expect((await repeated.json()).id).toBe(job);
    const library = await clients[1].get("/api/library", { headers: owner(1) }).then((r) => r.json());
    expect(library.likes.map((entry: { id: string }) => entry.id)).toEqual(["studio:afterglow-1"]);
    expect(library.playlists).toHaveLength(1);
    expect(library.playlists[0].name).toBe("Portable example");
    expect(library.playlists[0].tracks).toHaveLength(1);
    expect(library.playlists[0].id).not.toBe(playlistId);
    expect((await clients[1].get("/api/auth/me").then((r) => r.json())).user.id).toBe(ids[1]);
    expect((await clients[1].get("/api/auth/me").then((r) => r.json())).user.identities).toEqual(["local"]);
  } finally {
    for (const [index, id] of ids.entries()) expect((await clients[index].delete("/api/auth/account", { headers: { Origin: origin, "X-Aurelia-Account": id } })).status()).toBe(200);
    await Promise.all(clients.map((client) => client.dispose()));
  }
});
