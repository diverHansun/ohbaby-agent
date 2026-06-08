import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";
import { useTuiLayout } from "../../layout/context.js";
import { useTheme } from "../../theme/index.js";

export interface OverlayCardProps {
  readonly children: ReactNode;
  readonly title: string;
}

export function OverlayCard({
  children,
  title,
}: OverlayCardProps): ReactElement {
  const layout = useTuiLayout();
  const theme = useTheme();
  const width = Math.max(24, Math.min(88, layout.contentWidth));

  return (
    <Box justifyContent="center" width={layout.contentWidth}>
      <Box
        borderColor={theme.border}
        borderStyle="round"
        flexDirection="column"
        paddingX={2}
        paddingY={1}
        width={width}
      >
        <Box justifyContent="space-between">
          <Text bold color={theme.text.headingAccent}>
            {title}
          </Text>
          <Text color={theme.text.muted}>esc</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {children}
        </Box>
      </Box>
    </Box>
  );
}
