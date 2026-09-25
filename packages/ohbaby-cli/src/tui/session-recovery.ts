import { randomUUID } from "node:crypto";
import {
  createSessionSync,
  sameSessionGeneration,
  type CoreAPI,
  type SessionSyncState,
  type UiEvent,
  type UiMessage,
  type UiPromptReceipt,
  type UiReasoningConfig,
  type UiSessionControl,
  type UiSessionScope,
  type UiSessionRecoveryClient,
} from "ohbaby-sdk";
import type { TuiStore } from "./store/snapshot.js";

export interface PendingTuiPrompt {
  readonly clientRequestId: string;
  readonly sessionId?: string;
  readonly runtimeEpoch?: string;
}
/** A previous runtime cannot confirm this request; keep it visible without blocking new work. */
export function pendingPromptBlocks(
  pending: PendingTuiPrompt,
  sessionId: string | null,
  runtimeEpoch: string | undefined,
): boolean {
  return (
    (pending.runtimeEpoch === undefined ||
      runtimeEpoch === undefined ||
      pending.runtimeEpoch === runtimeEpoch) &&
    (pending.sessionId === undefined || pending.sessionId === sessionId)
  );
}

function isDefiniteSubmissionRejection(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  // These are admission failures, not transport, cancellation or post-acceptance errors.
  return [
    "QUEUE_FULL",
    "INVALID_CLIENT_REQUEST_ID",
    "PROMPT_SCHEDULER_CLOSED",
    "IDEMPOTENCY_CONFLICT",
    "PROMPT_SUBMISSION_REJECTED",
  ].includes(String(error.code));
}

