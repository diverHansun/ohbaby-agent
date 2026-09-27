import { Box } from "ink";
import type { UiModelRequest, UiMessage, UiNotice } from "ohbaby-sdk";
import type { ReactElement } from "react";
import type {
  TuiCommandNotice,
  TuiReasoningViewState,
  TuiRuntimeStatus,
} from "../../store/snapshot.js";
import type { TranscriptItem } from "../../store/transcript.js";
import { WorkingSpinner } from "../working-spinner.js";
import { CommandNoticeLane } from "./command-notice-lane.js";
import { CommittedTranscript } from "./committed-transcript.js";
import { LiveTail } from "./live-tail.js";
import { NoticeLane } from "./notice-lane.js";

export interface TranscriptViewportProps {
  readonly commandNotices: readonly TuiCommandNotice[];
  readonly committedItems: readonly TranscriptItem[];
  readonly liveMessage: UiMessage | null;
  readonly liveReasoning?: TuiReasoningViewState;
  readonly notices: readonly UiNotice[];
  readonly runtime: TuiRuntimeStatus;
  readonly modelActivity?: UiModelRequest;
}

export function TranscriptViewport({
  commandNotices,
  committedItems,
  liveMessage,
  liveReasoning,
  notices,
  runtime,
  modelActivity,
}: TranscriptViewportProps): ReactElement {
  return (
    <Box flexDirection="column">
      <CommittedTranscript items={committedItems} />
      <CommandNoticeLane commandNotices={commandNotices} />
      <LiveTail message={liveMessage} reasoning={liveReasoning} />
      <WorkingSpinner runtime={runtime} modelActivity={modelActivity} />
      <NoticeLane notices={notices} />
    </Box>
  );
}
