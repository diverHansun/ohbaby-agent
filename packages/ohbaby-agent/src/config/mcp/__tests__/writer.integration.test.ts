import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as writer from "../writer.js";
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mcp-writer-"));
  vi.stubEnv("OHBABY_HOME", home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { force: true, recursive: true });
});
it("merges concurrent different servers and credential patches without exposing values", async () => {
  await Promise.all([
    writer.updateGlobalMcpServer("one", {
      transport: "stdio",
      command: "node",
      args: ["keep"],
      env: { set: { TOKEN: "first-secret", KEEP: "keep-secret" } },
    }),
    writer.updateGlobalMcpServer("two", {
      transport: "http",
      url: "http://localhost:1",
      headers: {
        set: { Authorization: "header-secret", Other: "other-secret" },
      },
    }),
  ]);
  await writer.updateGlobalMcpServer("one", {
    enabled: false,
    env: { set: { TOKEN: "replacement" }, unset: ["KEEP"] },
  });
  await writer.updateGlobalMcpServer("two", { headers: { unset: ["Other"] } });
  const raw = JSON.parse(
    await readFile(join(home, "mcp/settings.json"), "utf8"),
  ) as {
    mcpServers: Record<
      string,
      {
        env: Record<string, string>;
        headers: Record<string, string>;
        command?: string;
      }
    >;
  };
  expect(raw.mcpServers.one).toMatchObject({
    enabled: false,
    env: { TOKEN: "replacement" },
    args: ["keep"],
  });
  expect(raw.mcpServers.one.env.KEEP).toBeUndefined();
  expect(raw.mcpServers.two.headers).toEqual({
    Authorization: "header-secret",
  });
  const publicList = await writer.readGlobalMcpServers();
  expect(publicList).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "one",
        envKeys: ["TOKEN"],
        headerKeys: [],
      }),
      expect.objectContaining({ name: "two", headerKeys: ["Authorization"] }),
    ]),
  );
  expect(JSON.stringify(publicList)).not.toMatch(
    /replacement|header-secret|first-secret/,
  );
});
it("rejects invalid complete configs atomically and deletes only an existing global entry", async () => {
  await writer.updateGlobalMcpServer("one", {
    transport: "stdio",
    command: "node",
  });
  const before = await readFile(join(home, "mcp/settings.json"), "utf8");
  await expect(
    writer.updateGlobalMcpServer("one", {
      includeTools: ["sentinel-secret"],
      excludeTools: ["sentinel-secret"],
    }),
  ).rejects.toThrow();
  expect(await readFile(join(home, "mcp/settings.json"), "utf8")).toBe(before);
  await expect(writer.deleteGlobalMcpServer("missing")).rejects.toMatchObject({
    code: "MCP_SERVER_NOT_FOUND",
  });
  await writer.deleteGlobalMcpServer("one");
  expect(await writer.readGlobalMcpServers()).toEqual([]);
});
it("drops incompatible old transport fields while retaining common metadata", async () => {
  await writer.updateGlobalMcpServer("one", {
    transport: "stdio",
    command: "node",
    env: { set: { TOKEN: "secret" } },
    trust: true,
  });
  await writer.updateGlobalMcpServer("one", {
    transport: "http",
    url: "http://localhost:2",
  });
  const raw = JSON.parse(
    await readFile(join(home, "mcp/settings.json"), "utf8"),
  ) as {
    mcpServers: Record<
      string,
      {
        env: Record<string, string>;
        headers: Record<string, string>;
        command?: string;
      }
    >;
  };
  expect(raw.mcpServers.one).toMatchObject({
    type: "http",
    url: "http://localhost:2",
    trust: true,
  });
  expect(raw.mcpServers.one.env).toBeUndefined();
  expect(raw.mcpServers.one.command).toBeUndefined();
});
it.each([
  "https://credential-sentinel@example.test/search?topic=news",
  "https://example.test/search?%74oken=credential%2Dsentinel&topic=news",
])(
  "redacts parsed MCP URL credentials on write and read without changing saved %s",
  async (url) => {
    const updated = await writer.updateGlobalMcpServer("url", {
      transport: "http",
      url,
      enabled: false,
    });
    const read = await writer.readGlobalMcpServers();
    for (const projected of [updated, ...read]) {
      expect(JSON.stringify(projected)).not.toMatch(
        /credential(?:-|%2D)sentinel/i,
      );
      expect(new URL(projected.url ?? "").searchParams.get("topic")).toBe(
        "news",
      );
    }
    const saved: unknown = JSON.parse(
      await readFile(join(home, "mcp/settings.json"), "utf8"),
    );
    expect(saved).toMatchObject({ mcpServers: { url: { url } } });
  },
);
it.each([
  "https://example.test/mcp?auth=prefix-header-sentinel-suffix&topic=news",
  "https://example.test/mcp?auth=prefix-header%2Dsentinel-suffix&topic=news",
])(
  "masks known header secrets inside arbitrary decoded URL parameter values on PUT and GET: %s",
  async (url) => {
    const updated = await writer.updateGlobalMcpServer("known-secret", {
      transport: "http",
      url,
      enabled: false,
      headers: { set: { "X-Api-Key": "header-sentinel" } },
    });
    for (const projected of [
      updated,
      ...(await writer.readGlobalMcpServers()),
    ]) {
      expect(JSON.stringify(projected)).not.toMatch(/header(?:-|%2D)sentinel/i);
      const publicUrl = new URL(projected.url ?? "");
      expect(publicUrl.searchParams.get("auth")).toBe(
        "prefix-[REDACTED]-suffix",
      );
      expect(publicUrl.searchParams.get("topic")).toBe("news");
    }
    const saved: unknown = JSON.parse(
      await readFile(join(home, "mcp/settings.json"), "utf8"),
    );
    expect(saved).toMatchObject({
      mcpServers: {
        "known-secret": { url, headers: { "X-Api-Key": "header-sentinel" } },
      },
    });
  },
);
