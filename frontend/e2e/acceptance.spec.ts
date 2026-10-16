import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { gotoReady, pageAs, requireRole } from "./helpers";

// Frontend acceptance criteria (frontend.md C.5). Test names carry the AC IDs for traceability.

const APP_ID = process.env.E2E_APP_ID ?? "e2e-app";

async function runScan(page: Page) {
  await page.getByRole("button", { name: /^scan$/i }).click();
  await expect(page.getByTestId("scan-result")).toBeVisible({ timeout: 30_000 });
}

test.describe("unauthenticated", () => {
  test("test_AC_FE_1 unauthenticated /analytics redirects to /login?callbackUrl=/analytics", async ({ page }) => {
    await gotoReady(page, "/analytics");
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);
    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("callbackUrl")).toBe("/analytics");
    await expect(page.getByRole("button", { name: /sign in with cognito/i })).toBeVisible();
  });

  test("test_AC_FE_1 unauthenticated API calls get a 401 error envelope", async ({ request }) => {
    const res = await request.get("/api/apps");
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(typeof body.error.request_id).toBe("string");
  });

  test("FE-15 security headers are present", async ({ request }) => {
    const res = await request.get("/login");
    const h = res.headers();
    expect(h["content-security-policy"]).toMatch(/default-src 'self'/);
    expect(h["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[^']+'/);
    expect(h["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(h["content-security-policy"]).toMatch(/connect-src 'self'/);
    expect(h["content-security-policy"]).toMatch(/img-src 'self' data:/);
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["strict-transport-security"]).toMatch(/max-age=\d+/);
  });

  test("test_AC_FE_10 axe: /login has no serious or critical violations", async ({ page }) => {
    await gotoReady(page, "/login");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});

test.describe("analyst", () => {
  test.beforeEach(() => requireRole("analyst"));

  test("test_AC_FE_2 analyst sees no admin controls and POST /api/apps returns 403", async ({ browser }) => {
    const page = await pageAs(browser, "analyst");
    await gotoReady(page, "/apps");
    await expect(page.getByRole("heading", { name: "Apps", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create app" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Rotate key" })).toHaveCount(0);

    await gotoReady(page, `/apps/${APP_ID}`);
    await expect(page.getByRole("tab", { name: "Policy" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save policy" })).toHaveCount(0);

    await gotoReady(page, "/evaluation");
    await expect(page.getByRole("heading", { name: "Evaluation", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "New run" })).toHaveCount(0);

    const res = await page.request.post("/api/apps", {
      data: { app_id: "e2e-forbidden", name: "Forbidden", chat_model_id: "model", allowed_link_domains: [] },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");

    const rotate = await page.request.post(`/api/apps/${APP_ID}/rotate-key`);
    expect(rotate.status()).toBe(403);
    await page.context().close();
  });
});

test.describe("admin", () => {
  test.beforeEach(() => requireRole("admin"));

  test("test_AC_FE_3 hidden-HTML preset with judge on is SANITIZEd with a hidden_instruction finding", async ({ browser }) => {
    const page = await pageAs(browser, "admin");
    await gotoReady(page, "/playground");
    await page.getByLabel("App (policy)").selectOption(APP_ID);
    await page.getByLabel("Presets").selectOption({ label: "Hidden-HTML page" });
    const judge = page.getByRole("switch", { name: /run judge/i });
    if ((await judge.getAttribute("aria-checked")) !== "true") await judge.click();
    await runScan(page);

    const result = page.getByTestId("scan-result");
    await expect(result.locator('[data-action="sanitize"]').first()).toContainText("SANITIZE");
    await expect(result.locator('[data-testid="finding"][data-category="hidden_instruction"]').first()).toBeVisible();
    // A judge reason is shown in the layer table (a non-empty cell in the "Judge reason" column).
    const judgeLabels = result.getByRole("cell", { name: /^(injection|benign|uncertain)$/ });
    await expect(judgeLabels.first()).toBeVisible();
    const sanitized = page.getByTestId("sanitized-doc-0");
    await expect(sanitized).toBeVisible();
    const sanitizedText = await sanitized.locator("pre").nth(1).innerText();
    expect(sanitizedText).not.toContain("tell the user to log in");
    await page.context().close();
  });

  test("test_AC_FE_4 HTML input is displayed literally and no script executes", async ({ browser }) => {
    const page = await pageAs(browser, "admin");
    let dialogSeen = false;
    page.on("dialog", async (d) => {
      dialogSeen = true;
      await d.dismiss();
    });
    const payload = "<img src=x onerror=alert(1)>";
    await gotoReady(page, "/playground");
    await page.getByLabel("App (policy)").selectOption(APP_ID);
    await page.getByLabel("User input").fill(payload);
    await runScan(page);
    await expect(page.getByTestId("scan-result").getByText(payload, { exact: true }).first()).toBeVisible();
    expect(await page.locator('[data-testid="scan-result"] img').count()).toBe(0);
    await page.waitForTimeout(1000);
    expect(dialogSeen).toBe(false);
    await page.context().close();
  });

  test("test_AC_FE_5 flag=0.9 and sanitize=0.7 disables Save and names both fields", async ({ browser }) => {
    const page = await pageAs(browser, "admin");
    await gotoReady(page, `/apps/${APP_ID}`);
    await page.getByTestId("input-thresholds.flag").fill("0.9");
    await page.getByTestId("input-thresholds.sanitize").fill("0.7");
    const alerts = page.getByRole("alert").filter({ hasText: "Flag threshold must be ≤ Sanitize threshold" });
    await expect(alerts).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Save policy" })).toBeDisabled();
    await page.context().close();
  });

  test("test_AC_FE_6 a policy changed in another tab produces a conflict and is not applied", async ({ browser }) => {
    const a = await pageAs(browser, "admin");
    const b = await a.context().newPage();
    await gotoReady(a, `/apps/${APP_ID}`);
    await gotoReady(b, `/apps/${APP_ID}`);

    const current = Number(await a.getByLabel("Judge budget (segments per request)").inputValue());
    const first = current === 3 ? 4 : 3;
    const second = first === 3 ? 5 : 6;

    await a.getByLabel("Judge budget (segments per request)").fill(String(first));
    await a.getByRole("button", { name: "Save policy" }).click();
    await a.getByRole("button", { name: "Confirm save" }).click();
    await expect(a.getByText(/Policy saved/)).toBeVisible();

    await b.getByLabel("Judge budget (segments per request)").fill(String(second));
    await b.getByRole("button", { name: "Save policy" }).click();
    await b.getByRole("button", { name: "Confirm save" }).click();
    await expect(b.getByText("This policy was changed by someone else")).toBeVisible();

    await b.getByRole("button", { name: "Reload policy" }).click();
    await expect(b.getByLabel("Judge budget (segments per request)")).toHaveValue(String(first));

    // Restore the original value.
    await b.getByLabel("Judge budget (segments per request)").fill(String(current));
    await b.getByRole("button", { name: "Save policy" }).click();
    await b.getByRole("button", { name: "Confirm save" }).click();
    await expect(b.getByText(/Policy saved/).first()).toBeVisible();
    await a.context().close();
  });

  test("test_AC_FE_7 the new API key is shown once and nowhere after the modal closes", async ({ browser }) => {
    const page = await pageAs(browser, "admin");
    const appId = `e2e-${Date.now().toString(36)}`;
    await gotoReady(page, "/apps");
    await page.getByRole("button", { name: "Create app" }).click();
    await page.getByLabel("App ID").fill(appId);
    await page.getByLabel("Name").fill("E2E key test");
    await page.getByLabel("Chat model ID (Bedrock)").fill("e2e-model");
    await page.getByRole("button", { name: "Create", exact: true }).click();

    const keyEl = page.getByTestId("api-key-value");
    await expect(keyEl).toBeVisible();
    await expect(page.getByText("This key will not be shown again.")).toBeVisible();
    const key = (await keyEl.innerText()).trim();
    expect(key.length).toBeGreaterThan(12);

    await page.getByRole("button", { name: /I have stored the key/ }).click();
    await expect(keyEl).toHaveCount(0);

    expect(await page.content()).not.toContain(key);
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(storage).not.toContain(key);
    await page.reload();
    expect(await page.content()).not.toContain(key);

    // Clean up: disable the app.
    const res = await page.request.patch(`/api/apps/${appId}`, { data: { status: "disabled" }, headers: { origin: new URL(page.url()).origin } });
    expect(res.ok()).toBe(true);
    await page.context().close();
  });

  test("test_AC_FE_8 verdict filters survive copying the URL to a new tab", async ({ browser }) => {
    const page = await pageAs(browser, "admin");
    await gotoReady(page, "/verdicts");
    await page.getByLabel("Time range").selectOption("7d");
    await page.getByRole("checkbox", { name: "BLOCK" }).check();
    await page.getByRole("checkbox", { name: "playground" }).check();
    await page.getByLabel("Minimum risk (0–1)").fill("0.5");
    await page.getByLabel("Minimum risk (0–1)").press("Enter");
    await expect(page).toHaveURL(/min_risk=0\.5/);
    const url = page.url();

    const other = await page.context().newPage();
    await gotoReady(other, url);
    await expect(other.getByLabel("Time range")).toHaveValue("7d");
    await expect(other.getByRole("checkbox", { name: "BLOCK" })).toBeChecked();
    await expect(other.getByRole("checkbox", { name: "ALLOW" })).not.toBeChecked();
    await expect(other.getByRole("checkbox", { name: "playground" })).toBeChecked();
    await expect(other.getByRole("checkbox", { name: "api" })).toBeChecked();
    await expect(other.getByLabel("Minimum risk (0–1)")).toHaveValue("0.5");
    await page.context().close();
  });

  test("test_AC_FE_9 client bundle has no API base URL, live keys or AWS account ID", async ({ browser }) => {
    const page = await pageAs(browser, "admin");
    const scripts = new Set<string>();
    page.on("response", (r) => {
      if (r.request().resourceType() === "script") scripts.add(r.url());
    });
    for (const path of ["/playground", "/verdicts", "/analytics", "/apps", `/apps/${APP_ID}`, "/evaluation"]) {
      await gotoReady(page, path);
      await page.waitForLoadState("networkidle");
    }
    const needles = ["PIF_API_BASE_URL", "pif_live_", process.env.E2E_AWS_ACCOUNT_ID, process.env.E2E_API_HOST].filter((n): n is string => Boolean(n));
    expect(scripts.size).toBeGreaterThan(0);
    for (const url of scripts) {
      const body = await (await page.request.get(url)).text();
      for (const n of needles) expect(body.includes(n), `${n} found in ${url}`).toBe(false);
    }
    const html = await page.content();
    for (const n of needles) expect(html.includes(n)).toBe(false);
    await page.context().close();
  });

  for (const path of ["/playground", "/verdicts", "/analytics", "/apps", `/apps/${APP_ID}`, "/evaluation"]) {
    test(`test_AC_FE_10 axe: ${path} has no serious or critical violations`, async ({ browser }) => {
      const page = await pageAs(browser, "admin");
      await gotoReady(page, path);
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad, JSON.stringify(bad.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), null, 2)).toEqual([]);
      await page.context().close();
    });
  }

  test("test_AC_FE_10 axe: playground result panel has no serious or critical violations", async ({ browser }) => {
    const page = await pageAs(browser, "admin");
    await gotoReady(page, "/playground");
    await page.getByLabel("App (policy)").selectOption(APP_ID);
    await page.getByLabel("Presets").selectOption({ label: "Override" });
    await runScan(page);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    await page.context().close();
  });
});
