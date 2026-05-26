import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimeRoot = fileURLToPath(new URL(".", import.meta.url));
const forbiddenModuleName = ["permission", "profiles"].join("-");
const forbiddenDeferredModuleNames = [
  "scheduler",
  "heartbeat",
  "tasks",
  forbiddenModuleName,
];
const forbiddenRuntimePermissionIdentifiers = [
  "BUILTIN_PERMISSION_PROFILES",
  "createPermissionProfileRegistry",
  "createProfileAwarePolicy",
  "PermissionProfile",
  "ProfileRegistry",
  "profileRegistry",
];

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(fullPath)));
      continue;
    }
    if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".unit.test.ts") &&
      !entry.name.endsWith(".integration.test.ts")
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("runtime module boundary", () => {
  it("does not reintroduce deferred runtime modules", async () => {
    const existingModules: string[] = [];
    for (const moduleName of forbiddenDeferredModuleNames) {
      if (await pathExists(path.join(runtimeRoot, moduleName))) {
        existingModules.push(moduleName);
      }
    }

    expect(existingModules).toEqual([]);
  });

  it("does not import or export runtime permission profile modules", async () => {
    const sourceFiles = await collectSourceFiles(runtimeRoot);
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = await fs.readFile(file, "utf8");
      if (content.includes(forbiddenModuleName)) {
        offenders.push(path.relative(runtimeRoot, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("does not reintroduce permission profile semantics in runtime source", async () => {
    const sourceFiles = await collectSourceFiles(runtimeRoot);
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = await fs.readFile(file, "utf8");
      for (const identifier of forbiddenRuntimePermissionIdentifiers) {
        if (content.includes(identifier)) {
          offenders.push(`${path.relative(runtimeRoot, file)}:${identifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
