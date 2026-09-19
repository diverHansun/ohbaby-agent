import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { retainFailedLoopWorkspace } from "./agent-loop-workspace.js";

describe("failed real-loop workspace retention", () => {
  it("retains private database/config while exporting only an identifying manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-loop-retention-test-"));
    const manifestPath = join(root, "resume.json");
    try {
      await mkdir(join(root, "config"));
      await mkdir(join(root, "workspace"));
      await writeFile(
        join(root, "config", "model.json"),
        JSON.stringify({ apiConfig: { apiKeyEnv: "ZENMUX_API_KEY" } }),
      );
      await writeFile(join(root, "session.db"), "OPAQUE_PRIVATE_STATE_FIXTURE");
      await writeFile(
        join(root, "workspace", "cache-note.md"),
        "PRIVATE_VISIBLE_BODY_FIXTURE",
      );
      await retainFailedLoopWorkspace({
        root,
        manifestPath,
        auditPath: "audit.json",
        profile: "fixed-profile",
        sessionId: "session-7",
        httpRequests: 10,
        commit: "test-commit",
      });
      if (process.platform !== "win32") {
        for (const directory of [
          root,
          join(root, "config"),
          join(root, "workspace"),
        ])
          expect((await stat(directory)).mode & 0o777).toBe(0o700);
        for (const file of [
          manifestPath,
          join(root, "session.db"),
          join(root, "config", "model.json"),
          join(root, "workspace", "cache-note.md"),
        ])
          expect((await stat(file)).mode & 0o777).toBe(0o600);
      }
      const manifest = await readFile(manifestPath, "utf8");
      expect(manifest).not.toMatch(
        /OPAQUE_PRIVATE_STATE_FIXTURE|PRIVATE_VISIBLE_BODY_FIXTURE/,
      );
      expect(JSON.parse(manifest)).toMatchObject({
        status: "retained-failed-run",
        sessionId: "session-7",
        httpRequestsAlreadyConsumed: 10,
        credential: { kind: "environment", name: "ZENMUX_API_KEY" },
      });
      expect(await readFile(join(root, "session.db"), "utf8")).toBe(
        "OPAQUE_PRIVATE_STATE_FIXTURE",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses a manifest for an inline credential configuration without echoing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-loop-retention-test-"));
    const manifestPath = join(root, "resume.json");
    try {
      await mkdir(join(root, "config"));
      await writeFile(
        join(root, "config", "model.json"),
        JSON.stringify({
          apiConfig: {
            apiKeyEnv: "ZENMUX_API_KEY",
            apiKey: "SECRET_FIXTURE_VALUE",
          },
        }),
      );
      await expect(
        retainFailedLoopWorkspace({
          root,
          manifestPath,
          auditPath: "audit.json",
          profile: "fixed-profile",
          httpRequests: 1,
          commit: "test",
        }),
      ).rejects.toThrow("UNSAFE_INLINE_CREDENTIAL_CONFIG");
      await expect(stat(manifestPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
