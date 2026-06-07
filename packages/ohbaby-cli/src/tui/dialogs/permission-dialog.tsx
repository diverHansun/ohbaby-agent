import { Box, Text, useInput } from "ink";
import type { CoreAPI, UiPermissionRequest } from "ohbaby-sdk";
import { useRef, useState } from "react";
import type { ReactElement } from "react";
import { useTheme } from "../theme/index.js";

export interface PermissionDialogProps {
  readonly client: CoreAPI;
  readonly request: UiPermissionRequest;
}

export function PermissionDialog({
  client,
  request,
}: PermissionDialogProps): ReactElement {
  const theme = useTheme();
  const [selectedIndex, setSelectedIndex] = useState(() =>
    findInitialChoiceIndex(request),
  );
  const selectedIndexRef = useRef(selectedIndex);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectIndex = (index: number): void => {
    selectedIndexRef.current = index;
    setSelectedIndex(index);
  };

  useInput((_, key) => {
    if (pending) {
      return;
    }

    if (key.upArrow || key.leftArrow) {
      if (request.choices.length === 0) {
        return;
      }

      selectIndex(
        (selectedIndexRef.current - 1 + request.choices.length) %
          request.choices.length,
      );
      return;
    }

    if (key.downArrow || key.rightArrow || key.tab) {
      if (request.choices.length === 0) {
        return;
      }

      selectIndex((selectedIndexRef.current + 1) % request.choices.length);
      return;
    }

    if (key.escape) {
      respondWithChoice(
        client,
        request,
        findEscapeDefaultChoiceIndex(request),
        setPending,
        setError,
      );
      return;
    }

    if (key.return) {
      respondWithChoice(
        client,
        request,
        selectedIndexRef.current,
        setPending,
        setError,
      );
    }
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.status.warning}>Permission: {request.title}</Text>
      <Text>{request.description}</Text>
      {request.choices.map((choice, index) => (
        <Text key={choice.id}>
          {index === selectedIndex ? ">" : " "} {choice.label} [{choice.intent}]
        </Text>
      ))}
      {request.choices.length === 0 ? <Text dimColor>No choices</Text> : null}
      {request.choices.length === 0 ? null : (
        <Text dimColor>Enter select | Esc safe default | arrows move</Text>
      )}
      {pending ? <Text dimColor>sending...</Text> : null}
      {error === null ? null : <Text color={theme.status.error}>{error}</Text>}
    </Box>
  );
}

function respondWithChoice(
  client: CoreAPI,
  request: UiPermissionRequest,
  choiceIndex: number,
  setPending: (pending: boolean) => void,
  setError: (message: string | null) => void,
): void {
  if (request.choices.length === 0) {
    setError("Permission request has no choices");
    return;
  }

  const choice = request.choices[choiceIndex % request.choices.length];

  setPending(true);
  void client
    .respondPermission(request.id, { choiceId: choice.id })
    .catch((caught: unknown) => {
      setError(formatError(caught));
      setPending(false);
    });
}

function findInitialChoiceIndex(request: UiPermissionRequest): number {
  const allowIndex = request.choices.findIndex(
    (choice) => choice.intent === "allow",
  );

  return allowIndex >= 0 ? allowIndex : findEscapeDefaultChoiceIndex(request);
}

function findEscapeDefaultChoiceIndex(request: UiPermissionRequest): number {
  const denyIndex = request.choices.findIndex(
    (choice) => choice.intent === "deny",
  );

  if (denyIndex >= 0) {
    return denyIndex;
  }

  const abortIndex = request.choices.findIndex(
    (choice) => choice.intent === "abort",
  );

  return abortIndex >= 0 ? abortIndex : 0;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Permission response failed";
}
