import path from "node:path";
import { test, type Browser, type Page } from "@playwright/test";

export type E2ERole = "admin" | "analyst";

export const STATE_DIR = path.join(__dirname, ".auth");
export const statePath = (role: E2ERole) => path.join(STATE_DIR, `${role}.json`);

export function credentials(role: E2ERole): { username: string; password: string } | null {
  const prefix = role === "admin" ? "E2E_ADMIN" : "E2E_ANALYST";
  const username = process.env[`${prefix}_USERNAME`];
  const password = process.env[`${prefix}_PASSWORD`];
  return username && password ? { username, password } : null;
}

/** Skip the current test when the role's test user is not configured. */
export function requireRole(role: E2ERole) {
  test.skip(!credentials(role), `E2E_${role.toUpperCase()}_USERNAME / _PASSWORD not set`);
}

export async function pageAs(browser: Browser, role: E2ERole): Promise<Page> {
  const context = await browser.newContext({ storageState: statePath(role) });
  return context.newPage();
}

/** Navigate and wait until the page is idle, so React has hydrated before the test interacts. */
export async function gotoReady(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

/** Sign in through the Cognito Hosted UI (classic or managed login). */
export async function signInViaHostedUi(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByRole("button", { name: /sign in with cognito/i }).click();
  await page.waitForURL((url) => !url.toString().startsWith(process.env.E2E_BASE_URL ?? "http://localhost:3000"));
  const user = page.locator('input[name="username"]:visible, input[type="email"]:visible').first();
  await user.fill(username);
  const pass = page.locator('input[name="password"]:visible, input[type="password"]:visible').first();
  if (!(await pass.isVisible().catch(() => false))) {
    // Managed login asks for the username first.
    await page.getByRole("button", { name: /next|continue/i }).first().click();
  }
  await pass.fill(password);
  await page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
  await page.waitForURL(/\/playground/);
}
