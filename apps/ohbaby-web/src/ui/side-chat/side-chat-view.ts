import type { UiPromptSubmission, UiRun } from "ohbaby-sdk";
import type { ViewModel } from "../session/selectors.js";

/**
 * A side chat's session starts with a copy of the main chat and one boundary
 * message. The panel shows only what came after the boundary (side chat 02
 * Stage 2 step 4): the copied messages, their prompts and their runs are left
 * out, so inherited turns never appear.
 */
export function selectSideChatView(
  view: ViewModel,
  boundaryMessageId: string,
): {
  readonly view: ViewModel;
  /** The boundary is among the loaded messages, so nothing earlier is ours. */
  readonly boundaryLoaded: boolean;
} {
  const session = view.activeSession;
  const loaded = session?.messages ?? [];
  const boundary = loaded.findIndex(
    (message) => message.id === boundaryMessageId,
  );
  // History loads newest first: without the boundary in it, every loaded
  // message is later than the boundary.
  const inherited = boundary < 0 ? [] : loaded.slice(0, boundary + 1);
  const messages = boundary < 0 ? loaded : loaded.slice(boundary + 1);
  const hiddenMessages = new Set(inherited.map((message) => message.id));
  const hiddenRuns = new Set(
    inherited.flatMap((message) => (message.runId ? [message.runId] : [])),
  );
  const ownPrompt = (prompt: UiPromptSubmission): boolean =>
    !isCopied(prompt.clientRequestId) &&
    !hiddenMessages.has(prompt.userMessageId) &&
    !(prompt.runId !== undefined && hiddenRuns.has(prompt.runId));
  const ownRun = (run: UiRun): boolean =>
    !hiddenRuns.has(run.id) && !run.id.startsWith("run_-copy_");
  const snapshot = view.snapshot;
  return {
    boundaryLoaded: boundary >= 0,
    view: {
      ...view,
      activeSession: session ? { ...session, messages } : null,
      isEmpty: messages.length === 0,
      queuedPrompts: view.queuedPrompts.filter(ownPrompt),
      snapshot: snapshot
        ? {
            ...snapshot,
            sessions: snapshot.sessions.map((entry) =>
              entry.id === session?.id ? { ...entry, messages } : entry,
            ),
            prompts: snapshot.prompts?.filter(ownPrompt),
            runs: snapshot.runs.filter(ownRun),
          }
        : null,
    },
  };
}

/** Copied prompts carry `copy:<id>` request ids (side chat 02 Stage 1 step 0.3). */
function isCopied(clientRequestId: string): boolean {
  return clientRequestId.startsWith("copy:");
}
