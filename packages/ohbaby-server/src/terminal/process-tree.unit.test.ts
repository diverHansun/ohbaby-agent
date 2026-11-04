import { expect, it } from "vitest";
import { collectTerminalProcesses, parseProcessTable } from "./process-tree.js";

const table = ` 10 1 ttys004 Wed Nov  4 13:00:00 2026 S /bin/zsh
 11 10 ttys004 Wed Nov  4 13:00:01 2026 S /usr/local/bin/node
 12 11 ttys004 Wed Nov  4 13:00:02 2026 S /bin/sleep
 13 10 ?? Wed Nov  4 13:00:02 2026 S /usr/bin/detached
 14 10 ttys004 Wed Nov  4 13:00:02 2026 Z /bin/zombie
 99 1 ttys005 Wed Nov  4 13:00:00 2026 S /bin/other`;
it("finds terminal descendants and names, excluding detached and dead processes", () => {
  const rows = parseProcessTable(table);
  expect(
    collectTerminalProcesses(rows, rows[0], []).map(({ pid, name }) => ({
      pid,
      name,
    })),
  ).toEqual([
    { pid: 10, name: "zsh" },
    { pid: 11, name: "node" },
    { pid: 12, name: "sleep" },
  ]);
});
it("keeps captured orphans and their children after the root exits without adopting a recycled root PID", () => {
  const initial = parseProcessTable(table);
  const later =
    parseProcessTable(`10 1 ttys004 Wed Nov  4 13:01:00 2026 S /bin/unrelated
11 1 ttys004 Wed Nov  4 13:00:01 2026 S /usr/local/bin/node
15 11 ttys004 Wed Nov  4 13:00:03 2026 S /bin/sleep
16 10 ttys004 Wed Nov  4 13:01:01 2026 S /bin/unrelated-child`);
  expect(
    collectTerminalProcesses(later, initial[0], initial.slice(1, 3)).map(
      ({ pid }) => pid,
    ),
  ).toEqual([11, 15]);
});
it("rejects a malformed process-table observation instead of reporting an idle terminal", () => {
  expect(() => parseProcessTable("unparseable data")).toThrow();
});
