import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StorageWriteError } from "./errors.js";
import type { StorageKey } from "./types.js";

export async function atomicWrite(input: {
  readonly key: StorageKey;
  readonly targetPath: string;
  readonly data: string | Uint8Array;
  readonly writeFile: (
    path: string,
    data: string | Uint8Array,
  ) => Promise<void>;
}): Promise<void> {
  const tempPath = join(dirname(input.targetPath), `.tmp-${randomUUID()}`);
  try {
    await input.writeFile(tempPath, input.data);
    await rename(tempPath, input.targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new StorageWriteError(input.key, error);
  }
}
