import {
  Box,
  Text,
  measureElement,
  useBoxMetrics,
  useInput,
  useWindowSize,
  type DOMElement,
} from "ink";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  LayoutProvider,
  TranscriptDocumentContext,
  TranscriptAnchorContext,
  TranscriptWindowContext,
  TodoPanelRefContext,
} from "./context.js";
import { computeLayoutMetrics } from "./metrics.js";
import { useTranscriptMouse } from "../hooks/use-transcript-mouse.js";

/** One screen owner; the complete document scrolls independently of the dock. */
export function FullscreenShell({
  output,
  priorityDock,
  children,
  identity,
  scrollEnabled,
}: {
  readonly output: ReactNode;
  readonly priorityDock: boolean;
  readonly children: ReactNode;
  readonly identity?: string;
  readonly scrollEnabled: boolean;
}): ReactElement {
  const anchors = useRef(new Map<string, DOMElement>());
  const anchor = useRef<{ id: string; row: number } | null>(null);
  const dimensions = useWindowSize();
  const layout = computeLayoutMetrics(dimensions);
  const dockRef = useRef<DOMElement>(null);
  const todoRef = useRef<DOMElement>(null);
  const dock = useBoxMetrics(dockRef);
  const todo = useBoxMetrics(todoRef);
  const viewportRef = useRef<DOMElement>(null);
  const documentRef = useRef<DOMElement>(null);
  const viewport = useBoxMetrics(viewportRef);
  const document = useBoxMetrics(documentRef);
  // null means follow the document end. A number is a pinned document row.
  const [position, setPosition] = useState<number | null>(null);
  useEffect(() => {
    anchor.current = null;
    setPosition(null);
  }, [identity]);
  const end = Math.max(0, document.height - viewport.height);
  const offset = position === null ? end : Math.min(position, end);
  const selectPosition = (next: number): void => {
    anchor.current = null;
    let nearest = -1;
    for (const [id, node] of anchors.current) {
      const box = measureElement(node);
      if (box.y <= next && box.y >= nearest) {
        nearest = box.y;
        anchor.current = {
          id,
          row: Math.min(next - box.y, Math.max(0, box.height - 1)),
        };
      }
    }
    setPosition(next >= end ? null : next);
  };
  const scroll = (delta: number): void => {
    selectPosition(Math.max(0, Math.min(end, offset + delta)));
  };
  // A document row alone is not an identity: prepending history and reflowing
  // earlier messages must keep the reader attached to the same message.
  useLayoutEffect(() => {
    const target = anchor.current;
    const node = target && anchors.current.get(target.id);
    if (position === null || !target || !node) return;
    const box = measureElement(node);
    const next = Math.min(
      end,
      box.y + Math.min(target.row, Math.max(0, box.height - 1)),
    );
    if (next !== position) setPosition(next);
  });
  useInput(
    (value, key) => {
      if (key.ctrl && (value === "b" || value === "f")) {
        scroll((value === "f" ? 1 : -1) * Math.max(1, viewport.height - 1));
        return;
      }
      if (!key.shift) return;
      if (key.pageUp || key.pageDown)
        scroll((key.pageDown ? 1 : -1) * Math.max(1, viewport.height - 1));
      else if (key.home) selectPosition(0);
      else if (key.end) setPosition(null);
    },
    { isActive: scrollEnabled },
  );
  useTranscriptMouse(({ delta, y }) => {
    if (scrollEnabled && y < viewport.height) scroll(delta * 3);
  });
  const height = Math.max(1, layout.rows - 1);
  const minimumDocumentRows = priorityDock
    ? 1
    : Math.min(3, Math.max(1, height - 6));
  const dockRows = Math.max(1, height - minimumDocumentRows);
  const metrics = {
    ...layout,
    // Tasks can never claim the document's share of the screen.
    todoPanelRows: Math.max(
      1,
      Math.min(
        6,
        Math.floor(layout.rows / 4),
        dock.hasMeasured ? dockRows - (dock.height - todo.height) : 3,
      ),
    ),
    approvalRows: Math.max(0, dockRows - (priorityDock ? 2 : 3)),
  };
  return (
    <LayoutProvider value={metrics}>
      <Box
        width={layout.columns}
        height={height}
        paddingX={layout.horizontalPadding}
        flexDirection="column"
        alignItems="center"
      >
        <Box width={layout.contentWidth} height={height} flexDirection="column">
          <Box
            ref={viewportRef}
            minHeight={minimumDocumentRows}
            flexGrow={1}
            flexShrink={1}
            flexBasis={0}
            overflow="hidden"
            contentOffsetY={offset}
            flexDirection="column"
          >
            <Box ref={documentRef} flexDirection="column" flexShrink={0}>
              <TranscriptAnchorContext.Provider value={anchors.current}>
                <TranscriptWindowContext.Provider
                  value={{ top: offset, height: viewport.height }}
                >
                  <TranscriptDocumentContext.Provider value={true}>
                    {output}
                  </TranscriptDocumentContext.Provider>
                </TranscriptWindowContext.Provider>
              </TranscriptAnchorContext.Provider>
            </Box>
          </Box>
          <Box
            flexShrink={0}
            maxHeight={dockRows}
            flexDirection="column"
            overflow="hidden"
            justifyContent="flex-end"
          >
            <Box ref={dockRef} flexShrink={0} flexDirection="column">
              {!priorityDock ? (
                <Text dimColor wrap="truncate-end">
                  {position === null
                    ? "─".repeat(layout.contentWidth)
                    : "History · Ctrl+B/F scroll · Shift+End latest"}
                </Text>
              ) : null}
              <TodoPanelRefContext.Provider value={todoRef}>
                {children}
              </TodoPanelRefContext.Provider>
            </Box>
          </Box>
        </Box>
      </Box>
    </LayoutProvider>
  );
}
