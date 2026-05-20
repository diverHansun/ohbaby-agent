import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { TuiStoreState } from "../store/snapshot.js";
import { StatusBar } from "./status-bar.js";

export interface FooterProps {
  readonly state: TuiStoreState;
}

export function Footer({ state }: FooterProps): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <StatusBar state={state} />
      <Text dimColor>
        / for commands | Shift+Tab mode | Ctrl+C aborts a running prompt
      </Text>
    </Box>
  );
}
