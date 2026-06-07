import { Box, Text } from "ink";
import type { ReactElement } from "react";
import {
  getSlashCompletionCandidates,
  getSlashCompletionWindow,
  getSlashCompletionWindowStart,
} from "../../slash-commands/completions.js";
import { formatCommandHints } from "../../slash-commands/hints.js";
import type { TuiCommandCatalog } from "../../store/snapshot.js";
import { useTheme } from "../../theme/index.js";

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
  const theme = useTheme();
  const candidates = getSlashCompletionCandidates(input, catalog);
  const windowStart = getSlashCompletionWindowStart(
    candidates.length,
    selectedIndex,
  );
  const hints = formatCommandHints(
    getSlashCompletionWindow(input, catalog, selectedIndex),
  );
  const selectedWindowIndex = selectedIndex - windowStart;

  if (!input.startsWith("/") || hints.length === 0) {
    return <></>;
  }

  return (
    <Box flexDirection="column">
      {hints.map((hint, index) => (
        <Text
          bold={index === selectedWindowIndex}
          color={
            index === selectedWindowIndex ? theme.status.accent : undefined
          }
          dimColor={index !== selectedWindowIndex}
          key={hint}
        >
          {index === selectedWindowIndex ? "> " : "  "}
          {hint}
        </Text>
      ))}
    </Box>
  );
}
