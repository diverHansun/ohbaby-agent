import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistentUiBackendClient } from "ohbaby-agent";
import { OhbabyTerminalApp } from "ohbaby-tui";
import {
  closeDatabase,
  getDatabase,
  schema,
} from "../../packages/ohbaby-agent/src/services/database/index.js";
import { _LLMConfigManager as LLMConfigManager } from "../../packages/ohbaby-agent/src/config/llm/index.js";
import {
  flush,
  promptIsReady,
  waitForFrame,
} from "../integration/tui/helpers.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  closeDatabase();
  LLMConfigManager.resetInstance();
  vi.unstubAllEnvs();
  for (const directory of cleanupDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), `.tmp-${prefix}-`));
  cleanupDirectories.push(directory);
  return directory;
}

async function writeZhipuModelConfig(home: string): Promise<void> {
  await mkdir(join(home, ".ohbaby-agent"), { recursive: true });
  await writeFile(
    join(home, ".ohbaby-agent", "model.json"),
    JSON.stringify(
      {
        apiConfig: {
          apiKeyEnv: "ZAI_API_KEY",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        },
        defaultModel: "glm-5.1",
        llmParams: {
          maxTokens: 128000,
          temperature: 0.7,
        },
        provider: "zhipu",
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function createRealTuiHarness(input: {
  readonly requireTavily?: boolean;
}): Promise<{
  readonly app: ReturnType<typeof render>;
  readonly client: ReturnType<typeof createPersistentUiBackendClient>;
  readonly workdir: string;
}> {
  const modelApiKey = process.env.ZAI_API_KEY ?? process.env.ZHIPU_API_KEY;
  const tavilyApiKey = process.env.TAVILY_API_KEY;
  if (!modelApiKey) {
    throw new Error("Set ZAI_API_KEY or ZHIPU_API_KEY for real TUI smoke.");
  }
  if (input.requireTavily === true && !tavilyApiKey) {
    throw new Error("Set TAVILY_API_KEY for real Tavily TUI smoke.");
  }

  const directory = await tempDirectory("ohbaby-real-tui");
  const home = join(directory, "home");
  const workdir = join(directory, "workspace");
  await mkdir(workdir, { recursive: true });
  await writeZhipuModelConfig(home);
  LLMConfigManager.resetInstance();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("ZAI_API_KEY", modelApiKey);
  if (tavilyApiKey) {
    vi.stubEnv("TAVILY_API_KEY", tavilyApiKey);
  }

  const client = createPersistentUiBackendClient({
    dbPath: join(directory, "agent.db"),
    workdir,
  });
  return {
    app: render(<OhbabyTerminalApp client={client} />),
    client,
    workdir,
  };
}

async function submitPrompt(
  app: ReturnType<typeof render>,
  prompt: string,
): Promise<void> {
  await waitForFrame(app, promptIsReady, 30_000);
  app.stdin.write(prompt);
  app.stdin.write("\r");
}

async function waitForAssistantText(
  client: ReturnType<typeof createPersistentUiBackendClient>,
  predicate: (text: string) => boolean = (text) => text.length > 0,
  timeoutMs = 240_000,
): Promise<string> {
  const startedAt = Date.now();
  let lastText = "";
  while (Date.now() - startedAt < timeoutMs) {
    await flush();
    const snapshot = await client.getSnapshot();
    const assistant = snapshot.sessions
      .find((session) => session.id === snapshot.activeSessionId)
      ?.messages.findLast((message) => message.role === "assistant");
    const text = assistant?.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();

    if (text) {
      lastText = text;
    }
    if (text && predicate(text)) {
      return text;
    }
  }

  throw new Error(
    `Timed out waiting for real assistant text. Last text: ${lastText}`,
  );
}

async function waitForDatabaseCondition(
  predicate: () => boolean,
  timeoutMs = 240_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await flush();
    if (predicate()) {
      return;
    }
  }
  throw new Error("Timed out waiting for database condition");
}

function latestChildSessionId(parentSessionId: string): string | undefined {
  return getDatabase()
    .prepare<{ readonly id: string }>(
      `SELECT id
       FROM ${schema.session.tableName}
       WHERE parent_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(parentSessionId)?.id;
}

function sessionMessageCount(sessionId: string): number {
  return (
    getDatabase()
      .prepare<{ readonly count: number }>(
        `SELECT COUNT(*) AS count
         FROM ${schema.message.tableName}
         WHERE session_id = ?`,
      )
      .get(sessionId)?.count ?? 0
  );
}

function latestAgentTaskId(parentSessionId: string): string | undefined {
  const parts = getDatabase()
    .prepare<{ readonly data: string }>(
      `SELECT data
       FROM ${schema.part.tableName}
       WHERE session_id = ?
       ORDER BY created_at DESC, order_index DESC
       LIMIT 50`,
    )
    .all(parentSessionId);
  const match = JSON.stringify(parts).match(/task_id:\s*(agent_task_[a-z0-9_]+)/);
  return match?.[1];
}

const runRealTuiSmoke = process.env.OHBABY_RUN_REAL_TUI_SMOKE === "1";
const runRealTavilySmoke =
  runRealTuiSmoke && process.env.OHBABY_RUN_REAL_TUI_TAVILY_SMOKE === "1";
const runRealSubagentSmoke =
  runRealTuiSmoke && process.env.OHBABY_RUN_REAL_SUBAGENT_SMOKE === "1";

describe("real provider TUI smoke", () => {
  (runRealTuiSmoke ? it : it.skip)(
    "submits a prompt through the rendered TUI and receives a real response",
    async () => {
      const { app, client } = await createRealTuiHarness({});

      try {
        await submitPrompt(
          app,
          "Reply in one short sentence containing the exact token OHBABY_REAL_TUI_SMOKE_OK.",
        );
        const text = await waitForAssistantText(client, (value) =>
          value.includes("OHBABY_REAL_TUI_SMOKE_OK"),
        );
        await waitForFrame(
          app,
          (frame) => frame.includes("status: idle | session:"),
          240_000,
        );

        expect(text).toContain("OHBABY_REAL_TUI_SMOKE_OK");
      } finally {
        app.unmount();
      }
    },
    300_000,
  );

  (runRealTuiSmoke ? it : it.skip)(
    "lets a real model call the read tool from the rendered TUI",
    async () => {
      const { app, client, workdir } = await createRealTuiHarness({});
      await writeFile(
        join(workdir, "marker.txt"),
        "FILE_ONLY_SECRET_MARKER_73f4b0\n",
        "utf8",
      );

      try {
        await submitPrompt(
          app,
          'Use the read tool exactly once to read "marker.txt". If the file has a marker line, reply with only the exact token OHBABY_REAL_TOOL_READ_OK.',
        );
        await waitForFrame(
          app,
          (frame) => frame.includes("tool read (completed)"),
          240_000,
        );
        const text = await waitForAssistantText(client, (value) =>
          value.includes("OHBABY_REAL_TOOL_READ_OK"),
        );
        const finalFrame = await waitForFrame(
          app,
          (frame) =>
            frame.includes("tool read (completed)") &&
            frame.includes("status: idle | session:"),
          240_000,
        );

        expect(text).toContain("OHBABY_REAL_TOOL_READ_OK");
        expect(finalFrame).toContain("tool result");
        expect(finalFrame).toContain("result hidden");
        expect(finalFrame).not.toContain("FILE_ONLY_SECRET_MARKER_73f4b0");
      } finally {
        app.unmount();
      }
    },
    300_000,
  );

  (runRealTavilySmoke ? it : it.skip)(
    "lets a real model call Tavily web_search from the rendered TUI",
    async () => {
      const { app } = await createRealTuiHarness({ requireTavily: true });

      try {
        await waitForFrame(app, promptIsReady, 30_000);
        app.stdin.write("/mode ask");
        app.stdin.write("\r");
        await waitForFrame(
          app,
          (frame) => frame.includes("mode: ask / ask-before-edit"),
          30_000,
        );

        app.stdin.write("/tools");
        app.stdin.write("\r");
        await waitForFrame(
          app,
          (frame) =>
            frame.includes("tools:") &&
            frame.includes("web_search") &&
            frame.includes("web_fetch") &&
            !frame.includes(", write") &&
            !frame.includes("tools: write"),
          30_000,
        );

        app.stdin.write(
          'Use the web_search tool exactly once with query "OpenAI Codex CLI". Then answer in one short sentence.',
        );
        app.stdin.write("\r");

        await waitForFrame(
          app,
          (frame) => frame.includes("tool web_search (completed)"),
          240_000,
        );
        const finalFrame = await waitForFrame(
          app,
          (frame) =>
            frame.includes("tool web_search (completed)") &&
            frame.includes("status: idle | session:"),
          240_000,
        );

        expect(finalFrame).toContain("tool web_search (completed)");
      } finally {
        app.unmount();
      }
    },
    300_000,
  );

  (runRealSubagentSmoke ? it : it.skip)(
    "lets a real model run and resume an explore subagent child session",
    async () => {
      const { client, workdir } = await createRealTuiHarness({});
      await writeFile(
        join(workdir, "subagent-target-a.txt"),
        "alpha subagent smoke marker",
        "utf8",
      );
      await writeFile(
        join(workdir, "subagent-target-b.txt"),
        "beta subagent smoke marker",
        "utf8",
      );

      await client.submitPrompt(
        [
          "Call the task tool exactly once with agent_name explore.",
          "Ask the child to inspect subagent-target-a.txt and subagent-target-b.txt.",
          "After the child returns, answer with the exact token OHBABY_REAL_SUBAGENT_FIRST_OK.",
        ].join(" "),
      );
      const firstSnapshot = await client.getSnapshot();
      const parentSessionId = firstSnapshot.activeSessionId;
      if (!parentSessionId) {
        throw new Error("expected parent session id");
      }
      const child = getDatabase()
        .prepare<{ readonly id: string }>(
          `SELECT id
           FROM ${schema.session.tableName}
           WHERE parent_id = ?
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get(parentSessionId);
      if (!child) {
        throw new Error("real model did not create a subagent child session");
      }

      await client.submitPrompt(
        [
          "Call the task tool exactly once with agent_name explore.",
          `Use resume_session_id ${child.id}.`,
          "Ask the child to reference its prior inspection and return one extra concise finding.",
          "After the child returns, answer with the exact token OHBABY_REAL_SUBAGENT_RESUME_OK.",
        ].join(" "),
        { sessionId: parentSessionId },
      );

      const childMessages = getDatabase()
        .prepare<{ readonly count: number }>(
          `SELECT COUNT(*) AS count
           FROM ${schema.message.tableName}
           WHERE session_id = ?`,
        )
        .get(child.id);
      expect(childMessages?.count ?? 0).toBeGreaterThanOrEqual(4);
      const finalText = JSON.stringify((await client.getSnapshot()).sessions);
      expect(finalText).toContain("OHBABY_REAL_SUBAGENT_FIRST_OK");
      expect(finalText).toContain("OHBABY_REAL_SUBAGENT_RESUME_OK");

      await writeFile(
        join(workdir, "agent-task-target-c.txt"),
        "gamma background agent task marker",
        "utf8",
      );
      await client.submitPrompt(
        [
          "Call the agent_open tool exactly once with agent_name explore.",
          "Ask the child to inspect agent-task-target-c.txt and remember the gamma marker.",
          "Do not call the task tool for this step.",
          "After agent_open returns, answer with the exact token OHBABY_REAL_AGENT_OPEN_OK.",
        ].join(" "),
        { sessionId: parentSessionId },
      );
      const agentTaskId = latestAgentTaskId(parentSessionId);
      if (!agentTaskId) {
        throw new Error("real model did not create an agent task id");
      }
      const agentTaskChildId = latestChildSessionId(parentSessionId);
      if (!agentTaskChildId) {
        throw new Error("real model did not create an agent task child session");
      }
      await waitForDatabaseCondition(
        () => sessionMessageCount(agentTaskChildId) >= 2,
      );

      await client.submitPrompt(
        [
          `Call the agent_eval tool exactly once with task_id ${agentTaskId}.`,
          "Ask the child to use its prior child history and restate the gamma marker in one concise finding.",
          "After agent_eval returns, answer with the exact token OHBABY_REAL_AGENT_EVAL_OK.",
        ].join(" "),
        { sessionId: parentSessionId },
      );
      await waitForDatabaseCondition(
        () => sessionMessageCount(agentTaskChildId) >= 4,
      );

      await client.submitPrompt(
        [
          `Call the agent_status tool exactly once with task_id ${agentTaskId}.`,
          "After agent_status returns, answer with the exact token OHBABY_REAL_AGENT_STATUS_OK.",
        ].join(" "),
        { sessionId: parentSessionId },
      );
      await client.submitPrompt(
        [
          `Call the agent_close tool exactly once with task_id ${agentTaskId}.`,
          "After agent_close returns, answer with the exact token OHBABY_REAL_AGENT_CLOSE_OK.",
        ].join(" "),
        { sessionId: parentSessionId },
      );

      const agentTaskFinalText = JSON.stringify(
        (await client.getSnapshot()).sessions,
      );
      expect(agentTaskFinalText).toContain("OHBABY_REAL_AGENT_OPEN_OK");
      expect(agentTaskFinalText).toContain("OHBABY_REAL_AGENT_EVAL_OK");
      expect(agentTaskFinalText).toContain("OHBABY_REAL_AGENT_STATUS_OK");
      expect(agentTaskFinalText).toContain("OHBABY_REAL_AGENT_CLOSE_OK");
    },
    900_000,
  );
});
