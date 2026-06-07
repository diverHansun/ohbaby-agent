import { Box } from "ink";
import type { ReactElement } from "react";
import { Logo } from "./logo.js";

export interface HeaderProps {
  readonly isEmpty: boolean;
}

export function Header({ isEmpty }: HeaderProps): ReactElement {
  return <Box flexDirection="column">{isEmpty ? <Logo /> : null}</Box>;
}
