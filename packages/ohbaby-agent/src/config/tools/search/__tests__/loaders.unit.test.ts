import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SearchConfigError } from "../types.js";
import { getSearchJsonPath, loadSearchJson } from "../loaders.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

describe("config/tools/search loaders", () => {
  let tempDir: string;
  let searchJsonPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-search-"));
    searchJsonPath = path.join(
      tempDir,
      "home",
      ".ohbaby-agent",
      "tools",
      "search.json",
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  it("resolves the global tools/search.json path", () => {
    expect(getSearchJsonPath("D:/home")).toBe(
      path.join("D:/home", ".ohbaby-agent", "tools", "search.json"),
    );
  });

  it("returns parsed JSON when search.json exists", async () => {
    const raw = {
      apiKeyEnv: "TAVILY_API_KEY",
      provider: "tavily",
    };
    await writeJson(searchJsonPath, raw);

    await expect(loadSearchJson(searchJsonPath)).resolves.toEqual(raw);
  });

  it("accepts UTF-8 BOM-prefixed search.json files", async () => {
    const raw = {
      apiKeyEnv: "TAVILY_API_KEY",
      provider: "tavily",
    };
    await fs.mkdir(path.dirname(searchJsonPath), { recursive: true });
    await fs.writeFile(searchJsonPath, `\uFEFF${JSON.stringify(raw)}`, "utf8");

    await expect(loadSearchJson(searchJsonPath)).resolves.toEqual(raw);
  });

  it("returns null when search.json does not exist", async () => {
    await expect(loadSearchJson(searchJsonPath)).resolves.toBeNull();
  });

  it("throws INVALID_JSON for malformed search.json", async () => {
    await fs.mkdir(path.dirname(searchJsonPath), { recursive: true });
    await fs.writeFile(searchJsonPath, "{ invalid json", "utf8");

    await expect(loadSearchJson(searchJsonPath)).rejects.toThrow(
      SearchConfigError,
    );
    await expect(loadSearchJson(searchJsonPath)).rejects.toMatchObject({
      code: "INVALID_JSON",
      path: searchJsonPath,
    });
  });
});
