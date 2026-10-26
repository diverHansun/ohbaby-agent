import {
  createTestContextManager as createContextManager,
  type TestContextManager as ContextManager,
} from "../testing/model-fixtures.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBus } from "../../bus/index.js";
import { createHeuristicTokenCounter } from "../../services/llm-model/tokenCounting.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../message/index.js";
import { createSystemPromptProvider } from "../system-prompt/index.js";

import type { PreparedModelRequest } from "./types.js";

const PROJECT_MARKER = "PROJECT_RULE_MARKER";
const GLOBAL_MARKER = "GLOBAL_RULE_MARKER";
const WORKDIR_MARKER = "WORKDIR_RULE_MARKER";

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

function systemText(request: PreparedModelRequest): string {
  const first = request.messages[0];
  expect(first.role).toBe("system");
  return typeof first.content === "string" ? first.content : "";
}

describe("project instructions in prepared requests", () => {
  let root: string;
  let projectRoot: string;
  let workdir: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-instructions-"));
    projectRoot = path.join(root, "repo");
    workdir = path.join(projectRoot, ".worktrees", "child");
    const home = path.join(root, "home");
    await fs.mkdir(workdir, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(projectRoot, "OHBABY.md"), PROJECT_MARKER);
    await fs.writeFile(path.join(workdir, "OHBABY.md"), WORKDIR_MARKER);
    await fs.writeFile(path.join(home, "OHBABY.md"), GLOBAL_MARKER);
    previousHome = process.env.OHBABY_HOME;
    process.env.OHBABY_HOME = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.OHBABY_HOME;
    else process.env.OHBABY_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  function createFixture(): {
    readonly manager: ContextManager;
  } {
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
    });
    const manager = createContextManager({
      bus: createBus(),
      llmClient: {
        generateSummary: () => Promise.reject(new Error("unexpected summary")),
      },
      messageManager,
      systemPromptProvider: createSystemPromptProvider({
        agentPromptResolver: (_agentName, input) =>
          input.isSubagent ? "Inspect the delegated project." : undefined,
      }),
      tokenCounter: createHeuristicTokenCounter({ defaultLimit: 128_000 }),
    });
    return { manager };
  }

  it("sends primary instructions once, global before project, without a memory block", async () => {
    const { manager } = createFixture();
    const snapshot = await manager.createRunPromptSnapshot({
      directory: projectRoot,
      isSubagent: false,
      sessionId: "primary",
      toolNames: [],
    });
    const prepared = await manager.prepareTurn({
      directory: projectRoot,
      modelId: "model-a",
      promptSnapshot: snapshot,
      sessionId: "primary",
      toolNames: [],
      tools: undefined,
    });
    const usage = await manager.assemble("primary", projectRoot, {
      isSubagent: false,
      toolNames: [],
    });

    const system = systemText(prepared.request);
    expect(occurrences(system, PROJECT_MARKER)).toBe(1);
    expect(occurrences(system, GLOBAL_MARKER)).toBe(1);
    expect(system.indexOf(GLOBAL_MARKER)).toBeLessThan(
      system.indexOf(PROJECT_MARKER),
    );
    expect(system).not.toContain("<memory>");
    expect(usage.systemPrompt).toBe(snapshot.systemPrompt);
  });

  it("sends subagent instructions from the session project root, not its workdir", async () => {
    const { manager } = createFixture();
    const snapshot = await manager.createRunPromptSnapshot({
      agentName: "generic",
      contextScopeId: "child_scope",
      directory: workdir,
      isSubagent: true,
      projectRoot,
      sessionId: "child",
      toolNames: [],
    });
    const prepared = await manager.prepareTurn({
      agentName: "generic",
      contextScopeId: "child_scope",
      directory: workdir,
      isSubagent: true,
      modelId: "model-a",
      promptSnapshot: snapshot,
      sessionId: "child",
      toolNames: [],
      tools: undefined,
    });

    const system = systemText(prepared.request);
    expect(system).toContain("<subagent_base>");
    expect(occurrences(system, PROJECT_MARKER)).toBe(1);
    expect(occurrences(system, GLOBAL_MARKER)).toBe(1);
    expect(system).not.toContain(WORKDIR_MARKER);
    expect(system).not.toContain("You are Lychee, an AI coding assistant");
    expect(system).toContain("<agent_prompt_addon>");
    expect(system.indexOf("<agent_prompt_addon>")).toBeLessThan(
      system.indexOf("<custom_instructions>"),
    );
  });
});
