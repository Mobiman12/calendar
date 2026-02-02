"use strict";

import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const labelArgIndex = args.findIndex((arg) => arg === "--label");
const label = labelArgIndex !== -1 ? args[labelArgIndex + 1] : undefined;

async function main() {
  console.log("🛡️  Verifiziere kritische Kalender-Dateien …");
  await runPnpm(["verify:critical"]);

  const backupArgs = ["backup"];
  if (label) {
    backupArgs.push("--", "--label", label);
  }

  console.log("💾 Erstelle Backup …");
  await runPnpm(backupArgs);

  console.log("✅ Snapshot abgeschlossen.");
}

function runPnpm(pnpmArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", pnpmArgs, {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command pnpm ${pnpmArgs.join(" ")} exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
