import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";

const APP_DIR_NAME = "ohbaby-agent";
const DEFAULT_DB_FILE = "ohbaby-agent.db";

function defaultDataBaseDir(): string {
  if (process.env.XDG_DATA_HOME) {
    return join(process.env.XDG_DATA_HOME, APP_DIR_NAME);
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_DIR_NAME);
  }
  if (platform() === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      APP_DIR_NAME,
    );
  }
  return join(homedir(), ".local", "share", APP_DIR_NAME);
}

export function resolveDatabasePath(dbPath?: string): string {
  const resolved = process.env.OHBABY_DB_PATH ?? dbPath;
  return resolved ?? join(defaultDataBaseDir(), DEFAULT_DB_FILE);
}

export function ensureDatabaseDirectory(dbPath: string): void {
  if (dbPath === ":memory:") {
    return;
  }
  mkdirSync(dirname(dbPath), { recursive: true });
}
