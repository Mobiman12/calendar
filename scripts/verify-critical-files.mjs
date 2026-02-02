"use strict";

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const CRITICAL_PATHS = [
  "components/dashboard/CalendarWorkspace.tsx",
  "components/dashboard/views/CalendarDaysView.tsx",
  "app/backoffice/[location]/calendar/page.tsx",
  "lib/stundenliste-client.ts",
];

async function main() {
  const missing = [];
  for (const relativePath of CRITICAL_PATHS) {
    const absolute = path.join(projectRoot, relativePath);
    try {
      const stats = await fs.stat(absolute);
      if (!stats.isFile()) {
        missing.push(relativePath);
      }
    } catch {
      missing.push(relativePath);
    }
  }

  if (missing.length > 0) {
    console.error("❌ Kritische Dateien fehlen:");
    for (const item of missing) {
      console.error(`   • ${item}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("✅ Alle kritischen Dateien sind vorhanden.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
