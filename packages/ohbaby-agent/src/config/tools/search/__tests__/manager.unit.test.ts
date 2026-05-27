import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _SearchConfigManager as SearchConfigManager,
  getSearchConfig,
  isSearchConfigCached,
  reloadSearchConfig,
  toSearchProviderConfig,
} from "../index.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

describe("SearchConfigManager", () => {
  let tempDir: string;
  let searchJsonPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    SearchConfigManager.resetInstance();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-search-"));
    searchJsonPath = path.join(tempDir, ".ohbaby-agent", "tools", "search.json");
    env = { TAVILY_API_KEY: "tvly-test-key" };
  });

  afterEach(async () => {
    SearchConfigManager.resetInstance();
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  it("loads defaults when tools/search.json is absent and env has the key", async () => {
    await expect(getSearchConfig({ env, searchJsonPath })).resolves.toEqual({
      apiKey: "tvly-test-key",
      apiKeyEnvName: "TAVILY_API_KEY",
      defaults: {
        maxResults: 5,
        searchDepth: "basic",
        timeout: 60,
        topic: "general",
      },
      provider: "tavily",
    });
  });

  it("loads configured values and adapts them to search provider config", async () => {
    await writeJson(searchJsonPath, {
      apiKeyEnv: "CUSTOM_TAVILY_KEY",
      baseUrl: "https://search.example.com",
      defaults: {
        maxResults: 8,
        searchDepth: "advanced",
        timeout: 90,
        topic: "finance",
      },
      provider: "tavily",
    });

    const config = await getSearchConfig({
      env: { CUSTOM_TAVILY_KEY: "custom-key" },
      searchJsonPath,
    });

    expect(config).toEqual({
      apiKey: "custom-key",
      apiKeyEnvName: "CUSTOM_TAVILY_KEY",
      baseUrl: "https://search.example.com",
      defaults: {
        maxResults: 8,
        searchDepth: "advanced",
        timeout: 90,
        topic: "finance",
      },
      provider: "tavily",
    });
    expect(toSearchProviderConfig(config)).toEqual({
      apiKey: "custom-key",
      baseUrl: "https://search.example.com",
      defaults: {
        search: {
          maxResults: 8,
          searchDepth: "advanced",
          timeout: 90,
          topic: "finance",
        },
      },
      providerId: "tavily",
    });
  });

  it("caches successful loads and reloads on demand", async () => {
    await writeJson(searchJsonPath, {
      defaults: { maxResults: 5 },
    });
    const first = await getSearchConfig({ env, searchJsonPath });
    expect(isSearchConfigCached()).toBe(true);

    await writeJson(searchJsonPath, {
      defaults: { maxResults: 12 },
    });
    const cached = await getSearchConfig({ env, searchJsonPath });
    const reloaded = await reloadSearchConfig({ env, searchJsonPath });

    expect(cached).toBe(first);
    expect(reloaded.defaults.maxResults).toBe(12);
  });

  it("throws MISSING_API_KEY when no environment value is available", async () => {
    await expect(
      getSearchConfig({ env: {}, searchJsonPath }),
    ).rejects.toMatchObject({
      code: "MISSING_API_KEY",
    });
  });
});
