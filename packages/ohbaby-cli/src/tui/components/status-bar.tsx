import { Text } from "ink";
import type { ReactElement } from "react";
import {
  selectActiveContextWindowUsage,
  selectEffectiveRuntime,
  selectRuntimeLabel,
} from "../store/selectors.js";
import type { TuiStoreState } from "../store/snapshot.js";
import { formatContextWindowUsage } from "../render/usage.js";

export interface StatusBarProps {
  readonly state: TuiStoreState;
}

export function StatusBar({ state }: StatusBarProps): ReactElement {
  const runtime = selectEffectiveRuntime(state);
  const contextWindowUsage = formatContextWindowUsage(
    selectActiveContextWindowUsage(state),
  );

  return (
    <Text color={statusColor(state)} dimColor={runtime.kind === "idle"}>
      status: {selectRuntimeLabel(state)}
      {state.activeSessionId === null
        ? ""
        : ` | session: ${state.activeSessionId}`}
      {contextWindowUsage === "" ? "" : ` | ${contextWindowUsage}`}
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
