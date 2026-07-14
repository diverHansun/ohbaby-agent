import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSearchApiKey } from "../writer.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("setSearchApiKey", () => {
  let tempHome: string;
  let envPath: string;
  let searchJsonPath: string;
  let originalTavilyKey: string | undefined;
  let originalCustomKey: string | undefined;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-search-writer-"),
    );
    envPath = path.join(tempHome, ".ohbaby", ".env");
    searchJsonPath = path.join(tempHome, ".ohbaby", "tools", "search.json");
    originalTavilyKey = process.env.TAVILY_API_KEY;
    originalCustomKey = process.env.CUSTOM_TAVILY_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.CUSTOM_TAVILY_KEY;
  });

  afterEach(async () => {
    restoreEnvValue("TAVILY_API_KEY", originalTavilyKey);
    restoreEnvValue("CUSTOM_TAVILY_KEY", originalCustomKey);
    await fs.rm(tempHome, { force: true, recursive: true });
  });

  it("writes the Tavily key to global env and creates minimal search config", async () => {
    const result = await setSearchApiKey({
      apiKey: "tvly-test-secret",
      homeDirectory: tempHome,
      searchJsonPath,
    });

    expect(result).toEqual({
      apiKeyEnv: "TAVILY_API_KEY",
      envPath,
      provider: "tavily",
      searchJsonPath,
    });
    expect(JSON.stringify(result)).not.toContain("tvly-test-secret");
    await expect(fs.readFile(envPath, "utf-8")).resolves.toBe(
      "TAVILY_API_KEY=tvly-test-secret\n",
    );
    const searchJson = JSON.parse(
      await fs.readFile(searchJsonPath, "utf-8"),
    ) as Record<string, unknown>;
    expect(searchJson).toEqual({
      apiKeyEnv: "TAVILY_API_KEY",
      provider: "tavily",
    });
    expect(process.env.TAVILY_API_KEY).toBe("tvly-test-secret");
  });

  it("writes only provider and key env metadata while updating the key env", async () => {
    await writeJson(searchJsonPath, {
      apiKeyEnv: "OLD_KEY",
      baseUrl: "https://search.example.com",
      defaults: {
        maxResults: 8,
        searchDepth: "advanced",
        timeout: 90,
        topic: "finance",
      },
      provider: "tavily",
    });

    const result = await setSearchApiKey({
      apiKey: "custom-secret",
      apiKeyEnv: "CUSTOM_TAVILY_KEY",
      homeDirectory: tempHome,
      searchJsonPath,
    });

    expect(result.apiKeyEnv).toBe("CUSTOM_TAVILY_KEY");
    await expect(fs.readFile(envPath, "utf-8")).resolves.toBe(
      "CUSTOM_TAVILY_KEY=custom-secret\n",
    );
    expect(JSON.parse(await fs.readFile(searchJsonPath, "utf-8"))).toEqual({
      apiKeyEnv: "CUSTOM_TAVILY_KEY",
      provider: "tavily",
    });
    expect(process.env.CUSTOM_TAVILY_KEY).toBe("custom-secret");
  });

  it("rejects invalid apiKeyEnv values before writing secrets or search config", async () => {
    await expect(
      setSearchApiKey({
        apiKey: "tvly-test-secret",
        apiKeyEnv: "tvly-test-secret",
        homeDirectory: tempHome,
        searchJsonPath,
      }),
    ).rejects.toThrow("must be an environment variable name");

    await expect(fs.readFile(envPath, "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(searchJsonPath, "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(process.env["tvly-test-secret"]).toBeUndefined();
  });
});

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}