export interface TuiRecoveryState {
  readonly sync: SessionSyncState;
  readonly control: UiSessionControl | null;
  readonly initialized: boolean;
  readonly runtimeEpoch?: string;
  readonly historyStale?: boolean;
  readonly historyReasoningMissing?: boolean;
  readonly error?: string;
  readonly pending: readonly PendingTuiPrompt[];
}
export interface TuiSessionRecovery {
  getState(): TuiRecoveryState;
  start(): Promise<void>;
  select(
    sessionId: string | null,
    metadata?: Pick<UiSessionScope, "runtimeEpoch" | "bindingGeneration">,
  ): void;
  refreshControl(): Promise<void>;
  reconcileReceipts(): Promise<Map<string, UiPromptReceipt>>;
  retry(): void;
  receive(event: UiEvent): boolean;
  loadHistory(): Promise<void>;
  stop(expectedRunId: string): Promise<void>;
  discardPending(clientRequestIds: readonly string[]): void;
  submit(text: string, reasoning?: UiReasoningConfig): Promise<UiPromptReceipt>;
  dispose(): void;
}
export function createTuiSessionRecovery(options: {
  readonly client: CoreAPI;
  readonly store: TuiStore;
  readonly onChange?: (state: TuiRecoveryState) => void;
  readonly onHistory?: () => void;
  readonly onModelInvalidated?: () => void;
  readonly pending?: readonly PendingTuiPrompt[];
  readonly savePending?: (pending: readonly PendingTuiPrompt[]) => void;
}): TuiSessionRecovery {
  const { client, store } = options;
  const recoveryClient = client as CoreAPI & UiSessionRecoveryClient;
  const submissionsInFlight = new Set<string>();
  let connected = true;
  let backendEpoch: string | undefined;
  let disposed = false,
    selection = 0,
    controlTicket = 0,
    indexTicket = 0;
  let connection: string | number = "in-process";
  let scope: UiSessionScope | null = null;
  let older: readonly UiMessage[] = [];
  let historyBefore: string | undefined;
  let historyMore = true,
    historyBusy = false;
  let invalidatedAt = -1;
  let historyStale = false;
  let resetTranscript = false;
  let state: TuiRecoveryState = {
    sync: { status: "idle", scope: null, attempts: 0 },
    control: null,
    initialized: false,
    pending: options.pending ?? [],
  };
  const supported =
    typeof client.getSessionView === "function" &&
    typeof client.getSessionHistory === "function" &&
    typeof client.getSessionControl === "function" &&
    typeof client.getPromptReceipt === "function";
  function publish(patch: Partial<TuiRecoveryState>): void {
    if (disposed) return;
    state = { ...state, ...patch };
    options.onChange?.(state);
  }
  function savePending(pending: readonly PendingTuiPrompt[]): void {
    options.savePending?.(pending);
    publish({ pending });
  }
  const sync = createSessionSync({
    query: (input, signal) =>
      recoveryClient.getSessionView({ ...input, signal }),
    onChange(next) {
      if (next.status === "ready" && next.view) {
        if (
          state.sync.view &&
          !sameSessionGeneration(state.sync.view.version, next.view.version) &&
          older.length
        ) {
          historyStale = true;
          historyBefore = undefined;
          historyMore = true;
          invalidatedAt = -1;
        }
        backendEpoch = next.view.version.runtimeEpoch;
        store.installSessionView(next.view, older, resetTranscript);
        if (resetTranscript) {
          resetTranscript = false;
          options.onHistory?.();
        }
        if (scope && !scope.runtimeEpoch)
          scope = { ...scope, runtimeEpoch: next.view.version.runtimeEpoch };
      }
      publish({ sync: next, historyStale, runtimeEpoch: backendEpoch });
    },
  });
  const isConnected = (): boolean => connected && !disposed;
  const readControl = (): UiSessionControl | null => state.control;
  async function refreshControl(): Promise<void> {
    if (!scope || !supported || disposed || !connected) return;
    const current = scope,
      ticket = ++controlTicket,
      generation = selection;
    try {
      const control = await recoveryClient.getSessionControl(current);
      if (
        !isConnected() ||
        ticket !== controlTicket ||
        generation !== selection ||
        control.sessionId !== current.sessionId ||
        (current.runtimeEpoch !== undefined &&
          control.runtimeEpoch !== current.runtimeEpoch) ||
        (current.bindingGeneration !== undefined &&
          control.bindingGeneration !== current.bindingGeneration)
      )
        return;
      publish({ control });
    } catch {
      if (ticket === controlTicket && generation === selection)
        publish({ control: null });
    }
  }
  function select(
    sessionId: string | null,
    metadata?: Pick<UiSessionScope, "runtimeEpoch" | "bindingGeneration">,
  ): void {
    if (disposed || !supported) return;
    ++selection;
    ++controlTicket;
    const preserveHistory =
      sessionId !== null && scope?.sessionId === sessionId && older.length > 0;
    if (!preserveHistory) older = [];
    historyBefore = undefined;
    historyMore = true;
    historyBusy = false;
    historyStale = preserveHistory;
    invalidatedAt = -1;
    scope =
      sessionId === null
        ? null
        : { sessionId, runtimeEpoch: backendEpoch, ...metadata };
    store.selectSession(sessionId);
    publish({
      control: null,
      error: undefined,
      historyReasoningMissing: preserveHistory && state.historyReasoningMissing,
    });
    if (connected) sync.begin(scope, connection);
    void refreshControl();
  }
  async function refreshIndex(selectCurrent = false): Promise<void> {
    const ticket = ++indexTicket,
      generation = selection;
    try {
      const [selected, index] = await Promise.all([
        client.getSelectedSessionId(),
        client.getSessionIndex(),
      ]);
      if (disposed || ticket !== indexTicket) return;
      store.setSessionIndex(index);
      if (selectCurrent && generation === selection) select(selected);
      publish({ initialized: true, error: undefined });
    } catch (error) {
      publish({ error: String(error) });
    }
  }
  async function reconcileReceipts(): Promise<Map<string, UiPromptReceipt>> {
    const receipts = new Map<string, UiPromptReceipt>();
    if (!supported) return receipts;
    for (const pending of [...state.pending]) {
      if (
        backendEpoch !== undefined &&
        pending.runtimeEpoch !== undefined &&
        pending.runtimeEpoch !== backendEpoch
      )
        continue;
      try {
        const result = await recoveryClient.getPromptReceipt(pending);
        if (
          disposed ||
          result.clientRequestId !== pending.clientRequestId ||
          (pending.runtimeEpoch !== undefined &&
            pending.runtimeEpoch !== result.runtimeEpoch)
        )
          continue;
        if (result.receipt?.clientRequestId === pending.clientRequestId) {
          receipts.set(pending.clientRequestId, result.receipt);
          savePending(
            state.pending.filter(
              (item) => item.clientRequestId !== pending.clientRequestId,
            ),
          );
        }
      } catch {
        /* Unknown outcomes remain queryable with their original identity. */
      }
    }
    return receipts;
  }
  function canAdoptRuntimeEpoch(): boolean {
    return !disposed && connected && backendEpoch === undefined;
  }
  async function refreshEpoch(): Promise<void> {
    if (!canAdoptRuntimeEpoch()) return;
    try {
      const snapshot = await client.getPermissionSnapshot({
        rootSessionId: null,
      });
      if (canAdoptRuntimeEpoch()) {
        backendEpoch = snapshot.permissionEpoch;
        publish({ runtimeEpoch: backendEpoch });
      }
    } catch {
      /* Explicit retry can restore runtime identity without a chat query. */
    }
  }
  return {
    getState: (): TuiRecoveryState => state,
    async start(): Promise<void> {
      if (!supported) {
        publish({
          error:
            "SESSION_RECOVERY_UNSUPPORTED: upgrade the backend to use session recovery",
        });
        return;
      }
      await Promise.all([refreshIndex(true), refreshEpoch()]);
      void reconcileReceipts();
    },
    select,
    refreshControl,
    reconcileReceipts,
    retry(): void {
      void refreshEpoch();
      sync.retry();
      void refreshControl();
      void reconcileReceipts();
    },
    receive(event: UiEvent): boolean {
      if (event.type === "snapshot.replaced") return true;
      if (event.type === "session.resync-required") {
        if (event.disconnected) {
          connected = false;
          ++controlTicket;
          sync.disconnect();
          publish({ control: null });
          return true;
        }
        if (event.unsupported) {
          connected = false;
          ++controlTicket;
          sync.disconnect();
          publish({
            control: null,
            error: "SESSION_RECOVERY_UNSUPPORTED: upgrade the backend",
          });
          return true;
        }
        connected = true;
        backendEpoch = event.runtimeEpoch;
        publish({ runtimeEpoch: backendEpoch });
        connection =
          event.connectionGeneration ??
          `${event.runtimeEpoch}:${String(event.bindingGeneration ?? 0)}`;
        select(event.sessionId, {
          runtimeEpoch: event.runtimeEpoch,
          bindingGeneration: event.bindingGeneration,
        });
        void refreshIndex();
        void reconcileReceipts();
        return true;
      }
      if (event.type === "session.changed") {
        if (
          connected &&
          event.version.sessionId === scope?.sessionId &&
          (scope.runtimeEpoch === undefined ||
            event.version.runtimeEpoch === scope.runtimeEpoch) &&
          (scope.bindingGeneration === undefined ||
            event.bindingGeneration === scope.bindingGeneration)
        ) {
          const current = sync.getState().view;
          const applies =
            current !== undefined &&
            sameSessionGeneration(current.version, event.version) &&
            event.version.sessionRevision > current.version.sessionRevision;

          if (applies && event.historyInvalidated) {
            historyStale = true;
            historyBefore = undefined;
            historyMore = true;
            invalidatedAt = event.version.sessionRevision;
          }
          if (applies) {
            const visible = store.getState().messages;
            if (
              event.removedMessageIds?.some((id) =>
                visible.some((message) => message.id === id),
              ) ||
              event.textAppends?.some(
                (append) =>
                  append.text.length > 0 &&
                  visible.some(
                    (previous) =>
                      previous.id === append.messageId &&
                      previous.status !== "streaming" &&
                      previous.parts.some(
                        (part) =>
                          part.id === append.partId &&
                          (part.type === "text" || part.type === "reasoning") &&
                          part.text.length === append.offset,
                      ),
                  ),
              ) ||
              event.messages?.some((message) =>
                visible.some(
                  (previous) =>
                    previous.id === message.id &&
                    previous.status !== "streaming" &&
                    JSON.stringify(previous) !== JSON.stringify(message),
                ),
              )
            )
              resetTranscript = true;
          }
          if (applies && event.removedMessageIds)
            older = older.filter(
              (message) => !event.removedMessageIds?.includes(message.id),
            );
          sync.receive(event);
          // Text deltas do not change the independently queried Stop target.
          if (
            (event.runs !== undefined || event.prompts !== undefined) &&
            (applies ||
              current === undefined ||
              !sameSessionGeneration(current.version, event.version))
          )
            void refreshControl();
        }
        return true;
      }
      if (event.type === "session.unavailable") {
        if (
          connected &&
          event.sessionId === scope?.sessionId &&
          (scope.runtimeEpoch === undefined ||
            event.runtimeEpoch === scope.runtimeEpoch) &&
          (scope.bindingGeneration === undefined ||
            event.bindingGeneration === scope.bindingGeneration)
        ) {
          if (event.reason === "connection interrupted") {
            connected = false;
            ++controlTicket;
            sync.disconnect();
            publish({ control: null });
          } else {
            sync.receive(event);
            void refreshControl();
          }
        }
        return true;
      }
      if (event.type === "session.index.invalidated") {
        if (
          event.selectedSessionId !== undefined &&
          event.selectedSessionId !== scope?.sessionId
        )
          select(event.selectedSessionId);
        void refreshIndex();
        return true;
      }
      if (event.type === "model.invalidated") {
        options.onModelInvalidated?.();
        void refreshIndex();
        return true;
      }
      // Core chat state has one source and one revision stream. Legacy producers cannot overwrite it.
      return [
        "session.updated",
        "message.appended",
        "message.updated",
        "message.part.delta",
        "message.reasoning.delta",
        "message.reasoning.end",
        "run.updated",
        "prompt.submitted",
        "prompt.updated",
        "todo.updated",
        "goal.updated",
      ].includes(event.type);
    },
    async loadHistory(): Promise<void> {
      const view = sync.getState().view;
      if (
        !connected ||
        !scope ||
        !view ||
        sync.getState().status !== "ready" ||
        historyBusy ||
        !historyMore ||
        (!older.length && !view.history.hasMore)
      )
        return;
      historyBusy = true;
      const generation = selection,
        current = scope;
      try {
        const page = await recoveryClient.getSessionHistory({
          ...current,
          before: historyBefore ?? view.history.before,
          limit: 50,
        });
        const latest = sync.getState().view;
        if (
          disposed ||
          !isConnected() ||
          generation !== selection ||
          !latest ||
          !sameSessionGeneration(latest.version, page.version) ||
          page.version.sessionRevision > latest.version.sessionRevision ||
          page.version.sessionRevision < invalidatedAt ||
          (current.bindingGeneration !== undefined &&
            page.bindingGeneration !== current.bindingGeneration)
        )
          return;
        const messages = new Map(
          [...page.messages, ...(historyStale ? [] : older)].map((message) => [
            message.id,
            message,
          ]),
        );
        older = [...messages.values()];
        historyBefore = page.before;
        historyMore = page.hasMore;
        historyStale = false;
        publish({
          historyStale: false,
          historyReasoningMissing:
            state.historyReasoningMissing === true || page.reasoningMissing,
        });
        store.installSessionView(
          {
            ...latest,
            reasoningMissing: latest.reasoningMissing || page.reasoningMissing,
          },
          older,
          true,
        );
        options.onHistory?.();
      } catch (error) {
        publish({ error: `History unavailable: ${String(error)}` });
      } finally {
        if (generation === selection) historyBusy = false;
      }
    },
    discardPending(clientRequestIds): void {
      const ids = new Set(clientRequestIds);
      savePending(
        state.pending.filter(
          (item) =>
            !ids.has(item.clientRequestId) ||
            submissionsInFlight.has(item.clientRequestId),
        ),
      );
    },
    async stop(expectedRunId: string): Promise<void> {
      if (
        !connected ||
        !expectedRunId ||
        state.control?.runId !== expectedRunId
      )
        throw new Error("Stop unavailable: current run could not be confirmed");
      const generation = selection;
      await refreshControl();
      if (!isConnected() || generation !== selection || !readControl()?.runId)
        throw new Error("Stop unavailable: current run could not be confirmed");
      if (readControl()?.runId !== expectedRunId)
        throw new Error(
          "Stop target has ended; the new run was not interrupted",
        );
      await client.abortRun(expectedRunId);
    },
    async submit(
      text: string,
      reasoning?: UiReasoningConfig,
    ): Promise<UiPromptReceipt> {
      if (
        state.pending.some((item) =>
          pendingPromptBlocks(item, scope?.sessionId ?? null, backendEpoch),
        )
      )
        throw new Error(
          "Submission outcome unknown; query the original receipt before sending again",
        );
      if (
        !connected ||
        !backendEpoch ||
        !supported ||
        !state.initialized ||
        (scope !== null && sync.getState().status !== "ready")
      )
        throw new Error("Session is syncing; draft kept");
      const current = scope,
        generation = selection;
      const pending: PendingTuiPrompt = {
        clientRequestId: randomUUID(),
        sessionId: current?.sessionId,
        runtimeEpoch: current?.runtimeEpoch ?? backendEpoch,
      };
      savePending([...state.pending, pending]);
      submissionsInFlight.add(pending.clientRequestId);
      try {
        const receipt = await client.submitPromptAccepted(text, {
          clientRequestId: pending.clientRequestId,
          sessionId: pending.sessionId,
          reasoning,
        });
        submissionsInFlight.delete(pending.clientRequestId);
        savePending(
          state.pending.filter(
            (item) => item.clientRequestId !== pending.clientRequestId,
          ),
        );
        if (generation === selection && current === null)
          select(receipt.sessionId);
        return receipt;
      } catch (error) {
        submissionsInFlight.delete(pending.clientRequestId);
        if (isDefiniteSubmissionRejection(error)) {
          savePending(
            state.pending.filter(
              (item) => item.clientRequestId !== pending.clientRequestId,
            ),
          );
          throw error;
        }
        const receipts = await reconcileReceipts();
        const receipt = receipts.get(pending.clientRequestId);
        if (receipt) {
          if (generation === selection && current === null)
            select(receipt.sessionId);
          return receipt;
        }
        throw new Error(
          "Submission outcome unknown; press Ctrl+R to query the original receipt. Do not resend.",
        );
      }
    },
    dispose(): void {
      disposed = true;
      ++selection;
      ++controlTicket;
      ++indexTicket;
      sync.dispose();
    },
  };
}
