import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CommandsEvent } from "../commands/events.js";
import { ContextEvent } from "../core/context/events.js";
import { MemoryEvent } from "../core/memory/events.js";
import { MessageEvent } from "../core/message/events.js";
import { ToolSchedulerEvent } from "../core/tool-scheduler/events.js";
import { PermissionEvent } from "../permission/events.js";
import { InteractionEvent } from "../runtime/interaction-broker/events.js";
import { SessionEvent } from "../services/session/events.js";
import type { BusEventDefinition } from "./bus-event.js";
import {
  allBusEvents,
  busEventCatalog,
  type BusEventCatalogEntry,
} from "./event-catalog.js";

const catalogFields = [
  "audience",
  "contextStatus",
  "decision",
  "event",
  "frequency",
  "owner",
  "requiredContext",
  "scope",
  "uiVisible",
].sort();

type BusEventNamespace = Record<string, BusEventDefinition>;

function eventDefinitions<Events extends BusEventNamespace>(
  events: Events,
): readonly Events[keyof Events][] {
  return Object.values(events) as Events[keyof Events][];
}

function expectedBusEvents(): readonly BusEventDefinition[] {
  return [
    ...eventDefinitions(CommandsEvent),
    ...eventDefinitions(InteractionEvent),
    ...eventDefinitions(PermissionEvent),
    ...eventDefinitions(MessageEvent),
    ...eventDefinitions(ContextEvent),
    ...eventDefinitions(MemoryEvent),
    ...eventDefinitions(ToolSchedulerEvent),
    ...eventDefinitions(SessionEvent),
  ];
}

function asDocRow(entry: BusEventCatalogEntry): readonly string[] {
  return [
    entry.event.type,
    entry.owner,
    entry.scope,
    entry.audience.join(", "),
    entry.frequency,
    entry.requiredContext.join(", "),
    entry.contextStatus,
    entry.uiVisible,
    entry.decision,
  ];
}

function parseTableRow(row: string): readonly string[] {
  return row
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function readDocRows(): readonly (readonly string[])[] {
  const markdown = readFileSync(
    new URL("../../../../docs/bus/event-catalog.md", import.meta.url),
    "utf8",
  );
  const tableRows = markdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"));

  expect(parseTableRow(tableRows[0])).toEqual([
    "Event",
    "Owner",
    "Scope",
    "Audience",
    "Frequency",
    "Required context",
    "Context status",
    "UI visible",
    "Decision",
  ]);

  return tableRows.slice(2).map(parseTableRow);
}

describe("bus event catalog", () => {
  it("contains every known Bus event exactly once", () => {
    const expected = expectedBusEvents().map((event) => event.type);
    const actualEvents = allBusEvents.map((event) => event.type);
    const actualCatalog = busEventCatalog.map((entry) => entry.event.type);

    expect(actualEvents).toEqual(expected);
    expect(actualCatalog).toEqual(expected);
    expect(actualCatalog).toHaveLength(29);
    expect(new Set(actualCatalog).size).toBe(actualCatalog.length);
  });

  it("documents every event owner, scope, audience, context, and UI visibility", () => {
    const allowedScopes = new Set(["app", "project", "session", "run"]);
    const allowedAudience = new Set([
      "daemon",
      "domain",
      "tests",
      "ui-projection",
    ]);
    const allowedFrequencies = new Set(["high", "low", "medium"]);
    const allowedContextStatuses = new Set(["complete", "known-gap"]);
    const allowedUiVisibility = new Set(["no", "via-projector", "yes"]);

    for (const entry of busEventCatalog) {
      expect(Object.keys(entry).sort()).toEqual(catalogFields);
      expect(entry.owner).not.toBe("");
      expect(allowedScopes.has(entry.scope)).toBe(true);
      expect(entry.audience.length).toBeGreaterThan(0);
      expect(
        entry.audience.every((audience) => allowedAudience.has(audience)),
      ).toBe(true);
      expect(allowedFrequencies.has(entry.frequency)).toBe(true);
      expect(entry.requiredContext.length).toBeGreaterThan(0);
      expect(allowedContextStatuses.has(entry.contextStatus)).toBe(true);
      expect(allowedUiVisibility.has(entry.uiVisible)).toBe(true);
      expect(entry.decision).not.toBe("");
    }
  });

  it("allows known run/project context gaps only when documented", () => {
    const knownGaps = busEventCatalog.filter(
      (entry) => entry.contextStatus === "known-gap",
    );

    expect(knownGaps.map((entry) => entry.event.type).sort()).toEqual([
      "memory.added",
      "memory.removed",
      "memory.updated",
      "tool-scheduler.execution-completed",
      "tool-scheduler.execution-started",
      "tool-scheduler.status-changed",
    ]);

    for (const entry of knownGaps) {
      if (entry.owner === "Memory") {
        expect(entry.decision).toContain("lacks directory/projectRoot");
      } else {
        expect(entry.decision).toContain("Missing runId/sessionId/messageId");
      }
    }
  });

  it("keeps Message and ToolScheduler domain events out of direct UI projection", () => {
    const directlyVisible = busEventCatalog.filter(
      (entry) =>
        (entry.owner === "Message" || entry.owner === "ToolScheduler") &&
        entry.uiVisible !== "no",
    );

    expect(directlyVisible).toEqual([]);
  });

  it("documents permission run projection context as stateful projector context", () => {
    const permissionUpdated = busEventCatalog.find(
      (entry) => entry.event.type === PermissionEvent.Updated.type,
    );

    expect(permissionUpdated).toMatchObject({
      contextStatus: "complete",
      scope: "run",
      uiVisible: "yes",
    });
    expect(permissionUpdated?.requiredContext).toContain(
      "projector.activeRunId",
    );
    expect(permissionUpdated?.decision).toContain(
      "Stateful in-process projection supplies active run context",
    );
    expect(permissionUpdated?.decision).toContain("not bus payload scope");
  });

  it("keeps the human-readable catalog synchronized with the source catalog", () => {
    expect(readDocRows()).toEqual(busEventCatalog.map(asDocRow));
  });
});
