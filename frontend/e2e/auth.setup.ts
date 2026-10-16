import fs from "node:fs";
import { test as setup } from "@playwright/test";
import { STATE_DIR, credentials, signInViaHostedUi, statePath, type E2ERole } from "./helpers";

fs.mkdirSync(STATE_DIR, { recursive: true });

for (const role of ["admin", "analyst"] as E2ERole[]) {
  setup(`authenticate as ${role}`, async ({ page }) => {
    const creds = credentials(role);
    setup.skip(!creds, `No ${role} test user configured`);
    await signInViaHostedUi(page, creds!.username, creds!.password);
    await page.context().storageState({ path: statePath(role) });
  });
}
