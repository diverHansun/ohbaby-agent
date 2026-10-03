import type { createSubagentReader, UiSubagentReaderState } from "ohbaby-sdk";
import { useMemo, useSyncExternalStore } from "react";

type SubagentReader = Pick<
  ReturnType<typeof createSubagentReader>,
  "getSnapshot" | "subscribe"
>;

/** Subscribe to the root summary, or the complete reader while browsing it. */
export function useSubagentState(
  reader: SubagentReader,
  browserOpen: boolean,
): UiSubagentReaderState {
  const getSnapshot = useMemo(() => {
    let cached: UiSubagentReaderState | undefined;
    return (): UiSubagentReaderState => {
      const next = reader.getSnapshot();
      if (browserOpen || !cached || !sameRootSummary(cached, next)) {
        cached = next;
      }
      return cached;
    };
  }, [reader, browserOpen]);
  return useSyncExternalStore(reader.subscribe, getSnapshot);
}

function sameRootSummary(
  previous: UiSubagentReaderState,
  next: UiSubagentReaderState,
): boolean {
  const a = previous.list;
  const b = next.list;
  if (
    (a?.executions.length ?? 0) !== (b?.executions.length ?? 0) ||
    Boolean(a?.waiting) !== Boolean(b?.waiting)
  ) {
    return false;
  }
  // Counts and approval state are only rendered while the root is waiting.
  return (
    !b?.waiting ||
    (a?.activeCount === b.activeCount &&
      a.completedCount === b.completedCount &&
      a.approvalBlocked === b.approvalBlocked)
  );
}
