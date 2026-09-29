import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBoundedFile, readWriteTargetHeader } from "./text-files.js";

const readers = [
  {
    name: "Edit bounded reader",
    read: (target: string, signal: AbortSignal): Promise<unknown> =>
      readBoundedFile(target, 1024, "test", signal),
  },
  {
    name: "Write header reader",
    read: (target: string, signal: AbortSignal): Promise<unknown> =>
      readWriteTargetHeader(target, signal),
  },
];

describe("mutation regular-file readers", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mutation-regular-file-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  for (const reader of readers) {
    it.skipIf(process.platform === "win32").each(["existing", "replacement"])(
      `${reader.name} rejects FIFO %s without waiting for a writer`,
      async (kind) => {
        const target = path.join(root, "target");
        const fifo =
          kind === "existing" ? target : path.join(root, "replacement");
        await promisify(execFile)("mkfifo", [fifo]);
        const originalOpen = fs.open.bind(fs);
        if (kind === "replacement") {
          await fs.writeFile(target, "original");
          vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
            await fs.rename(fifo, target);
            return originalOpen(...args);
          });
        }
        const controller = new AbortController();
        const operation = reader.read(target, controller.signal).then(
          () => ({ kind: "success", message: "" }),
          (error: unknown) => ({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          operation,
          new Promise<{ kind: string; message: string }>((resolve) => {
            timer = setTimeout(() => {
              controller.abort();
              resolve({ kind: "timeout", message: "blocked on FIFO" });
            }, 150);
          }),
        ]);
        clearTimeout(timer);
        // Rescue the intentionally failing RED run without leaving blocked opens.
        if (outcome.kind === "timeout") {
          const rescue = await originalOpen(
            target,
            constants.O_RDWR | constants.O_NONBLOCK,
          );
          try {
            await operation;
          } finally {
            await rescue.close();
          }
        }
        expect(outcome.kind, outcome.message).toBe("error");
        expect(outcome.message).toMatch(/not a file/iu);
        expect((await fs.stat(target)).isFIFO()).toBe(true);
      },
    );

    it(`${reader.name} closes its handle if cancelled during open`, async () => {
      const target = path.join(root, "target");
      await fs.writeFile(target, "original");
      const controller = new AbortController();
      const originalOpen = fs.open.bind(fs);
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
        handle = await originalOpen(...args);
        controller.abort();
        return handle;
      });
      await expect(reader.read(target, controller.signal)).rejects.toThrow();
      await expect(handle?.stat()).rejects.toMatchObject({ code: "EBADF" });
      expect(await fs.readFile(target, "utf8")).toBe("original");
    });
  }
});
