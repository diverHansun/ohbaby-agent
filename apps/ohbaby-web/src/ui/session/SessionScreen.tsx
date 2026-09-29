import { hasUnsentSteerAfterLatestStop } from "ohbaby-sdk";
import {
  createSubagentReader,
  createSubagentConversationReader,
} from "ohbaby-sdk";
import { SubagentView, type SubagentReadingCache } from "./SubagentView.js";
import { ConversationPresentation } from "../conversation/ConversationPresentation.js";
import { DelegationRow, delegationExecution } from "./DelegationRow.js";
import { subagentSheetGeometry } from "./subagent-layout.js";
import { TodoDock } from "../conversation/TodoDock.js";
import { PermissionPolicyControl } from "../permissions/PermissionPolicyControl.js";
import type {
  UiBackendClient,
  UiPromptSubmission,
  UiReasoningConfig,
  UiWebCommandCatalog,
} from "ohbaby-sdk";
import { parseSlashCommandInput, resolveSlashCommand } from "ohbaby-sdk";
import type { ReactElement } from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { OhbabyWebRuntime } from "../../runtime.js";
import {
  CommandResultModal,
  CommandNoticeList,
} from "../commands/CommandResultModal.js";
import {
  DEFAULT_GOAL_PANEL_INTENT,
  type GoalPanelIntent,
  goalPanelIntentFromArgs,
} from "../commands/GoalControl.js";
import {
  createCommandResultModel,
  slashCommandLabel,
} from "../commands/slashCommands.js";
import {
  StructuredCommandOverlay,
  type StructuredCommandRequest,
  structuredOverlayKindForAction,
  type StructuredOverlayState,
} from "../commands/StructuredCommandOverlay.js";
import { Composer, type ComposerPrefill } from "../composer/Composer.js";
import {
  ConversationStream,
  type PromptProjectionModel,
} from "../conversation/ConversationStream.js";
import { DurationSampleContext } from "../conversation/use-execution-duration.js";
import { PermissionModal } from "../permissions/PermissionModal.js";
import { DirectoryPickerDialog } from "../workspace/directory-picker/DirectoryPickerDialog.js";
import { ProjectRail } from "../workspace/ProjectRail.js";
import { selectViewModel, type ViewModel } from "./selectors.js";
import { SessionSidebar } from "./SessionSidebar.js";
import {
  EmptyState,
  ErrorBanner,
  StatusBar,
  SessionSyncNotice,
} from "./SessionStatus.js";
import { useSessionSyncBanner } from "./use-session-sync-banner.js";
import { useStopRequest } from "./use-stop-request.js";

interface LocalPromptAttempt {
  readonly clientRequestId: string;
  readonly createdAt: string;
  readonly originSessionId: string | null;
  readonly placement: "conversation" | "queue";
  readonly submittedSessionId?: string;
  readonly text: string;
  readonly userMessageId?: string;
}

function promptMatchesAttempt(
  prompt: UiPromptSubmission,
  attempt: LocalPromptAttempt,
): boolean {
  return (
    prompt.clientRequestId === attempt.clientRequestId ||
    (attempt.userMessageId !== undefined &&
      prompt.userMessageId === attempt.userMessageId)
  );
}

function hasLiveRunForSession(
  snapshot: ViewModel["snapshot"],
  sessionId: string | undefined,
): boolean {
  if (!snapshot || !sessionId) return false;
  return snapshot.runs.some(
    (run) =>
      run.sessionId === sessionId &&
      (run.status.kind === "running" ||
        run.status.kind === "waiting-for-permission"),
  );
}

function hasActiveTurnForSession(
  snapshot: ViewModel["snapshot"],
  sessionId: string | undefined,
): boolean {
  if (!snapshot || !sessionId) return false;
  return (
    hasLiveRunForSession(snapshot, sessionId) ||
    (snapshot.prompts ?? []).some(
      (prompt) =>
        prompt.sessionId === sessionId &&
        (prompt.status === "starting" || prompt.status === "running"),
    )
  );
}

function localAttemptSessionMatches(
  attempt: LocalPromptAttempt,
  activeSessionId: string | undefined,
): boolean {
  if (activeSessionId === undefined) {
    return attempt.originSessionId === null;
  }
  return (
    attempt.submittedSessionId === activeSessionId ||
    (attempt.submittedSessionId === undefined &&
      attempt.originSessionId === activeSessionId)
  );
}

function isExpectedPromptInterruption(
  prompt: UiPromptSubmission,
  view: ViewModel,
): boolean {
  if (prompt.status !== "interrupted" || prompt.error?.source !== "runtime")
    return false;
  const run = view.snapshot?.runs.find(
    (candidate) =>
      candidate.id === prompt.runId && candidate.sessionId === prompt.sessionId,
  );
  const reason =
    prompt.error.terminalReason ??
    run?.terminalReason ??
    (prompt.error.code === "RUN_INTERRUPTED"
      ? prompt.error.message
      : undefined);
  return reason === "user-stop" || reason === "service-shutdown";
}

