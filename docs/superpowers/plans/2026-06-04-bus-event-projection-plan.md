# Bus Event Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `Bus` as the internal domain event bus, move UI/app stream conversion into explicit projectors, remove global Bus fallback, and use Phase 3 tests to decide whether per-session bus is needed.

**Architecture:** Phase 1 adds a typed projection layer for pure Commands/Interaction events and a separate stateful Permission projection. Phase 2 establishes per-backend Bus ownership by removing production use of the global `Bus` singleton. Phase 3 creates an event catalog and scope tests for Message, Context, Memory, ToolScheduler, Permission, Session, Commands, and Interaction payloads.

**Tech Stack:** TypeScript, Vitest, Zod-backed `BusEvent.define`, `ohbaby-sdk` `UiEvent`, in-memory `StreamBridge`.

---

## Boundaries

This plan implements the agreed direction from `docs/bus/improve-1/`:

- `Bus` remains a synchronous internal domain event bus.
- No `BusOptions.onPublish`, no `createSessionBus`, and no automatic `Bus.publish()` to UI bridge.
- `run/{runId}` events continue through `StreamBridge` and `run-stream-adapter`; do not route them through Bus projectors.
- Phase 1 does not change Message, Context, Memory, ToolScheduler, or Session payloads.
- Phase 4 per-session bus is not implemented here. Phase 3 produces evidence for or against it.

## File Structure

- Create `packages/ohbaby-agent/src/adapters/app-events/projectors.ts`
  - Pure mapping from `CommandsEvent` and `InteractionEvent` payloads to SDK `UiEvent` values.
  - Owns `ProjectedAppEvent`, `AppStreamEvent`, `appEventProjectors`, and `toAppStreamEvent()`.
- Create `packages/ohbaby-agent/src/adapters/app-events/subscriptions.ts`
  - Subscribes all pure projectors to a `BusInstance` and calls a target callback.
  - Owns subscription disposal and projection error handling.
- Create `packages/ohbaby-agent/src/adapters/app-events/permission-projection.ts`
  - Stateful Permission event projection for in-process UI only.
  - Owns `toUiPermissionRequest()` and subscription wiring, but not `respondPermission`.
- Create `packages/ohbaby-agent/src/adapters/app-events/index.ts`
  - Re-export the projection helpers.
- Create tests:
  - `packages/ohbaby-agent/src/adapters/app-events/projectors.unit.test.ts`
  - `packages/ohbaby-agent/src/adapters/app-events/subscriptions.unit.test.ts`
  - `packages/ohbaby-agent/src/adapters/app-events/permission-projection.unit.test.ts`
- Modify:
  - `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
  - `packages/ohbaby-agent/src/runtime/daemon/command-events.ts`
  - `packages/ohbaby-agent/src/runtime/daemon/app-events.ts`
  - `packages/ohbaby-agent/src/runtime/daemon/types.ts`
  - `packages/ohbaby-agent/src/runtime/daemon/bootstrap.ts`
  - `packages/ohbaby-agent/src/runtime/daemon/command-events.unit.test.ts`
  - `packages/ohbaby-agent/src/runtime/daemon/bootstrap.integration.test.ts`
  - `packages/ohbaby-agent/src/permission/manager.ts`
  - `packages/ohbaby-agent/src/permission/state.ts`
  - `packages/ohbaby-agent/src/permission/index.ts`
  - `packages/ohbaby-agent/src/bus/index.ts`
- Create Phase 3 catalog:
  - `packages/ohbaby-agent/src/bus/event-catalog.ts`
  - `packages/ohbaby-agent/src/bus/event-catalog.contract.test.ts`
  - `docs/bus/event-catalog.md`

---

### Task 1: Phase 1A Pure App Event Projectors

**Files:**
- Create: `packages/ohbaby-agent/src/adapters/app-events/projectors.ts`
- Create: `packages/ohbaby-agent/src/adapters/app-events/projectors.unit.test.ts`
- Create: `packages/ohbaby-agent/src/adapters/app-events/index.ts`

- [ ] **Step 1: Write failing projector tests**

Add `packages/ohbaby-agent/src/adapters/app-events/projectors.unit.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { CommandsEvent } from "../../commands/index.js";
import { InteractionEvent } from "../../runtime/interaction-broker/index.js";
import { appEventProjectors, toAppStreamEvent } from "./projectors.js";

function projectorFor(type: string) {
  const projector = appEventProjectors.find(
    (candidate) => candidate.event.type === type,
  );
  if (!projector) {
    throw new Error(`Missing projector for ${type}`);
  }
  return projector;
}

