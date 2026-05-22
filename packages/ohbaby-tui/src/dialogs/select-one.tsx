import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  TuiBackendClient,
  TuiInteractionRequest,
} from "../store/snapshot.js";

export interface SelectOneDialogProps {
  readonly client: TuiBackendClient;
  readonly interaction: TuiInteractionRequest;
  readonly title: string;
}

export function SelectOneDialog({
  client,
  interaction,
  title,
}: SelectOneDialogProps): ReactElement {
  const options = interaction.options ?? [];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedIndexRef = useRef(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectIndex = (index: number): void => {
    selectedIndexRef.current = index;
    setSelectedIndex(index);
  };

  useInput((value, key) => {
    if (client.respondInteraction === undefined || pending) {
      return;
    }

    const numericIndex = Number.parseInt(value, 10) - 1;

    if (
      Number.isInteger(numericIndex) &&
      numericIndex >= 0 &&
      numericIndex < options.length
    ) {
      selectIndex(numericIndex);
      return;
    }

    if (key.upArrow || key.leftArrow) {
      selectIndex(
        options.length === 0
          ? 0
          : (selectedIndexRef.current - 1 + options.length) % options.length,
      );
      return;
    }

    if (key.downArrow || key.rightArrow || key.tab) {
      selectIndex(
        options.length === 0
          ? 0
          : (selectedIndexRef.current + 1) % options.length,
      );
      return;
    }

    if (key.escape) {
      setPending(true);
      void client
        .respondInteraction(interaction.interactionId, {
          kind: "cancelled",
          reason: "user-cancelled",
        })
        .catch((caught: unknown) => {
          setError(formatError(caught));
          setPending(false);
        });
      return;
    }

    if (key.return && options.length > 0) {
      void client
        .respondInteraction(interaction.interactionId, {
          choiceId: options[selectedIndexRef.current % options.length].id,
          kind: "accepted",
        })
        .catch((caught: unknown) => {
          setError(formatError(caught));
          setPending(false);
        });
      setPending(true);
    }
  });

  return (
    <Box flexDirection="column">
      <Text color="yellow">
        {title}: {interaction.title ?? "Select one"}
      </Text>
      {options.map((option, index) => (
        <Text key={option.id}>
          {index === selectedIndex ? ">" : " "} {String(index + 1)}.{" "}
          {option.label}
        </Text>
      ))}
      {options.length === 0 ? <Text dimColor>No options</Text> : null}
      {pending ? <Text dimColor>sending...</Text> : null}
      {error === null ? null : <Text color="red">{error}</Text>}
    </Box>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Interaction failed";
}
