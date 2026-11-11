import { appHref } from "../../apps/web/src/lib/app-navigation";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Account, Library } from "@aurelia/core";
import { continueWithEmail } from "./auth-helpers";

// Synthetic API responses only. A service worker must not bypass these routes.
// DOM autofill semantics are checked here; an actual Bitwarden extension is not.
test.use({ serviceWorkers: "block" });

const account: Account = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Auth flow fixture",
  email: "listener@example.test",
  identities: ["local"],
};
const password = "synthetic-only-passphrase";
const library: Library = {
  likes: [],
  playlists: [],
  history: [],
  followedArtists: [],
  searches: [],
  queue: null,
};
interface AuthRequest {
  path: string;
  method: string;
  body: Record<string, unknown>;
}
interface AuthReply {
  status?: number;
  json: Record<string, unknown>;
}

async function syntheticAuth(
  page: Page,
  respond: (request: AuthRequest) => AuthReply | Promise<AuthReply>,
) {
  let user: Account | null = null;
  const requests: AuthRequest[] = [];
  const settled: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\//, "");
    if (path === "bootstrap") {
      await route.fulfill({
        json: {
          user,
          library: user ? library : null,
          catalogue: [],
          albums: [],
          artists: [],
          editorialPlaylists: [],
          recommendations: [],
          capabilities: {
            localAccounts: true,
            google: true,
            telegram: true,
            apple: true,
            youtube: false,
          },
        },
      });
      return;
    }
    if (
      request.method() === "POST" &&
      ["auth/email", "auth/login", "auth/register", "auth/email-code"].includes(
        path,
      )
    ) {
      const captured: AuthRequest = {
        path,
        method: request.method(),
        body: request.postData() ? request.postDataJSON() : {},
      };
      requests.push(captured);
      const reply = await respond(captured);
      if (reply.json.user) user = reply.json.user as Account;
      await route.fulfill(reply);
      settled.push(path);
      return;
    }
    await route.fulfill({
      status: 503,
      json: { error: "Unavailable in synthetic auth QA" },
    });
  });
  return { requests, settled };
}

async function openAuth(page: Page) {
  await page.goto(appHref("/"));
  const trigger = page.getByRole("button", { name: "Sign in", exact: true });
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(/\S/);
  return dialog;
}

async function expectCredentialForm(
  dialog: Locator,
  mode: "password" | "register",
  email: string,
) {
  const username = dialog.getByLabel("Email", { exact: true });
  const secret = dialog.getByLabel("Password", { exact: true });
  await expect(username).toHaveAttribute("id", "auth-email");
  await expect(username).toHaveAttribute("name", "email");
  await expect(username).toHaveAttribute("type", "email");
  await expect(username).toHaveAttribute("autocomplete", "username");
  await expect(username).toHaveValue(email);
  await expect(secret).toHaveAttribute("id", "auth-password");
  await expect(secret).toHaveAttribute("name", "password");
  await expect(secret).toHaveAttribute("type", "password");
  await expect(secret).toHaveAttribute(
    "autocomplete",
    mode === "password" ? "current-password" : "new-password",
  );
  // Include hidden inputs: a decoy password field can mislead autofill too.
  await expect(dialog.locator('input[type="password"]')).toHaveCount(1);
  await expect(dialog.locator('input[autocomplete="username"]')).toHaveCount(1);
  await expect(dialog.locator("#auth-email")).toHaveCount(1);
  await expect(dialog.locator("#auth-password")).toHaveCount(1);
  expect(
    await secret.evaluate((input) => {
      const form = input.closest("form");
      const email = form?.querySelector<HTMLInputElement>("#auth-email");
      return !!form && !!email && email.form === form;
    }),
  ).toBe(true);
  await expect(
    dialog.getByRole("button", {
      name: mode === "password" ? "Sign in" : "Create account",
      exact: true,
    }),
  ).toHaveAttribute("type", "submit");
}

test("email-first sign-in offers providers and submits one real username/password form by keyboard", async ({
  page,
}) => {
  const fixture = await syntheticAuth(page, ({ path }) => ({
    json: path === "auth/email" ? { step: "password" } : { user: account },
  }));
  const dialog = await openAuth(page);
  for (const provider of ["Google", "Telegram", "Apple"]) {
    await expect(
      dialog.getByRole("link", {
        name: `Continue with ${provider}`,
        exact: true,
      }),
    ).toHaveAttribute(
      "href",
      new RegExp(`^/api/auth/${provider.toLowerCase()}/start\\?`),
    );
  }
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  await expect(dialog.getByLabel("Your name", { exact: true })).toHaveCount(0);
  const email = dialog.getByLabel("Email", { exact: true });
  await expect(email).toHaveAttribute("id", "auth-email");
  await expect(email).toHaveAttribute("name", "email");
  await expect(email).toHaveAttribute("type", "email");
  await expect(email).toHaveAttribute("autocomplete", "username");
  await email.fill(account.email!);
  await email.press("Enter");
  await expectCredentialForm(dialog, "password", account.email!);
  await expect(dialog.getByLabel("Your name", { exact: true })).toHaveCount(0);
  await dialog.getByLabel("Password", { exact: true }).fill(password);
  await dialog.getByLabel("Password", { exact: true }).press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Your account", exact: true }),
  ).toBeVisible();
  expect(fixture.requests).toEqual([
    { path: "auth/email", method: "POST", body: { email: account.email } },
    {
      path: "auth/login",
      method: "POST",
      body: { email: account.email, password },
    },
  ]);
});

