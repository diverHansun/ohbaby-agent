import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ToolCommandContext,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import type { TrustedRoot } from "../sandbox/trusted-roots.js";
import type { SearchProvider } from "../services/search-providers/index.js";
import { createListTool } from "./list.js";
import { createGlobTool } from "./glob.js";
import { createWebTools } from "./web.js";

describe("tool display output persistence", () => {
  let root: string;
  let workspace: string;
  let storage: string;
  let context: ToolExecutionContext;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-tool-output-")),
    );
    workspace = path.join(root, "workspace");
    storage = path.join(root, "owner-session");
    await fs.mkdir(workspace);
    await fs.mkdir(storage);
    context = {
      callId: "../../same-call",
      messageId: "message",
      sessionId: "child-session",
      signal: new AbortController().signal,
      environment: {
        workdir: workspace,
        resolvePath: (value): string => path.resolve(workspace, value),
        resolvePathForExisting: (value): Promise<string> =>
          fs.realpath(path.resolve(workspace, value)),
        resolvePathForWrite: (value): Promise<string> =>
          Promise.resolve(path.resolve(workspace, value)),
        resolveCommandContext: (): ToolCommandContext => ({
          kind: "host-local",
          cwd: workspace,
        }),
        trustedRoots: (): readonly TrustedRoot[] => [
          { kind: "session-storage", path: storage },
        ],
      },
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  function savedPath(result: ToolExecutionResult): string {
    expect(result.metadata?.outputFile).toMatchObject({ status: "full" });
    const file = (result.metadata?.outputFile as { path: string }).path;
    expect(path.dirname(file)).toBe(path.join(storage, "tool-results"));
    expect(result.output).toContain(file);
    return file;
  }
  it("saves list's acquired entries before display clipping, without overriding its entry limit", async () => {
    const names = Array.from(
      { length: 180 },
      (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(200)}`,
    );
    await Promise.all(
      names.map((name) => fs.writeFile(path.join(workspace, name), "")),
    );
    const tool = createListTool();
    const first = await tool.execute({ limit: 170 }, context);
    const second = await tool.execute({ limit: 170 }, context);
    const firstPath = savedPath(first);
    expect(savedPath(second)).not.toBe(firstPath);
    expect(await fs.readFile(firstPath, "utf8")).toBe(
      names.slice(0, 170).join("\n") + "\n... (10 more entries)",
    );
    expect(first.metadata).toMatchObject({
      truncated: true,
      displayLimited: true,
    });
    if (process.platform !== "win32") {
      expect((await fs.stat(firstPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(firstPath))).mode & 0o777).toBe(0o700);
    }
  });
  it("saves glob's collected paths and retains the scan-incomplete notice", async () => {
    const directory = Array.from(
      { length: 4 },
      (_, i) => `${String(i)}${"a".repeat(200)}`,
    ).join("/");
    await fs.mkdir(path.join(workspace, directory), { recursive: true });
    const names = Array.from(
      { length: 60 },
      (_, i) => `${directory}/${String(i).padStart(2, "0")}.txt`,
    );
    await Promise.all(
      names.map((name) => fs.writeFile(path.join(workspace, name), "")),
    );
    const result = await createGlobTool().execute(
      { pattern: "**/*.txt", limit: 50 },
      context,
    );
    const notice =
      "\n\nGlob incomplete (match-limit). Narrow the pattern or search root.";
    expect(await fs.readFile(savedPath(result), "utf8")).toBe(
      names.slice(0, 50).join("\n") + notice,
    );
    expect(result.output).toContain(notice);
    expect(result.metadata).toMatchObject({
      scanComplete: false,
      displayLimited: true,
      stopReason: "match-limit",
    });
  });
  it.each(["web_search", "web_fetch"])(
    "saves %s provider-acquired content exactly",
    async (name) => {
      const content = "a".repeat(40_000) + "\n[provider limit reached]";
      const provider: SearchProvider = {
        id: "fixture",
        search: vi.fn(() =>
          Promise.resolve([
            { title: "Fixture", url: "https://example.com", content },
          ]),
        ),
        fetch: vi.fn(() =>
          Promise.resolve([
            { url: "https://example.com", success: true, content },
          ]),
        ),
      };
      const tool = createWebTools({
        createProvider: () => provider,
        loadConfig: () => ({ providerId: "fixture", apiKey: "fixture" }),
      }).find((tool) => tool.name === name);
      if (!tool) throw new Error("Missing web tool");
      const result = await tool.execute(
        name === "web_search"
          ? { query: "fixture" }
          : { urls: ["https://example.com"] },
        context,
      );
      expect(await fs.readFile(savedPath(result), "utf8")).toBe(
        (name === "web_search"
          ? "1. [Fixture](https://example.com)\n"
          : "## https://example.com\n") + content,
      );
    },
  );
  it("leaves short output unchanged and does not prepare files", async () => {
    await fs.writeFile(path.join(workspace, "one.txt"), "");
    expect((await createListTool().execute({}, context)).output).toBe(
      "one.txt",
    );
    expect(await fs.readdir(storage)).toEqual([]);
  });
  it("reports a capped web output as partial rather than a full acquired result", async () => {
    const provider: SearchProvider = {
      id: "fixture",
      search: vi.fn(() =>
        Promise.resolve([
          {
            title: "Fixture",
            url: "https://example.com",
            content: "x".repeat(10_485_761),
          },
        ]),
      ),
      fetch: vi.fn(),
    };
    const tool = createWebTools({
      createProvider: () => provider,
      loadConfig: () => ({ providerId: "fixture", apiKey: "fixture" }),
    })[0];
    const result = await tool.execute({ query: "fixture" }, context);
    expect(result.metadata?.outputFile).toMatchObject({
      status: "partial",
      reason: "size-limit",
    });
    expect(result.output).toContain("Partial output saved");
    expect(result.output).not.toContain("Full output");
    const file = (result.metadata?.outputFile as { path: string }).path;
    const bytes = await fs.readFile(file);
    expect(bytes.length).toBe(10_485_760);
    expect(bytes.toString("utf8")).toContain("output truncated");
  });
  it.each(["missing-root", "redirected-directory"])(
    "reports %s honestly while retaining the displayed output",
    async (failure) => {
      const content = "a".repeat(40_000);
      const provider: SearchProvider = {
        id: "fixture",
        search: vi.fn(() =>
          Promise.resolve([
            { title: "Fixture", url: "https://example.com", content },
          ]),
        ),
        fetch: vi.fn(),
      };
      if (failure === "missing-root")
        context = { ...context, environment: undefined };
      else
        await fs.symlink(workspace, path.join(storage, "tool-results"), "dir");
      const tool = createWebTools({
        createProvider: () => provider,
        loadConfig: () => ({ providerId: "fixture", apiKey: "fixture" }),
      })[0];
      const result = await tool.execute({ query: "fixture" }, context);
      expect(result.output).toContain("[results truncated]");
      expect(result.output).toContain("could not be saved");
      expect(result.output).not.toContain("saved to");
      expect(result.metadata?.outputFile).toEqual({ status: "unavailable" });
      expect(await fs.readdir(workspace)).toEqual([]);
    },
  );
});
