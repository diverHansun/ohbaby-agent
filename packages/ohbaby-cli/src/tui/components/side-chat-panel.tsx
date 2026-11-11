import { Box, Text } from "ink";
import {
  applySessionChange,
  type CoreAPI,
  type UiEventHandler,
  type UiSessionView,
  type UiUnsubscribe,
} from "ohbaby-sdk";
import { randomUUID } from "node:crypto";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { DialogManager } from "../dialogs/manager.js";
import { formatError } from "../format-error.js";
import { useTuiLayout } from "../layout/context.js";
import { wrapAnsi } from "../render/wrap.js";
import { isVisibleTranscriptMessage } from "../store/transcript.js";
import { useTheme } from "../theme/index.js";
import { usePermissionSync } from "../use-permission-sync.js";
import { renderMessageParts } from "./message/message-row.js";
import { Prompt, type PromptProps } from "./prompt/index.js";

/** The side chat's approvals stay out of the main session's list. */
const NO_STORE = { setPermissions: (): void => undefined };

/**
 * `/btw` (frontend design §3.2, side chat 02 Stage 3): the side chat takes
 * the main view's place. It follows its own session view and approvals, so
 * the main session's transcript, recovery and approvals are left alone.
 */
export function SideChatPanel(props: {
  readonly client: CoreAPI;
  readonly subscribeEvents: (handler: UiEventHandler) => UiUnsubscribe;
  readonly sideChatId: string;
  readonly boundaryMessageId: string;
  /** Sent once the panel is ready (`/btw <question>`). */
  readonly firstQuestion?: string;
  /** The main session is waiting for an approval. */
  readonly mainNeedsApproval: boolean;
  /** The main chat's footer facts; a side chat shares its model and folder. */
  readonly footer: Pick<PromptProps, "model" | "workingDirectory">;
  readonly onClose: () => void;
}): ReactElement {
  const { client, sideChatId } = props;
  const theme = useTheme();
  const layout = useTuiLayout();
  const [view, setView] = useState<UiSessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const permissionSync = usePermissionSync(client, NO_STORE, sideChatId);

  useEffect(() => {
    let current: UiSessionView | null = null;
    let disposed = false;
    const load = (): void => {
      if (!client.getSessionView) {
        setError("This backend cannot show a side chat.");
        return;
      }
      const getView = client.getSessionView.bind(client);
      // The in-process backend seeds a session's view on entry; this does
      // not select it, so the main session stays current.
      void Promise.resolve(client.initializeSession?.(sideChatId))
        .then(() => getView({ sessionId: sideChatId }))
        .then(
          (next) => {
            if (disposed) return;
            current = next;
            setView(next);
          },
          (caught: unknown) => {
            if (!disposed) setError(formatError(caught));
          },
        );
    };
    const unsubscribe = props.subscribeEvents((event) => {
      if (
        event.type !== "session.changed" ||
        event.version.sessionId !== sideChatId
      )
        return;
      const next = current ? applySessionChange(current, event) : undefined;
      // A gap or a new generation: read the whole view again.
      if (!next) {
        load();
        return;
      }
      current = next;
      setView(next);
    });
    load();
    return (): void => {
      disposed = true;
      unsubscribe();
    };
  }, [client, sideChatId, props.subscribeEvents]);

  const submit = (text: string): ReturnType<CoreAPI["submitPromptAccepted"]> =>
    client.submitPromptAccepted(text, {
      clientRequestId: randomUUID(),
      sessionId: sideChatId,
    });
  const asked = useRef(false);
  useEffect(() => {
    if (!view || asked.current || !props.firstQuestion) return;
    asked.current = true;
    void submit(props.firstQuestion).catch((caught: unknown) => {
      setError(formatError(caught));
    });
  }, [view, props.firstQuestion]);

  const running = view?.runs.find(
    (run) =>
      run.status.kind === "running" ||
      run.status.kind === "waiting-for-permission",
  );
  const width = Math.max(1, layout.contentWidth);
  // Only what came after the boundary: the copied history stays hidden.
  const lines = useMemo(() => {
    const messages = view?.session.messages ?? [];
    const boundary = messages.findIndex(
      (message) => message.id === props.boundaryMessageId,
    );
    return messages
      .slice(boundary + 1)
      .filter(isVisibleTranscriptMessage)
      .flatMap((message) => {
        const parts = renderMessageParts(message, width - 2, theme).flatMap(
          (part) =>
            wrapAnsi(part.kind === "text" ? part.text : part.label, width - 2, {
              hyperlinks: true,
            }),
        );
        if (parts.every((line) => line.trim() === "")) return [];
        return [
          ...(message.role === "user"
            ? parts.map((line, index) => `${index === 0 ? "› " : "  "}${line}`)
            : parts.map((line) => `  ${line}`)),
          "",
        ];
      });
  }, [view, props.boundaryMessageId, width, theme]);
  const permissions = permissionSync.state.requests;
  const height = Math.max(3, layout.rows - 10);
  const rule = "─".repeat(width);

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" width={width}>
        <Text bold color={theme.status.accent}>
          Side chat · Esc to close
        </Text>
        {props.mainNeedsApproval ? (
          <Text color={theme.status.warning}>
            Main session needs approval · Esc to return
          </Text>
        ) : null}
      </Box>
      <Text color={theme.text.dim}>{rule}</Text>
      {lines.length === 0 && !running ? (
        <Text color={theme.text.dim}>
          No messages yet · Sees this chat up to now. The main chat won’t see
          it.
        </Text>
      ) : (
        <Text>{lines.slice(-height).join("\n")}</Text>
      )}
      {running ? <Text color={theme.text.dim}>Thinking…</Text> : null}
      {error ? <Text color={theme.status.error}>{error}</Text> : null}
      <Text color={theme.text.dim}>{rule}</Text>
      {permissions.length > 0 ? (
        <DialogManager
          client={client}
          interactions={[]}
          permissions={permissions}
          permissionSync={permissionSync.state}
          onRetryPermissions={permissionSync.retry}
          controllableRun={running !== undefined}
        />
      ) : null}
      <Prompt
        plainText
        activeSessionId={sideChatId}
        activeRunId={running?.id}
        catalog={null}
        client={client}
        disabled={permissions.length > 0}
        footerOnly={permissions.length > 0}
        submitPrompt={(text) => submit(text)}
        onEscapeEmpty={props.onClose}
        isRuntimeRunning={running !== undefined}
        model={props.footer.model}
        workingDirectory={props.footer.workingDirectory}
      />
    </Box>
  );
}
