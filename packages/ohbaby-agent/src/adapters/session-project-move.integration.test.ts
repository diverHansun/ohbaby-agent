import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMClientInstance } from "ohbaby-llm";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "ohbaby-llm";
import { ensureDefaultWorkspaceDirectory } from "../paths/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../services/database/index.js";
import { INITIAL_MIGRATIONS } from "../services/database/migrations.js";
import {
  commitSessionProjectMove,
  getGlobalSession,
  planSessionProjectMove,
} from "../services/session/index.js";
import {
  createPersistentUiBackendClient,
  type PersistentUiBackendClient,
} from "./ui-persistent.js";

const TITLE_MARKER =
  "Write a short conversation title that identifies the user's task.";

interface ProviderLog {
  readonly turns: string[];
}

/** Records each non-title turn; turns mentioning `blockOn` wait for `release`. */
function createLLM(input: {
  readonly log: ProviderLog;
  readonly blockOn?: string;
  readonly release?: Promise<void>;
}): LLMClientInstance<{ readonly kind: "fake" }> {
  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamResponse(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        const all = JSON.stringify(request.messages);
        const isTitle = all.includes(TITLE_MARKER);
        if (!isTitle) input.log.turns.push(all);
        const block =
          !isTitle &&
          input.blockOn !== undefined &&
          all.includes(input.blockOn);
        return Promise.resolve(
          (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            if (block) await input.release;
            yield { textDelta: isTitle ? "Title" : "ok", finishReason: "stop" };
          })(),
        );
      },
      isAbortError: () => false,
    },
    config: {
      provider: "fake",
      model: "fake-model",
      modelProfiles: [
        {
          model: "fake-model",
          contextWindowTokens: 128000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

let root: string;
let workspaceA: string;
let workspaceB: string;
const clients: PersistentUiBackendClient[] = [];

function createClient(
  workdir: string,
  llm: LLMClientInstance<{ readonly kind: "fake" }>,
): PersistentUiBackendClient {
  const client = createPersistentUiBackendClient({
    dbPath: join(root, "agent.db"),
    llmClient: llm,
    workdir,
  });
  clients.push(client);
  return client;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ohbaby-session-move-"));
  vi.stubEnv("OHBABY_HOME", join(root, ".ohbaby"));
  workspaceA = join(root, "a");
  workspaceB = join(root, "b");
  await mkdir(workspaceA);
  await mkdir(workspaceB);
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.dispose()));
  closeDatabase();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("moving a session between workspaces", () => {
  it("rejects the old workspace and continues the same session in the target", async () => {
    const logA: ProviderLog = { turns: [] };
    const logB: ProviderLog = { turns: [] };
    const clientA = createClient(workspaceA, createLLM({ log: logA }));
    const clientB = createClient(workspaceB, createLLM({ log: logB }));

    const first = await clientA.submitPromptAccepted("hello from a", {
      sessionId: "session_move",
    });
    await clientA.waitForPrompt(first.promptId);
    await commitSessionProjectMove(
      planSessionProjectMove("session_move", workspaceB),
    );

    await expect(
      clientA.submitPromptAccepted("still a?", { sessionId: "session_move" }),
    ).rejects.toMatchObject({
      code: "SESSION_MOVED",
      targetDirectory: workspaceB,
    });

    const second = await clientB.submitPromptAccepted("hello from b", {
      sessionId: "session_move",
    });
    await expect(clientB.waitForPrompt(second.promptId)).resolves.toMatchObject(
      {
        prompt: { status: "succeeded" },
      },
    );

    expect(getGlobalSession("session_move")).toMatchObject({
      id: "session_move",
      projectRoot: workspaceB,
      projectDirectory: workspaceB,
    });
    expect(
      getGlobalSession("session_move")?.pendingProjectRoot,
    ).toBeUndefined();
    const turnInB = logB.turns.at(-1) ?? "";
    expect(turnInB).toContain("hello from a");
    expect(turnInB).toContain(`Current working directory: ${workspaceB}`);
    // After the change took effect the old workspace still reports where to go.
    await expect(
      clientA.submitPromptAccepted("late", { sessionId: "session_move" }),
    ).rejects.toMatchObject({ targetDirectory: workspaceB });
  });

  it("finishes the running turn in place and runs queued prompts in the target afterwards", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const logA: ProviderLog = { turns: [] };
    const logB: ProviderLog = { turns: [] };
    const clientA = createClient(
      workspaceA,
      createLLM({ log: logA, blockOn: "long turn", release: released }),
    );
    const clientB = createClient(workspaceB, createLLM({ log: logB }));

    try {
      const running = await clientA.submitPromptAccepted("long turn", {
        sessionId: "session_queue",
      });
      await vi.waitFor(() => {
        expect(logA.turns).toHaveLength(1);
      });
      const queued = await clientA.submitPromptAccepted("queued turn", {
        sessionId: "session_queue",
      });

      const plan = planSessionProjectMove("session_queue", workspaceB);
      expect(plan.needsQueueHandover).toBe(true);
      await clientB.adoptSessionProjectMove(plan);
      expect(getGlobalSession("session_queue")).toMatchObject({
        projectRoot: workspaceA,
        pendingProjectRoot: workspaceB,
      });

      // The target must not start while the original turn still runs.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(logB.turns).toHaveLength(0);
      expect(getGlobalSession("session_queue")?.projectRoot).toBe(workspaceA);
      // Viewing follows membership: the running workspace and the target
      // both open the session; only new turns are routed to the target.
      await expect(
        clientA.selectSession("session_queue"),
      ).resolves.toBeUndefined();
      await expect(
        clientB.selectSession("session_queue"),
      ).resolves.toBeUndefined();
      await expect(
        clientB.initializeSession("session_queue"),
      ).resolves.toBeUndefined();

      release();
      await expect(
        clientA.waitForPrompt(running.promptId),
      ).resolves.toMatchObject({ prompt: { status: "succeeded" } });
      await vi.waitFor(
        () => {
          expect(logB.turns).toHaveLength(1);
        },
        { timeout: 10_000 },
      );
      await expect(
        clientB.waitForPrompt(queued.promptId),
      ).resolves.toMatchObject({ prompt: { status: "succeeded" } });
      expect(logA.turns).toHaveLength(1);
      expect(getGlobalSession("session_queue")).toMatchObject({
        projectRoot: workspaceB,
      });
      // The target re-read the turn that finished in A before running its own.
      if (!clientB.getSessionView)
        throw new Error("session views are required");
      const view = await clientB.getSessionView({ sessionId: "session_queue" });
      const assistantReplies = view.session.messages.filter(
        (message) => message.role === "assistant",
      );
      expect(assistantReplies).toHaveLength(2);
      for (const reply of assistantReplies) {
        expect(reply.parts.length).toBeGreaterThan(0);
      }
      expect(JSON.stringify(view)).not.toContain('"outcome":"running"');
      // Once the target ran a turn, the old workspace no longer shows it.
      await expect(clientA.selectSession("session_queue")).rejects.toThrow();
      expect(logB.turns[0]).toContain(
        `Current working directory: ${workspaceB}`,
      );
    } finally {
      release();
    }
  });

  it("upgrades sessions that ran in the default workspace before the binding existed", async () => {
    const defaultWorkspace = await ensureDefaultWorkspaceDirectory();
    initDatabase({
      dbPath: join(root, "agent.db"),
      migrations: INITIAL_MIGRATIONS.filter(
        (migration) => migration.version !== "025_session_project_binding",
      ),
    });
    const insert = getDatabase().prepare(
      `INSERT INTO session (id, project_id, project_root, status, created_at, updated_at)
       VALUES (?, 'global', ?, 'active', 1, 1)`,
    );
    insert.run("legacy_chat", defaultWorkspace);
    insert.run("legacy_project", workspaceA);
    closeDatabase();

    createClient(workspaceA, createLLM({ log: { turns: [] } }));

    expect(getGlobalSession("legacy_chat")).toMatchObject({
      projectRoot: defaultWorkspace,
    });
    expect(getGlobalSession("legacy_chat")?.projectDirectory).toBeUndefined();
    expect(getGlobalSession("legacy_project")?.projectDirectory).toBe(
      workspaceA,
    );
  });
});