function selectPromptProjection(input: {
  readonly attempts: readonly LocalPromptAttempt[];
  readonly view: ViewModel;
}): {
  readonly rows: readonly PromptProjectionModel[];
  readonly startupThinkingAt?: string;
} {
  const activeSessionId = input.view.composer.activeSessionId;
  const activeSession = input.view.activeSession;
  const formalMessageIds = new Set(
    activeSession?.messages.map((message) => message.id) ?? [],
  );
  const prompts = (input.view.snapshot?.prompts ?? []).filter(
    (prompt) => prompt.sessionId === activeSessionId,
  );
  const hasActiveTurn = hasActiveTurnForSession(
    input.view.snapshot,
    activeSessionId,
  );
  const serverRows = prompts.flatMap((prompt): PromptProjectionModel[] => {
    if (formalMessageIds.has(prompt.userMessageId)) return [];
    if (prompt.status === "starting" || prompt.status === "running") {
      return [
        {
          clientRequestId: prompt.clientRequestId,
          createdAt: prompt.createdAt,
          id: prompt.userMessageId,
          text: prompt.text,
        },
      ];
    }
    if (prompt.status === "failed" || prompt.status === "interrupted") {
      return [
        {
          clientRequestId: prompt.clientRequestId,
          createdAt: prompt.createdAt,
          error: isExpectedPromptInterruption(prompt, input.view)
            ? undefined
            : (prompt.error?.message ??
              (prompt.status === "failed"
                ? "Prompt failed before the run started."
                : "Prompt was interrupted before completion.")),
          id: prompt.userMessageId,
          label: prompt.status === "failed" ? "Failed" : "Interrupted",
          text: prompt.text,
        },
      ];
    }
    return [];
  });
  const serverRequestIds = new Set(
    serverRows.map((row) => row.clientRequestId),
  );
  const serverMessageIds = new Set(serverRows.map((row) => row.id));
  const visibleAttempts = input.attempts.filter((attempt) =>
    localAttemptSessionMatches(attempt, activeSessionId),
  );
  const localRows = visibleAttempts.flatMap(
    (attempt): PromptProjectionModel[] => {
      if (attempt.placement !== "conversation") return [];
      const matchingPrompt = prompts.find((prompt) =>
        promptMatchesAttempt(prompt, attempt),
      );
      if (
        serverRequestIds.has(attempt.clientRequestId) ||
        (attempt.userMessageId !== undefined &&
          (formalMessageIds.has(attempt.userMessageId) ||
            serverMessageIds.has(attempt.userMessageId)))
      ) {
        return [];
      }
      if (matchingPrompt) {
        if (matchingPrompt.status !== "queued" || hasActiveTurn) {
          return [];
        }
      }
      return [
        {
          clientRequestId: attempt.clientRequestId,
          createdAt: attempt.createdAt,
          id: attempt.userMessageId ?? `pending:${attempt.clientRequestId}`,
          text: attempt.text,
        },
      ];
    },
  );
  const startupCandidates = [
    ...prompts
      .filter(
        (prompt) => prompt.status === "starting" || prompt.status === "running",
      )
      .map((prompt) => prompt.startedAt ?? prompt.createdAt),
    ...visibleAttempts.flatMap((attempt): string[] => {
      if (attempt.placement !== "conversation") return [];
      const matchingPrompt = prompts.find((prompt) =>
        promptMatchesAttempt(prompt, attempt),
      );
      if (
        matchingPrompt &&
        (matchingPrompt.status === "succeeded" ||
          matchingPrompt.status === "failed" ||
          matchingPrompt.status === "cancelled" ||
          matchingPrompt.status === "interrupted" ||
          (matchingPrompt.status === "queued" && hasActiveTurn))
      ) {
        return [];
      }
      return [attempt.createdAt];
    }),
  ].sort();
  const startupThinkingAt = startupCandidates[0];
  return {
    rows: [...serverRows, ...localRows].sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.id.localeCompare(right.id),
    ),
    ...(startupCandidates.length === 0 ? {} : { startupThinkingAt }),
  };
}

