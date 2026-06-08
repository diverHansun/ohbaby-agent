import { Box, useStdout } from "ink";
import type { ReactElement, ReactNode } from "react";
import { LayoutProvider } from "./context.js";
import { computeLayoutMetrics } from "./metrics.js";

export interface AppShellProps {
  readonly children: ReactNode;
}

export function AppShell({ children }: AppShellProps): ReactElement {
  const { stdout } = useStdout();
  const metrics = computeLayoutMetrics({
    columns: stdout.columns,
    rows: stdout.rows,
  });

  return (
    <LayoutProvider value={metrics}>
      <Box
        alignItems="center"
        flexDirection="column"
        paddingLeft={metrics.horizontalPadding}
        paddingRight={metrics.horizontalPadding}
        width={metrics.columns}
      >
        <Box flexDirection="column" width={metrics.contentWidth}>
          {children}
        </Box>
      </Box>
    </LayoutProvider>
  );
}
