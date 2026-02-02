"use strict";

import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import JSZip from "jszip";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const CRITICAL_PATHS = [
  "components/dashboard/CalendarWorkspace.tsx",
  "components/dashboard/views/CalendarDaysView.tsx",
  "app/backoffice/[location]/calendar/page.tsx",
  "lib/stundenliste-client.ts",
];

const BACKUP_MANIFEST = [
  "app",
  "components",
  "lib",
  "prisma",
  "public",
  "scripts",
  "styles",
  "types",
  "workers",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "next.config.ts",
  "postcss.config.mjs",
  "README.md",
];

const BACKUP_TARGETS = [
  {
    label: "local",
    directory: path.join(projectRoot, ".backups"),
    description: "Projektinterne Sofort-Sicherung",
  },
  {
    label: "project",
    directory: path.resolve(projectRoot, "..", "calendar_backups"),
    description: "Backup neben dem Projektordner",
  },
  {
    label: "home",
    directory: path.join(os.homedir(), "CalendarBackups", "codex-calendar"),
    description: "Benutzerweite Sicherung im Home-Verzeichnis",
  },
];

const args = process.argv.slice(2);
const labelArgIndex = args.findIndex((arg) => arg === "--label");
const backupLabel = labelArgIndex >= 0 ? (args[labelArgIndex + 1] ?? "").trim() : "";

const timestamp = new Date();
const timestampTag = [
  timestamp.getFullYear(),
  String(timestamp.getMonth() + 1).padStart(2, "0"),
  String(timestamp.getDate()).padStart(2, "0"),
  "-",
  String(timestamp.getHours()).padStart(2, "0"),
  String(timestamp.getMinutes()).padStart(2, "0"),
  String(timestamp.getSeconds()).padStart(2, "0"),
].join("");
const archiveBaseName = `codex-backup-${timestampTag}${backupLabel ? `-${sanitizeLabel(backupLabel)}` : ""}`;
const archiveFilename = `${archiveBaseName}.zip`;

async function main() {
  await ensureTargets();
  await verifyCriticalFiles();
  const gitMeta = await gatherGitMeta();

  const zipPath = path.join(BACKUP_TARGETS[0].directory, archiveFilename);
  await createZipArchive(zipPath);

  // replicate archive to secondary locations
  const replicationResults = [];
  for (let index = 1; index < BACKUP_TARGETS.length; index += 1) {
    const target = BACKUP_TARGETS[index];
    const targetPath = path.join(target.directory, archiveFilename);
    await fs.copyFile(zipPath, targetPath);
    replicationResults.push({ target, path: targetPath });
  }

  const summary = [
    `Backup-Zeitpunkt: ${timestamp.toISOString()}`,
    gitMeta ? `Git-Referenz: ${gitMeta.commit} (${gitMeta.status})` : "Git-Referenz: nicht ermittelbar",
    "",
    "Erstellte Sicherungen:",
    `  1. ${BACKUP_TARGETS[0].description}: ${zipPath}`,
  ];

  replicationResults.forEach(({ target, path: targetPath }, index) => {
    summary.push(`  ${index + 2}. ${target.description}: ${targetPath}`);
  });

  summary.push("");
  summary.push("Hinweis: Bewahre mindestens eines der Backups auf einem externen Medium oder Cloud-Speicher auf.");

  console.log(summary.join("\n"));
}

async function ensureTargets() {
  for (const target of BACKUP_TARGETS) {
    await fs.mkdir(target.directory, { recursive: true });
  }
}

async function verifyCriticalFiles() {
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
    throw new Error(
      `Sicherung abgebrochen – wichtige Dateien fehlen:\n${missing
        .map((item) => `  • ${item}`)
        .join("\n")}\nBitte stelle diese Dateien wieder her, bevor du eine Sicherung erstellst.`,
    );
  }
}

async function gatherGitMeta() {
  try {
    const [{ stdout: commit }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: projectRoot }),
      execFileAsync("git", ["status", "--short"], { cwd: projectRoot }),
    ]);
    const formattedStatus = status.trim() === "" ? "clean" : "dirty";
    return {
      commit: commit.trim(),
      status: formattedStatus,
    };
  } catch {
    return null;
  }
}

async function createZipArchive(destinationPath) {
  const zip = new JSZip();
  for (const entry of BACKUP_MANIFEST) {
    const source = path.join(projectRoot, entry);
    await addEntryToZip(zip, entry, source);
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, buffer);
}

async function addEntryToZip(zip, relativePath, absolutePath) {
  try {
    const stats = await fs.stat(absolutePath);
    if (stats.isDirectory()) {
      const children = await fs.readdir(absolutePath);
      await Promise.all(
        children.map((child) =>
          addEntryToZip(zip, path.join(relativePath, child), path.join(absolutePath, child)),
        ),
      );
    } else if (stats.isFile()) {
      const fileContent = await fs.readFile(absolutePath);
      zip.file(relativePath, fileContent);
    }
  } catch (error) {
    if (error && error.code === "ENOENT") {
      // Optional Dateien dürfen fehlen; wir protokollieren dies
      console.warn(`⚠️  Überspringe fehlenden Pfad: ${relativePath}`);
      return;
    }
    throw error;
  }
}

async function writeFile(destinationPath, buffer) {
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(destinationPath);
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.end(buffer);
  });
}

function sanitizeLabel(label) {
  return label.replace(/[^a-z0-9-_]/gi, "_");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
