import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { getSlashCompletionCandidates } from "../../command/completions.js";
import { formatCommandHints } from "../../command/hints.js";
import type { TuiCommandCatalog } from "../../store/snapshot.js";

export interface CompletionProps {
  readonly input: string;
  readonly catalog: TuiCommandCatalog | null;
  readonly selectedIndex: number;
}

export function Completion({
  catalog,
  input,
  selectedIndex,
}: CompletionProps): ReactElement {
  const hints = formatCommandHints(
    getSlashCompletionCandidates(input, catalog),
  );

  if (!input.startsWith("/") || hints.length === 0) {
    return <></>;
  }

  return (
    <Box flexDirection="column">
      {hints.map((hint, index) => (
        <Text dimColor key={hint}>
          {index === selectedIndex ? "> " : "  "}
          {hint}
        </Text>
      ))}
    </Box>
  );
}
