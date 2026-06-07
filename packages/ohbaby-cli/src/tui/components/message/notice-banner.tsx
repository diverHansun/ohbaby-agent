import { Box, Text } from "ink";
import type { UiNotice } from "ohbaby-sdk";
import type { ReactElement } from "react";
import type { TuiCommandNotice } from "../../store/snapshot.js";
import { useTheme, type Theme } from "../../theme/index.js";

export interface NoticeBannerProps {
  readonly commandNotices: readonly TuiCommandNotice[];
  readonly notices: readonly UiNotice[];
}

export function NoticeBanner({
  commandNotices,
  notices,
}: NoticeBannerProps): ReactElement {
  const theme = useTheme();

  return (
    <>
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
    </>
  );
}

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
