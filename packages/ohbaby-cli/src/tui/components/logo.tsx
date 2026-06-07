import Gradient from "ink-gradient";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { useTuiLayout } from "../layout/context.js";
import { renderOhbabyLogo } from "../render/logo.js";
import { useTheme } from "../theme/index.js";

export function Logo(): ReactElement {
  const theme = useTheme();
  const layout = useTuiLayout();
  const lines = renderOhbabyLogo({ maxWidth: layout.contentWidth });
  const logo = lines.join("\n");
  const gradientColors = [
    theme.brandTitle.primary,
    theme.brandTitle.secondary,
    theme.brandTitle.tertiary,
  ];
  const useGradient =
    lines.length > 1 && gradientColors.every((color) => color.startsWith("#"));

  return (
    <Box flexDirection="column" marginBottom={1}>
      {useGradient ? (
        <Gradient colors={gradientColors}>{logo}</Gradient>
      ) : (
        <Text color={theme.brandTitle.primary} bold>
          {logo}
        </Text>
      )}
    </Box>
  );
}
