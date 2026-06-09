import { Box } from "ink";
import type { UiMessage, UiNotice } from "ohbaby-sdk";
import type { ReactElement } from "react";
import type { TuiCommandNotice, TuiRuntimeStatus } from "../../store/snapshot.js";
import { WorkingSpinner } from "../working-spinner.js";
import { CommandNoticeLane } from "./command-notice-lane.js";
import { CommittedTranscript } from "./committed-transcript.js";
import { LiveTail } from "./live-tail.js";
import { NoticeLane } from "./notice-lane.js";

export interface TranscriptViewportProps {
  readonly commandNotices: readonly TuiCommandNotice[];
  readonly committedMessages: readonly UiMessage[];
  readonly liveMessage: UiMessage | null;
  readonly notices: readonly UiNotice[];
  readonly runtime: TuiRuntimeStatus;
}

export function TranscriptViewport({
  commandNotices,
  committedMessages,
  liveMessage,
  notices,
  runtime,
}: TranscriptViewportProps): ReactElement {
  return (
    <Box flexDirection="column">
      <CommittedTranscript messages={committedMessages} />
      <CommandNoticeLane commandNotices={commandNotices} />
      <LiveTail message={liveMessage} />
      <WorkingSpinner runtime={runtime} />
      <NoticeLane notices={notices} />
    </Box>
  );
}
