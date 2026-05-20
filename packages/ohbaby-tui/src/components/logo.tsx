import { Box, Text } from "ink";
import type { ReactElement } from "react";

export function Logo(): ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan" bold>
        OHBABY
      </Text>
      <Text dimColor>single-process coding agent</Text>
    </Box>
  );
}
