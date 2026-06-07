import { Box, Text } from "ink";
import { memo, type ReactElement } from "react";
import type { TuiCommandNotice } from "../../store/snapshot.js";
import { useTheme } from "../../theme/index.js";

export interface CommandNoticeLaneProps {
  readonly commandNotices: readonly TuiCommandNotice[];
}

export const CommandNoticeLane = memo(function CommandNoticeLane({
  commandNotices,
}: CommandNoticeLaneProps): ReactElement {
  const theme = useTheme();

  return (
    <Box flexDirection="column">
      {commandNotices.map((notice) => (
        <Box flexDirection="row" key={notice.id} marginBottom={1}>
          {notice.kind === "error" ? (
            <>
              <Text color={theme.status.error}>error</Text>
              <Text> {notice.text}</Text>
            </>
          ) : (
            <Text>{notice.text}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
});
