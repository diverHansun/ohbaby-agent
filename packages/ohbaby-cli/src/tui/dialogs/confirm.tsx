import { Box, Text, useInput } from "ink";
import type { CoreAPI } from "ohbaby-sdk";
import { useState } from "react";
import type { ReactElement } from "react";
import type { TuiInteractionRequest } from "../store/snapshot.js";

export interface ConfirmDialogProps {
  readonly client: CoreAPI;
  readonly interaction: TuiInteractionRequest;
}

export function ConfirmDialog({
  client,
  interaction,
}: ConfirmDialogProps): ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useInput((_, key) => {
    if (pending) {
      return;
    }

    if (key.return) {
      setPending(true);
      void client
        .respondInteraction(interaction.interactionId, {
          kind: "accepted",
          value: true,
        })
        .catch((caught: unknown) => {
          setError(formatError(caught));
          setPending(false);
        });
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
    }
  });

  return (
    <Box flexDirection="column">
      <Text color="yellow">Confirm: {interaction.title ?? "Confirm"}</Text>
      {interaction.message === undefined ? null : (
        <Text>{interaction.message}</Text>
      )}
      {pending ? <Text dimColor>sending...</Text> : null}
      {error === null ? null : <Text color="red">{error}</Text>}
    </Box>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Interaction failed";
}
