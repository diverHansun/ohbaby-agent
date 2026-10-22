import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settingsConfigVersion } from "../config-coordination.js";

afterEach(() => {
  vi.unstubAllEnvs();
});
describe("partitioned settings versions", () => {
  it("hashes all six partitions independently and isolates project files by instance directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-settings-version-"));
    vi.stubEnv("OHBABY_HOME", join(root, "global"));
    const a = join(root, "a");
    const b = join(root, "b");
    try {
      const before = await settingsConfigVersion(a);
      for (const [domain, file] of [
        ["model", join(root, "global", "model.json")],
        ["env", join(root, "global", ".env")],
        ["search", join(root, "global", "tools", "search.json")],
        ["mcp", join(a, ".ohbaby", "mcp", "settings.json")],
        ["agents", join(a, ".ohbaby", "agents", "settings.json")],
        ["skills", join(a, ".ohbaby", "skills", "settings.json")],
      ] as const) {
        const previous = await settingsConfigVersion(a);
        const other = await settingsConfigVersion(b);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, "changed");
        const current = await settingsConfigVersion(a);
        expect(
          Object.keys(current).filter(
            (key) =>
              current[key as keyof typeof current] !==
              previous[key as keyof typeof previous],
          ),
        ).toEqual([domain]);
        if (["mcp", "agents", "skills"].includes(domain))
          expect(await settingsConfigVersion(b)).toEqual(other);
      }
      expect(Object.keys(before).sort()).toEqual([
        "agents",
        "env",
        "mcp",
        "model",
        "search",
        "skills",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
