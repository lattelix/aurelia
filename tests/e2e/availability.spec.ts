import { appHref } from "../../apps/web/src/lib/app-navigation";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { outageProxy } from "./outage-proxy";
import { prepareEmailRegistration } from "./auth-helpers";

test("registration explains a lost connection and succeeds when retried", async ({
  page,
}) => {
  const proxy = await outageProxy(
    process.env.E2E_BASE_URL ?? "http://localhost:3000",
    { forwardOwnOrigin: true },
  );
  try {
    const bootstrap = page.waitForResponse("**/api/bootstrap");
    await page.goto(new URL(appHref("/"), proxy.origin).href);
    await bootstrap;
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await prepareEmailRegistration(page, {
      name: "Availability QA",
      email: `availability-${randomUUID()}@example.test`,
      password: randomUUID(),
    });
    // A real origin outage also works when WebKit bypasses route interception for SW requests.
    await proxy.stop();
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(
      "Cannot reach Aurelia. Check your connection and try again.",
    );
    await proxy.restart();
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Your account", exact: true }),
    ).toBeVisible();
    const accountId = (
      await (await page.request.get(`${proxy.origin}/api/bootstrap`)).json()
    ).user.id;
    const result = await page.request.delete(
      `${proxy.origin}/api/auth/account`,
      {
        headers: { Origin: proxy.origin, "X-Aurelia-Account": accountId },
      },
    );
    expect(result.status()).toBe(200);
  } finally {
    await proxy.stop();
  }
});
