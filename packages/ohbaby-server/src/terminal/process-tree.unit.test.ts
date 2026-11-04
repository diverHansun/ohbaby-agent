import { expect, it } from "vitest";
import { collectTerminalProcesses, parseProcessTable } from "./process-tree.js";

const table = ` 10 1 ttys004 Wed Nov  4 13:00:00 2026 S /bin/zsh
 11 10 ttys004 Wed Nov  4 13:00:01 2026 S /usr/local/bin/node
 12 11 ttys004 Wed Nov  4 13:00:02 2026 S /bin/sleep
 13 10 ?? Wed Nov  4 13:00:02 2026 S /usr/bin/detached
 14 10 ttys004 Wed Nov  4 13:00:02 2026 Z /bin/zombie
 99 1 ttys005 Wed Nov  4 13:00:00 2026 S /bin/other`;
it("finds terminal descendants and names, excluding detached and dead processes", () => {
  const rows = withSessions(table);
  expect(
    collectTerminalProcesses(rows, rows[0], [], 10).map(({ pid, name }) => ({
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
  const initial = withSessions(table);
  const later =
    withSessions(`10 1 ttys004 Wed Nov  4 13:01:00 2026 S /bin/unrelated
11 1 ttys004 Wed Nov  4 13:00:01 2026 S /usr/local/bin/node
15 11 ttys004 Wed Nov  4 13:00:03 2026 S /bin/sleep
16 10 ttys004 Wed Nov  4 13:01:01 2026 S /bin/unrelated-child`);
  expect(
    collectTerminalProcesses(
      later,
      initial[0],
      initial.slice(1, 3),
      10,
      true,
    ).map(({ pid }) => pid),
  ).toEqual([11, 15]);
});
it("rejects a malformed process-table observation instead of reporting an idle terminal", () => {
  expect(() => parseProcessTable("unparseable data")).toThrow();
});
it("captures unobserved same-session orphans while excluding new sessions", () => {
  const initial = withSessions(table);
  const later =
    parseProcessTable(`11 1 ?? Wed Nov  4 13:00:01 2026 S /usr/local/bin/node
13 1 ?? Wed Nov  4 13:00:02 2026 S /usr/bin/detached`).map((row) => ({
      ...row,
      sessionId: row.pid === 11 ? 10 : 13,
    }));
  expect(
    collectTerminalProcesses(later, initial[0], [], 10, true).map(
      ({ pid }) => pid,
    ),
  ).toEqual([11]);
});
it("reads Linux session IDs independently of a vanished controlling tty", () => {
  expect(
    parseProcessTable(
      "11 1 ? Wed Nov  4 13:00:01 2026 S 10 /bin/node",
      true,
    )[0],
  ).toMatchObject({ pid: 11, sessionId: 10, name: "node" });
});

function withSessions(text: string): ReturnType<typeof parseProcessTable> {
  return parseProcessTable(text).map((row) => ({
    ...row,
    sessionId: row.tty === "ttys004" ? 10 : row.pid,
  }));
}
it("keeps ownership of an already captured identity that later changes sessions", () => {
  const initial = withSessions(table);
  const captured = initial[1];
  const moved = { ...captured, parentPid: 1, sessionId: captured.pid };
  const newChild = {
    ...initial[2],
    parentPid: moved.pid,
    sessionId: moved.pid,
  };
  expect(
    collectTerminalProcesses([moved, newChild], initial[0], [captured], 10).map(
      ({ pid }) => pid,
    ),
  ).toEqual([11, 12]);
});
it("continues an established session when old members fork then disappear between scans", () => {
  const initial = withSessions(table);
  const successor = { ...initial[2], parentPid: 1, tty: "??" };
  expect(
    collectTerminalProcesses(
      [successor],
      initial[0],
      [initial[1]],
      10,
      true,
    ).map(({ pid }) => pid),
  ).toEqual([12]);
  expect(
    collectTerminalProcesses([successor], initial[0], [], 10, false),
  ).toEqual([]);
});
