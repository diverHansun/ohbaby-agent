import type { BusInstance } from "../bus/index.js";
import { PermissionEvent } from "./events.js";
import type {
  Level,
  Mode,
  PermissionRule,
  PermissionState,
  PermissionStateStore,
  UiPermissionState,
} from "./types.js";

export interface PermissionStateOptions {
  readonly bus: BusInstance;
  readonly initialMode?: Mode;
  readonly initialLevel?: Level;
}

function cloneRules(
  rules: Map<string, readonly PermissionRule[]>,
): Map<string, readonly PermissionRule[]> {
  return new Map(
    Array.from(rules.entries(), ([sessionId, sessionRules]) => [
      sessionId,
      [...sessionRules],
    ]),
  );
}

export function createPermissionState(
  options: PermissionStateOptions,
): PermissionStateStore {
  const bus = options.bus;
  let mode: Mode = options.initialMode ?? "auto";
  let level: Level = options.initialLevel ?? "default";
  const sessionRules = new Map<string, readonly PermissionRule[]>();

  function getState(): PermissionState {
    return {
      level,
      mode,
      sessionRules: cloneRules(sessionRules),
    };
  }

  function getMode(): Mode {
    return mode;
  }

  function setMode(nextMode: Mode): void {
    if (nextMode === mode) {
      return;
    }
    const previous = mode;
    mode = nextMode;
    bus.publish(PermissionEvent.ModeChanged, { current: mode, previous });
  }

  function toggleMode(): Mode {
    setMode(mode === "auto" ? "plan" : "auto");
    return mode;
  }

  function getLevel(): Level {
    return level;
  }

  function setLevel(nextLevel: Level): void {
    if (nextLevel === level) {
      return;
    }
    const previous = level;
    level = nextLevel;
    bus.publish(PermissionEvent.LevelChanged, { current: level, previous });
  }

  function getSessionRules(sessionId: string): readonly PermissionRule[] {
    return [...(sessionRules.get(sessionId) ?? [])];
  }

  function addSessionRule(sessionId: string, rule: PermissionRule): void {
    const rules = sessionRules.get(sessionId) ?? [];
    sessionRules.set(sessionId, [...rules, rule]);
    bus.publish(PermissionEvent.RuleAdded, { rule, sessionId });
  }

  function clearSession(sessionId: string): void {
    sessionRules.delete(sessionId);
  }

  function toSnapshot(): UiPermissionState {
    return {
      level,
      mode,
      sessionRules: Array.from(
        sessionRules.entries(),
        ([sessionId, rules]) => ({
          rules: [...rules],
          sessionId,
        }),
      ),
    };
  }

  return {
    addSessionRule,
    clearSession,
    getLevel,
    getMode,
    getSessionRules,
    getState,
    setLevel,
    setMode,
    toggleMode,
    toSnapshot,
  };
}
