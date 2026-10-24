import type {
  UiSettingsGlobalMcpServer,
  UiSettingsMcpServer,
} from "ohbaby-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockSettingsApi } from "../dev/mock-settings.js";
import { selectSettings } from "../store/settings-cache.js";
import { mergeMcpRows } from "../ui/settings/mcp/mcp-rows.js";
import { SettingsLayer } from "./settings-layer.js";

afterEach(() => {
  vi.useRealTimers();
});

function config(name: string, enabled = true): UiSettingsGlobalMcpServer {
  return {
    name,
    transport: "stdio",
    enabled,
    trust: false,
    timeout: 10_000,
    envKeys: [],
    headerKeys: [],
  };
}

function live(
  name: string,
  status: UiSettingsMcpServer["status"],
): UiSettingsMcpServer {
  return {
    name,
    origin: "project",
    enabled: status !== "disabled",
    status,
    toolCount: status === "connected" ? 2 : 0,
    tools: [],
  };
}

describe("MCP rows", () => {
  it("joins config and status by name and classifies Off, Not connected and unknown", () => {
    const rows = mergeMcpRows(
      [config("a"), config("b", false), config("c"), config("d"), config("e")],
      [
        live("a", "connected"),
        live("b", "connected"),
        live("c", "disconnected"),
        live("d", "failed"),
        live("not-global", "connected"),
      ],
    );
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ["a", "connected"],
      ["b", "off"],
      ["c", "not-connected"],
      ["d", "failed"],
      ["e", "unknown"],
    ]);
    expect(mergeMcpRows([config("a")], undefined)[0]?.status).toBe("unknown");
  });
});

describe("settings layer", () => {
  it("skips a read while the cached list is younger than maxAge", async () => {
    vi.useFakeTimers();
    const api = createMockSettingsApi("settings", () => Promise.resolve());
    const reads = vi.spyOn(api, "getModels");
    const layer = new SettingsLayer(api, () => "/a");
    await layer.load("models");
    await layer.load("models", { maxAge: 30_000 });
    expect(reads).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    await layer.load("models", { maxAge: 30_000 });
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("keeps instance reads apart per settings directory", async () => {
    const api = createMockSettingsApi("settings", () => Promise.resolve());
    const status = vi.spyOn(api, "getMcpStatus");
    let directory = "/a";
    const layer = new SettingsLayer(api, () => directory);
    await layer.load("mcpStatus");
    directory = "/b";
    expect(
      selectSettings(layer.cache.getSnapshot(), "mcpStatus", "/b").data,
    ).toBeUndefined();
    await layer.load("mcpStatus");
    expect(status.mock.calls.map(([dir]) => dir)).toEqual(["/a", "/b"]);
    expect(
      selectSettings(layer.cache.getSnapshot(), "mcpStatus", "/a").data,
    ).toBeDefined();
  });

  it("rereads only watched kinds on change events and focus", async () => {
    const api = createMockSettingsApi("settings", () => Promise.resolve());
    const servers = vi.spyOn(api, "getMcpServers");
    const status = vi.spyOn(api, "getMcpStatus");
    const search = vi.spyOn(api, "getSearch");
    const layer = new SettingsLayer(api, () => "/a");
    const stop = layer.watch("mcpServers");
    layer.invalidate(["mcp"]);
    layer.reactivate();
    await vi.waitFor(() => {
      expect(servers).toHaveBeenCalledTimes(2);
    });
    expect(status).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    stop();
    layer.reactivate();
    expect(servers).toHaveBeenCalledTimes(2);
  });
});
