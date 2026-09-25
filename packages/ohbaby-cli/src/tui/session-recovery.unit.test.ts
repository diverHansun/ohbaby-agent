import { describe, expect, it, vi, type Mock } from "vitest";
import { createRPC, type CoreAPI, type UiSessionView } from "ohbaby-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPendingPromptStorage } from "./pending-prompts.js";
import {
  createTuiSessionRecovery,
  type TuiSessionRecovery,
} from "./session-recovery.js";
import { createTuiStore } from "./store/events.js";

const view = (id = "a", revision = 1): UiSessionView => ({
  version: {
    runtimeEpoch: "epoch",
    sessionId: id,
    viewGeneration: "g",
    sessionRevision: revision,
  },
  session: {
    id,
    title: id,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    messages: [],
  },
  runs: [],
  prompts: [],
  history: { hasMore: false },
  reasoningMissing: false,
  todo: { status: "ready", value: null },
  goal: { status: "ready", value: null },
  context: { status: "ready", value: null },
});
const tick = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function setup(
  overrides: Record<string, unknown> = {},
  options: Pick<
    Parameters<typeof createTuiSessionRecovery>[0],
    "pending" | "savePending" | "onHistory"
  > = {},
): {
  client: Record<
    | "getPermissionSnapshot"
    | "getSelectedSessionId"
    | "getSessionIndex"
    | "getSessionView"
    | "getSessionHistory"
    | "getSessionControl"
    | "getPromptReceipt"
    | "getSnapshot"
    | "abortRun"
    | "submitPromptAccepted",
    Mock
  >;
  store: ReturnType<typeof createTuiStore>;
  recovery: TuiSessionRecovery;
} {
  const client = {
    getPermissionSnapshot: vi.fn(() =>
      Promise.resolve({
        permissionEpoch: "epoch",
        permissionRevision: 0,
        rootSessionId: null,
        requests: [],
      }),
    ),
    getSelectedSessionId: vi.fn(() => Promise.resolve("a")),
    getSessionIndex: vi.fn(() => Promise.resolve([view().session])),
    getSessionView: vi.fn(({ sessionId }: { sessionId: string }) =>
      Promise.resolve(view(sessionId)),
    ),
    getSessionHistory: vi.fn(),
    getSessionControl: vi.fn(({ sessionId }: { sessionId: string }) =>
      Promise.resolve({
        runtimeEpoch: "epoch",
        sessionId,
        rootSessionId: sessionId,
        runId: "real-run",
        driver: "user",
      }),
    ),
    getPromptReceipt: vi.fn(() =>
      Promise.resolve({
        runtimeEpoch: "epoch",
        clientRequestId: "request",
        receipt: null,
      }),
    ),
    getSnapshot: vi.fn(),
    abortRun: vi.fn(() => Promise.resolve()),
    submitPromptAccepted: vi.fn(),
    ...overrides,
  };
  const store = createTuiStore({
    activeSessionId: null,
    sessions: [],
    runs: [],
    permissions: [],
    status: { kind: "idle" },
  });
  const recovery = createTuiSessionRecovery({
    client: client as unknown as CoreAPI,
    store,
    ...options,
  });
  return { client, store, recovery };
}
describe("TUI source recovery", () => {
  it("starts from the selected source view and ignores legacy replacement", async () => {
    const { client, store, recovery } = setup();
    await recovery.start();
    await tick();
    expect(store.getState().activeSessionId).toBe("a");
    expect(client.getSnapshot).not.toHaveBeenCalled();
    expect(
      recovery.receive({
        type: "snapshot.replaced",
        snapshot: {
          activeSessionId: "old",
          sessions: [],
          runs: [],
          permissions: [],
          status: { kind: "idle" },
        },
      }),
    ).toBe(true);
    expect(store.getState().activeSessionId).toBe("a");
    recovery.dispose();
  });
  it("buffers actual message identities during baseline and keeps reasoning failures", async () => {
    let release!: (value: UiSessionView) => void;
    const { recovery, store } = setup({
      getSessionView: vi.fn(
        () =>
          new Promise<UiSessionView>((resolve) => {
            release = resolve;
          }),
      ),
    });
    await recovery.start();
    await tick();
    recovery.receive({
      type: "session.changed",
      version: view("a", 2).version,
      messages: [
        {
          id: "real-message",
          role: "assistant",
          status: "completed",
          createdAt: "2026-01-01",
          parts: [
            {
              id: "real-part",
              type: "reasoning",
              text: "thought",
              saveState: "failed",
            },
          ],
        },
      ],
      reasoningMissing: true,
    });
    release(view());
    await tick();
    expect(store.getState().messages[0]?.id).toBe("real-message");
    expect(store.getState().messages[0]?.parts[0]).toMatchObject({
      id: "real-part",
      saveState: "failed",
    });
    expect(recovery.getState().sync.view?.reasoningMissing).toBe(true);
    recovery.dispose();
  });
  it("rejects missing capabilities explicitly without legacy reads", async () => {
    const { client, recovery } = setup({ getSessionView: undefined });
    await recovery.start();
    expect(recovery.getState().error).toContain("SESSION_RECOVERY_UNSUPPORTED");
    expect(client.getSnapshot).not.toHaveBeenCalled();
    recovery.dispose();
  });
  it("does not install stale A control after switching to B and stops exact current control run", async () => {
    let release!: (value: unknown) => void;
    const { client, recovery } = setup({
      getSessionControl: vi.fn(({ sessionId }: { sessionId: string }) =>
        sessionId === "a"
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve({
              runtimeEpoch: "epoch",
              sessionId,
              rootSessionId: sessionId,
              runId: "b-run",
              driver: "user",
            }),
      ),
    });
    await recovery.start();
    await tick();
    recovery.select("b");
    await tick();
    release({
      runtimeEpoch: "epoch",
      sessionId: "a",
      rootSessionId: "a",
      runId: "a-run",
      driver: "user",
    });
    await tick();
    await recovery.stop("b-run");
    expect(client.abortRun).toHaveBeenCalledWith("b-run");
    recovery.dispose();
  });
  it("queries a lost receipt with its original ID and never replays POST", async () => {
    const { client, recovery } = setup({
      submitPromptAccepted: vi.fn(() =>
        Promise.reject(new Error("connection lost")),
      ),
    });
    await recovery.start();
    await tick();
    await expect(recovery.submit("hello")).rejects.toThrow("unknown");
    const id = (
      client.submitPromptAccepted.mock.calls as unknown as [
        string,
        { clientRequestId: string },
      ][]
    )[0][1].clientRequestId;
    await recovery.reconcileReceipts();
    expect(client.getPromptReceipt).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientRequestId: id, sessionId: "a" }),
    );
    expect(client.submitPromptAccepted).toHaveBeenCalledTimes(1);
    recovery.dispose();
  });
  it("holds recovery on remote disconnect and starts a fresh scope on hello", async () => {
    const { client, recovery } = setup();
    await recovery.start();
    await tick();
    recovery.receive({
      type: "session.resync-required",
      runtimeEpoch: "epoch",
      sessionId: "a",
      connectionGeneration: 1,
      disconnected: true,
    });
    const count = client.getSessionView.mock.calls.length;
    recovery.retry();
    await tick();
    expect(client.getSessionView).toHaveBeenCalledTimes(count);
    recovery.receive({
      type: "session.resync-required",
      runtimeEpoch: "epoch",
      sessionId: "a",
      connectionGeneration: 2,
    });
    await tick();
    expect(client.getSessionView).toHaveBeenCalledTimes(count + 1);
    recovery.dispose();
  });
  it("does not overwrite a live message with an older page and keeps invalidated history readable", async () => {
    let release!: (value: unknown) => void;
    const initial = { ...view(), history: { hasMore: true, before: "cursor" } };
    const { recovery, store } = setup({
      getSessionView: vi.fn(() => Promise.resolve(initial)),
      getSessionHistory: vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    });
    await recovery.start();
    await tick();
    const pending = recovery.loadHistory();
    const old = {
      id: "old",
      createdAt: "2025-01-01",
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "old page" }],
    };
    recovery.receive({
      type: "session.changed",
      version: view("a", 2).version,
      messages: [{ ...old, parts: [{ type: "text", text: "new live" }] }],
    });
    release({
      version: view().version,
      messages: [old, { ...old, id: "older" }],
      prompts: [],
      reasoningMissing: true,
      hasMore: false,
    });
    await pending;
    expect(
      store.getState().messages.find((item) => item.id === "old")?.parts[0],
    ).toMatchObject({ text: "new live" });
    expect(store.getState().messages.some((item) => item.id === "older")).toBe(
      true,
    );
    recovery.receive({
      type: "session.changed",
      version: view("a", 3).version,
      historyInvalidated: true,
    });
    expect(recovery.getState().historyStale).toBe(true);
    expect(store.getState().messages.some((item) => item.id === "older")).toBe(
      true,
    );
    recovery.dispose();
  });
  it("a delayed accepted response cannot jump back after the user selected B", async () => {
    let release!: (value: unknown) => void;
    const { recovery, store, client } = setup({
      getSelectedSessionId: vi.fn(() => Promise.resolve(null)),
      submitPromptAccepted: vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    });
    await recovery.start();
    const pending = recovery.submit("new session");
    recovery.select("b");
    await tick();
    release({
      clientRequestId: (
        client.submitPromptAccepted.mock.calls as unknown as [
          string,
          { clientRequestId: string },
        ][]
      )[0][1].clientRequestId,
      promptId: "p",
      sessionId: "a",
      userMessageId: "m",
      status: "queued",
      createdAt: "now",
    });
    await pending;
    expect(store.getState().activeSessionId).toBe("b");
    recovery.dispose();
  });
  it("invalidates a control reply that was in flight when disconnected", async () => {
    let release!: (value: unknown) => void;
    const { recovery, client } = setup({
      getSessionControl: vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    });
    await recovery.start();
    await tick();
    recovery.receive({
      type: "session.resync-required",
      runtimeEpoch: "epoch",
      sessionId: "a",
      connectionGeneration: 1,
      disconnected: true,
    });
    release({
      runtimeEpoch: "epoch",
      sessionId: "a",
      rootSessionId: "a",
      runId: "stale-run",
      driver: "user",
    });
    await tick();
    expect(recovery.getState().control).toBeNull();
    await expect(recovery.stop("stale-run")).rejects.toThrow(
      "Stop unavailable",
    );
    expect(client.abortRun).not.toHaveBeenCalled();
    recovery.dispose();
  });
  it("does not let old epoch events invalidate loaded history", async () => {
    const initial = { ...view(), history: { hasMore: true, before: "cursor" } };
    const { recovery, store } = setup({
      getSessionView: vi.fn(() => Promise.resolve(initial)),
      getSessionHistory: vi.fn(() =>
        Promise.resolve({
          version: view().version,
          messages: [
            {
              id: "old",
              createdAt: "2025-01-01",
              role: "assistant",
              parts: [],
            },
          ],
          prompts: [],
          reasoningMissing: false,
          hasMore: false,
        }),
      ),
    });
    await recovery.start();
    await tick();
    await recovery.loadHistory();
    recovery.receive({
      type: "session.changed",
      version: { ...view("a", 2).version, runtimeEpoch: "old-epoch" },
      historyInvalidated: true,
      removedMessageIds: ["old"],
    });
    expect(recovery.getState().historyStale).toBe(false);
    expect(
      store.getState().messages.some((message) => message.id === "old"),
    ).toBe(true);
    recovery.dispose();
  });
  it("blocks another POST while the original same-session receipt remains unknown", async () => {
    const { recovery, client } = setup({
      submitPromptAccepted: vi.fn(() =>
        Promise.reject(new Error("response lost")),
      ),
    });
    await recovery.start();
    await tick();
    await expect(recovery.submit("hello")).rejects.toThrow("unknown");
    await expect(recovery.submit("hello")).rejects.toThrow("unknown");
    expect(client.submitPromptAccepted).toHaveBeenCalledTimes(1);
    recovery.dispose();
  });
  it.each([false, true])(
    "does not adopt a late startup epoch after transport change (disconnected=%s)",
    async (disconnected) => {
      let release!: (value: {
        permissionEpoch: string;
        permissionRevision: number;
        rootSessionId: null;
        requests: never[];
      }) => void;
      const { recovery } = setup({
        getSelectedSessionId: vi.fn(() => Promise.resolve(null)),
        getPermissionSnapshot: vi.fn(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        ),
      });
      const startup = recovery.start();
      await tick();
      recovery.receive({
        type: "session.resync-required",
        runtimeEpoch: "new-epoch",
        sessionId: null,
        connectionGeneration: 2,
        disconnected,
      });
      release({
        permissionEpoch: "old-epoch",
        permissionRevision: 0,
        rootSessionId: null,
        requests: [],
      });
      await startup;
      expect(recovery.getState().runtimeEpoch).toBe(
        disconnected ? undefined : "new-epoch",
      );
      recovery.dispose();
    },
  );
});

