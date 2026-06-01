#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TEST_TYPES = new Set(["unit", "contract", "integration", "smoke"]);
const type = process.argv[2];

if (!TEST_TYPES.has(type)) {
  console.error(
    `Usage: node scripts/run-vitest-by-type.mjs <${Array.from(TEST_TYPES).join("|")}>`,
  );
  process.exit(1);
}

const root = process.cwd();
const searchRoots = ["packages", "tests"];
const ignoredDirectories = new Set(["node_modules", "dist", "coverage"]);
const suffixes = [`.${type}.test.ts`, `.${type}.test.tsx`];

function walk(directory) {
  const entries = readdirSync(directory);
  const files = [];

  for (const entry of entries) {
    if (ignoredDirectories.has(entry)) {
      continue;
    }

    const absolutePath = path.join(directory, entry);
    const stat = statSync(absolutePath);

    if (stat.isDirectory()) {
      files.push(...walk(absolutePath));
      continue;
    }

    if (suffixes.some((suffix) => entry.endsWith(suffix))) {
      files.push(path.relative(root, absolutePath));
    }
  }

  return files;
}

const testFiles = searchRoots
  .filter((searchRoot) => existsSync(path.join(root, searchRoot)))
  .flatMap((searchRoot) => walk(path.join(root, searchRoot)))
  .sort();

if (testFiles.length === 0) {
  console.log(`No ${type} test files found.`);
  process.exit(0);
}

const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");
const vitestArgs = ["run"];
if (type === "integration") {
  // Integration CLI packaging tests rebuild shared dist directories.
  vitestArgs.push("--no-file-parallelism");
}
vitestArgs.push(...testFiles);

const result = spawnSync(process.execPath, [vitestEntry, ...vitestArgs], {
  shell: false,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
}

process.exit(result.status ?? 1);
