import { defineConfig, devices } from "@playwright/test";

// E2E against a running dashboard (local `npm run start`, a Vercel preview, or production).
//   E2E_BASE_URL               base URL, default http://localhost:3000
//   E2E_ADMIN_USERNAME/_PASSWORD, E2E_ANALYST_USERNAME/_PASSWORD   Cognito test users (dev pool)
//   E2E_APP_ID                 an existing app whose policy the tests may edit (AC-FE-6)
//   E2E_AWS_ACCOUNT_ID         searched for in the client bundle (AC-FE-9)
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
});