test("new email discovers registration with a named username and new-password in the same form", async ({
  page,
}) => {
  const fixture = await syntheticAuth(page, ({ path }) => ({
    json: path === "auth/email" ? { step: "register" } : { user: account },
  }));
  await openAuth(page);
  const dialog = await continueWithEmail(page, account.email!);
  await expectCredentialForm(dialog, "register", account.email!);
  const name = dialog.getByLabel("Your name", { exact: true });
  await expect(name).toHaveAttribute("id", "auth-name");
  await expect(name).toHaveAttribute("name", "name");
  await expect(name).toHaveAttribute("autocomplete", "name");
  await name.fill(account.name);
  await dialog.getByLabel("Password", { exact: true }).fill(password);
  await dialog.getByLabel("Password", { exact: true }).press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(fixture.requests.at(-1)).toEqual({
    path: "auth/register",
    method: "POST",
    body: { name: account.name, email: account.email, password },
  });
});

test("email-code challenge requires six digits and verifies the captured challenge without a password decoy", async ({
  page,
}) => {
  const fixture = await syntheticAuth(page, ({ path }) => ({
    json:
      path === "auth/email"
        ? { step: "password" }
        : path === "auth/login"
          ? {
              status: "challenge",
              challengeId: "synthetic-email-challenge",
              expiresIn: 600,
              resendAfter: 30,
            }
          : { user: account },
  }));
  await openAuth(page);
  const dialog = await continueWithEmail(page, account.email!);
  await dialog.getByLabel("Password", { exact: true }).fill(password);
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  const code = dialog.getByLabel("Email code", { exact: true });
  await expect(code).toBeVisible();
  await expect(code).toHaveAttribute("id", "auth-email-code");
  await expect(code).toHaveAttribute("name", "code");
  await expect(code).toHaveAttribute("autocomplete", "one-time-code");
  await expect(code).toHaveAttribute("inputmode", "numeric");
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Verify code", exact: true }),
  ).toHaveAttribute("type", "submit");
  await code.fill("12345");
  expect(
    await code.evaluate((input: HTMLInputElement) => input.checkValidity()),
  ).toBe(false);
  await code.press("Enter");
  expect(
    fixture.requests.filter(({ path }) => path === "auth/email-code"),
  ).toHaveLength(0);
  await code.fill("12ab34");
  expect(
    await code.evaluate((input: HTMLInputElement) => input.checkValidity()),
  ).toBe(false);
  await code.press("Enter");
  expect(
    fixture.requests.filter(({ path }) => path === "auth/email-code"),
  ).toHaveLength(0);
  await code.fill("123456");
  await code.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(fixture.requests.at(-1)).toEqual({
    path: "auth/email-code",
    method: "POST",
    body: { challengeId: "synthetic-email-challenge", code: "123456" },
  });
});

test("late email discovery A cannot replace the edited email B password step", async ({
  page,
}) => {
  let releaseA: (() => void) | undefined;
  const emailA = "discovery-a@example.test";
  const emailB = "discovery-b@example.test";
  const fixture = await syntheticAuth(page, ({ path, body }) => {
    if (path === "auth/email" && body.email === emailA)
      return new Promise<AuthReply>((resolve) => {
        releaseA = () => resolve({ json: { step: "register" } });
      });
    return {
      json: path === "auth/email" ? { step: "password" } : { user: account },
    };
  });
  try {
    const dialog = await openAuth(page);
    const email = dialog.getByLabel("Email", { exact: true });
    await email.fill(emailA);
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.poll(() => !!releaseA).toBe(true);
    await email.fill(emailB);
    await expect(
      dialog.getByRole("button", { name: "Continue", exact: true }),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expectCredentialForm(dialog, "password", emailB);
    await dialog.getByLabel("Password", { exact: true }).fill(password);
    releaseA!();
    releaseA = undefined;
    await expect
      .poll(
        () => fixture.settled.filter((path) => path === "auth/email").length,
      )
      .toBe(2);
    // Allow the late fetch continuation to render before assessing its effect.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expectCredentialForm(dialog, "password", emailB);
    await expect(dialog.getByLabel("Password", { exact: true })).toHaveValue(
      password,
    );
    await expect(dialog.getByLabel("Your name", { exact: true })).toHaveCount(
      0,
    );
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(fixture.requests.at(-1)?.body).toEqual({ email: emailB, password });
  } finally {
    releaseA?.();
  }
});

for (const step of ["password", "register"] as const) {
  test(`email-first ${step} form remains usable in a short mobile viewport`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 320 });
    await syntheticAuth(page, ({ path }) => ({
      json: path === "auth/email" ? { step } : { user: account },
    }));
    const dialog = await openAuth(page);
    await continueWithEmail(page, account.email!);
    await expectCredentialForm(dialog, step, account.email!);
    if (step === "register")
      await dialog.getByLabel("Your name", { exact: true }).fill(account.name);
    await dialog.getByLabel("Password", { exact: true }).fill(password);
    const submit = dialog.getByRole("button", {
      name: step === "password" ? "Sign in" : "Create account",
      exact: true,
    });
    await submit.scrollIntoViewIfNeeded();
    const bounds = await dialog.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(320);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await submit.click();
    await expect(dialog).toHaveCount(0);
  });
}

test("Escape closes the email-first dialog and restores keyboard focus without an auth request", async ({
  page,
}) => {
  const fixture = await syntheticAuth(page, () => ({
    json: { step: "password" },
  }));
  const dialog = await openAuth(page);
  await dialog.getByLabel("Email", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeFocused();
  expect(fixture.requests).toHaveLength(0);
});
