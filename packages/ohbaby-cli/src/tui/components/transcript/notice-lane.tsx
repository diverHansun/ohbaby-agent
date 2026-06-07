import { Box, Text } from "ink";
import type { UiNotice } from "ohbaby-sdk";
import { memo, type ReactElement } from "react";
import { useTheme, type Theme } from "../../theme/index.js";

export interface NoticeLaneProps {
  readonly notices: readonly UiNotice[];
}

export const NoticeLane = memo(function NoticeLane({
  notices,
}: NoticeLaneProps): ReactElement {
  const theme = useTheme();

  return (
    <Box flexDirection="column">
      {notices.map((notice) => (
        <Box flexDirection="row" key={notice.id} marginBottom={1}>
          <Text color={noticeColor(notice.level, theme)}>notice</Text>
          <Text dimColor> {notice.title}: </Text>
          <Text>{notice.message}</Text>
          {notice.source === undefined ? null : (
            <Text dimColor> ({notice.source})</Text>
          )}
        </Box>
      ))}
    </Box>
  );
});

function noticeColor(
  level: UiNotice["level"],
  theme: Theme,
): string | undefined {
  switch (level) {
    case "error":
      return theme.status.error;
    case "warning":
      return theme.status.warning;
    case "info":
      return theme.status.accent;
  }
}
