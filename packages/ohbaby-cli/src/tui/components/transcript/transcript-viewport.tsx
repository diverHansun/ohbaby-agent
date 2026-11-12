import { Box, useStdout } from "ink";
import type { UiMessage, UiNotice, UiRun, UiUnconsumedSteer } from "ohbaby-sdk";
import { useContext, type ReactElement } from "react";
import { TranscriptDocumentContext } from "../../layout/context.js";
import type {
  TuiCommandNotice,
  TuiReasoningViewState,
  TuiRuntimeStatus,
} from "../../store/snapshot.js";
import type { TranscriptItem } from "../../store/transcript.js";
import { WorkingSpinner } from "../working-spinner.js";
import { CommandNoticeLane } from "./command-notice-lane.js";
import {
  CommittedTranscript,
  transcriptAnchorId,
  shouldUseStaticTranscript,
} from "./committed-transcript.js";
import { ReplayableTranscript } from "./replayable-transcript.js";
import { LiveTail } from "./live-tail.js";
import { NoticeLane } from "./notice-lane.js";

export interface TranscriptViewportProps {
  readonly unconsumedSteers?: readonly UiUnconsumedSteer[];
  readonly toolsExpanded?: boolean;
  readonly commandNotices: readonly TuiCommandNotice[];
  readonly committedItems: readonly TranscriptItem[];
  readonly liveMessage: UiMessage | null;
  readonly liveReasoning?: TuiReasoningViewState;
  readonly notices: readonly UiNotice[];
  readonly runtime: TuiRuntimeStatus;
  /** The run behind `runtime`, when the status slot may show it. */
  readonly run?: UiRun;
}

export function TranscriptViewport({
  unconsumedSteers,
  toolsExpanded = false,
  commandNotices,
  committedItems,
  liveMessage,
  liveReasoning,
  notices,
  runtime,
  run,
}: TranscriptViewportProps): ReactElement {
  const { stdout } = useStdout();
  const fullDocument = useContext(TranscriptDocumentContext);
  const useStatic =
    !fullDocument &&
    shouldUseStaticTranscript({
      isTTY: "isTTY" in stdout && stdout.isTTY === true,
    });
  return (
    <Box flexDirection="column">
      {useStatic ? (
        <ReplayableTranscript
          unconsumedSteers={unconsumedSteers}
          items={committedItems}
          liveMessage={liveMessage}
          toolsExpanded={toolsExpanded}
        >
          <CommandNoticeLane commandNotices={commandNotices} />
        </ReplayableTranscript>
      ) : (
        <>
          <CommittedTranscript
            unconsumedSteers={unconsumedSteers}
            items={committedItems}
            toolsExpanded={toolsExpanded}
          />
          <CommandNoticeLane commandNotices={commandNotices} />
          <LiveTail
            anchorId={
              liveMessage
                ? transcriptAnchorId(
                    liveMessage.id,
                    committedItems
                      .filter(
                        (item) =>
                          !item.turnCompletion &&
                          item.messageId === liveMessage.id,
                      )
                      .reduce(
                        (count, item) => count + item.message.parts.length,
                        0,
                      ),
                  )
                : undefined
            }
            message={liveMessage}
            reasoning={liveReasoning}
            toolsExpanded={toolsExpanded}
          />
        </>
      )}
      <WorkingSpinner runtime={runtime} run={run} />
      <NoticeLane notices={notices} />
    </Box>
  );
}
