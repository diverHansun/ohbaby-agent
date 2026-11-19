import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export async function writeUpdateJson(
  path: string,
  value: object,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${String(process.pid)}.${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function readAutoUpdate(ohbabyHome: string): boolean {
  try {
    const settings: unknown = JSON.parse(
      readFileSync(join(ohbabyHome, "update", "settings.json"), "utf8"),
    );
    return (
      typeof settings === "object" &&
      settings !== null &&
      "autoUpdate" in settings &&
      settings.autoUpdate === true
    );
  } catch {
    return false;
  }
}

export function setAutoUpdate(
  ohbabyHome: string,
  autoUpdate: boolean,
): Promise<void> {
  return writeUpdateJson(join(ohbabyHome, "update", "settings.json"), {
    autoUpdate,
  });
}
