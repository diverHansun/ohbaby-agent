import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { TuiStoreState } from "../store/snapshot.js";
import { Logo } from "./logo.js";

export interface HeaderProps {
  readonly state: TuiStoreState;
}

export function Header({ state }: HeaderProps): ReactElement {
  const isEmpty = state.messages.length === 0;

  return (
    <Box flexDirection="column">
      {isEmpty ? <Logo /> : null}
      <Box flexDirection="row" marginBottom={isEmpty ? 1 : 0}>
        <Text color="cyan" bold>
          ohbaby
        </Text>
        <Text dimColor> | {state.activeSessionId ?? "new session"}</Text>
      </Box>
    </Box>
  );
}
