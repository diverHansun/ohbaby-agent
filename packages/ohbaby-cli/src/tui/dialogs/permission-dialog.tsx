import { Box, Text, useInput } from "ink";
import type {
  CoreAPI,
  UiPermissionRequest,
  UiPermissionResponseContext,
} from "ohbaby-sdk";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useTheme } from "../theme/index.js";

export interface PermissionDialogProps {
  readonly client: CoreAPI;
  readonly request: UiPermissionRequest;
  readonly ready: boolean;
  readonly context?: UiPermissionResponseContext;
  readonly onResync: () => void;
}

export function PermissionDialog({
  client,
  request: originalRequest,
  ready,
  context,
  onResync,
}: PermissionDialogProps): ReactElement {
  const request = {
    ...originalRequest,
    choices: originalRequest.choices.filter(
      (choice) => choice.id !== "cancel" && choice.intent !== "abort",
    ),
  };
  const mounted = useRef(true);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  useLayoutEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  const theme = useTheme();
  const [selectedIndex, setSelectedIndex] = useState(() =>
    findInitialChoiceIndex(request),
  );
  const selectedIndexRef = useRef(selectedIndex);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const identity = JSON.stringify([
    request.id,
    context?.permissionEpoch,
    context?.rootSessionId,
    context?.bindingGeneration,
  ]);
  const responseScope = useRef({ identity });
  if (responseScope.current.identity !== identity)
    responseScope.current = { identity };
  const [error, setError] = useState<string | null>(null);

  const selectIndex = (index: number): void => {
    selectedIndexRef.current = index;
    setSelectedIndex(index);
  };

  const current = useRef({ request, context, onResync });
  current.current = { request, context, onResync };
  useLayoutEffect(() => {
    selectedIndexRef.current = findInitialChoiceIndex(request);
    setSelectedIndex(selectedIndexRef.current);
    pendingRef.current = false;
    setPending(false);
    setError(null);
  }, [identity]);
  useInput((_, key) => {
    const { request, context, onResync } = current.current;
    if (
      pendingRef.current ||
      !mounted.current ||
      !readyRef.current ||
      !context
    ) {
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

    const scope = responseScope.current;
    const isCurrent = (): boolean =>
      mounted.current && responseScope.current === scope;
    const updatePending = (value: boolean): void => {
      pendingRef.current = value;
      setPending(value);
    };
    if (key.escape) {
      respondWithChoice(
        client,
        request,
        findEscapeDefaultChoiceIndex(request),
        updatePending,
        setError,
        context,
        onResync,
        isCurrent,
      );
      return;
    }

    if (key.return) {
      respondWithChoice(
        client,
        request,
        selectedIndexRef.current,
        updatePending,
        setError,
        context,
        onResync,
        isCurrent,
      );
    }
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.status.warning}>Permission: {request.title}</Text>
      <Text>
        {request.sessionId === request.rootSessionId
          ? "Main agent"
          : (request.sourceLabel ?? request.sessionId)}
      </Text>
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
      {!ready ? <Text dimColor>Synchronizing approvals...</Text> : null}
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
  context: UiPermissionResponseContext,
  onResync: () => void,
  isCurrent: () => boolean,
): void {
  if (request.choices.length === 0) {
    setError("Permission request has no choices");
    return;
  }

  const choice = request.choices[choiceIndex % request.choices.length];

  setPending(true);
  void client
    .respondPermission(request.id, { choiceId: choice.id }, context)
    .catch((caught: unknown) => {
      if (!isCurrent()) return;
      setError(formatError(caught));
      setPending(false);
      if (
        typeof caught === "object" &&
        caught !== null &&
        "code" in caught &&
        caught.code === "PERMISSION_NOT_PENDING"
      )
        onResync();
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

  return 0;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Permission response failed";
}
