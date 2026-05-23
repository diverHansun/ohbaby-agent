import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSearchProvider,
  InvalidProviderConfigError,
  loadDefaultSearchProviderConfig,
  registerSearchProvider,
  UnknownProviderError,
} from "../index.js";
import type { SearchProvider } from "../index.js";

function createMockProvider(id: string): SearchProvider {
  return {
    id,
    fetch: () => Promise.resolve([]),
    search: () => Promise.resolve([]),
  };
}

describe("search provider registry unit", () => {
  const cleanupDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupDirectories.splice(0).map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  it("creates a registered provider by id", () => {
    const providerId = "mock-registry";
    registerSearchProvider(providerId, () => createMockProvider(providerId));

    const provider = createSearchProvider({
      apiKey: "test-key",
      providerId,
    });

    expect(provider.id).toBe(providerId);
  });

  it("rejects unknown providers with a clear error", () => {
    expect(() =>
      createSearchProvider({
        apiKey: "test-key",
        providerId: "missing-provider",
      }),
    ).toThrow(UnknownProviderError);
  });

  it("rejects missing API keys before creating clients", () => {
    expect(() =>
      createSearchProvider({
        apiKey: " ",
        providerId: "tavily",
      }),
    ).toThrow(InvalidProviderConfigError);
  });

  it("loads Tavily config from project .env when shell env is absent", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "ohbaby-search-env-"));
    cleanupDirectories.push(projectDirectory);
    await writeFile(
      join(projectDirectory, ".env"),
      [
        "TAVILY_API_KEY=from-project-env",
        "TAVILY_BASE_URL=https://search.example.test",
        "OHBABY_SEARCH_PROVIDER=tavily",
      ].join("\n"),
    );

    const config = loadDefaultSearchProviderConfig(
      {},
      { projectDirectory },
    );

    expect(config).toEqual({
      apiKey: "from-project-env",
      baseUrl: "https://search.example.test",
      providerId: "tavily",
    });
  });

  it("keeps shell search env ahead of project .env", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "ohbaby-search-env-"));
    cleanupDirectories.push(projectDirectory);
    await writeFile(
      join(projectDirectory, ".env"),
      [
        "TAVILY_API_KEY=from-project-env",
        "TAVILY_BASE_URL=https://project.example.test",
        "OHBABY_SEARCH_PROVIDER=project-provider",
      ].join("\n"),
    );

    const config = loadDefaultSearchProviderConfig(
      {
        OHBABY_SEARCH_PROVIDER: "shell-provider",
        TAVILY_API_KEY: "from-shell",
        TAVILY_BASE_URL: "https://shell.example.test",
      },
      { projectDirectory },
    );

    expect(config).toEqual({
      apiKey: "from-shell",
      baseUrl: "https://shell.example.test",
      providerId: "shell-provider",
    });
  });
});