describe("TUI rejected submissions and exact Stop targets", () => {
  it.each(["QUEUE_FULL", "PROMPT_SUBMISSION_REJECTED"])(
    "clears definite rejection %s preserved through the real local RPC bridge",
    async (code) => {
      const rpc = createRPC<Pick<CoreAPI, "submitPromptAccepted">>();
      rpc.connectImpl({
        submitPromptAccepted: () =>
          Promise.reject(Object.assign(new Error("queue full"), { code })),
      });
      const proxy = rpc.createProxy({});
      const savePending = vi.fn();
      const { recovery, client } = setup(
        {
          submitPromptAccepted: vi.fn(
            (...args: Parameters<CoreAPI["submitPromptAccepted"]>) =>
              proxy.submitPromptAccepted(...args),
          ),
        },
        { savePending },
      );
      await recovery.start();
      await tick();
      await expect(recovery.submit("first")).rejects.toThrow("queue full");
      expect(recovery.getState().pending).toEqual([]);
      expect(savePending).toHaveBeenLastCalledWith([]);
      await expect(recovery.submit("second")).rejects.toThrow("queue full");
      expect(client.submitPromptAccepted).toHaveBeenCalledTimes(2);
      expect(client.getPromptReceipt).not.toHaveBeenCalled();
      recovery.dispose();
    },
  );
  it("keeps ambiguous transport failures across restart until explicitly forgotten, without a repeated POST", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tui-recovery-restart-"));
    try {
      const disk = createPendingPromptStorage("workspace", directory);
      const first = setup(
        {
          submitPromptAccepted: vi.fn(() =>
            Promise.reject(new TypeError("fetch failed")),
          ),
        },
        {
          pending: disk.read(),
          savePending: (pending) => {
            disk.write(pending);
          },
        },
      );
      await first.recovery.start();
      await tick();
      await expect(first.recovery.submit("original")).rejects.toThrow(
        "unknown",
      );
      first.recovery.dispose();
      const reopened = createPendingPromptStorage("workspace", directory);
      const second = setup(
        {},
        {
          pending: reopened.read(),
          savePending: (pending) => {
            reopened.write(pending);
          },
        },
      );
      await second.recovery.start();
      await tick();
      expect(second.recovery.getState().pending).toHaveLength(1);
      await expect(second.recovery.submit("another")).rejects.toThrow(
        "unknown",
      );
      second.recovery.discardPending(
        second.recovery.getState().pending.map((item) => item.clientRequestId),
      );
      expect(second.client.submitPromptAccepted).not.toHaveBeenCalled();
      expect(createPendingPromptStorage("workspace", directory).read()).toEqual(
        [],
      );
      second.recovery.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("old runtime pending records stay visible but do not block a fresh explicitly submitted prompt", async () => {
    const { recovery, client } = setup(
      {
        submitPromptAccepted: vi.fn(
          (_text: string, input: { clientRequestId: string }) =>
            Promise.resolve({
              clientRequestId: input.clientRequestId,
              sessionId: "a",
              promptId: "p",
              userMessageId: "m",
              status: "queued",
              createdAt: "now",
            }),
        ),
      },
      {
        pending: [{ clientRequestId: "old", runtimeEpoch: "previous-runtime" }],
      },
    );
    await recovery.start();
    await tick();
    await recovery.submit("new explicit submission");
    expect(recovery.getState().pending).toEqual([
      { clientRequestId: "old", runtimeEpoch: "previous-runtime" },
    ]);
    expect(client.submitPromptAccepted).toHaveBeenCalledTimes(1);
    recovery.dispose();
  });
  it("does not forget an in-flight acceptance before its outcome becomes unknown", async () => {
    let reject!: (error: Error) => void;
    const { recovery } = setup({
      submitPromptAccepted: vi.fn(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      ),
    });
    await recovery.start();
    await tick();
    const submission = recovery.submit("in flight");
    const pending = recovery.getState().pending[0];
    recovery.discardPending([pending.clientRequestId]);
    expect(recovery.getState().pending).toEqual([pending]);
    reject(new TypeError("fetch failed"));
    await expect(submission).rejects.toThrow("unknown");
    recovery.discardPending([pending.clientRequestId]);
    expect(recovery.getState().pending).toEqual([]);
    recovery.dispose();
  });
  it("never retargets Stop(A) when its control refresh discovers B", async () => {
    const { recovery, client } = setup();
    await recovery.start();
    await tick();
    client.getSessionControl.mockResolvedValue({
      runtimeEpoch: "epoch",
      sessionId: "a",
      rootSessionId: "a",
      runId: "run-B",
      driver: "user",
    });
    await expect(recovery.stop("real-run")).rejects.toThrow("target has ended");
    expect(client.abortRun).not.toHaveBeenCalled();
    recovery.dispose();
  });
  it("cannot initiate Stop with unknown control even if a refresh would discover a run", async () => {
    const { recovery, client } = setup();
    await expect(recovery.stop("real-run")).rejects.toThrow("Stop unavailable");
    expect(client.getSessionControl).not.toHaveBeenCalled();
    expect(client.abortRun).not.toHaveBeenCalled();
    recovery.dispose();
  });
});

describe("TUI source text append transcript reset", () => {
  it.each(["completed", "streaming"] as const)(
    "refreshes committed %s text and reasoning with UTF16 offsets without replay reset",
    async (status) => {
      const baseline = view();
      const seeded: UiSessionView = {
        ...baseline,
        session: {
          ...baseline.session,
          messages: [
            {
              id: "m",
              role: "assistant",
              createdAt: "2026-01-01",
              status,
              parts: [
                { id: "text", type: "text", text: "😀a" },
                { id: "reasoning", type: "reasoning", text: "思考" },
              ],
            },
          ],
        },
      };
      const onHistory = vi.fn();
      const { recovery, store } = setup(
        { getSessionView: vi.fn(() => Promise.resolve(seeded)) },
        { onHistory },
      );
      await recovery.start();
      await tick();
      onHistory.mockClear();
      const event = {
        type: "session.changed" as const,
        version: view("a", 2).version,
        textAppends: [
          { messageId: "m", partId: "text", offset: 3, text: "完成" },
          { messageId: "m", partId: "reasoning", offset: 2, text: "🚀" },
        ],
      };
      recovery.receive(event);
      recovery.receive(event);
      await tick();
      expect(store.getState().messages[0].parts).toMatchObject([
        { text: "😀a完成" },
        { text: "思考🚀" },
      ]);
      expect(onHistory).toHaveBeenCalledTimes(status === "completed" ? 1 : 0);
      recovery.dispose();
    },
  );
});

describe("TUI independent control query frequency", () => {
  it("does not query control for 400 text appends or metadata but refreshes on run/prompt changes and explicit Stop", async () => {
    const { recovery, client } = setup();
    await recovery.start();
    await tick();
    const initialCalls = client.getSessionControl.mock.calls.length;
    recovery.receive({
      type: "session.changed",
      version: view("a", 2).version,
      messages: [
        {
          id: "stream",
          role: "assistant",
          status: "streaming",
          createdAt: "now",
          parts: [{ id: "text", type: "text", text: "" }],
        },
      ],
    });
    for (let i = 0; i < 400; i++)
      recovery.receive({
        type: "session.changed",
        version: view("a", i + 3).version,
        textAppends: [
          { messageId: "stream", partId: "text", offset: i, text: "x" },
        ],
      });
    recovery.receive({
      type: "session.changed",
      version: view("a", 403).version,
      session: { ...view().session, title: "renamed" },
    });
    await tick();
    expect(client.getSessionControl).toHaveBeenCalledTimes(initialCalls);
    const runEvent = {
      type: "session.changed" as const,
      version: view("a", 404).version,
      runs: [],
    };
    recovery.receive(runEvent);
    await tick();
    recovery.receive(runEvent);
    await tick();
    expect(client.getSessionControl).toHaveBeenCalledTimes(initialCalls + 1);
    recovery.receive({
      type: "session.changed",
      version: view("a", 405).version,
      prompts: [],
    });
    await tick();
    expect(client.getSessionControl).toHaveBeenCalledTimes(initialCalls + 2);
    await recovery.stop("real-run");
    expect(client.getSessionControl).toHaveBeenCalledTimes(initialCalls + 3);
    expect(client.abortRun).toHaveBeenCalledWith("real-run");
    recovery.dispose();
  });
});