function selectPersistedPromptError(view: ViewModel): {
  readonly message: string;
  readonly promptId: string;
} | null {
  const activeSessionId = view.composer.activeSessionId;
  if (
    !activeSessionId ||
    hasActiveTurnForSession(view.snapshot, activeSessionId)
  ) {
    return null;
  }
  const latest = (view.snapshot?.prompts ?? [])
    .filter((prompt) => prompt.sessionId === activeSessionId)
    .reduce<UiPromptSubmission | null>(
      (current, prompt) =>
        current === null || prompt.createdAt >= current.createdAt
          ? prompt
          : current,
      null,
    );
  if (
    !latest ||
    isExpectedPromptInterruption(latest, view) ||
    (latest.status !== "failed" && latest.status !== "interrupted") ||
    !view.activeSession?.messages.some(
      (message) => message.id === latest.userMessageId,
    )
  ) {
    return null;
  }
  return {
    message:
      latest.error?.message ??
      (latest.status === "failed"
        ? "Prompt failed."
        : "Prompt was interrupted."),
    promptId: latest.promptId,
  };
}

export function SessionScreen({
  client,
  runtime,
}: {
  readonly runtime: OhbabyWebRuntime;
  readonly client: UiBackendClient;
}): ReactElement {
  const storeSnapshot = useSyncExternalStore(
    (listener) => runtime.store.subscribe(listener),
    () => runtime.store.getSnapshot(),
    () => runtime.store.getSnapshot(),
  );
  const view = useMemo(() => selectViewModel(storeSnapshot), [storeSnapshot]);
  const promptRecoveryReminders = storeSnapshot.unknownPromptRequests.filter(
    (request) => request.status === "epoch-changed" || !request.submitting,
  );
  const sessionSyncBanner = useSessionSyncBanner(storeSnapshot.sessionSync);
  const workspace = useSyncExternalStore(
    (listener) => runtime.subscribeWorkspaces(listener),
    () => runtime.getWorkspaceSnapshot(),
    () => runtime.getWorkspaceSnapshot(),
  );
  const draftScopeKey = `${workspace.selectedDirectory ?? "workspace"}:${view.composer.activeSessionId ?? "new"}`;
  const composerEditRevision = useRef(0);
  const composerPrefillNonce = useRef(0);
  const commandScopeGeneration = useRef(0);
  const [commandInputError, setCommandInputError] = useState<{
    scopeKey: string;
    clientRequestId: string | undefined;
    message: string;
  } | null>(null);
  const trackComposerRevision = useCallback(
    (revision: number): void => {
      composerEditRevision.current = revision;
      setCommandInputError(null);
      for (const notice of runtime.store.getSnapshot().view.commandNotices)
        if (notice.kind === "error") runtime.store.consumeCommand(notice.id);
    },
    [runtime],
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const stopRequest = useStopRequest(
    runtime,
    view.composer.activeSessionId,
    view.composer.activeRunId,
    setActionError,
  );
  const [dismissedPromptErrorId, setDismissedPromptErrorId] = useState<
    string | null
  >(null);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [sessionSidebarOpen, setSessionSidebarOpen] = useState(false);
  const [structuredOverlay, setStructuredOverlay] =
    useState<StructuredOverlayState | null>(null);
  const [composerPrefill, setComposerPrefill] =
    useState<ComposerPrefill | null>(null);
  useLayoutEffect(() => {
    commandScopeGeneration.current += 1;
    setStructuredOverlay(null);
    setComposerPrefill(null);
    setActionError(null);
    setCommandInputError(null);
    return (): void => {
      commandScopeGeneration.current += 1;
    };
  }, [draftScopeKey, client]);
  const [localPromptAttempts, setLocalPromptAttempts] = useState<
    readonly LocalPromptAttempt[]
  >([]);
  const persistedPromptError = useMemo(
    () => selectPersistedPromptError(view),
    [view],
  );
  const errorBannerMessage =
    actionError ??
    view.error ??
    (persistedPromptError?.promptId === dismissedPromptErrorId
      ? null
      : (persistedPromptError?.message ?? null));
  const clearActionError = useCallback(() => {
    setActionError(null);
    setDismissedPromptErrorId(persistedPromptError?.promptId ?? null);
  }, [persistedPromptError]);
  const promptProjection = useMemo(
    () => selectPromptProjection({ attempts: localPromptAttempts, view }),
    [localPromptAttempts, view],
  );
  const isPromptAdmitting = localPromptAttempts.some(
    (attempt) =>
      attempt.userMessageId === undefined &&
      localAttemptSessionMatches(attempt, view.composer.activeSessionId),
  );
  const showMain =
    !view.isEmpty ||
    view.commandNotices.length > 0 ||
    promptProjection.rows.length > 0 ||
    promptProjection.startupThinkingAt !== undefined;

  useEffect(() => {
    const keepAttempt = (attempt: LocalPromptAttempt): boolean => {
      if (attempt.userMessageId === undefined) return true;
      const matchingPrompt = view.snapshot?.prompts?.find((prompt) =>
        promptMatchesAttempt(prompt, attempt),
      );
      const sessionId = attempt.submittedSessionId ?? matchingPrompt?.sessionId;
      const formalVisible = view.snapshot?.sessions
        .find((session) => session.id === sessionId)
        ?.messages.some((message) => message.id === attempt.userMessageId);
      if (matchingPrompt) {
        if (
          matchingPrompt.status === "starting" ||
          matchingPrompt.status === "running" ||
          matchingPrompt.status === "succeeded" ||
          matchingPrompt.status === "failed" ||
          matchingPrompt.status === "cancelled" ||
          matchingPrompt.status === "interrupted"
        ) {
          return false;
        }
        if (
          attempt.placement === "queue" ||
          hasLiveRunForSession(view.snapshot, sessionId)
        ) {
          return false;
        }
      }
      return !(
        formalVisible === true &&
        (matchingPrompt !== undefined ||
          hasLiveRunForSession(view.snapshot, sessionId))
      );
    };
    // Even a same-state setter can schedule work while SyncLane stream updates
    // are pending. Only enqueue cleanup when this snapshot retires an attempt.
    if (!localPromptAttempts.some((attempt) => !keepAttempt(attempt))) return;
    setLocalPromptAttempts((attempts) => {
      const next = attempts.filter(keepAttempt);
      return next.length === attempts.length ? attempts : next;
    });
  }, [localPromptAttempts, view.snapshot]);

  const runAction = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      try {
        clearActionError();
        await action();
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [clearActionError],
  );
  useEffect(() => {
    void runtime.refreshWorkspaces().catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error));
    });
  }, [runtime]);
  const switchWorkspace = useCallback(
    (directory: string): void => {
      void runAction(() => runtime.switchWorkspace(directory));
    },
    [runAction, runtime],
  );
  const hideWorkspace = useCallback(
    (directory: string): void => {
      void runAction(() => runtime.hideWorkspace(directory));
    },
    [runAction, runtime],
  );
  const openDirectoryPicker = useCallback((): void => {
    clearActionError();
    setDirectoryPickerOpen(true);
  }, [clearActionError]);
  const selectDirectory = useCallback(
    async (directory: string): Promise<void> => {
      if (await runAction(() => runtime.openWorkspace(directory))) {
        setDirectoryPickerOpen(false);
      }
    },
    [runAction, runtime],
  );

  const openOverlayForSlashText = useCallback(
    async (text: string): Promise<boolean> => {
      const generation = commandScopeGeneration.current;
      let catalog: UiWebCommandCatalog;
      try {
        catalog = await runtime.listWebCommands();
      } catch {
        return false;
      }
      if (generation !== commandScopeGeneration.current) return false;
      const resolved = resolveSlashCommand(
        catalog,
        parseSlashCommandInput(text),
        { surface: "tui" },
      );
      if (!resolved.ok) {
        return false;
      }
      const command = catalog.commands.find(
        (candidate) => candidate.id === resolved.command.id,
      );
      if (command?.executionKind !== "overlay") {
        return false;
      }
      const kind = structuredOverlayKindForAction(command.action);
      if (!kind) {
        return false;
      }
      setStructuredOverlay({
        commandLabel: slashCommandLabel(command),
        ...(kind === "goal"
          ? { goalIntent: goalPanelIntentFromArgs(resolved.rawArgs) }
          : {}),
        kind,
      });
      return true;
    },
    [runtime],
  );
  const submitText = useCallback(
    async (
      text: string,
      clientRequestId?: string,
      reasoning?: UiReasoningConfig,
    ): Promise<boolean> => {
      if (text.startsWith("/")) {
        const generation = commandScopeGeneration.current;
        const opened = await openOverlayForSlashText(text);
        if (generation !== commandScopeGeneration.current) return false;
        if (opened) return true;
        clearActionError();
        try {
          const completion = await runtime.executeSlashCommand({
            ...(view.composer.activeSessionId === undefined
              ? {}
              : { sessionId: view.composer.activeSessionId }),
            text,
            clientRequestId,
          });
          return completion.status === "completed";
        } catch (error) {
          if (
            generation === commandScopeGeneration.current &&
            !(
              typeof error === "object" &&
              error !== null &&
              "commandFeedback" in error
            )
          )
            setCommandInputError({
              scopeKey: draftScopeKey,
              clientRequestId,
              message: error instanceof Error ? error.message : String(error),
            });
          return false;
        }
      }
      const requestId = clientRequestId ?? globalThis.crypto.randomUUID();
      const submittedSessionId = view.composer.activeSessionId;
      const placement =
        submittedSessionId !== undefined &&
        (hasActiveTurnForSession(view.snapshot, submittedSessionId) ||
          localPromptAttempts.some(
            (attempt) =>
              attempt.placement === "conversation" &&
              localAttemptSessionMatches(attempt, submittedSessionId),
          ))
          ? "queue"
          : "conversation";
      try {
        clearActionError();
        setLocalPromptAttempts((attempts) => [
          ...attempts.filter(
            (attempt) => attempt.clientRequestId !== requestId,
          ),
          {
            clientRequestId: requestId,
            createdAt: new Date().toISOString(),
            originSessionId: submittedSessionId ?? null,
            placement,
            ...(submittedSessionId === undefined ? {} : { submittedSessionId }),
            text,
          },
        ]);
        const receipt = await client.submitPromptAccepted(text, {
          ...(reasoning === undefined ? {} : { reasoning }),
          clientRequestId: requestId,
          ...(submittedSessionId === undefined
            ? {}
            : { sessionId: submittedSessionId }),
        });
        if (receipt.clientRequestId !== requestId) {
          throw new Error("Prompt receipt did not match this submission");
        }
        setLocalPromptAttempts((attempts) =>
          attempts.map((attempt) =>
            attempt.clientRequestId === requestId
              ? {
                  ...attempt,
                  submittedSessionId: receipt.sessionId,
                  userMessageId: receipt.userMessageId,
                }
              : attempt,
          ),
        );
        if (
          submittedSessionId === undefined &&
          runtime.store.getSnapshot().sessionSync.scope === null &&
          runtime.getWorkspaceSnapshot().selectedDirectory ===
            workspace.selectedDirectory
        ) {
          void runtime
            .selectSession(receipt.sessionId)
            .catch((error: unknown) => {
              setActionError(
                `Prompt accepted, but the session could not be opened: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
        }
        return true;
      } catch (error) {
        setLocalPromptAttempts((attempts) =>
          attempts.filter((attempt) => attempt.clientRequestId !== requestId),
        );
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [
      clearActionError,
      draftScopeKey,
      openOverlayForSlashText,
      runAction,
      client,
      localPromptAttempts,
      runtime,
      view.composer.activeSessionId,
      view.snapshot,
      workspace.selectedDirectory,
    ],
  );
  const createSession = useCallback((): void => {
    void runAction(() => runtime.createSession());
  }, [runAction, runtime]);
  const selectSession = useCallback(
    (sessionId: string): void => {
      if (sessionId === view.activeSession?.id) {
        return;
      }
      void runAction(() => runtime.selectSession(sessionId));
    },
    [runAction, runtime, view.activeSession?.id],
  );
  const archiveSession = useCallback(
    (sessionId: string): void => {
      if (!window.confirm("Archive this session?")) {
        return;
      }
      void runAction(() => runtime.archiveSession(sessionId));
    },
    [runAction, runtime],
  );
  const listCommands = useCallback(() => runtime.listWebCommands(), [runtime]);
  const openGoalPanel = useCallback((intent?: GoalPanelIntent) => {
    setStructuredOverlay({
      commandLabel: "/goal",
      goalIntent: intent ?? DEFAULT_GOAL_PANEL_INTENT,
      kind: "goal",
    });
  }, []);
  const openStructuredCommand = useCallback(
    (request: StructuredCommandRequest) => {
      const { item, text } = request;
      const kind = structuredOverlayKindForAction(item.action);
      if (!kind) {
        return;
      }
      setStructuredOverlay({
        commandLabel: item.label,
        ...(kind === "goal"
          ? {
              goalIntent: goalPanelIntentFromArgs(
                text.startsWith(item.label)
                  ? text.slice(item.label.length)
                  : "",
              ),
            }
          : {}),
        kind,
      });
    },
    [],
  );
  const commandModalNotice = useMemo(
    () =>
      [...view.commandNotices]
        .reverse()
        .find((notice) => createCommandResultModel(notice) !== null) ?? null,
    [view.commandNotices],
  );

  const subagents = useMemo(
    () => createSubagentReader(client, view.activeSession?.id ?? ""),
    [client, view.activeSession?.id],
  );
  const subagentState = useSyncExternalStore(
    subagents.subscribe,
    subagents.getSnapshot,
  );
  useEffect(() => {
    if (!view.activeSession?.id) return;
    void subagents.refresh();
    const timer = setInterval(() => {
      void subagents.refresh();
    }, 1000);
    return (): void => {
      clearInterval(timer);
      subagents.dispose();
    };
  }, [subagents, view.activeSession?.id]);
  const childReader = useMemo(
    () =>
      createSubagentConversationReader(client, view.activeSession?.id ?? ""),
    [client, view.activeSession?.id],
  );
  const childReadingCache = useMemo<SubagentReadingCache>(
    () => new Map(),
    [childReader],
  );
  const childState = useSyncExternalStore(
    useCallback(
      (listener: () => void) => childReader.subscribe(listener),
      [childReader],
    ),
    childReader.getSnapshot,
  );
  useEffect(
    () => (): void => {
      childReader.dispose();
    },
    [childReader],
  );
  const viewingSubagent = childState.selected !== undefined;
  const approvalDialogVisible =
    !viewingSubagent && view.pendingPermissions.length > 0;
  const [childExpanded, setChildExpanded] = useState(false);
  const [childAnchorToken, setChildAnchorToken] = useState(0);
  const childTrigger = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeChild = useCallback(() => {
    childReader.close();
    setChildExpanded(false);
    requestAnimationFrame(() => {
      const approvalTitle = contentRef.current?.querySelector<HTMLElement>(
        ".ohb-permission-modal h2",
      );
      if (approvalTitle) {
        approvalTitle.focus({ preventScroll: true });
        return;
      }
      const target = childTrigger.current?.isConnected
        ? childTrigger.current
        : contentRef.current?.querySelector<HTMLElement>(
            ".ohb-root-conversation",
          );
      target?.focus({ preventScroll: true });
    });
  }, [childReader]);
  const composerFocusBeforeApproval = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const rememberComposerFocus = (event: FocusEvent): void => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        target.closest(".ohb-permission-modal")
      )
        return;
      composerFocusBeforeApproval.current =
        target instanceof HTMLTextAreaElement &&
        target.closest(".ohb-root-composer")
          ? target
          : null;
    };
    document.addEventListener("focusin", rememberComposerFocus);
    return (): void => {
      document.removeEventListener("focusin", rememberComposerFocus);
    };
  }, []);
  const previousApprovalVisible = useRef(false);
  useLayoutEffect(() => {
    const wasVisible = previousApprovalVisible.current;
    previousApprovalVisible.current = approvalDialogVisible;
    if (approvalDialogVisible || !wasVisible) return;
    const restore = composerFocusBeforeApproval.current;
    composerFocusBeforeApproval.current = null;
    if (!viewingSubagent && restore?.isConnected)
      restore.focus({ preventScroll: true });
  }, [approvalDialogVisible, viewingSubagent]);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !approvalDialogVisible) return;
    const card = content.querySelector<HTMLElement>(".ohb-permission-modal");
    if (!card) return;
    const measure = (): void => {
      content.style.setProperty(
        "--approval-space",
        `${String(card.getBoundingClientRect().height + 24)}px`,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(card);
    return (): void => {
      observer?.disconnect();
      content.style.removeProperty("--approval-space");
    };
  }, [approvalDialogVisible]);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !viewingSubagent || childExpanded) return;
    const composer = content.querySelector<HTMLElement>(".ohb-composer-input");
    const header = content.querySelector<HTMLElement>(".ohb-statusbar");
    const measure = (): void => {
      if (!composer) return;
      const rect = content.getBoundingClientRect();
      const geometry = subagentSheetGeometry(
        rect,
        composer.getBoundingClientRect(),
        header?.getBoundingClientRect().bottom ?? rect.top,
        window.innerWidth <= 720,
      );
      for (const [key, value] of Object.entries(geometry))
        content.style.setProperty(`--child-${key}`, `${String(value)}px`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    if (composer) observer.observe(composer);
    if (header) observer.observe(header);
    return (): void => {
      observer.disconnect();
    };
  }, [viewingSubagent, childExpanded]);

  return (
    <main
      className={`ohb-app ohb-app-shell ${
        showMain ? "ohb-app-main" : "ohb-app-empty"
      }`}
    >
      <ProjectRail
        onAdd={openDirectoryPicker}
        onHide={hideWorkspace}
        onSelect={switchWorkspace}
        onToggleSessions={() => {
          setSessionSidebarOpen((open) => !open);
        }}
        sessionsOpen={sessionSidebarOpen}
        workspace={workspace}
      />
      <SessionSidebar
        open={sessionSidebarOpen}
        onArchiveSession={archiveSession}
        onCreateSession={createSession}
        onSelectSession={selectSession}
        view={view}
        workspace={workspace}
      />
      <div
        ref={contentRef}
        className={`ohb-app-content ${
          showMain ? "ohb-app-content-main" : "ohb-app-content-empty"
        } ${sessionSyncBanner === "loading" ? "ohb-app-content-loading" : ""} ${view.activeTodoList ? "ohb-app-content-has-todos" : ""} ${approvalDialogVisible ? "has-approval" : ""}`}
      >
        <PermissionModal
          visible={!viewingSubagent}
          disabled={storeSnapshot.permissionSync.status !== "ready"}
          error={storeSnapshot.permissionSync.error}
          syncing={storeSnapshot.permissionSync.status === "syncing"}
          onRetry={() => {
            runtime.retryPermissions();
          }}
          onRespond={(request, choice) =>
            runAction(() =>
              client.respondPermission(request.id, { choiceId: choice.id }),
            )
          }
          onCancel={stopRequest.stop}
          canCancel={view.composer.canStop}
          cancelLabel={stopRequest.label}
          permissions={view.pendingPermissions}
        />
        <SessionSyncNotice
          state={sessionSyncBanner}
          error={storeSnapshot.sessionSync.error}
          onRetry={() => {
            runtime.retrySession();
          }}
        />
        {promptRecoveryReminders.length > 0 ? (
          <div className="ohb-error-banner" role="status">
            <span>
              {promptRecoveryReminders.some(
                (request) => request.status === "epoch-changed",
              )
                ? "The backend restarted. A previous submission could not be confirmed; check its original conversation before sending again."
                : "Submission result is unknown. Check its receipt before sending again."}
            </span>
            <button
              type="button"
              onClick={() => {
                void runtime.retryUnknownPrompts();
              }}
            >
              Check submission
            </button>
            {promptRecoveryReminders.map((request) => (
              <button
                key={request.clientRequestId}
                type="button"
                disabled={request.submitting}
                title="Remove this local reminder. The original submission may still have run; this does not cancel or resend it."
                onClick={() => {
                  runtime.forgetUnknownPrompt(request.clientRequestId);
                }}
              >
                Forget pending submission
              </button>
            ))}
          </div>
        ) : null}
        {storeSnapshot.sessionSync.view?.reasoningMissing ? (
          <div className="ohb-error-banner" role="status">
            Some thinking could not be saved and is no longer available.
          </div>
        ) : null}
        {showMain ? (
          <div
            className="ohb-root-conversation"
            tabIndex={-1}
            inert={viewingSubagent && childExpanded}
            style={
              viewingSubagent && childExpanded
                ? { visibility: "hidden" }
                : undefined
            }
          >
            <StatusBar
              onOpenContextUsage={() => {
                const sessionId = view.activeSession?.id;
                if (sessionId) {
                  void client
                    .getContextWindowUsage({ sessionId })
                    .catch(() => undefined);
                }
              }}
              waitingSummary={
                subagentState.list?.waiting
                  ? `Waiting for subagents  ${String(subagentState.list.completedCount)} done  ${String(subagentState.list.activeCount)} open`
                  : undefined
              }
              activeGoal={view.activeGoal}
              header={view.header}
              onOpenGoalPanel={openGoalPanel}
              sessionId={view.activeSession?.id ?? null}
            />
            <ErrorBanner
              message={errorBannerMessage}
              onDismiss={clearActionError}
            />
            <DurationSampleContext.Provider
              value={storeSnapshot.durationSample}
            >
              <ConversationPresentation.Provider
                value={{
                  renderTool: (message, call, result) =>
                    call.name === "subagent_run" ? (
                      <DelegationRow
                        call={call}
                        result={result}
                        execution={delegationExecution(
                          message,
                          call,
                          subagentState.list?.executions ?? [],
                          view.activeSession?.id ?? "",
                        )}
                        onOpen={(execution, trigger) => {
                          childTrigger.current = trigger;
                          setChildAnchorToken((value) => value + 1);
                          void childReader.select(execution);
                        }}
                      />
                    ) : undefined,
                }}
              >
                <ConversationStream
                  historyState={storeSnapshot.historyState}
                  historyHasMore={storeSnapshot.historyHasMore}
                  historyStale={storeSnapshot.historyStale}
                  historyError={storeSnapshot.historyError}
                  onLoadHistory={() => runtime.loadEarlierHistory()}
                  promptRows={promptProjection.rows}
                  startupThinkingAt={promptProjection.startupThinkingAt}
                  messages={view.activeSession?.messages ?? []}
                  sessionId={view.activeSession?.id ?? null}
                  prompts={(view.snapshot?.prompts ?? []).filter(
                    (prompt) => prompt.sessionId === view.activeSession?.id,
                  )}
                  activeRun={view.snapshot?.runs.find(
                    (run) =>
                      run.sessionId === view.composer.activeSessionId &&
                      run.id === view.composer.activeRunId,
                  )}
                  isRunning={
                    view.composer.isRunning && !subagentState.list?.waiting
                  }
                  reasoningByMessageId={view.reasoningByMessageId}
                  commandNotices={
                    <CommandNoticeList
                      notices={view.commandNotices.filter(
                        (notice) => notice.kind === "success",
                      )}
                      onClose={(id) => {
                        runtime.store.consumeCommand(id);
                      }}
                    />
                  }
                />
              </ConversationPresentation.Provider>
            </DurationSampleContext.Provider>
            {!viewingSubagent && commandModalNotice ? (
              <CommandResultModal
                header={view.header}
                notice={commandModalNotice}
                onClose={() => {
                  runtime.store.consumeCommand(commandModalNotice.id);
                }}
                onInsertSkill={(text) => {
                  composerPrefillNonce.current += 1;
                  setComposerPrefill({
                    nonce: composerPrefillNonce.current,
                    scopeKey: draftScopeKey,
                    editRevision: composerEditRevision.current,
                    text,
                  });
                  runtime.store.consumeCommand(commandModalNotice.id);
                }}
                view={{
                  activeSession: view.activeSession
                    ? { title: view.activeSession.title }
                    : null,
                  composer: {
                    activeSessionId: view.composer.activeSessionId,
                    mode: view.composer.mode,
                    permissionLevel: view.composer.permissionLevel,
                  },
                }}
              />
            ) : null}
          </div>
        ) : (
          <>
            <ErrorBanner
              message={errorBannerMessage}
              onDismiss={clearActionError}
            />
            <EmptyState
              onOpenGoalPanel={openGoalPanel}
              status={view.header}
              view={view}
              workspaceDirectory={workspace.selectedDirectory}
            />
          </>
        )}
        <div
          className="ohb-root-composer"
          inert={approvalDialogVisible}
          style={{
            display:
              approvalDialogVisible || (viewingSubagent && childExpanded)
                ? "none"
                : "contents",
          }}
        >
          <Composer
            readOnly={viewingSubagent || approvalDialogVisible}
            client={client}
            compact={!showMain}
            draftScopeKey={draftScopeKey}
            onEditRevision={trackComposerRevision}
            isPromptAdmitting={isPromptAdmitting}
            prefill={composerPrefill}
            onListCommands={listCommands}
            onSetPermission={(input) => {
              void runAction(async () => {
                await client.setPermission(input);
              });
            }}
            onStructuredCommand={openStructuredCommand}
            onSubmit={submitText}
            onStop={stopRequest.stop}
            stopLabel={stopRequest.label}
            model={{
              ...view.composer,
              disabled:
                view.composer.disabled ||
                viewingSubagent ||
                approvalDialogVisible,
            }}
            activeSession={view.activeSession}
            queuedPrompts={view.queuedPrompts}
            unsentSteer={hasUnsentSteerAfterLatestStop(
              view.snapshot?.runs ?? [],
              view.composer.activeSessionId,
            )}
            commandCatalogVersion={view.commandCatalogVersion}
            connectionKind={view.header.connectionKind}
            topContent={
              <>
                <ErrorBanner
                  message={
                    commandInputError?.scopeKey === draftScopeKey
                      ? commandInputError.message
                      : null
                  }
                  onDismiss={() => {
                    setCommandInputError(null);
                  }}
                />
                <CommandNoticeList
                  notices={view.commandNotices.filter(
                    (notice) => notice.kind === "error",
                  )}
                  onClose={(id) => {
                    runtime.store.consumeCommand(id);
                  }}
                />
                <TodoDock
                  key={view.activeTodoList?.sessionId ?? "hidden"}
                  todoList={view.activeTodoList}
                />
              </>
            }
            permissionControl={
              <PermissionPolicyControl
                level={view.composer.permissionLevel}
                disabled={view.composer.disabled}
                onSetPermission={(input) => {
                  void runAction(async () => {
                    await client.setPermission(input);
                  });
                }}
              />
            }
          />
        </div>
        {viewingSubagent ? (
          <SubagentView
            reader={childReader}
            readingCache={childReadingCache}
            state={childState}
            rootTitle={view.activeSession?.title ?? "Main conversation"}
            title={childState.conversation?.displayName ?? "Subagent"}
            expanded={childExpanded}
            onExpandedChange={setChildExpanded}
            onClose={closeChild}
            approvalRequired={view.pendingPermissions.length > 0}
            anchorToken={String(childAnchorToken)}
          />
        ) : null}
        {!viewingSubagent && structuredOverlay ? (
          <StructuredCommandOverlay
            key={draftScopeKey}
            client={client}
            onExecuteSlashCommand={(input) =>
              runtime.executeSlashCommand(input)
            }
            onClose={() => {
              setStructuredOverlay(null);
            }}
            overlay={structuredOverlay}
            sessionId={view.composer.activeSessionId ?? view.activeSession?.id}
            activeGoal={view.activeGoal}
          />
        ) : null}
        {directoryPickerOpen ? (
          <DirectoryPickerDialog
            directoryPicker={runtime}
            onClose={() => {
              setDirectoryPickerOpen(false);
            }}
            onSelect={selectDirectory}
          />
        ) : null}
      </div>
    </main>
  );
}
