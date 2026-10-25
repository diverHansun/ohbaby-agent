import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase } from "../services/database/index.js";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";
import { createPersistentUiBackendClient } from "./ui-persistent.js";

let directory: string;
beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), "ohbaby-directory-wire-")),
  );
  vi.stubEnv("OHBABY_HOME", join(directory, "home"));
});
afterEach(async () => {
  closeDatabase();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe.each(["memory", "persistent"] as const)(
  "%s session directory contract",
  (kind) => {
    it("exposes workingDirectory in creation, snapshots and index entries without old keys", async () => {
      const client =
        kind === "memory"
          ? createInProcessUiBackendClient({ workdir: directory })
          : createPersistentUiBackendClient({
              workdir: directory,
              dbPath: join(directory, "agent.db"),
            });
      try {
        const created = await client.createSession();
        const snapshot = await client.getSnapshot();
        const index = await client.getSessionIndex();
        const records = [
          created,
          snapshot.sessions.find((session) => session.id === created.id),
          index.find((session) => session.id === created.id),
        ];
        for (const record of records) {
          expect(record).toMatchObject({ workingDirectory: directory });
          expect(record).not.toHaveProperty("projectRoot");
          expect(record).not.toHaveProperty("projectDirectory");
          expect(record).not.toHaveProperty("pendingProjectRoot");
        }
      } finally {
        await client.dispose();
      }
    });
  },
);
