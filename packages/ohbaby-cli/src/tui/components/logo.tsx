import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { renderOhbabyLogo } from "../render/logo.js";

export function Logo(): ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {renderOhbabyLogo().map((line, index) => (
        <Text color={index % 2 === 0 ? "cyan" : "yellow"} key={line} bold>
          {line}
        </Text>
      ))}
    </Box>
  );
}
