#!/usr/bin/env node
// AC-FE-9 (build-time variant): after `next build`, search the client bundle for secrets.
// Usage: npm run build && npm run check:bundle
// Extra needles: CHECK_BUNDLE_NEEDLES="123456789012,abc.execute-api.us-east-1.amazonaws.com"
import fs from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), ".next", "static");
if (!fs.existsSync(root)) {
  console.error("No .next/static directory — run `npm run build` first.");
  process.exit(2);
}

const needles = ["PIF_API_BASE_URL", "pif_live_", "AUTH_SECRET", "AUTH_COGNITO_SECRET"];
if (process.env.PIF_API_BASE_URL) needles.push(new URL(process.env.PIF_API_BASE_URL).host);
if (process.env.AWS_ACCOUNT_ID) needles.push(process.env.AWS_ACCOUNT_ID);
for (const n of (process.env.CHECK_BUNDLE_NEEDLES ?? "").split(",")) if (n.trim()) needles.push(n.trim());

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.(js|mjs|css|json|html|txt|map)$/.test(entry.name)) yield p;
  }
}

let failures = 0;
let files = 0;
for (const file of walk(root)) {
  files++;
  const text = fs.readFileSync(file, "utf8");
  for (const n of needles) {
    if (text.includes(n)) {
      console.error(`FOUND "${n}" in ${path.relative(process.cwd(), file)}`);
      failures++;
    }
  }
}
console.log(`Scanned ${files} files for ${needles.length} needles.`);
process.exit(failures ? 1 : 0);
