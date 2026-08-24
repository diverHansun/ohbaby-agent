import type { ToolDefinition } from "../../core/tool-scheduler/index.js";
import type { McpToolMenuScope } from "./dynamic-tool-menu.js";

export interface ScopeToolSnapshot {
  readonly epoch: number;
  readonly tools: readonly ToolDefinition[];
}

interface ScopeToolState {
  epoch: number;
  order: string[];
  signatures: Map<string, string>;
  tools: Map<string, ToolDefinition>;
}

function scopeKey(scope: McpToolMenuScope): string {
  return `${scope.sessionId}\u0000${scope.contextScopeId ?? ""}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function signature(tool: ToolDefinition): string {
  return JSON.stringify(stableValue(tool));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

export class ScopeToolSequence {
  private readonly states = new Map<string, ScopeToolState>();

  snapshot(
    scope: McpToolMenuScope,
    visibleTools: readonly ToolDefinition[],
  ): ScopeToolSnapshot {
    const key = scopeKey(scope);
    const previous = this.states.get(key);
    const incoming = new Map(
      visibleTools.map((tool) => [tool.name, structuredClone(tool)]),
    );
    if (previous === undefined) {
      const state: ScopeToolState = {
        epoch: 0,
        order: [...incoming.keys()],
        signatures: new Map(
          [...incoming].map(([name, tool]) => [name, signature(tool)]),
        ),
        tools: incoming,
      };
      this.states.set(key, state);
      return this.freezeSnapshot(state);
    }

    let changed = false;
    for (const name of [...previous.order]) {
      if (!incoming.has(name)) {
        previous.order = previous.order.filter(
          (candidate) => candidate !== name,
        );
        previous.signatures.delete(name);
        previous.tools.delete(name);
        changed = true;
      }
    }
    for (const [name, tool] of incoming) {
      const nextSignature = signature(tool);
      if (!previous.tools.has(name)) {
        previous.order.push(name);
        previous.tools.set(name, tool);
        previous.signatures.set(name, nextSignature);
        changed = true;
      } else if (previous.signatures.get(name) !== nextSignature) {
        previous.tools.set(name, tool);
        previous.signatures.set(name, nextSignature);
        changed = true;
      }
    }
    if (changed) {
      previous.epoch += 1;
    }

    return this.freezeSnapshot(previous);
  }

  disposeScope(sessionId: string, contextScopeId: string): void {
    this.states.delete(scopeKey({ sessionId, contextScopeId }));
  }

  disposeSession(sessionId: string): void {
    for (const key of this.states.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) {
        this.states.delete(key);
      }
    }
  }

  private freezeSnapshot(state: ScopeToolState): ScopeToolSnapshot {
    return deepFreeze({
      epoch: state.epoch,
      tools: state.order.flatMap((name) => {
        const tool = state.tools.get(name);
        return tool === undefined ? [] : [structuredClone(tool)];
      }),
    });
  }
}
