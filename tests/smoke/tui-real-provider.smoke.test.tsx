import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistentUiBackendClient } from "ohbaby-agent";
import { OhbabyTerminalApp } from "ohbaby-tui";
import { closeDatabase } from "../../packages/ohbaby-agent/src/services/database/index.js";
import { _LLMConfigManager as LLMConfigManager } from "../../packages/ohbaby-agent/src/config/llm/index.js";
import { flush, promptIsReady, waitForFrame } from "../integration/tui/helpers.js";

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
  await waitForFrame(
    app,
    promptIsReady,
    30_000,
  );
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

const runRealTuiSmoke = process.env.OHBABY_RUN_REAL_TUI_SMOKE === "1";
const runRealTavilySmoke =
  runRealTuiSmoke &&
  process.env.OHBABY_RUN_REAL_TUI_TAVILY_SMOKE === "1";

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

  (runRealTavilySmoke ? it : it.skip)(
    "lets a real model call Tavily web_search from the rendered TUI",
    async () => {
      const { app } = await createRealTuiHarness({ requireTavily: true });

      try {
        await waitForFrame(
          app,
          promptIsReady,
          30_000,
        );
        app.stdin.write("/mode ask");
        app.stdin.write("\r");
        await waitForFrame(
          app,
          (frame) => frame.includes("mode: ask/ask-before-edit"),
          30_000,
        );

        app.stdin.write("/tools");
        app.stdin.write("\r");
        await waitForFrame(
          app,
          (frame) =>
            frame.includes('"name":"web_search"') &&
            frame.includes('"name":"web_fetch"') &&
            !frame.includes('"name":"write"'),
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
});
