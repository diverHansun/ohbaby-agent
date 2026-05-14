import { Text } from "ink";
import type { ReactElement } from "react";
import { selectRuntimeLabel } from "../store/selectors.js";
import type { TuiStoreState } from "../store/snapshot.js";

export interface StatusBarProps {
  readonly state: TuiStoreState;
}

export function StatusBar({ state }: StatusBarProps): ReactElement {
  return (
    <Text dimColor>
      status: {selectRuntimeLabel(state)}
      {state.activeSessionId === null ? "" : ` | session: ${state.activeSessionId}`}
    </Text>
  );
}
