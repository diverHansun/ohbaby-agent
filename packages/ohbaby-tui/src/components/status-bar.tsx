import { Text } from "ink";
import type { ReactElement } from "react";
import {
  selectEffectiveRuntime,
  selectRuntimeLabel,
} from "../store/selectors.js";
import type { TuiStoreState } from "../store/snapshot.js";

export interface StatusBarProps {
  readonly state: TuiStoreState;
}

export function StatusBar({ state }: StatusBarProps): ReactElement {
  const runtime = selectEffectiveRuntime(state);

  return (
    <Text color={statusColor(state)} dimColor={runtime.kind === "idle"}>
      status: {selectRuntimeLabel(state)}
      {state.activeSessionId === null
        ? ""
        : ` | session: ${state.activeSessionId}`}
      {state.policy === undefined
        ? ""
        : ` | mode: ${state.policy.mode}/${state.policy.agentState}`}
    </Text>
  );
}

function statusColor(state: TuiStoreState): string | undefined {
  switch (selectEffectiveRuntime(state).kind) {
    case "error":
      return "red";
    case "running":
      return "green";
    case "waiting-for-permission":
      return "yellow";
    case "idle":
      return undefined;
  }
}
