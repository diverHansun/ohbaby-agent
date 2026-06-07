import { Box, Static, useStdout } from "ink";
import type { UiMessage } from "ohbaby-sdk";
import { memo, type ReactElement } from "react";
import { useTuiLayout } from "../../layout/context.js";
import { MessageRow } from "../message/message-row.js";

export interface CommittedTranscriptProps {
  readonly messages: readonly UiMessage[];
}

interface StaticTranscriptDecisionInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTTY?: boolean;
  readonly platform?: NodeJS.Platform;
}

export const CommittedTranscript = memo(function CommittedTranscript({
  messages,
}: CommittedTranscriptProps): ReactElement {
  const layout = useTuiLayout();
  const { stdout } = useStdout();
  const useStatic = shouldUseStaticTranscript({
    isTTY: stdout.isTTY,
  });

  if (useStatic) {
    return (
      <Static items={messages as UiMessage[]}>
        {(message): ReactElement => (
          <MessageRow
            contentWidth={layout.contentWidth}
            key={message.id}
            message={message}
          />
        )}
      </Static>
    );
  }

  return (
    <Box flexDirection="column">
      {messages.map((message) => (
        <MessageRow
          contentWidth={layout.contentWidth}
          key={message.id}
          message={message}
        />
      ))}
    </Box>
  );
});

export function shouldUseStaticTranscript(
  input: StaticTranscriptDecisionInput = {},
): boolean {
  const env = input.env ?? process.env;
  const override = env.OHBABY_TUI_STATIC_TRANSCRIPT?.trim();

  if (override === "0" || override?.toLowerCase() === "false") {
    return false;
  }

  if (override === "1" || override?.toLowerCase() === "true") {
    return true;
  }

  return (
    input.isTTY === true && (input.platform ?? process.platform) === "win32"
  );
}
