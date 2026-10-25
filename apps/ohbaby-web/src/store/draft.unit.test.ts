// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createDraftStore } from "./draft.js";

beforeEach(() => {
  sessionStorage.clear();
});

describe("draft workspace", () => {
  it("starts at No workspace and survives a reload of the store", () => {
    expect(createDraftStore().getSnapshot().workspaceDirectory).toBeNull();
    const store = createDraftStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.setWorkspace("/a");
    store.setWorkspace("/a");
    expect(notified).toBe(1);
    expect(createDraftStore().getSnapshot().workspaceDirectory).toBe("/a");
    store.setWorkspace(null);
    expect(createDraftStore().getSnapshot().workspaceDirectory).toBeNull();
  });

  it("ignores unreadable stored values", () => {
    sessionStorage.setItem("ohbaby:draft-workspace:new", "{broken");
    expect(createDraftStore().getSnapshot().workspaceDirectory).toBeNull();
  });
});
