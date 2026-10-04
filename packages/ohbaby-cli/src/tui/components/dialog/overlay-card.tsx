import { Box, Text, useBoxMetrics, useInput, type DOMElement } from "ink";
import {
  createContext,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTuiLayout } from "../../layout/context.js";
import { useTheme } from "../../theme/index.js";

export const OverlayBodyRowsContext = createContext<number | undefined>(
  undefined,
);

export interface OverlayCardProps {
  readonly children: ReactNode;
  readonly title: string;
  readonly scrollable?: boolean;
  readonly compact?: boolean;
  readonly bodyRows?: number;
}

export function OverlayCard({
  children,
  title,
  scrollable = false,
  compact = false,
  bodyRows,
}: OverlayCardProps): ReactElement {
  const layout = useTuiLayout();
  const theme = useTheme();
  const width = Math.max(1, Math.min(88, layout.contentWidth));
  const contentRef = useRef<DOMElement>(null);
  const content = useBoxMetrics(contentRef);
  const [position, setPosition] = useState(0);
  const end = Math.max(0, content.height - (bodyRows ?? content.height));
  useInput(
    (_value, key) => {
      if (key.shift) return;
      if (key.pageDown)
        setPosition((current) =>
          Math.min(end, current + Math.max(1, (bodyRows ?? 1) - 1)),
        );
      if (key.pageUp)
        setPosition((current) =>
          Math.max(0, current - Math.max(1, (bodyRows ?? 1) - 1)),
        );
    },
    { isActive: bodyRows !== undefined && scrollable },
  );

  return (
    <Box justifyContent="center" width={layout.contentWidth}>
      <Box
        borderColor={theme.border}
        borderStyle={compact ? undefined : "round"}
        flexDirection="column"
        paddingX={compact ? 0 : 2}
        paddingY={compact ? 0 : 1}
        width={width}
      >
        <Box justifyContent="space-between">
          <Text bold color={theme.text.headingAccent}>
            {title}
          </Text>
          <Text color={theme.text.muted}>
            {scrollable && end > 0 ? "PgUp/PgDn · esc" : "esc"}
          </Text>
        </Box>
        <Box
          flexDirection="column"
          marginTop={compact ? 0 : 1}
          maxHeight={bodyRows}
          overflow={bodyRows !== undefined ? "hidden" : undefined}
          contentOffsetY={scrollable ? Math.min(position, end) : 0}
        >
          <Box ref={contentRef} flexDirection="column" flexShrink={0}>
            <OverlayBodyRowsContext.Provider value={bodyRows}>
              {children}
            </OverlayBodyRowsContext.Provider>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
