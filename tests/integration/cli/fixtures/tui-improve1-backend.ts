import type {
  CoreAPI,
  UiEvent,
  UiEventHandler,
  UiPermissionEvent,
  UiPermissionRequest,
  UiSessionView,
} from "ohbaby-sdk";

/** Synthetic backend only: no model calls, filesystem tools, or real approvals. */
export function createTuiReviewBackend(historyLines = 40) {
  const handlers = new Set<UiEventHandler>();
  const approvals = new Set<(event: UiPermissionEvent) => void>();
  let requests: UiPermissionRequest[] = [];
  let permissionRevision = 0;
  let refreshes = 0;
  const submitted: string[] = [];
  const responses: { requestId: string; choiceId: string }[] = [];
  const now = "2026-10-03T00:00:00.000Z";
  let view: UiSessionView = {
    version: {
      runtimeEpoch: "review-epoch",
      sessionId: "review-session",
      viewGeneration: "review-view",
      sessionRevision: 1,
    },
    session: {
      id: "review-session",
      title: "TUI review",
      projectRoot: "/review/中文-project",
      reasoning: { effort: "high" },
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: "user",
          role: "user",
          createdAt: now,
          parts: [{ type: "text", text: "检查中文布局 🧪" }],
        },
        {
          id: "internal",
          role: "system",
          runtimeInputKind: "subagent-status",
          createdAt: "2026-10-03T00:00:00.001Z",
          parts: [
            { type: "text", text: "INTERNAL_OBSERVATION_DO_NOT_DISPLAY" },
          ],
        },
        {
          id: "answer",
          role: "assistant",
          createdAt: "2026-10-03T00:00:00.002Z",
          status: "completed",
          parts: [
            { type: "reasoning", text: "PRIVATE_REASONING_DO_NOT_DISPLAY" },
            {
              type: "text",
              text: Array.from(
                { length: historyLines },
                (_, i) => `History ${i + 1}: 可复制的正文 and stable history`,
              ).join("\n"),
            },
          ],
        },
      ],
    },
    runs: [],
    prompts: [],
    history: { hasMore: false },
    reasoningMissing: false,
    goal: { status: "ready", value: null },
    todo: {
      status: "ready",
      value: {
        sessionId: "review-session",
        visible: true,
        todos: Array.from({ length: 7 }, (_, i) => ({
          content: `Review task ${i + 1}`,
          status: i === 0 ? "in_progress" : "pending",
        })),
      },
    },
    context: {
      status: "ready",
      value: {
        sessionId: "review-session",
        modelId: "old-usage-model",
        currentTokens: 2000,
        contextWindowTokens: 1000000,
        contextWindowRatio: 0.002,
        estimatedAt: now,
      },
    },
  };
  const emit = (event: UiEvent): void => {
    for (const handler of handlers) handler(event);
  };
  const subscribeEvents = (handler: UiEventHandler): (() => void) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  };
  const update = (patch: Partial<UiSessionView> = {}): void => {
    view = {
      ...view,
      ...patch,
      version: {
        ...view.version,
        sessionRevision: view.version.sessionRevision + 1,
      },
    };
    emit({
      type: "session.changed",
      version: view.version,
      messages: view.session.messages,
      runs: view.runs,
      prompts: view.prompts,
      todo: view.todo,
      context: view.context,
    });
  };
  const client = {
    submitPromptAccepted: async (
      text: string,
      options?: Parameters<CoreAPI["submitPromptAccepted"]>[1],
    ) => {
      submitted.push(text);
      return {
        promptId: `review-prompt-${submitted.length}`,
        clientRequestId: options?.clientRequestId ?? "review-request",
        userMessageId: "review-user",
        sessionId: view.session.id,
        status: "queued" as const,
        createdAt: now,
      };
    },
    getSelectedSessionId: async () => view.session.id,
    getSessionIndex: async () => [{ ...view.session, messages: undefined }],
    getSessionView: async () => view,
    getSessionHistory: async () => ({
      version: view.version,
      messages: [],
      prompts: [],
      reasoningMissing: false,
      hasMore: false,
    }),
    getSessionControl: async () => ({
      runtimeEpoch: "review-epoch",
      sessionId: view.session.id,
      rootSessionId: view.session.id,
      runId: view.runs.find((run) => run.status.kind === "running")?.id ?? null,
      driver: "user" as const,
    }),
    getPromptReceipt: async ({
      clientRequestId,
    }: {
      clientRequestId: string;
    }) => ({ runtimeEpoch: "review-epoch", clientRequestId, receipt: null }),
    getPermissionSnapshot: async ({
      rootSessionId,
    }: {
      rootSessionId: string | null;
    }) => ({
      permissionEpoch: "review-epoch",
      rootSessionId,
      permissionRevision,
      requests,
    }),
    subscribePermissionEvents: (
      handler: (event: UiPermissionEvent) => void,
    ) => {
      approvals.add(handler);
      return () => {
        approvals.delete(handler);
      };
    },
    respondPermission: async (
      requestId: string,
      response: { choiceId: string },
    ) => {
      responses.push({ requestId, choiceId: response.choiceId });
      requests = requests.filter((request) => request.id !== requestId);
      permissionRevision++;
      for (const handler of approvals)
        handler({
          type: "permission.resolved",
          permissionEpoch: "review-epoch",
          rootSessionId: view.session.id,
          permissionRevision,
          requestId,
        });
    },
    getCurrentModel: async () => ({
      provider: "review",
      baseUrl: "https://example.invalid",
      interfaceProvider: "anthropic" as const,
      model: "review-model",
      reasoning: {
        status: "identified" as const,
        mode: "effort" as const,
        efforts: ["low", "high"],
        default: { effort: "low" },
      },
    }),
    getContextWindowUsage: async () =>
      view.context.status === "ready" ? view.context.value : null,
    listCommands: async () => ({ version: "review", commands: [] }),
    listSubagentExecutions: async () => {
      refreshes++;
      return {
        executions: [],
        activeCount: 0,
        completedCount: 0,
        waiting: false,
        approvalBlocked: false,
        hasMore: false,
      };
    },
    getSubagentExecutionView: async () => {
      throw new Error("No fake execution selected");
    },
  } satisfies Partial<CoreAPI>;
  return {
    client: client as CoreAPI,
    subscribeEvents,
    emit,
    update,
    get view() {
      return view;
    },
    get refreshes() {
      return refreshes;
    },
    get requests() {
      return requests;
    },
    responses,
    submitted,
    approve(patch: Partial<UiPermissionRequest> = {}): void {
      const request: UiPermissionRequest = {
        id: "fake-approval",
        rootSessionId: view.session.id,
        sessionId: view.session.id,
        runId: "review-run",
        callId: "fake-call",
        messageId: "answer",
        createdAt: Date.now(),
        title: "Fake review approval",
        description: "Synthetic preview only",
        choices: [
          { id: "allow", label: "Allow once", intent: "allow" },
          { id: "deny", label: "Deny", intent: "deny" },
        ],
        ...patch,
      };
      requests = [request];
      permissionRevision++;
      for (const handler of approvals)
        handler({
          type: "permission.requested",
          permissionEpoch: "review-epoch",
          rootSessionId: view.session.id,
          permissionRevision,
          request,
        });
    },
  };
}
