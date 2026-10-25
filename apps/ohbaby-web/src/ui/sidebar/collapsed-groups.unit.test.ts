// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  readCollapsedGroups,
  writeCollapsedGroups,
} from "./collapsed-groups.js";

afterEach(() => {
  localStorage.clear();
});

it("reads and writes the v2 key", () => {
  writeCollapsedGroups(new Set(["pinned", "workspace:/repo"]));
  expect(
    JSON.parse(localStorage.getItem("ohbaby.web.sidebar.collapsed.v2") ?? ""),
  ).toEqual(["pinned", "workspace:/repo"]);
  expect([...readCollapsedGroups()]).toEqual(["pinned", "workspace:/repo"]);
});

it("drops the v1 key without converting its project groups", () => {
  localStorage.setItem(
    "ohbaby.web.sidebar.collapsed.v1",
    JSON.stringify(["no-project", "project:/repo"]),
  );
  expect(readCollapsedGroups().size).toBe(0);
  expect(localStorage.getItem("ohbaby.web.sidebar.collapsed.v1")).toBeNull();
});

it("falls back to nothing collapsed when the stored value is malformed", () => {
  localStorage.setItem("ohbaby.web.sidebar.collapsed.v2", "{not json");
  expect(readCollapsedGroups().size).toBe(0);
});
