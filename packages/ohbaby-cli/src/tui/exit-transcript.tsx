import { Box, renderToString } from "ink";
import type { UiMessage } from "ohbaby-sdk";
import { CommittedTranscript } from "./components/transcript/committed-transcript.js";
import { LiveTail } from "./components/transcript/live-tail.js";
import { LayoutProvider, TranscriptDocumentContext } from "./layout/context.js";
import { computeLayoutMetrics } from "./layout/metrics.js";
import type { TuiReasoningViewState } from "./store/snapshot.js";
import type { TranscriptItem } from "./store/transcript.js";
import { ThemeProvider } from "./theme/index.js";

/** Only the visible session document crosses the app's exit boundary. */
export interface ExitTranscript {
  readonly committedItems: readonly TranscriptItem[];
  readonly liveMessage: UiMessage | null;
  readonly liveReasoning?: TuiReasoningViewState;
  readonly toolsExpanded: boolean;
}

export function renderExitTranscript(
  transcript: ExitTranscript,
  columns: number,
): string {
  const layout = computeLayoutMetrics({ columns, rows: 24 });
  return renderToString(
    <ThemeProvider>
      <LayoutProvider value={layout}>
        <TranscriptDocumentContext.Provider value>
          <Box flexDirection="column" paddingX={layout.horizontalPadding}>
            <CommittedTranscript
              items={transcript.committedItems}
              toolsExpanded={transcript.toolsExpanded}
            />
            <LiveTail
              message={transcript.liveMessage}
              reasoning={transcript.liveReasoning}
              toolsExpanded={transcript.toolsExpanded}
            />
          </Box>
        </TranscriptDocumentContext.Provider>
      </LayoutProvider>
    </ThemeProvider>,
    { columns: layout.columns },
  );
}
