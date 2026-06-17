import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeGlobalEnvSecret } from "../env-secrets.js";

describe("writeGlobalEnvSecret", () => {
  let tempHome: string;
  let envPath: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-secrets-"));
    envPath = path.join(tempHome, ".ohbaby-agent", ".env");
  });

  afterEach(async () => {
    await fs.rm(tempHome, { force: true, recursive: true });
  });

  it("creates the global env file and returns its path", async () => {
    await expect(
      writeGlobalEnvSecret("ZENMUX_API_KEY", "sk-test", {
        homeDirectory: tempHome,
      }),
    ).resolves.toBe(envPath);

    await expect(fs.readFile(envPath, "utf-8")).resolves.toBe(
      "ZENMUX_API_KEY=sk-test\n",
    );
  });

  it("replaces an existing key without duplicating it", async () => {
    await fs.mkdir(path.dirname(envPath), { recursive: true });
    await fs.writeFile(
      envPath,
      "ZENMUX_API_KEY=old\nOTHER_KEY=keep\n",
      "utf-8",
    );

    await writeGlobalEnvSecret("ZENMUX_API_KEY", "new", {
      homeDirectory: tempHome,
    });

    await expect(fs.readFile(envPath, "utf-8")).resolves.toBe(
      "ZENMUX_API_KEY=new\nOTHER_KEY=keep\n",
    );
  });

  it("quotes values that need dotenv escaping", async () => {
    await writeGlobalEnvSecret("TAVILY_API_KEY", "tvly key #1", {
      homeDirectory: tempHome,
    });

    await expect(fs.readFile(envPath, "utf-8")).resolves.toBe(
      'TAVILY_API_KEY="tvly key #1"\n',
    );
  });
});
