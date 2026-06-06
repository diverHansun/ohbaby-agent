import { Box } from "ink";
import type { ReactElement } from "react";
import type { TuiStoreState } from "../store/snapshot.js";
import { Logo } from "./logo.js";

export interface HeaderProps {
  readonly state: TuiStoreState;
}

export function Header({ state }: HeaderProps): ReactElement {
  const isEmpty = state.messages.length === 0;

  return <Box flexDirection="column">{isEmpty ? <Logo /> : null}</Box>;
}
