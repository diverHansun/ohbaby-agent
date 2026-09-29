import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, initDatabase } from "../database/index.js";
import { createWorkspaceRegistryStore } from "./database-store.js";

describe("workspace registry database store", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ohbaby-workspace-registry-"));
    initDatabase({ dbPath: join(directory, "agent.db") });
  });

  afterEach(async () => {
    closeDatabase();
    await rm(directory, { force: true, recursive: true });
  });

  it("persists ordered projects and keeps hidden discovery tombstones", async () => {
    let time = 1_000;
    const store = createWorkspaceRegistryStore({ now: () => time++ });

    await store.ensureDiscovered(["/repo/a", "/repo/b", "/repo/a"]);
    expect(store.list()).toMatchObject([
      { position: 0, scopeKey: "/repo/a", visibility: "visible" },
      { position: 1, scopeKey: "/repo/b", visibility: "visible" },
    ]);

    expect(await store.hide("/repo/a")).toBe(true);
    await store.ensureDiscovered(["/repo/a"]);
    expect(store.list()[0]).toMatchObject({
      position: 0,
      scopeKey: "/repo/a",
      visibility: "hidden",
    });

    const reopened = await store.open("/repo/a");
    expect(reopened).toMatchObject({
      position: 0,
      scopeKey: "/repo/a",
      visibility: "visible",
    });
  });

  it("does not create a hidden tombstone for an unknown project", async () => {
    const store = createWorkspaceRegistryStore();
    expect(await store.hide("/repo/missing")).toBe(false);
    expect(store.list()).toEqual([]);
  });
});
