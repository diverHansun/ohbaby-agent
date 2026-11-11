import { Box, Text, useInput } from "ink";
import type { UiPromptSubmission } from "ohbaby-sdk";
import { useState, type ReactElement } from "react";
import { useTuiLayout } from "../../layout/context.js";
import { useTheme } from "../../theme/index.js";
import { firstLine } from "./rewind-model.js";

/**
 * `/rewind` (frontend design §5.2): the newest prompt on top. The row under
 * the cursor and every newer row above it are what goes, so they are dimmed.
 */
export function RewindPanel(props: {
  /** Newest first. */
  readonly prompts: readonly UiPromptSubmission[];
  readonly confirmation: (turns: number) => string;
  /** Resolves to an error to show, or null once done. */
  readonly onConfirm: (prompt: UiPromptSubmission) => Promise<string | null>;
  readonly onClose: () => void;
}): ReactElement {
  const theme = useTheme();
  const layout = useTuiLayout();
  const [index, setIndex] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { prompts } = props;
  const selected = prompts.at(index);
  useInput((_value, key) => {
    if (busy) return;
    if (key.escape) {
      if (confirming) setConfirming(false);
      else props.onClose();
      return;
    }
    if (key.return && selected) {
      if (!confirming) {
        setError(null);
        setConfirming(true);
        return;
      }
      setBusy(true);
      void props.onConfirm(selected).then((failure) => {
        setBusy(false);
        setConfirming(false);
        setError(failure);
      });
      return;
    }
    if (confirming) return;
    if (key.upArrow) setIndex((current) => Math.max(0, current - 1));
    if (key.downArrow)
      setIndex((current) => Math.min(prompts.length - 1, current + 1));
  });
  const width = Math.max(20, layout.contentWidth);
  const rule = "─".repeat(width);
  const rows = Math.max(3, layout.rows - 8);
  const start = Math.max(0, Math.min(index - rows + 1, prompts.length - rows));
  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between">
        <Text bold color={theme.status.accent}>
          Rewind to…
        </Text>
        <Text color={theme.text.dim}>
          ↑↓ navigate · Enter select · Esc cancel
        </Text>
      </Box>
      <Text color={theme.text.dim}>{rule}</Text>
      {prompts.length === 0 ? (
        <Text color={theme.text.dim}>Nothing to rewind yet.</Text>
      ) : (
        prompts.slice(start, start + rows).map((prompt, offset) => {
          const row = start + offset;
          const time = new Date(prompt.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          return (
            <Box key={prompt.promptId} justifyContent="space-between">
              <Text
                wrap="truncate-end"
                color={row <= index ? theme.text.dim : undefined}
              >
                {row === index ? "› " : "  "}
                {firstLine(prompt.text)}
              </Text>
              <Text color={theme.text.dim}> {time}</Text>
            </Box>
          );
        })
      )}
      <Text color={theme.text.dim}>{rule}</Text>
      {busy ? (
        <Text color={theme.text.dim}>Rewinding…</Text>
      ) : confirming ? (
        <Text color={theme.status.warning}>
          {props.confirmation(index + 1)}
        </Text>
      ) : error ? (
        <Text color={theme.status.error}>{error}</Text>
      ) : null}
    </Box>
  );
}
