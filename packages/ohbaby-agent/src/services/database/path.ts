import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  OHBABY_DATABASE_FILE_NAME,
  resolveOhbabyDataRoot,
} from "../../paths/index.js";

function defaultDataBaseDir(): string {
  return resolveOhbabyDataRoot();
}

export function resolveDatabasePath(dbPath?: string): string {
  const resolved = process.env.OHBABY_DB_PATH ?? dbPath;
  return resolved ?? join(defaultDataBaseDir(), OHBABY_DATABASE_FILE_NAME);
}

export function ensureDatabaseDirectory(dbPath: string): void {
  if (dbPath === ":memory:") {
    return;
  }
  mkdirSync(dirname(dbPath), { recursive: true });
}
