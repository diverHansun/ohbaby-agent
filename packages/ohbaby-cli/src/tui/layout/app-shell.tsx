import {
  Box,
  useBoxMetrics,
  useWindowSize,
  useStdout,
  type DOMElement,
} from "ink";
import { useMemo, useRef, type ReactElement, type ReactNode } from "react";
import {
  LayoutProvider,
  LiveTailRefContext,
  TodoPanelRefContext,
} from "./context.js";
import { FullscreenShell } from "./fullscreen-shell.js";
import { computeLayoutMetrics } from "./metrics.js";

export function AppShell({
  children,
  output,
  fullscreen = false,
  priorityDock = false,
  identity,
  scrollEnabled = true,
}: {
  readonly children: ReactNode;
  readonly output?: ReactNode;
  readonly fullscreen?: boolean;
  readonly priorityDock?: boolean;
  readonly identity?: string;
  readonly scrollEnabled?: boolean;
}): ReactElement {
  if (fullscreen)
    return (
      <FullscreenShell
        priorityDock={priorityDock}
        output={output}
        identity={identity}
        scrollEnabled={scrollEnabled}
      >
        {children}
      </FullscreenShell>
    );
  return (
    <LegacyAppShell>
      {output}
      {children}
    </LegacyAppShell>
  );
}

/** Budget the live tail from the whole measured dynamic frame. */
function LegacyAppShell({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  const dimensions = useWindowSize();
  const { stdout } = useStdout();
  const isTTY = "isTTY" in stdout && stdout.isTTY === true;
  const root = useRef<DOMElement>(null);
  const liveTail = useRef<DOMElement>(null);
  const todoPanel = useRef<DOMElement>(null);
  const todoMetrics = useBoxMetrics(todoPanel);
  const rootMetrics = useBoxMetrics(root);
  const liveMetrics = useBoxMetrics(liveTail);
  const metrics = useMemo(
    () => computeLayoutMetrics(dimensions),
    [dimensions.columns, dimensions.rows],
  );
  const otherRows = rootMetrics.height - liveMetrics.height;
  // Start with controls alone. A speculative live budget can overflow before
  // the first layout measurement arrives.
  const liveTailRows = !isTTY
    ? metrics.liveTailRows
    : rootMetrics.hasMeasured
      ? Math.max(0, dimensions.rows - 1 - otherRows)
      : 0;
  const todoPanelRows = isTTY
    ? Math.max(3, dimensions.rows - 1 - (otherRows - todoMetrics.height))
    : undefined;
  const layout = useMemo(
    () => ({ ...metrics, liveTailRows, todoPanelRows }),
    [metrics, liveTailRows, todoPanelRows],
  );
  return (
    <LayoutProvider value={layout}>
      <TodoPanelRefContext.Provider value={todoPanel}>
        <LiveTailRefContext.Provider value={liveTail}>
          <Box
            alignItems="center"
            flexDirection="column"
            paddingLeft={metrics.horizontalPadding}
            paddingRight={metrics.horizontalPadding}
            width={metrics.columns}
            // Contain the transitional frame while a newly taller control area
            // is being measured. Anchor the input/dialog end; Static is outside
            // the dynamic layout. Keep measuring the inner natural height below.
            maxHeight={isTTY ? Math.max(1, dimensions.rows - 1) : undefined}
            overflow={isTTY ? "hidden" : undefined}
            justifyContent={isTTY ? "flex-end" : undefined}
          >
            <Box
              ref={root}
              flexShrink={0}
              flexDirection="column"
              width={metrics.contentWidth}
            >
              {children}
            </Box>
          </Box>
        </LiveTailRefContext.Provider>
      </TodoPanelRefContext.Provider>
    </LayoutProvider>
  );
}
