import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDatabaseMessageStore,
  isContextSummaryPart,
} from "../message/index.js";
import { closeDatabase, initDatabase } from "../../services/database/index.js";

const MARKER = "context-compaction:after-first-part-update:v1\n";
const cleanupPaths: string[] = [];

async function waitForExactMarker(
  markerPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readFile(markerPath, "utf8").catch(() => "");
    if (value === MARKER) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error("Crash child did not reach the exact transaction marker");
}

afterEach(async () => {
  closeDatabase();
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe.skipIf(process.platform === "win32")(
  "context compaction hard crash recovery",
  () => {
    it("rolls back an open SQLite compaction transaction after SIGKILL", async () => {
      const directory = await mkdtemp(join(tmpdir(), "ohbaby-context-crash-"));
      cleanupPaths.push(directory);
      const dbPath = join(directory, "agent.db");
      const markerPath = join(directory, "boundary.marker");
      await writeFile(markerPath, "", "utf8");
      const fixturePath = join(
        dirname(fileURLToPath(import.meta.url)),
        "testing/context-compaction-crash-child.ts",
      );
      const child = spawn(
        process.execPath,
        ["--import", "tsx", fixturePath, dbPath, markerPath],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const exited = once(child, "exit");

      try {
        await waitForExactMarker(markerPath, 5_000);
        expect(child.kill("SIGKILL")).toBe(true);
        const [code, signal] = (await exited) as [
          number | null,
          NodeJS.Signals | null,
        ];
        expect({ code, signal }).toEqual({ code: null, signal: "SIGKILL" });
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
        throw new Error(`${String(error)}\n${stderr}`);
      }

      initDatabase({ dbPath });
      const recovered = await createDatabaseMessageStore().listBySession(
        "session_1",
        { contextScopeId: undefined },
      );
      expect(
        recovered.filter((message) => message.parts.some(isContextSummaryPart)),
      ).toHaveLength(0);
      expect(
        recovered
          .flatMap((message) => message.parts)
          .every((part) => part.time?.compacted === undefined),
      ).toBe(true);
    });
  },
);