describe("app event projectors", () => {
  it("projects CommandsEvent.Started to command.started", () => {
    const projected = projectorFor(CommandsEvent.Started.type).project({
      clientInvocationId: "inv_1",
      commandId: "status",
      commandRunId: "cmd_1",
      path: ["status"],
      sessionId: "session_1",
      surface: "tui",
      timestamp: 1,
    });

    expect(projected).toEqual({
      type: "command.started",
      uiEvent: {
        type: "command.started",
        command: {
          clientInvocationId: "inv_1",
          commandId: "status",
          commandRunId: "cmd_1",
          path: ["status"],
          sessionId: "session_1",
          surface: "tui",
        },
        timestamp: 1,
      },
    });
  });

  it("projects CommandsEvent.ResultDelivered and omits undefined fields from stream data", () => {
    const projected = projectorFor(CommandsEvent.ResultDelivered.type).project({
      clientInvocationId: "inv_1",
      commandRunId: "cmd_1",
      timestamp: 2,
    });

    expect(projected).toEqual({
      type: "command.result.delivered",
      uiEvent: {
        type: "command.result.delivered",
        clientInvocationId: "inv_1",
        commandRunId: "cmd_1",
        timestamp: 2,
      },
    });
    expect(toAppStreamEvent(projected!)).toEqual({
      type: "command.result.delivered",
      data: {
        clientInvocationId: "inv_1",
        commandRunId: "cmd_1",
        timestamp: 2,
      },
    });
  });

  it("projects CommandsEvent.Failed to command.failed", () => {
    const projected = projectorFor(CommandsEvent.Failed.type).project({
      clientInvocationId: "inv_2",
      commandRunId: "cmd_2",
      error: { code: "INVALID_ARGS", message: "bad args" },
      timestamp: 3,
    });

    expect(projected).toEqual({
      type: "command.failed",
      uiEvent: {
        type: "command.failed",
        clientInvocationId: "inv_2",
        commandRunId: "cmd_2",
        error: { code: "INVALID_ARGS", message: "bad args" },
        timestamp: 3,
      },
    });
  });

  it("projects CommandsEvent.CatalogUpdated to command.catalog.updated", () => {
    const projected = projectorFor(CommandsEvent.CatalogUpdated.type).project({
      reason: "reload",
      timestamp: 4,
      version: "catalog_1",
    });

    expect(projected).toEqual({
      type: "command.catalog.updated",
      uiEvent: {
        type: "command.catalog.updated",
        reason: "reload",
        timestamp: 4,
        version: "catalog_1",
      },
    });
  });

  it("projects InteractionEvent.Requested to interaction.requested", () => {
    const request = {
      clientInvocationId: "inv_3",
      commandRunId: "cmd_3",
      interactionId: "interaction_1",
      kind: "select-one" as const,
      subject: "model",
    };

    const projected = projectorFor(InteractionEvent.Requested.type).project({
      request,
      timestamp: 5,
    });

    expect(projected).toEqual({
      type: "interaction.requested",
      uiEvent: {
        type: "interaction.requested",
        request,
        timestamp: 5,
      },
    });
  });

  it("projects InteractionEvent.Resolved to interaction.resolved status", () => {
    const projected = projectorFor(InteractionEvent.Resolved.type).project({
      clientInvocationId: "inv_3",
      commandRunId: "cmd_3",
      interactionId: "interaction_1",
      response: { kind: "cancelled", reason: "user-cancelled" },
      timestamp: 6,
    });

    expect(projected).toEqual({
      type: "interaction.resolved",
      uiEvent: {
        type: "interaction.resolved",
        clientInvocationId: "inv_3",
        commandRunId: "cmd_3",
        interactionId: "interaction_1",
        status: "cancelled",
        timestamp: 6,
      },
    });
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/adapters/app-events/projectors.unit.test.ts
```

Expected: FAIL because `projectors.ts` does not exist.

- [ ] **Step 3: Implement the projector table**

Add `packages/ohbaby-agent/src/adapters/app-events/projectors.ts`:

```typescript
import type { UiEvent } from "ohbaby-sdk";
import type {
  BusEventDefinition,
  BusEventPayload,
} from "../../bus/index.js";
import { CommandsEvent } from "../../commands/index.js";
import { InteractionEvent } from "../../runtime/interaction-broker/index.js";

export type AppProjectedUiEvent = Extract<
  UiEvent,
  {
    readonly type:
      | "command.started"
      | "command.result.delivered"
      | "command.failed"
      | "command.catalog.updated"
      | "interaction.requested"
      | "interaction.resolved";
  }
>;

export type ProjectedAppEvent =
  | {
      readonly type: "command.started";
      readonly uiEvent: Extract<AppProjectedUiEvent, { type: "command.started" }>;
    }
  | {
      readonly type: "command.result.delivered";
      readonly uiEvent: Extract<
        AppProjectedUiEvent,
        { type: "command.result.delivered" }
      >;
    }
  | {
      readonly type: "command.failed";
      readonly uiEvent: Extract<AppProjectedUiEvent, { type: "command.failed" }>;
    }
  | {
      readonly type: "command.catalog.updated";
      readonly uiEvent: Extract<
        AppProjectedUiEvent,
        { type: "command.catalog.updated" }
      >;
    }
  | {
      readonly type: "interaction.requested";
      readonly uiEvent: Extract<
        AppProjectedUiEvent,
        { type: "interaction.requested" }
      >;
    }
  | {
      readonly type: "interaction.resolved";
      readonly uiEvent: Extract<
        AppProjectedUiEvent,
        { type: "interaction.resolved" }
      >;
    };

export interface AppStreamEvent {
  readonly type: ProjectedAppEvent["type"];
  readonly data: Record<string, unknown>;
}

export interface AppEventProjector {
  readonly event: BusEventDefinition;
  project(payload: unknown): ProjectedAppEvent | undefined;
}

function withDefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function defineProjector<Event extends BusEventDefinition>(
  event: Event,
  project: (payload: BusEventPayload<Event>) => ProjectedAppEvent | undefined,
): AppEventProjector {
  return {
    event,
    project(payload: unknown): ProjectedAppEvent | undefined {
      return project(payload as BusEventPayload<Event>);
    },
  };
}

export const appEventProjectors = [
  defineProjector(CommandsEvent.Started, (payload) => ({
    type: "command.started",
    uiEvent: {
      type: "command.started",
      command: withDefined({
        commandRunId: payload.commandRunId,
        clientInvocationId: payload.clientInvocationId,
        commandId: payload.commandId,
        path: payload.path,
        sessionId: payload.sessionId,
        surface: payload.surface,
      }) as Extract<
        AppProjectedUiEvent,
        { type: "command.started" }
      >["command"],
      timestamp: payload.timestamp,
    },
  })),
  defineProjector(CommandsEvent.ResultDelivered, (payload) => ({
    type: "command.result.delivered",
    uiEvent: withDefined({
      type: "command.result.delivered",
      commandRunId: payload.commandRunId,
      clientInvocationId: payload.clientInvocationId,
      output: payload.output,
      action: payload.action,
      timestamp: payload.timestamp,
    }) as Extract<AppProjectedUiEvent, { type: "command.result.delivered" }>,
  })),
  defineProjector(CommandsEvent.Failed, (payload) => ({
    type: "command.failed",
    uiEvent: {
      type: "command.failed",
      commandRunId: payload.commandRunId,
      clientInvocationId: payload.clientInvocationId,
      error: payload.error,
      timestamp: payload.timestamp,
    },
  })),
  defineProjector(CommandsEvent.CatalogUpdated, (payload) => ({
    type: "command.catalog.updated",
    uiEvent: withDefined({
      type: "command.catalog.updated",
      version: payload.version,
      reason: payload.reason,
      timestamp: payload.timestamp,
    }) as Extract<AppProjectedUiEvent, { type: "command.catalog.updated" }>,
  })),
  defineProjector(InteractionEvent.Requested, (payload) => ({
    type: "interaction.requested",
    uiEvent: {
      type: "interaction.requested",
      request: payload.request,
      timestamp: payload.timestamp,
    },
  })),
  defineProjector(InteractionEvent.Resolved, (payload) => ({
    type: "interaction.resolved",
    uiEvent: withDefined({
      type: "interaction.resolved",
      interactionId: payload.interactionId,
      commandRunId: payload.commandRunId,
      clientInvocationId: payload.clientInvocationId,
      status: payload.response.kind,
      timestamp: payload.timestamp,
    }) as Extract<AppProjectedUiEvent, { type: "interaction.resolved" }>,
  })),
] as const;

export function toAppStreamEvent(event: ProjectedAppEvent): AppStreamEvent {
  const { type, ...data } = event.uiEvent;
  return { type, data: withDefined(data as Record<string, unknown>) };
}
```

Add `packages/ohbaby-agent/src/adapters/app-events/index.ts`:

```typescript
export {
  appEventProjectors,
  toAppStreamEvent,
  type AppEventProjector,
  type AppProjectedUiEvent,
  type AppStreamEvent,
  type ProjectedAppEvent,
} from "./projectors.js";
```

- [ ] **Step 4: Run the projector test**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/adapters/app-events/projectors.unit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/ohbaby-agent/src/adapters/app-events/projectors.ts packages/ohbaby-agent/src/adapters/app-events/projectors.unit.test.ts packages/ohbaby-agent/src/adapters/app-events/index.ts
git commit -m "refactor: add explicit app event projectors"
```

---

### Task 2: Phase 1A Subscription Helper And Daemon Adapter

**Files:**
- Create: `packages/ohbaby-agent/src/adapters/app-events/subscriptions.ts`
- Create: `packages/ohbaby-agent/src/adapters/app-events/subscriptions.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/adapters/app-events/index.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/command-events.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/app-events.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/types.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/bootstrap.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/command-events.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/bootstrap.integration.test.ts`

- [ ] **Step 1: Write failing subscription tests**

Add `packages/ohbaby-agent/src/adapters/app-events/subscriptions.unit.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { BusEvent, createBus } from "../../bus/index.js";
import { CommandsEvent } from "../../commands/index.js";
import { subscribeAppEventProjectors } from "./subscriptions.js";
import type { ProjectedAppEvent } from "./projectors.js";
import { z } from "zod";

describe("subscribeAppEventProjectors", () => {
  it("subscribes known projector events and disposes them", () => {
    const bus = createBus();
    const projected: ProjectedAppEvent[] = [];
    const unsubscribe = subscribeAppEventProjectors({
      bus,
      target(event) {
        projected.push(event);
      },
    });

    bus.publish(CommandsEvent.CatalogUpdated, {
      reason: "reload",
      timestamp: 10,
      version: "catalog_2",
    });
    unsubscribe();
    bus.publish(CommandsEvent.CatalogUpdated, {
      reason: "after-dispose",
      timestamp: 11,
      version: "catalog_3",
    });

    expect(projected).toEqual([
      {
        type: "command.catalog.updated",
        uiEvent: {
          type: "command.catalog.updated",
          reason: "reload",
          timestamp: 10,
          version: "catalog_2",
        },
      },
    ]);
  });

  it("does not forward arbitrary bus events", () => {
    const bus = createBus();
    const projected: ProjectedAppEvent[] = [];
    const arbitraryEvent = BusEvent.define(
      "daemon.test.arbitrary",
      z.object({ value: z.string() }),
    );

    subscribeAppEventProjectors({
      bus,
      target(event) {
        projected.push(event);
      },
    });

    bus.publish(arbitraryEvent, { value: "hidden" });

    expect(projected).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the failing subscription test**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/adapters/app-events/subscriptions.unit.test.ts
```

Expected: FAIL because `subscriptions.ts` does not exist.

- [ ] **Step 3: Implement subscription helper**

Add `packages/ohbaby-agent/src/adapters/app-events/subscriptions.ts`:

```typescript
import type { BusInstance, BusUnsubscribe } from "../../bus/index.js";
import { appEventProjectors, type ProjectedAppEvent } from "./projectors.js";

export interface AppEventProjectionError {
  readonly eventType: string;
  readonly error: unknown;
}

export interface SubscribeAppEventProjectorsOptions {
  readonly bus: BusInstance;
  readonly target: (event: ProjectedAppEvent) => void;
  readonly onError?: (error: AppEventProjectionError) => void;
}

export function subscribeAppEventProjectors({
  bus,
  target,
  onError,
}: SubscribeAppEventProjectorsOptions): BusUnsubscribe {
  const unsubscribers = appEventProjectors.map((projector) =>
    bus.subscribe(projector.event, (payload) => {
      try {
        const projected = projector.project(payload);
        if (projected) {
          target(projected);
        }
      } catch (error) {
        onError?.({ eventType: projector.event.type, error });
      }
    }),
  );

  return () => {
    for (const unsubscribe of unsubscribers.splice(0)) {
      unsubscribe();
    }
  };
}
```

Modify `packages/ohbaby-agent/src/adapters/app-events/index.ts`:

```typescript
export {
  appEventProjectors,
  toAppStreamEvent,
  type AppEventProjector,
  type AppProjectedUiEvent,
  type AppStreamEvent,
  type ProjectedAppEvent,
} from "./projectors.js";
export {
  subscribeAppEventProjectors,
  type AppEventProjectionError,
  type SubscribeAppEventProjectorsOptions,
} from "./subscriptions.js";
```

- [ ] **Step 4: Replace daemon command adapter with shared projector**

Replace `packages/ohbaby-agent/src/runtime/daemon/command-events.ts` with:

```typescript
import {
  subscribeAppEventProjectors,
  toAppStreamEvent,
} from "../../adapters/app-events/index.js";
import type { DaemonEventAdapter, DaemonEventAdapterDeps } from "./types.js";

export function startCommandEventAdapter({
  bus,
  streamBridge,
}: DaemonEventAdapterDeps): DaemonEventAdapter {
  const unsubscribe = subscribeAppEventProjectors({
    bus,
    target(projected) {
      const event = toAppStreamEvent(projected);
      streamBridge.publish("app", event.type, event.data);
    },
  });

  return {
    dispose(): void {
      unsubscribe();
    },
  };
}
```

Replace `packages/ohbaby-agent/src/runtime/daemon/app-events.ts` with:

```typescript
import type { DaemonEventAdapter, DaemonEventAdapterDeps } from "./types.js";

export function startAppEventAdapter(
  _deps: DaemonEventAdapterDeps,
): DaemonEventAdapter {
  return {
    dispose(): void {
      // App-scoped Bus events must use explicit projectors.
    },
  };
}
```

Modify `packages/ohbaby-agent/src/runtime/daemon/types.ts`:

```typescript
export interface DaemonEventAdapterDeps {
  readonly bus: BusInstance;
  readonly streamBridge: StreamBridge;
}
```

Remove these fields from `RuntimeBootstrapOptions`:

```typescript
readonly appEventDefinitions?: readonly BusEventDefinition[];
readonly commandEventDefinitions?: readonly BusEventDefinition[];
```

Modify `packages/ohbaby-agent/src/runtime/daemon/bootstrap.ts` so adapter start calls no longer pass event definitions:

```typescript
appEvents = (options.startAppEventAdapter ?? startAppEventAdapter)({
  bus,
  streamBridge,
});
commandEvents = (options.startCommandEventAdapter ?? startCommandEventAdapter)({
  bus,
  streamBridge,
});
```

- [ ] **Step 5: Update daemon tests**

In `packages/ohbaby-agent/src/runtime/daemon/command-events.unit.test.ts`, add `CommandsEvent.CatalogUpdated` before the dispose assertion:

```typescript
bus.publish(CommandsEvent.CatalogUpdated, {
  reason: "reload",
  timestamp: 6,
  version: "catalog_1",
});
```

Add this expected item before the dispose section:

```typescript
{
  data: {
    reason: "reload",
    timestamp: 6,
    version: "catalog_1",
  },
  event: "command.catalog.updated",
  scope: "app",
}
```

Update the final length assertion from `5` to `6`.

In `packages/ohbaby-agent/src/runtime/daemon/bootstrap.integration.test.ts`, replace the test named `adapts configured bus events into the app stream and disposes subscriptions` with:

```typescript
it("does not generically forward arbitrary bus events into the app stream", async () => {
  const bus = createBus();
  const calls: string[] = [];
  const bridge = new RecordingStreamBridge(calls);
  const arbitraryEvent = BusEvent.define(
    "daemon.test.app",
    z.object({ value: z.string() }),
  );
  const runtime = bootstrapRuntime({
    bus,
    runManager: new RecordingRunManager(calls),
    streamBridge: bridge,
  });

  await runtime.start();

  bus.publish(arbitraryEvent, { value: "one" });

  expect(bridge.published).toEqual([]);

  await runtime.stop();
});
```

- [ ] **Step 6: Run daemon and projection tests**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/adapters/app-events/projectors.unit.test.ts packages/ohbaby-agent/src/adapters/app-events/subscriptions.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/command-events.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/bootstrap.integration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add packages/ohbaby-agent/src/adapters/app-events/subscriptions.ts packages/ohbaby-agent/src/adapters/app-events/subscriptions.unit.test.ts packages/ohbaby-agent/src/adapters/app-events/index.ts packages/ohbaby-agent/src/runtime/daemon/command-events.ts packages/ohbaby-agent/src/runtime/daemon/app-events.ts packages/ohbaby-agent/src/runtime/daemon/types.ts packages/ohbaby-agent/src/runtime/daemon/bootstrap.ts packages/ohbaby-agent/src/runtime/daemon/command-events.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/bootstrap.integration.test.ts
git commit -m "refactor: route daemon app events through explicit projectors"
```

---

### Task 3: Phase 1A In-Process UI Uses The Same Projectors

**Files:**
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
- Test: `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`

- [ ] **Step 1: Update imports**

In `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`, replace the command and interaction imports:

```typescript
import { CommandsEvent, createCommandService } from "../commands/index.js";
import {
  createInteractionBroker,
  InteractionEvent,
} from "../runtime/interaction-broker/index.js";
```

with:

```typescript
import { createCommandService } from "../commands/index.js";
import { createInteractionBroker } from "../runtime/interaction-broker/index.js";
import { subscribeAppEventProjectors } from "./app-events/index.js";
```

- [ ] **Step 2: Replace duplicated Commands/Interaction subscriptions**

In `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`, remove the five direct subscriptions for:

- `CommandsEvent.Started`
- `CommandsEvent.ResultDelivered`
- `CommandsEvent.Failed`
- `InteractionEvent.Requested`
- `InteractionEvent.Resolved`

Add this in the same location:

```typescript
subscribeAppEventProjectors({
  bus,
  target(projected) {
    publish(projected.uiEvent);
  },
});
```

This intentionally adds the same `CommandsEvent.CatalogUpdated` projection to in-process UI that daemon already had. The `UiEvent` union already contains `command.catalog.updated`.

- [ ] **Step 3: Run in-process UI contract tests**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
```

Expected: PASS. If an assertion depends on `command.catalog.updated` not being emitted, update the assertion to treat it as an allowed app-scoped UI event.

- [ ] **Step 4: Run Phase 1A regression tests**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/adapters/app-events/projectors.unit.test.ts packages/ohbaby-agent/src/adapters/app-events/subscriptions.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/command-events.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/bootstrap.integration.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add packages/ohbaby-agent/src/adapters/ui-inprocess.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
git commit -m "refactor: share app event projectors in in-process UI"
```

---

### Task 4: Phase 1B Stateful Permission Projection

**Files:**
- Create: `packages/ohbaby-agent/src/adapters/app-events/permission-projection.ts`
- Create: `packages/ohbaby-agent/src/adapters/app-events/permission-projection.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/adapters/app-events/index.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`

- [ ] **Step 1: Write failing Permission projection tests**

Add `packages/ohbaby-agent/src/adapters/app-events/permission-projection.unit.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { UiEvent, UiPermissionRequest, UiRunStatus } from "ohbaby-sdk";
import { createBus } from "../../bus/index.js";
import { PermissionEvent } from "../../permission/index.js";
import type { UiStateStore } from "../ui-state/index.js";
import { startPermissionEventProjection } from "./permission-projection.js";

class RecordingPermissionStore
  implements Pick<UiStateStore, "upsertPermission" | "removePermission">
{
  readonly upserted: UiPermissionRequest[] = [];
  readonly removed: string[] = [];
  failUpsert = false;

  upsertPermission(request: UiPermissionRequest): Promise<void> {
    if (this.failUpsert) {
      return Promise.reject(new Error("upsert failed"));
    }
    this.upserted.push(request);
    return Promise.resolve();
  }

  removePermission(requestId: string): Promise<void> {
    this.removed.push(requestId);
    return Promise.resolve();
  }
}

function permissionInfo() {
  return {
    callId: "call_1",
    id: "permission_1",
    messageId: "message_1",
    metadata: {
      params: { command: "pwd" },
      rememberable: true,
      toolName: "bash",
    },
    name: "bash",
    pattern: "bash:pwd",
    sessionId: "session_1",
    time: { created: 1 },
    title: "Allow bash?",
    type: "bash" as const,
  };
}

describe("startPermissionEventProjection", () => {
  it("publishes permission.updated for mode, level, and rule changes", () => {
    const bus = createBus();
    const events: UiEvent[] = [];

    startPermissionEventProjection({
      bus,
      currentPermissionState: () => ({
        level: "default",
        mode: "auto",
        sessionRules: [],
      }),
      getActiveRunId: () => "run_1",
      now: () => 10,
      pendingPermissionSessions: new Map(),
      publish: (event) => events.push(event),
      reconcileRuntimeStatus: () => Promise.resolve({ kind: "idle" }),
      stateStore: new RecordingPermissionStore(),
    });

    bus.publish(PermissionEvent.ModeChanged, {
      current: "plan",
      previous: "auto",
    });
    bus.publish(PermissionEvent.LevelChanged, {
      current: "full-access",
      previous: "default",
    });
    bus.publish(PermissionEvent.RuleAdded, {
      rule: {
        decision: "allow",
        pattern: "bash:pwd",
        scope: "session",
        tool: "bash",
      },
      sessionId: "session_1",
    });

    expect(events.map((event) => event.type)).toEqual([
      "permission.updated",
      "permission.updated",
      "permission.updated",
    ]);
  });

  it("converts PermissionEvent.Updated into permission.requested and stores pending session", async () => {
    const bus = createBus();
    const store = new RecordingPermissionStore();
    const events: UiEvent[] = [];
    const pendingPermissionSessions = new Map<string, string>();
    const statuses: UiRunStatus[] = [];

    startPermissionEventProjection({
      bus,
      currentPermissionState: () => ({
        level: "default",
        mode: "auto",
        sessionRules: [],
      }),
      getActiveRunId: () => "run_1",
      now: () => 20,
      pendingPermissionSessions,
      publish: (event) => events.push(event),
      reconcileRuntimeStatus: () => {
        const status: UiRunStatus = { kind: "waiting-for-permission", requestId: "permission_1" };
        statuses.push(status);
        return Promise.resolve(status);
      },
      stateStore: store,
    });

    bus.publish(PermissionEvent.Updated, { info: permissionInfo() });
    await Promise.resolve();
    await Promise.resolve();

    expect(pendingPermissionSessions.get("permission_1")).toBe("session_1");
    expect(store.upserted[0]).toMatchObject({
      id: "permission_1",
      runId: "run_1",
      title: "Allow bash?",
    });
    expect(events).toContainEqual({
      type: "permission.requested",
      request: store.upserted[0],
      timestamp: 20,
    });
    expect(statuses).toHaveLength(1);
  });

  it("preserves legacy no-active-run callId fallback without treating callId as run scope", async () => {
    const bus = createBus();
    const store = new RecordingPermissionStore();

    startPermissionEventProjection({
      bus,
      currentPermissionState: () => ({
        level: "default",
        mode: "auto",
        sessionRules: [],
      }),
      getActiveRunId: () => undefined,
      now: () => 30,
      pendingPermissionSessions: new Map(),
      publish: () => undefined,
      reconcileRuntimeStatus: () => Promise.resolve({ kind: "idle" }),
      stateStore: store,
    });

    bus.publish(PermissionEvent.Updated, { info: permissionInfo() });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.upserted[0]?.runId).toBe("call_1");
  });

  it("converts PermissionEvent.Replied into permission.resolved and removes pending request", async () => {
    const bus = createBus();
    const store = new RecordingPermissionStore();
    const events: UiEvent[] = [];
    const pendingPermissionSessions = new Map([["permission_1", "session_1"]]);

    startPermissionEventProjection({
      bus,
      currentPermissionState: () => ({
        level: "default",
        mode: "auto",
        sessionRules: [],
      }),
      getActiveRunId: () => "run_1",
      now: () => 40,
      pendingPermissionSessions,
      publish: (event) => events.push(event),
      reconcileRuntimeStatus: () => Promise.resolve({ kind: "idle" }),
      stateStore: store,
    });

    bus.publish(PermissionEvent.Replied, {
      callId: "call_1",
      permissionId: "permission_1",
      response: { type: "once" },
      sessionId: "session_1",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(pendingPermissionSessions.has("permission_1")).toBe(false);
    expect(store.removed).toEqual(["permission_1"]);
    expect(events).toContainEqual({
      type: "permission.resolved",
      requestId: "permission_1",
      timestamp: 40,
    });
  });

  it("reports async projection errors without creating unhandled rejections", async () => {
    const bus = createBus();
    const store = new RecordingPermissionStore();
    const errors: unknown[] = [];
    store.failUpsert = true;

    startPermissionEventProjection({
      bus,
      currentPermissionState: () => ({
        level: "default",
        mode: "auto",
        sessionRules: [],
      }),
      getActiveRunId: () => "run_1",
      now: () => 50,
      onAsyncError: (error) => errors.push(error),
      pendingPermissionSessions: new Map(),
      publish: () => undefined,
      reconcileRuntimeStatus: () => Promise.resolve({ kind: "idle" }),
      stateStore: store,
    });

    bus.publish(PermissionEvent.Updated, { info: permissionInfo() });
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run the failing Permission projection test**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/adapters/app-events/permission-projection.unit.test.ts
```

Expected: FAIL because `permission-projection.ts` does not exist.

- [ ] **Step 3: Implement Permission projection**

Add `packages/ohbaby-agent/src/adapters/app-events/permission-projection.ts`:

```typescript
import type {
  UiEvent,
  UiPermissionRequest,
  UiRunStatus,
  UiSnapshot,
} from "ohbaby-sdk";
import type { BusInstance, BusUnsubscribe } from "../../bus/index.js";
import {
  isRememberablePermissionPattern,
  PermissionEvent,
  type PermissionInfo,
} from "../../permission/index.js";
import type { UiStateStore } from "../ui-state/index.js";

type UiPermissionState = NonNullable<UiSnapshot["permission"]>;

export interface PermissionEventProjectionOptions {
  readonly bus: BusInstance;
  readonly currentPermissionState: () => UiPermissionState;
  readonly getActiveRunId: () => string | undefined;
  readonly now: () => number;
  readonly onAsyncError?: (error: unknown) => void;
  readonly pendingPermissionSessions: Map<string, string>;
  readonly publish: (event: UiEvent) => void;
  readonly reconcileRuntimeStatus: () => Promise<UiRunStatus>;
  readonly stateStore: Pick<
    UiStateStore,
    "upsertPermission" | "removePermission"
  >;
}

export function toUiPermissionRequest(input: {
  readonly info: PermissionInfo;
  readonly runId: string;
}): UiPermissionRequest {
  const allowAlways =
    input.info.metadata.rememberable !== false &&
    isRememberablePermissionPattern(input.info.pattern);
  return {
    id: input.info.id,
    runId: input.runId,
    title: input.info.title,
    description: input.info.pattern,
    choices: [
      { id: "allow_once", label: "Allow once", intent: "allow" },
      ...(allowAlways
        ? [
            {
              id: "allow_always",
              label: "Always allow",
              intent: "allow",
            } as const,
          ]
        : []),
      { id: "reject", label: "Reject", intent: "deny" },
      { id: "cancel", label: "Cancel run", intent: "abort" },
    ],
  };
}

function runProjection(
  options: PermissionEventProjectionOptions,
  action: () => Promise<void>,
): void {
  void action().catch((error) => {
    options.onAsyncError?.(error);
  });
}

export function startPermissionEventProjection(
  options: PermissionEventProjectionOptions,
): BusUnsubscribe {
  const unsubscribers = [
    options.bus.subscribe(PermissionEvent.ModeChanged, () => {
      options.publish({
        type: "permission.updated",
        permission: options.currentPermissionState(),
        timestamp: options.now(),
      });
    }),
    options.bus.subscribe(PermissionEvent.LevelChanged, () => {
      options.publish({
        type: "permission.updated",
        permission: options.currentPermissionState(),
        timestamp: options.now(),
      });
    }),
    options.bus.subscribe(PermissionEvent.RuleAdded, () => {
      options.publish({
        type: "permission.updated",
        permission: options.currentPermissionState(),
        timestamp: options.now(),
      });
    }),
    options.bus.subscribe(PermissionEvent.Updated, (payload) => {
      runProjection(options, async () => {
        const activeRunId = options.getActiveRunId();
        const request = toUiPermissionRequest({
          info: payload.info,
          // Legacy fallback: callId is used only to preserve current no-active-run UI behavior.
          runId: activeRunId ?? payload.info.callId,
        });
        options.pendingPermissionSessions.set(
          payload.info.id,
          payload.info.sessionId,
        );
        await options.stateStore.upsertPermission(request);
        await options.reconcileRuntimeStatus();
        options.publish({
          type: "permission.requested",
          request,
          timestamp: options.now(),
        });
      });
    }),
    options.bus.subscribe(PermissionEvent.Replied, (payload) => {
      runProjection(options, async () => {
        options.pendingPermissionSessions.delete(payload.permissionId);
        await options.stateStore.removePermission(payload.permissionId);
        options.publish({
          type: "permission.resolved",
          requestId: payload.permissionId,
          timestamp: options.now(),
        });
        await options.reconcileRuntimeStatus();
      });
    }),
  ];

  return () => {
    for (const unsubscribe of unsubscribers.splice(0)) {
      unsubscribe();
    }
  };
}
```

Modify `packages/ohbaby-agent/src/adapters/app-events/index.ts`:

```typescript
export {
  appEventProjectors,
  toAppStreamEvent,
  type AppEventProjector,
  type AppProjectedUiEvent,
  type AppStreamEvent,
  type ProjectedAppEvent,
} from "./projectors.js";
export {
  subscribeAppEventProjectors,
  type AppEventProjectionError,
  type SubscribeAppEventProjectorsOptions,
} from "./subscriptions.js";
export {
  startPermissionEventProjection,
  toUiPermissionRequest,
  type PermissionEventProjectionOptions,
} from "./permission-projection.js";
```

- [ ] **Step 4: Refactor in-process Permission subscriptions**

In `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`, remove `isRememberablePermissionPattern` from the permission import and add `startPermissionEventProjection` to the app-events import:

```typescript
import {
  startPermissionEventProjection,
  subscribeAppEventProjectors,
} from "./app-events/index.js";
```

Delete the local `toUiPermissionRequest()` function.

Replace the five direct `PermissionEvent.*` subscriptions with:

```typescript
startPermissionEventProjection({
  bus,
  currentPermissionState,
  getActiveRunId: () => activeRunId,
  now: () => Date.now(),
  pendingPermissionSessions,
  publish,
  reconcileRuntimeStatus,
  stateStore,
});
```

Keep `pendingPermissionSessions` in `ui-inprocess.ts`; the projection receives the map but does not own `respondPermission`.

- [ ] **Step 5: Run Permission and UI regression tests**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/adapters/app-events/permission-projection.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts packages/ohbaby-agent/src/permission/
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add packages/ohbaby-agent/src/adapters/app-events/permission-projection.ts packages/ohbaby-agent/src/adapters/app-events/permission-projection.unit.test.ts packages/ohbaby-agent/src/adapters/app-events/index.ts packages/ohbaby-agent/src/adapters/ui-inprocess.ts
git commit -m "refactor: extract stateful permission event projection"
```

---

### Task 5: Phase 2A Remove Production Global Bus Fallback

**Files:**
- Modify: `packages/ohbaby-agent/src/permission/manager.ts`
- Modify: `packages/ohbaby-agent/src/permission/state.ts`
- Modify: `packages/ohbaby-agent/src/permission/index.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/bootstrap.ts`
- Modify tests under `packages/ohbaby-agent/src/permission/` and `packages/ohbaby-agent/src/runtime/daemon/bootstrap.integration.test.ts`

- [ ] **Step 1: Write failing bootstrap ownership test**

Add this test to `packages/ohbaby-agent/src/runtime/daemon/bootstrap.integration.test.ts`:

```typescript
it("creates an isolated bus when none is provided", () => {
  const first = bootstrapRuntime({
    runManager: new RecordingRunManager([]),
  });
  const second = bootstrapRuntime({
    runManager: new RecordingRunManager([]),
  });

  expect(first.bus).not.toBe(second.bus);
});

it("uses the provided bus when supplied", () => {
  const bus = createBus();
  const runtime = bootstrapRuntime({
    bus,
    runManager: new RecordingRunManager([]),
  });

  expect(runtime.bus).toBe(bus);
});
```

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/runtime/daemon/bootstrap.integration.test.ts
```

Expected: FAIL for the first new test because `bootstrapRuntime()` currently uses the global `Bus` singleton.

- [ ] **Step 2: Require explicit Bus in Permission manager and state**

In `packages/ohbaby-agent/src/permission/state.ts`, replace:

```typescript
import { Bus, type BusInstance } from "../bus/index.js";
```

with:

```typescript
import type { BusInstance } from "../bus/index.js";
```

Change `PermissionStateOptions`:

```typescript
export interface PermissionStateOptions {
  readonly bus: BusInstance;
  readonly initialMode?: Mode;
  readonly initialLevel?: Level;
}
```

Change `createPermissionState`:

```typescript
export function createPermissionState(
  options: PermissionStateOptions,
): PermissionStateStore {
  const bus = options.bus;
```

In `packages/ohbaby-agent/src/permission/manager.ts`, replace:

```typescript
import { Bus, type BusInstance } from "../bus/index.js";
```

with:

```typescript
import type { BusInstance } from "../bus/index.js";
```

Change `PermissionManagerOptions`:

```typescript
export interface PermissionManagerOptions {
  readonly bus: BusInstance;
  readonly generateId?: () => string;
  readonly now?: () => number;
  readonly state?: PermissionStateStore;
}
```

Change `createPermissionManager`:

```typescript
export function createPermissionManager(
  options: PermissionManagerOptions,
): PermissionManager {
  const bus = options.bus;
```

- [ ] **Step 3: Remove legacy global Permission object**

In `packages/ohbaby-agent/src/permission/index.ts`, remove:

```typescript
import { Bus } from "../bus/index.js";
import { PermissionEvent } from "./events.js";
import { createPermissionManager } from "./manager.js";
```

Replace them with:

```typescript
import { PermissionEvent } from "./events.js";
```

Delete this export:

```typescript
export const Permission = {
  Event: PermissionEvent,
  ...createPermissionManager({ bus: Bus }),
} as const;
```

Keep this namespace-style export:

```typescript
export { PermissionEvent } from "./events.js";
```

- [ ] **Step 4: Update call sites and tests**

Run:

```bash
rg -n "createPermission(State|Manager)\\(\\)" packages tests
rg -n "createPermission(State|Manager)\\(\\{" packages tests
```

For any `createPermissionState()` call, pass an explicit bus:

```typescript
const bus = createBus();
const state = createPermissionState({ bus });
```

For any `createPermissionManager()` call, pass an explicit bus:

```typescript
const bus = createBus();
const permission = createPermissionManager({ bus });
```

When a test already has a bus and a state, keep both on the same bus:

```typescript
const bus = createBus();
const state = createPermissionState({ bus });
const permission = createPermissionManager({ bus, state });
```

- [ ] **Step 5: Replace daemon global Bus fallback**

In `packages/ohbaby-agent/src/runtime/daemon/bootstrap.ts`, replace:

```typescript
import { Bus } from "../../bus/index.js";
```

with:

```typescript
import { createBus } from "../../bus/index.js";
```

Replace:

```typescript
const bus = options.bus ?? Bus;
```

with:

```typescript
const bus = options.bus ?? createBus();
```

- [ ] **Step 6: Run Phase 2A tests**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/permission/ packages/ohbaby-agent/src/runtime/daemon/bootstrap.integration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add packages/ohbaby-agent/src/permission/manager.ts packages/ohbaby-agent/src/permission/state.ts packages/ohbaby-agent/src/permission/index.ts packages/ohbaby-agent/src/runtime/daemon/bootstrap.ts packages/ohbaby-agent/src/permission packages/ohbaby-agent/src/runtime/daemon/bootstrap.integration.test.ts
git commit -m "refactor: remove production global bus fallback"
```

---

### Task 6: Phase 2B Delete Global Bus Export

**Files:**
- Modify: `packages/ohbaby-agent/src/bus/index.ts`
- Modify any remaining imports found by `rg`

- [ ] **Step 1: Verify no production imports remain**

Run:

```bash
rg -n "import \\{ Bus" packages tests
rg -n "\\bBus\\." packages tests
```

Expected before implementation: no production `Bus` singleton imports remain after Task 5. If tests still import `Bus`, replace them with `createBus()`.

- [ ] **Step 2: Delete the singleton export**

In `packages/ohbaby-agent/src/bus/index.ts`, remove:

```typescript
import { createBus } from "./bus.js";
import type { BusInstance } from "./types.js";
```

Remove:

```typescript
export const Bus: BusInstance = createBus();
```

Keep:

```typescript
export { BusEvent } from "./bus-event.js";
export { createBus } from "./bus.js";
export type { BusEventDefinition, BusEventPayload } from "./bus-event.js";
export type {
  BusInstance,
  BusCallback,
  BusOptions,
  BusSubscriberError,
  BusUnsubscribe,
} from "./types.js";
```

- [ ] **Step 3: Run hard governance checks**

Run:

```bash
rg -n "import \\{ Bus" packages tests
rg -n "\\bBus\\." packages tests
pnpm typecheck
pnpm vitest run packages/ohbaby-agent/src/bus/ packages/ohbaby-agent/src/permission/ packages/ohbaby-agent/src/runtime/daemon/
```

Expected: `rg` commands return no singleton usage, typecheck passes, and targeted tests pass.

- [ ] **Step 4: Commit Task 6**

```bash
git add packages/ohbaby-agent/src/bus/index.ts
git commit -m "refactor: remove global bus singleton export"
```

---

### Task 7: Phase 3 Event Catalog And Scope Contract Tests

**Files:**
- Create: `packages/ohbaby-agent/src/bus/event-catalog.ts`
- Create: `packages/ohbaby-agent/src/bus/event-catalog.contract.test.ts`
- Create: `docs/bus/event-catalog.md`
- Modify: event payload files only if the contract test exposes a decision already agreed in docs

- [ ] **Step 1: Add event catalog source**

Create `packages/ohbaby-agent/src/bus/event-catalog.ts`:

```typescript
import { CommandsEvent } from "../commands/index.js";
import { ContextEvent } from "../core/context/index.js";
import { MemoryEvent } from "../core/memory/index.js";
import { MessageEvent } from "../core/message/index.js";
import { ToolSchedulerEvent } from "../core/tool-scheduler/index.js";
import { PermissionEvent } from "../permission/index.js";
import { SessionEvent } from "../services/session/index.js";
import { InteractionEvent } from "../runtime/interaction-broker/index.js";
import type { BusEventDefinition } from "./index.js";

export type BusEventScope = "app" | "project" | "session" | "run";
export type BusEventAudience = "domain" | "ui-projection" | "daemon" | "tests";
export type BusEventFrequency = "low" | "medium" | "high";
export type BusEventContextStatus = "complete" | "known-gap";
export type BusEventUiVisibility = "yes" | "no" | "via-projector";

export interface BusEventCatalogEntry {
  readonly event: BusEventDefinition;
  readonly owner: string;
  readonly scope: BusEventScope;
  readonly audience: readonly BusEventAudience[];
  readonly frequency: BusEventFrequency;
  readonly requiredContext: readonly string[];
  readonly contextStatus: BusEventContextStatus;
  readonly uiVisible: BusEventUiVisibility;
  readonly decision: string;
}

export const allBusEvents = [
  CommandsEvent.Started,
  CommandsEvent.ResultDelivered,
  CommandsEvent.Failed,
  CommandsEvent.CatalogUpdated,
  InteractionEvent.Requested,
  InteractionEvent.Resolved,
  PermissionEvent.ModeChanged,
  PermissionEvent.LevelChanged,
  PermissionEvent.RuleAdded,
  PermissionEvent.Updated,
  PermissionEvent.Replied,
  MessageEvent.Updated,
  MessageEvent.Removed,
  MessageEvent.PartUpdated,
  MessageEvent.PartRemoved,
  ContextEvent.Compressed,
  ContextEvent.Pruned,
  ContextEvent.TurnPrepared,
  ContextEvent.CompactSkipped,
  MemoryEvent.Added,
  MemoryEvent.Updated,
  MemoryEvent.Removed,
  MemoryEvent.Refreshed,
  ToolSchedulerEvent.StatusChanged,
  ToolSchedulerEvent.ExecutionStarted,
  ToolSchedulerEvent.ExecutionCompleted,
  SessionEvent.Created,
  SessionEvent.Updated,
  SessionEvent.Removed,
] as const;

export const busEventCatalog: readonly BusEventCatalogEntry[] = [
  {
    event: CommandsEvent.Started,
    owner: "Commands",
    scope: "app",
    audience: ["ui-projection", "daemon", "tests"],
    frequency: "medium",
    requiredContext: ["commandRunId", "clientInvocationId", "timestamp"],
    contextStatus: "complete",
    uiVisible: "via-projector",
    decision: "Projected by Phase 1A app event projectors.",
  },
  {
    event: CommandsEvent.ResultDelivered,
    owner: "Commands",
    scope: "app",
    audience: ["ui-projection", "daemon", "tests"],
    frequency: "medium",
    requiredContext: ["commandRunId", "clientInvocationId", "timestamp"],
    contextStatus: "complete",
    uiVisible: "via-projector",
    decision: "Projected by Phase 1A app event projectors.",
  },
  {
    event: CommandsEvent.Failed,
    owner: "Commands",
    scope: "app",
    audience: ["ui-projection", "daemon", "tests"],
    frequency: "low",
    requiredContext: ["commandRunId", "clientInvocationId", "timestamp"],
    contextStatus: "complete",
    uiVisible: "via-projector",
    decision: "Projected by Phase 1A app event projectors.",
  },
  {
    event: CommandsEvent.CatalogUpdated,
    owner: "Commands",
    scope: "app",
    audience: ["ui-projection", "daemon", "tests"],
    frequency: "low",
    requiredContext: ["version", "timestamp"],
    contextStatus: "complete",
    uiVisible: "via-projector",
    decision: "Projected by Phase 1A app event projectors.",
  },
  {
    event: InteractionEvent.Requested,
    owner: "Interaction",
    scope: "app",
    audience: ["ui-projection", "daemon", "tests"],
    frequency: "medium",
    requiredContext: ["request.interactionId", "request.commandRunId", "timestamp"],
    contextStatus: "complete",
    uiVisible: "via-projector",
    decision: "Projected by Phase 1A app event projectors.",
  },
  {
    event: InteractionEvent.Resolved,
    owner: "Interaction",
    scope: "app",
    audience: ["ui-projection", "daemon", "tests"],
    frequency: "medium",
    requiredContext: ["interactionId", "commandRunId", "timestamp"],
    contextStatus: "complete",
    uiVisible: "via-projector",
    decision: "Projected by Phase 1A app event projectors.",
  },
  {
    event: PermissionEvent.ModeChanged,
    owner: "Permission",
    scope: "app",
    audience: ["ui-projection", "tests"],
    frequency: "low",
    requiredContext: ["current", "previous"],
    contextStatus: "complete",
    uiVisible: "yes",
    decision: "Stateful in-process projection publishes permission.updated.",
  },
  {
    event: PermissionEvent.LevelChanged,
    owner: "Permission",
    scope: "app",
    audience: ["ui-projection", "tests"],
    frequency: "low",
    requiredContext: ["current", "previous"],
    contextStatus: "complete",
    uiVisible: "yes",
    decision: "Stateful in-process projection publishes permission.updated.",
  },
  {
    event: PermissionEvent.RuleAdded,
    owner: "Permission",
    scope: "session",
    audience: ["ui-projection", "tests"],
    frequency: "low",
    requiredContext: ["sessionId", "rule"],
    contextStatus: "complete",
    uiVisible: "yes",
    decision: "Stateful in-process projection publishes permission.updated.",
  },
  {
    event: PermissionEvent.Updated,
    owner: "Permission",
    scope: "run",
    audience: ["ui-projection", "tests"],
    frequency: "medium",
    requiredContext: ["info.sessionId", "info.messageId", "info.callId", "info.id"],
    contextStatus: "complete",
    uiVisible: "yes",
    decision: "Stateful in-process projection publishes permission.requested; callId fallback remains legacy.",
  },
  {
    event: PermissionEvent.Replied,
    owner: "Permission",
    scope: "run",
    audience: ["ui-projection", "tests"],
    frequency: "medium",
    requiredContext: ["sessionId", "permissionId", "callId"],
    contextStatus: "complete",
    uiVisible: "yes",
    decision: "Stateful in-process projection publishes permission.resolved.",
  },
  {
    event: MessageEvent.Updated,
    owner: "Message",
    scope: "session",
    audience: ["domain", "tests"],
    frequency: "medium",
    requiredContext: ["info.sessionId", "info.id"],
    contextStatus: "complete",
    uiVisible: "no",
    decision: "Do not project directly because SDK has a different message.updated payload.",
  },
  {
    event: MessageEvent.Removed,
    owner: "Message",
    scope: "session",
    audience: ["domain", "tests"],
    frequency: "low",
    requiredContext: ["sessionId", "messageId"],
    contextStatus: "complete",
    uiVisible: "no",
    decision: "Internal domain event only.",
  },
  {
    event: MessageEvent.PartUpdated,
    owner: "Message",
    scope: "session",
    audience: ["domain", "tests"],
    frequency: "high",
    requiredContext: ["part.sessionId", "part.messageId", "part.id"],
    contextStatus: "complete",
    uiVisible: "no",
    decision: "Do not project directly because run stream owns message.part.delta.",
  },
  {
    event: MessageEvent.PartRemoved,
    owner: "Message",
    scope: "session",
    audience: ["domain", "tests"],
    frequency: "low",
    requiredContext: ["sessionId", "messageId", "partId"],
    contextStatus: "complete",
    uiVisible: "no",
    decision: "Internal domain event only.",
  },
  {
    event: ContextEvent.Compressed,
    owner: "Context",
    scope: "session",
    audience: ["domain", "tests"],
    frequency: "low",
    requiredContext: ["sessionId", "result"],
    contextStatus: "complete",
    uiVisible: "no",
    decision: "Internal domain event only.",
  },
  {
    event: ContextEvent.Pruned,
    owner: "Context",
    scope: "session",
    audience: ["domain", "tests"],
    frequency: "low",
    requiredContext: ["sessionId", "result"],
    contextStatus: "complete",
    uiVisible: "no",
    decision: "Internal domain event only.",
  },
  {
    event: ContextEvent.TurnPrepared,
    owner: "Context",
    scope: "session",
    audience: ["domain", "tests"],
    frequency: "medium",
    requiredContext: ["sessionId", "usage", "tookMs"],
    contextStatus: "complete",
    uiVisible: "no",
    decision: "Run stream owns user-visible run context events.",
  },
  {
    event: ContextEvent.CompactSkipped,
    owner: "Context",
    scope: "session",
    audience: ["domain", "tests"],
    frequency: "low",
    requiredContext: ["sessionId", "reason", "usage"],
    contextStatus: "complete",
    uiVisible: "no",
    decision: "Internal domain event only.",
  },
  {
    event: MemoryEvent.Added,
    owner: "Memory",
    scope: "project",
    audience: ["domain", "tests"],
    frequency: "low",
    requiredContext: ["scope", "text"],
    contextStatus: "known-gap",
    uiVisible: "no",
    decision: "Project memory lacks directory or projectRoot; keep internal until payload decision.",
  },
  {
    event: MemoryEvent.Updated,
    owner: "Memory",
    scope: "project",
    audience: ["domain", "tests"],
    frequency: "low",
    requiredContext: ["scope", "index", "newText"],
    contextStatus: "known-gap",
    uiVisible: "no",
    decision: "Project memory lacks directory or projectRoot; keep internal until payload decision.",
  },
  {
    event: MemoryEvent.Removed,
    owner: "Memory",
    scope: "project",
    audience: ["domain", "tests"],
    frequency: "low",
    requiredContext: ["scope", "index"],
    contextStatus: "known-gap",
    uiVisible: "no",
    decision: "Project memory lacks directory or projectRoot; keep internal until payload decision.",
  },
  {
    event: MemoryEvent.Refreshed,
    owner: "Memory",
    scope: "project",
    audience: ["domain", "tests"],
    frequency: "low",
    requiredContext: ["directory", "memory"],
    contextStatus: "complete",
    uiVisible: "no",
    decision: "Internal domain event only.",
  },
  {
    event: ToolSchedulerEvent.StatusChanged,
    owner: "ToolScheduler",
    scope: "run",
    audience: ["domain", "tests"],
    frequency: "high",
    requiredContext: ["callId", "toolName", "timestamp"],
    contextStatus: "known-gap",
    uiVisible: "no",
    decision: "Missing runId, sessionId, and messageId; run stream owns visible tool events.",
  },
  {
    event: ToolSchedulerEvent.ExecutionStarted,
    owner: "ToolScheduler",
    scope: "run",
    audience: ["domain", "tests"],
    frequency: "high",
    requiredContext: ["callId", "toolName", "timestamp"],
    contextStatus: "known-gap",
    uiVisible: "no",
    decision: "Missing runId, sessionId, and messageId; run stream owns visible tool events.",
  },
  {
    event: ToolSchedulerEvent.ExecutionCompleted,
    owner: "ToolScheduler",
    scope: "run",
    audience: ["domain", "tests"],
    frequency: "high",
    requiredContext: ["callId", "toolName", "timestamp"],
    contextStatus: "known-gap",
    uiVisible: "no",
    decision: "Missing runId, sessionId, and messageId; run stream owns visible tool events.",
  },
  {
    event: SessionEvent.Created,
    owner: "Session",
    scope: "project",
    audience: ["domain", "tests"],
    frequency: "low",
    requiredContext: ["session.id", "session.projectRoot"],
    contextStatus: "complete",
    uiVisible: "no",
    decision: "Domain event; UI session projection remains separate.",
  },
  {
    event: SessionEvent.Updated,
    owner: "Session",
    scope: "project",
    audience: ["domain", "tests"],
    frequency: "low",
    requiredContext: ["session.id", "session.projectRoot"],
    contextStatus: "complete",
    uiVisible: "no",
    decision: "Domain event; UI session projection remains separate.",
  },
  {
    event: SessionEvent.Removed,
    owner: "Session",
    scope: "project",
    audience: ["domain", "tests"],
    frequency: "low",
    requiredContext: ["sessionId"],
    contextStatus: "complete",
    uiVisible: "no",
    decision: "Domain event; UI session projection remains separate.",
  },
];
```

- [ ] **Step 2: Add catalog contract test**

Create `packages/ohbaby-agent/src/bus/event-catalog.contract.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { busEventCatalog, allBusEvents } from "./event-catalog.js";

describe("bus event catalog", () => {
  it("contains every known Bus event exactly once", () => {
    const expected = allBusEvents.map((event) => event.type).sort();
    const actual = busEventCatalog.map((entry) => entry.event.type).sort();

    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("documents every event owner, scope, audience, context, and UI visibility", () => {
    for (const entry of busEventCatalog) {
      expect(entry.owner).not.toBe("");
      expect(entry.audience.length).toBeGreaterThan(0);
      expect(entry.requiredContext.length).toBeGreaterThan(0);
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
      expect(entry.decision).toMatch(/Missing|lacks/);
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
});
```

- [ ] **Step 3: Add human-readable catalog**

Create `docs/bus/event-catalog.md` from `busEventCatalog`. The table must contain these columns:

```markdown
# Bus Event Catalog

| Event | Owner | Scope | Audience | Frequency | Required context | Context status | UI visible | Decision |
|-------|-------|-------|----------|-----------|------------------|----------------|------------|----------|
| commands.started.internal | Commands | app | ui-projection, daemon, tests | medium | commandRunId, clientInvocationId, timestamp | complete | via-projector | Projected by Phase 1A app event projectors. |
| commands.result.delivered.internal | Commands | app | ui-projection, daemon, tests | medium | commandRunId, clientInvocationId, timestamp | complete | via-projector | Projected by Phase 1A app event projectors. |
| commands.failed.internal | Commands | app | ui-projection, daemon, tests | low | commandRunId, clientInvocationId, timestamp | complete | via-projector | Projected by Phase 1A app event projectors. |
| commands.catalog.updated.internal | Commands | app | ui-projection, daemon, tests | low | version, timestamp | complete | via-projector | Projected by Phase 1A app event projectors. |
| interaction.requested.internal | Interaction | app | ui-projection, daemon, tests | medium | request.interactionId, request.commandRunId, timestamp | complete | via-projector | Projected by Phase 1A app event projectors. |
| interaction.resolved.internal | Interaction | app | ui-projection, daemon, tests | medium | interactionId, commandRunId, timestamp | complete | via-projector | Projected by Phase 1A app event projectors. |
| permission.mode.changed | Permission | app | ui-projection, tests | low | current, previous | complete | yes | Stateful in-process projection publishes permission.updated. |
| permission.level.changed | Permission | app | ui-projection, tests | low | current, previous | complete | yes | Stateful in-process projection publishes permission.updated. |
| permission.rule.added | Permission | session | ui-projection, tests | low | sessionId, rule | complete | yes | Stateful in-process projection publishes permission.updated. |
| permission.updated | Permission | run | ui-projection, tests | medium | info.sessionId, info.messageId, info.callId, info.id | complete | yes | Stateful in-process projection publishes permission.requested; callId fallback remains legacy. |
| permission.replied | Permission | run | ui-projection, tests | medium | sessionId, permissionId, callId | complete | yes | Stateful in-process projection publishes permission.resolved. |
| message.updated | Message | session | domain, tests | medium | info.sessionId, info.id | complete | no | Do not project directly because SDK has a different message.updated payload. |
| message.removed | Message | session | domain, tests | low | sessionId, messageId | complete | no | Internal domain event only. |
| message.part-updated | Message | session | domain, tests | high | part.sessionId, part.messageId, part.id | complete | no | Do not project directly because run stream owns message.part.delta. |
| message.part-removed | Message | session | domain, tests | low | sessionId, messageId, partId | complete | no | Internal domain event only. |
| context.compressed | Context | session | domain, tests | low | sessionId, result | complete | no | Internal domain event only. |
| context.pruned | Context | session | domain, tests | low | sessionId, result | complete | no | Internal domain event only. |
| context.turn-prepared | Context | session | domain, tests | medium | sessionId, usage, tookMs | complete | no | Run stream owns user-visible run context events. |
| context.compact-skipped | Context | session | domain, tests | low | sessionId, reason, usage | complete | no | Internal domain event only. |
| memory.added | Memory | project | domain, tests | low | scope, text | known-gap | no | Project memory lacks directory or projectRoot; keep internal until payload decision. |
| memory.updated | Memory | project | domain, tests | low | scope, index, newText | known-gap | no | Project memory lacks directory or projectRoot; keep internal until payload decision. |
| memory.removed | Memory | project | domain, tests | low | scope, index | known-gap | no | Project memory lacks directory or projectRoot; keep internal until payload decision. |
| memory.refreshed | Memory | project | domain, tests | low | directory, memory | complete | no | Internal domain event only. |
| tool-scheduler.status-changed | ToolScheduler | run | domain, tests | high | callId, toolName, timestamp | known-gap | no | Missing runId, sessionId, and messageId; run stream owns visible tool events. |
| tool-scheduler.execution-started | ToolScheduler | run | domain, tests | high | callId, toolName, timestamp | known-gap | no | Missing runId, sessionId, and messageId; run stream owns visible tool events. |
| tool-scheduler.execution-completed | ToolScheduler | run | domain, tests | high | callId, toolName, timestamp | known-gap | no | Missing runId, sessionId, and messageId; run stream owns visible tool events. |
| session.created | Session | project | domain, tests | low | session.id, session.projectRoot | complete | no | Domain event; UI session projection remains separate. |
| session.updated | Session | project | domain, tests | low | session.id, session.projectRoot | complete | no | Domain event; UI session projection remains separate. |
| session.removed | Session | project | domain, tests | low | sessionId | complete | no | Domain event; UI session projection remains separate. |
```

- [ ] **Step 4: Run Phase 3 contract tests**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/bus/event-catalog.contract.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/stream-bridge-run-event-source.unit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 7**

```bash
git add packages/ohbaby-agent/src/bus/event-catalog.ts packages/ohbaby-agent/src/bus/event-catalog.contract.test.ts docs/bus/event-catalog.md
git commit -m "test: document bus event scope contracts"
```

---

### Task 8: Phase 3 Decision Gate

**Files:**
- Modify: `docs/bus/improve-1/03-recommended-design-and-plan.md`
- Modify: `docs/bus/improve-1/04-testing-and-acceptance.md`

- [ ] **Step 1: Record Phase 3 decision**

After Task 7 passes, update `docs/bus/improve-1/03-recommended-design-and-plan.md` under `4.4 per-session bus 决策` with one of these exact conclusions:

```markdown
Phase 3 conclusion: per-backend bus is sufficient.

Reason:
- All direct UI projection paths are explicit.
- Known ToolScheduler and Memory context gaps are not projected to UI.
- Run-scoped user-visible events remain isolated by `StreamBridge` `run/{runId}` scope.

Decision:
- Do not implement Phase 4 now.
- Reopen Phase 4 only if new tests show cross-session leakage or projector filtering becomes complex.
```

or:

```markdown
Phase 3 conclusion: local session-scoped event source is needed for selected events.

Reason:
- Contract tests show `ToolSchedulerEvent.*` cannot be safely routed on a per-backend bus without stable `runId`, `sessionId`, or `messageId`.
- The risk is local to that event family and does not justify a full per-session bus.

Decision:
- Start a new design doc for a local session-scoped event source.
- Do not implement full per-session bus in this phase.
```

or:

```markdown
Phase 3 conclusion: full per-session bus design is needed.

Reason:
- Contract tests show cross-session leakage risk across multiple event families.
- Filtering at projector boundaries would duplicate lifecycle and permission ownership logic.

Decision:
- Start Phase 4 design before implementation.
- Do not patch per-session filtering into projectors as an architectural shortcut.
```

- [ ] **Step 2: Run final regression for Phases 1-3**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/bus/
pnpm vitest run packages/ohbaby-agent/src/adapters/
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-runtime/stream-bridge-run-event-source.unit.test.ts
pnpm vitest run packages/ohbaby-agent/src/runtime/daemon/
pnpm vitest run tests/integration/
pnpm typecheck
pnpm lint
```

Expected: PASS.

- [ ] **Step 3: Commit Task 8**

```bash
git add docs/bus/improve-1/03-recommended-design-and-plan.md docs/bus/improve-1/04-testing-and-acceptance.md
git commit -m "docs: record bus event scope decision"
```

---

## Self-Review

- Spec coverage:
  - Phase 1A explicit projector table: Tasks 1-3.
  - Phase 1B stateful Permission projection: Task 4.
  - Phase 2 per-backend Bus and global fallback cleanup: Tasks 5-6.
  - Phase 3 Message, Context, Memory, ToolScheduler, Session payload audit: Task 7.
  - Phase 4 decision only after tests: Task 8.
- Placeholder scan:
  - The plan contains no open placeholder markers.
  - The Phase 3 decision options name concrete outcomes and do not require template replacement.
- Type consistency:
  - `ProjectedAppEvent.uiEvent` is used for in-process UI.
  - `toAppStreamEvent()` strips `uiEvent.type` into stream `type` and `data`.
  - `pendingPermissionSessions` remains owned by `ui-inprocess.ts`.
  - No step introduces `BusOptions.onPublish`, `createSessionBus`, or Bus auto-bridging.
