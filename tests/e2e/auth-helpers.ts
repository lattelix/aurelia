import { expect, type Page } from "@playwright/test";

/** The auth dialog is already open; use the same email-first flow as a listener. */
export async function continueWithEmail(page: Page, email: string) {
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email", { exact: true }).fill(email);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  return dialog;
}

export async function prepareEmailRegistration(
  page: Page,
  account: { name: string; email: string; password: string },
) {
  const dialog = await continueWithEmail(page, account.email);
  await dialog.getByLabel("Your name", { exact: true }).fill(account.name);
  await dialog.getByLabel("Password", { exact: true }).fill(account.password);
  return dialog;
}

export async function registerWithEmail(
  page: Page,
  account: { name: string; email: string; password: string },
) {
  const dialog = await prepareEmailRegistration(page, account);
  await dialog
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
}

export async function signInWithEmail(
  page: Page,
  account: { email: string; password: string },
) {
  const dialog = await continueWithEmail(page, account.email);
  await dialog.getByLabel("Password", { exact: true }).fill(account.password);
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
