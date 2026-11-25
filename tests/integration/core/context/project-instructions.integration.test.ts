import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestContextManager } from "../../../fixtures/model-fixtures.js";
import { createBus } from "../../../../packages/ohbaby-agent/src/bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../../../packages/ohbaby-agent/src/core/message/index.js";
import type { PreparedTurn } from "../../../../packages/ohbaby-agent/src/core/context/types.js";
import { createSystemPromptProvider } from "../../../../packages/ohbaby-agent/src/core/system-prompt/index.js";
import { createInstructionsReminderProvider } from "../../../../packages/ohbaby-agent/src/services/instructions/index.js";
import { createReminderCollector } from "../../../../packages/ohbaby-agent/src/services/reminder/index.js";

describe("project instructions during context preparation", () => {
  let root: string;
  let projectRoot: string;
  let workdir: string;
  let file: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-instructions-"));
    vi.stubEnv("OHBABY_HOME", root);
    projectRoot = path.join(root, "repo");
    workdir = path.join(projectRoot, "nested");
    file = path.join(projectRoot, "AGENTS.md");
    await fs.mkdir(workdir, { recursive: true });
    await fs.writeFile(file, "PROJECT_RULE");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  function fixture(): {
    prepare(anchor: string, force?: boolean): Promise<PreparedTurn>;
    append(
      role: "assistant" | "user",
      text: string,
      id?: string,
    ): Promise<void>;
    onWarning: ReturnType<typeof vi.fn>;
    resetProvider(): void;
  } {
    const bus = createBus();
    const messageManager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    const onWarning = vi.fn();
    const collector = (): ReturnType<typeof createReminderCollector> =>
      createReminderCollector([
        createInstructionsReminderProvider({ onWarning }),
      ]);
    let collect = collector();
    const manager = createTestContextManager({
      bus,
      messageManager,
      collectReminders: (context) => collect(context),
      systemPromptProvider: createSystemPromptProvider({
        environmentDetector: () => {
          throw new Error("unavailable");
        },
      }),
      llmClient: {
        generateSummary: ({ request }) => {
          expect(request.messages.at(-1)?.content).toContain(
            "Do not copy or restate external instruction files",
          );
          return Promise.resolve({
            text: "short summary",
            summaryMessageId: "summary",
            requests: [],
          });
        },
      },
      tokenCounter: {
        estimateTokens: (text) => text.length,
        getLimit: () => 128_000,
      },
    });
    const prepare = (anchor: string, force = false): Promise<PreparedTurn> =>
      manager.prepareTurn({
        sessionId: "session",
        directory: workdir,
        projectRoot,
        reminderAnchorId: anchor,
        modelId: "fixture",
        toolNames: [],
        tools: undefined,
        force,
      });
    const append = async (
      role: "assistant" | "user",
      text: string,
      id?: string,
    ): Promise<void> => {
      const message = await messageManager.createMessage({
        sessionId: "session",
        role,
        agent: "build",
        id,
      });
      await messageManager.appendPart(message.id, { type: "text", text });
    };
    return {
      prepare,
      append,
      onWarning,
      resetProvider: (): void => {
        collect = collector();
      },
    };
  }

  it("loads instructions without detected environment and omits local paths from the reminder", async () => {
    await fs.writeFile(path.join(root, "CLAUDE.md"), "GLOBAL_RULE");
    await fs.writeFile(path.join(workdir, "AGENTS.md"), "NESTED_RULE");
    const { request } = await fixture().prepare("first");
    expect(request.messages[0].content).not.toMatch(/GLOBAL_RULE|PROJECT_RULE/);
    const tail = JSON.stringify(request.messages.at(-1));
    expect(tail).toMatch(
      /global\/CLAUDE\.md.*GLOBAL_RULE.*project\/AGENTS\.md.*PROJECT_RULE/,
    );
    expect(tail).not.toContain("NESTED_RULE");
    expect(tail).not.toContain(JSON.stringify(root).slice(1, -1));
  });

  it.each([
    "kept",
    "rebuilt",
    "deleted",
    "warm read error",
    "cold read error",
  ] as const)(
    "uses the correct snapshot in the final request after compaction: %s",
    async (scenario) => {
      const f = fixture();
      async function fillHistory(): Promise<void> {
        for (let index = 0; index < 6; index++) {
          await f.append(
            index % 2 === 0 ? "user" : "assistant",
            "older conversation ".repeat(800),
          );
        }
      }
      if (scenario === "kept") await fillHistory();
      await f.prepare("owner");
      await f.append("assistant", "answer", "owner");
      if (scenario !== "kept") await fillHistory();
      if (scenario === "deleted") await fs.unlink(file);
      if (scenario.includes("read error")) {
        if (scenario === "cold read error") f.resetProvider();
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation((target, ...rest) => {
          if (target === file)
            throw Object.assign(new Error("busy"), { code: "EBUSY" });
          return open(target, ...rest);
        });
      }
      const result = await f.prepare("current", true);
      expect(result.compaction?.status).toBe("compacted");
      const shouldExist =
        scenario !== "deleted" && scenario !== "cold read error";
      const history = JSON.stringify(result.request.messages.slice(1));
      expect(history.split("PROJECT_RULE")).toHaveLength(shouldExist ? 2 : 1);
      if (!shouldExist) expect(history).not.toContain("<system-reminder>");
      const last = JSON.stringify(result.request.messages.at(-1));
      if (scenario === "rebuilt" || scenario === "warm read error")
        expect(last).toContain("PROJECT_RULE");
      if (scenario === "kept") expect(last).not.toContain("PROJECT_RULE");
      expect(f.onWarning).toHaveBeenCalledTimes(
        scenario.includes("read error") ? 1 : 0,
      );
    },
  );
});
