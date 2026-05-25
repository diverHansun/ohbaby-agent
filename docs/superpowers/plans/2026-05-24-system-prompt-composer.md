# System Prompt Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `ohbaby-agent` system prompt assembly into a pi-inspired options-driven composer that separates stable agent identity from task contracts and treats configured agent prompts as additive refinements.

**Architecture:** `core/system-prompt` owns default prompt assets, task prompt assets, prompt layers, and final assembly. `agents` remains the runtime coordinator that selects the active primary/subagent, resolves task kind, supplies configured prompt add-ons, and passes actual tool/environment context into `core/system-prompt`.

**Tech Stack:** TypeScript, Vitest, pnpm, existing `ContextManager`, `AgentManager`, `ToolScheduler`, `PolicyManager`, and real TUI smoke infrastructure.

---

## Design Rules

- Default prompt text lives under `packages/ohbaby-agent/src/core/system-prompt`.
- Primary task prompts are task contracts: `ask`, `plan`, and `agent`.
- Subagent task prompts are task contracts: `explore`, `research`, `plan`, and `generic`.
- `AgentConfig.prompt` is an add-on/refinement layer. It never replaces the default base prompt or task prompt.
- `agents` resolves runtime assembly input. It does not own default prompt text.
- Subagents keep a stricter boundary than primary agents: no primary identity prompt, no custom instructions, no memory injection, and no recursive subagent tools.
- Prompt output must be stable enough for snapshot-style unit tests and explicit enough for e2e format inspection.

## File Structure

- Create: `packages/ohbaby-agent/src/core/system-prompt/prompts/primary/base.ts`
  - Stable primary identity prompt. This can move the current `IDENTITY_PROMPT` text without changing its public meaning.
- Create: `packages/ohbaby-agent/src/core/system-prompt/prompts/primary/tasks.ts`
  - Primary task contract prompt lookup for `ask`, `plan`, and `agent`.
- Create: `packages/ohbaby-agent/src/core/system-prompt/prompts/subagents/base.ts`
  - Stable subagent base identity prompt.
- Create: `packages/ohbaby-agent/src/core/system-prompt/prompts/subagents/tasks.ts`
  - Subagent task contract prompt lookup for `explore`, `research`, `plan`, and `generic`.
- Modify: `packages/ohbaby-agent/src/core/system-prompt/prompts/identity.ts`
  - Re-export the primary base prompt for compatibility.
- Modify: `packages/ohbaby-agent/src/core/system-prompt/prompts/agents/index.ts`
  - Re-export subagent task prompts from the new subagent task lookup.
- Create: `packages/ohbaby-agent/src/core/system-prompt/layers/tools.ts`
  - Render selected tools, one-line tool snippets, and deduplicated tool guidelines.
- Modify: `packages/ohbaby-agent/src/core/system-prompt/layers/index.ts`
  - Export the new tools layer.
- Modify: `packages/ohbaby-agent/src/core/system-prompt/types.ts`
  - Add prompt composer types while keeping existing public fields compatible.
- Modify: `packages/ohbaby-agent/src/core/system-prompt/assembler.ts`
  - Build the final primary/subagent prompt from base, task, add-on, tools, environment, and custom layers.
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`
  - Pass primary policy mode and subagent task kind into the system prompt provider.
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/types.ts`
  - Add optional prompt-task inputs only where runtime callers need them.
- Modify: `packages/ohbaby-agent/src/agents/types.ts`
  - Document `prompt` as an additive prompt refinement.
- Modify: `packages/ohbaby-agent/src/agents/manager.ts`
  - Keep fallback prompt building additive and aligned with `core/system-prompt`.
- Modify: `packages/ohbaby-agent/src/agents/builtin/explore.ts`
  - Remove duplicated default prompt text or reduce it to a short add-on.
- Modify: `packages/ohbaby-agent/src/agents/builtin/research.ts`
  - Remove duplicated default prompt text or reduce it to a short add-on.
- Create: `packages/ohbaby-agent/src/core/system-prompt/__tests__/tools.test.ts`
  - Unit tests for the new tools layer.
- Modify: `packages/ohbaby-agent/src/core/system-prompt/__tests__/assembler.test.ts`
  - Unit tests for primary and subagent prompt composition.
- Modify: `packages/ohbaby-agent/src/core/system-prompt/__tests__/provider.test.ts`
  - Provider tests for task kind resolution and prompt add-on behavior.
- Modify: `packages/ohbaby-agent/src/agents/manager.unit.test.ts`
  - Tests that configured prompts are additive and custom subagent descriptions remain visible.
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts`
  - Tests that policy mode reaches primary system prompts and subagent agent names reach subagent task prompts.
- Modify: `tests/smoke/tui-real-provider.smoke.test.tsx`
  - Add gated prompt-flow smoke checks only if needed after deterministic coverage.
- Create: `docs/core/system-prompt/ohbaby-e2e-test.md`
  - Real-provider e2e checklist and commands for prompt data-flow/format validation.

---

## Task 1: Write Planning And E2E Documentation

**Files:**
- Create: `docs/superpowers/plans/2026-05-24-system-prompt-composer.md`
- Create: `docs/core/system-prompt/ohbaby-e2e-test.md`

- [x] **Step 1: Write this implementation plan**

Create this file with the design rules, file structure, task list, and verification commands.

- [x] **Step 2: Write the e2e checklist**

Create `docs/core/system-prompt/ohbaby-e2e-test.md` with:

```markdown
# Ohbaby System Prompt E2E Test

## Goal

Verify that the final system prompt sent through the runtime data flow has the expected primary/subagent identity, task contract, tool guidance, environment, and custom-instruction boundaries.
```

- [x] **Step 3: Verify docs contain no unresolved markers**

Run:

```powershell
rg -n "T[B]D|T[O]DO|fill[ ]in" docs/superpowers/plans/2026-05-24-system-prompt-composer.md docs/core/system-prompt/ohbaby-e2e-test.md
```

Expected: no matches.

---

## Task 2: Add Prompt Composer Types And Task Assets

**Files:**
- Modify: `packages/ohbaby-agent/src/core/system-prompt/types.ts`
- Create: `packages/ohbaby-agent/src/core/system-prompt/prompts/primary/base.ts`
- Create: `packages/ohbaby-agent/src/core/system-prompt/prompts/primary/tasks.ts`
- Create: `packages/ohbaby-agent/src/core/system-prompt/prompts/subagents/base.ts`
- Create: `packages/ohbaby-agent/src/core/system-prompt/prompts/subagents/tasks.ts`
- Modify: `packages/ohbaby-agent/src/core/system-prompt/prompts/identity.ts`
- Modify: `packages/ohbaby-agent/src/core/system-prompt/prompts/agents/index.ts`
- Test: `packages/ohbaby-agent/src/core/system-prompt/__tests__/assembler.test.ts`

- [x] **Step 1: Write failing tests for task prompt lookup**

Add tests to `packages/ohbaby-agent/src/core/system-prompt/__tests__/assembler.test.ts`:

```typescript
it("includes the selected primary task contract", () => {
  const prompts = SystemPrompt.assemble({
    agentName: "build",
    environment: ENVIRONMENT,
    isSubagent: false,
    taskKind: "plan",
    tools: ["read", "grep"],
  });

  const fullPrompt = prompts.join("\n\n");
  expect(fullPrompt).toContain("<primary_task>");
  expect(fullPrompt).toContain("Task: plan");
  expect(fullPrompt).toContain("Do not write files or execute workspace changes.");
});

it("includes the selected subagent task contract", () => {
  const prompts = SystemPrompt.assemble({
    agentName: "explore",
    environment: ENVIRONMENT,
    isSubagent: true,
    taskKind: "explore",
    tools: ["read", "grep"],
  });

  const fullPrompt = prompts.join("\n\n");
  expect(fullPrompt).toContain("<subagent_task>");
  expect(fullPrompt).toContain("Task: explore");
  expect(fullPrompt).toContain("quickly find, inspect, and summarize");
});
```

- [x] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/core/system-prompt/__tests__/assembler.test.ts
```

Expected: FAIL because `taskKind` and task prompt sections do not exist yet.

- [x] **Step 3: Add composer types**

Update `packages/ohbaby-agent/src/core/system-prompt/types.ts` with:

```typescript
export type AgentKind = "primary" | "subagent";
export type PrimaryTaskKind = "ask" | "plan" | "agent";
export type SubagentTaskKind = "explore" | "research" | "plan" | "generic";
export type PromptTaskKind = PrimaryTaskKind | SubagentTaskKind;

export interface ToolPromptInfo {
  readonly name: string;
  readonly snippet?: string;
  readonly guidelines?: readonly string[];
}
```

Extend `AssembleOptions`:

```typescript
readonly taskKind?: PromptTaskKind;
readonly agentPromptAddon?: string;
readonly toolSnippets?: Readonly<Record<string, string>>;
readonly promptGuidelines?: readonly string[];
```

Keep `agentPrompt?: string` as a compatibility alias for the add-on layer.

- [x] **Step 4: Add primary and subagent task prompt assets**

Create `packages/ohbaby-agent/src/core/system-prompt/prompts/primary/tasks.ts`:

```typescript
import type { PrimaryTaskKind } from "../../types.js";

const PRIMARY_TASK_PROMPTS: Record<PrimaryTaskKind, string> = {
  ask: `<primary_task>
Task: ask
Answer, explain, inspect, and retrieve information. Do not modify files, run write-capable workflows, or imply that changes were made.
</primary_task>`,
  plan: `<primary_task>
Task: plan
Analyze the request and produce an executable plan. Do not write files or execute workspace changes.
</primary_task>`,
  agent: `<primary_task>
Task: agent
Implement focused changes, verify behavior with relevant checks, and report changed files and verification results.
</primary_task>`,
};

export function getPrimaryTaskPrompt(taskKind: PrimaryTaskKind): string {
  return PRIMARY_TASK_PROMPTS[taskKind];
}
```

Create `packages/ohbaby-agent/src/core/system-prompt/prompts/subagents/tasks.ts`:

```typescript
import type { SubagentTaskKind } from "../../types.js";

const SUBAGENT_TASK_PROMPTS: Record<SubagentTaskKind, string> = {
  explore: `<subagent_task>
Task: explore
Quickly find, inspect, and summarize relevant code. Prefer targeted search before reading large files.
</subagent_task>`,
  research: `<subagent_task>
Task: research
Investigate a bounded question, separate confirmed facts from inferences, and return a concise synthesis.
</subagent_task>`,
  plan: `<subagent_task>
Task: plan
Analyze a bounded child task and return a concise implementation plan. Do not create more subagents.
</subagent_task>`,
  generic: `<subagent_task>
Task: generic
Complete the delegated bounded task independently and return a concise result to the primary agent.
</subagent_task>`,
};

export function getSubagentTaskPrompt(taskKind: SubagentTaskKind): string {
  return SUBAGENT_TASK_PROMPTS[taskKind];
}
```

- [x] **Step 5: Run tests and verify GREEN for task assets after assembler integration**

This step becomes green in Task 4 after assembler uses these assets.

---

## Task 3: Add Tool Guidance Layer

**Files:**
- Create: `packages/ohbaby-agent/src/core/system-prompt/layers/tools.ts`
- Modify: `packages/ohbaby-agent/src/core/system-prompt/layers/index.ts`
- Create: `packages/ohbaby-agent/src/core/system-prompt/__tests__/tools.test.ts`

- [x] **Step 1: Write failing unit tests**

Create `packages/ohbaby-agent/src/core/system-prompt/__tests__/tools.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { generateToolGuidancePrompt } from "../layers/tools.js";

describe("tool guidance layer", () => {
  it("renders selected tool snippets and deduplicated guidelines", () => {
    const prompt = generateToolGuidancePrompt({
      promptGuidelines: [
        "Prefer grep before reading large files.",
        "Prefer grep before reading large files.",
      ],
      toolSnippets: {
        grep: "Search file contents.",
        read: "Read one text file.",
      },
      tools: ["read", "grep", "write"],
    });

    expect(prompt).toContain("<tool_guidance>");
    expect(prompt).toContain("- read: Read one text file.");
    expect(prompt).toContain("- grep: Search file contents.");
    expect(prompt).not.toContain("- write:");
    expect(prompt.match(/Prefer grep before reading large files\\./g)).toHaveLength(1);
  });

  it("returns an empty string when no tool details are available", () => {
    expect(
      generateToolGuidancePrompt({
        tools: [],
      }),
    ).toBe("");
  });
});
```

- [x] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/core/system-prompt/__tests__/tools.test.ts
```

Expected: FAIL because `layers/tools.ts` does not exist.

- [x] **Step 3: Implement the tool guidance layer**

Create `packages/ohbaby-agent/src/core/system-prompt/layers/tools.ts`:

```typescript
export interface GenerateToolGuidancePromptOptions {
  readonly tools?: readonly string[];
  readonly toolSnippets?: Readonly<Record<string, string>>;
  readonly promptGuidelines?: readonly string[];
}

function uniqueNonEmpty(values: readonly string[] = []): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized !== "" && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

export function generateToolGuidancePrompt(
  options: GenerateToolGuidancePromptOptions,
): string {
  const tools = options.tools ?? [];
  const snippets = options.toolSnippets ?? {};
  const visibleTools = tools.filter((toolName) => snippets[toolName]?.trim());
  const guidelines = uniqueNonEmpty(options.promptGuidelines ?? []);

  if (visibleTools.length === 0 && guidelines.length === 0) {
    return "";
  }

  const lines = ["<tool_guidance>"];
  if (visibleTools.length > 0) {
    lines.push("Available tool notes:");
    for (const toolName of visibleTools) {
      lines.push(`- ${toolName}: ${snippets[toolName].trim()}`);
    }
  }
  if (guidelines.length > 0) {
    lines.push("Tool use rules:");
    for (const guideline of guidelines) {
      lines.push(`- ${guideline}`);
    }
  }
  lines.push("</tool_guidance>");
  return lines.join("\n");
}
```

- [x] **Step 4: Export the layer and verify GREEN**

Modify `packages/ohbaby-agent/src/core/system-prompt/layers/index.ts`:

```typescript
export { generateToolGuidancePrompt } from "./tools.js";
export type { GenerateToolGuidancePromptOptions } from "./tools.js";
```

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/core/system-prompt/__tests__/tools.test.ts
```

Expected: PASS.

---

## Task 4: Compose Base, Task, Add-On, Tools, Environment, And Custom Layers

**Files:**
- Modify: `packages/ohbaby-agent/src/core/system-prompt/assembler.ts`
- Modify: `packages/ohbaby-agent/src/core/system-prompt/__tests__/assembler.test.ts`
- Modify: `packages/ohbaby-agent/src/core/system-prompt/__tests__/provider.test.ts`

- [x] **Step 1: Write failing tests for add-on semantics**

Add to `packages/ohbaby-agent/src/core/system-prompt/__tests__/assembler.test.ts`:

```typescript
it("treats agentPrompt as an add-on instead of replacing defaults", () => {
  const prompts = SystemPrompt.assemble({
    agentName: "build",
    agentPrompt: "Use extra release-note care.",
    environment: ENVIRONMENT,
    isSubagent: false,
    taskKind: "agent",
  });

  const fullPrompt = prompts.join("\n\n");
  expect(fullPrompt).toContain("You are ohbaby-agent");
  expect(fullPrompt).toContain("Task: agent");
  expect(fullPrompt).toContain("<agent_prompt_addon>");
  expect(fullPrompt).toContain("Use extra release-note care.");
});

it("does not include primary custom instructions in subagent prompts", () => {
  const prompts = SystemPrompt.assemble({
    agentName: "research",
    customInstructions: ["Project-only rule"],
    environment: ENVIRONMENT,
    isSubagent: true,
    taskKind: "research",
  });

  const fullPrompt = prompts.join("\n\n");
  expect(fullPrompt).toContain("Task: research");
  expect(fullPrompt).not.toContain("Project-only rule");
  expect(fullPrompt).not.toContain("You are ohbaby-agent");
});
```

- [x] **Step 2: Run assembler tests and verify RED**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/core/system-prompt/__tests__/assembler.test.ts
```

Expected: FAIL because add-on wrappers and task layering are not implemented.

- [x] **Step 3: Update assembler composition**

Modify `packages/ohbaby-agent/src/core/system-prompt/assembler.ts` so primary assembly order is:

```typescript
generateIdentityPrompt(),
getPrimaryTaskPrompt(resolvePrimaryTaskKind(options.taskKind)),
generateAgentAddonPrompt(options.agentPromptAddon ?? options.agentPrompt),
generateToolGuidancePrompt({
  tools: options.tools,
  toolSnippets: options.toolSnippets,
  promptGuidelines: options.promptGuidelines,
}),
generateEnvironmentPrompt({ info: options.environment, minimal: false, tools: options.tools }),
generateCustomInstructionsPrompt(options.customInstructions ?? []),
```

Subagent assembly order is:

```typescript
getSubagentBasePrompt(),
getSubagentTaskPrompt(resolveSubagentTaskKind(options.agentName, options.taskKind)),
generateAgentAddonPrompt(options.agentPromptAddon ?? options.agentPrompt),
generateToolGuidancePrompt({
  tools: options.tools,
  toolSnippets: options.toolSnippets,
  promptGuidelines: options.promptGuidelines,
}),
generateEnvironmentPrompt({ info: options.environment, minimal: true, tools: options.tools }),
```

Add a local wrapper helper:

```typescript
function generateAgentAddonPrompt(prompt: string | undefined): string {
  const trimmed = prompt?.trim();
  return trimmed ? `<agent_prompt_addon>\n${trimmed}\n</agent_prompt_addon>` : "";
}
```

- [x] **Step 4: Run targeted system-prompt tests and verify GREEN**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/core/system-prompt
```

Expected: PASS.

---

## Task 5: Wire Runtime Task Kind And Tool Details Into Prompt Provider

**Files:**
- Modify: `packages/ohbaby-agent/src/core/system-prompt/assembler.ts`
- Modify: `packages/ohbaby-agent/src/core/system-prompt/types.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/types.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/core/system-prompt/__tests__/provider.test.ts`

- [x] **Step 1: Write failing provider test for mode-aware primary prompts**

Add to `packages/ohbaby-agent/src/core/system-prompt/__tests__/provider.test.ts`:

```typescript
it("resolves primary task kind through the provider", async () => {
  const provider = createSystemPromptProvider({
    environmentDetector: vi.fn().mockResolvedValue(ENVIRONMENT),
    taskKindResolver: vi.fn().mockResolvedValue("plan"),
    toolsProvider: vi.fn().mockResolvedValue(["read", "grep"]),
  });

  const prompt = await provider.build({
    directory: "/repo",
    isSubagent: false,
    sessionId: "session_1",
  });

  expect(prompt).toContain("Task: plan");
  expect(prompt).toContain("Do not write files or execute workspace changes.");
});
```

- [x] **Step 2: Write failing composition test for policy mode**

Add to `packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts`:

```typescript
it("passes current policy mode into primary system prompts", async () => {
  const composition = await createCompositionForTest({
    policyMode: "plan",
  });

  const messages = await composition.buildPromptMessages({
    agentName: "build",
    projectRoot: "/repo",
    sessionId: "session_prompt_mode",
  });

  expect(messages[0]?.role).toBe("system");
  expect(messages[0]?.content).toContain("Task: plan");
});
```

If the local helper does not support `policyMode`, add the smallest test helper field that returns `policy.getMode()`.

- [x] **Step 3: Run tests and verify RED**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/core/system-prompt/__tests__/provider.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts
```

Expected: FAIL because task kind is not resolved by provider/composition.

- [x] **Step 4: Add provider resolver inputs**

Extend `SystemPromptProviderOptions` in `assembler.ts`:

```typescript
readonly taskKindResolver?: (
  input: SystemPromptProviderInput,
  agentName: string,
) => PromptTaskKind | Promise<PromptTaskKind>;
readonly toolDetailsProvider?: (
  input: SystemPromptProviderInput,
) =>
  | Promise<{
      readonly toolSnippets?: Readonly<Record<string, string>>;
      readonly promptGuidelines?: readonly string[];
    }>
  | {
      readonly toolSnippets?: Readonly<Record<string, string>>;
      readonly promptGuidelines?: readonly string[];
    };
```

Call these before `SystemPrompt.assemble()`.

- [x] **Step 5: Wire composition runtime**

In `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`, configure `createSystemPromptProvider` with:

```typescript
async taskKindResolver(input, agentName) {
  if (!input.isSubagent) {
    return await options.policy.getMode();
  }
  if (agentName === "explore" || agentName === "research" || agentName === "plan") {
    return agentName;
  }
  return "generic";
}
```

Keep `agentPromptResolver` returning `agentManager.get(agentName)?.prompt`; assembler now treats it as an add-on.

- [x] **Step 6: Run targeted provider/composition tests and verify GREEN**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/core/system-prompt/__tests__/provider.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts
```

Expected: PASS.

---

## Task 6: Align Agent Config And Subagent Defaults

**Files:**
- Modify: `packages/ohbaby-agent/src/agents/types.ts`
- Modify: `packages/ohbaby-agent/src/agents/manager.ts`
- Modify: `packages/ohbaby-agent/src/agents/builtin/explore.ts`
- Modify: `packages/ohbaby-agent/src/agents/builtin/research.ts`
- Modify: `packages/ohbaby-agent/src/agents/manager.unit.test.ts`

- [x] **Step 1: Write failing AgentManager tests for add-on semantics**

Modify `packages/ohbaby-agent/src/agents/manager.unit.test.ts`:

```typescript
it("treats configured prompts as add-ons for custom subagents", async () => {
  const manager = new AgentManager({
    registry: new AgentRegistry({
      configLoader: async () => ({
        agents: {
          audit: {
            description: "Audit code for release risks.",
            mode: "subagent",
            name: "audit",
            prompt: "Focus on release blockers.",
          },
        },
      }),
    }),
  });
  await manager.initialize();

  const runtimeAgent = await manager.getRuntimeAgent("audit");

  expect(runtimeAgent.systemPrompt).toContain("You are the audit subagent.");
  expect(runtimeAgent.systemPrompt).toContain("Role: Audit code for release risks.");
  expect(runtimeAgent.systemPrompt).toContain("Focus on release blockers.");
});
```

- [x] **Step 2: Run tests and verify RED or behavior gap**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/agents/manager.unit.test.ts
```

Expected: FAIL if configured prompt replaces fallback subagent defaults.

- [x] **Step 3: Update AgentConfig prompt documentation**

In `packages/ohbaby-agent/src/agents/types.ts`, update the `prompt` field comment:

```typescript
/**
 * Additive runtime prompt refinement appended after the default base/task prompt.
 * This must not replace the default core/system-prompt identity or task contract.
 */
readonly prompt?: string;
```

- [x] **Step 4: Update fallback provider add-on behavior**

Modify `FALLBACK_SYSTEM_PROMPT_PROVIDER` in `packages/ohbaby-agent/src/agents/manager.ts` so a configured prompt is appended after default text instead of returned immediately.

Use this shape:

```typescript
const promptAddon = agent.prompt?.trim();
return [
  defaultPrompt,
  promptAddon ? `<agent_prompt_addon>\n${promptAddon}\n</agent_prompt_addon>` : undefined,
]
  .filter((part): part is string => part !== undefined && part.trim() !== "")
  .join("\n\n");
```

- [x] **Step 5: Reduce builtin subagent duplication**

For `packages/ohbaby-agent/src/agents/builtin/explore.ts` and `research.ts`, either remove the `prompt` field or keep only a short add-on that does not repeat the default task contract. The preferred first pass is to remove the field because defaults now live in `core/system-prompt`.

- [x] **Step 6: Run AgentManager tests and verify GREEN**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/agents/manager.unit.test.ts
```

Expected: PASS.

---

## Task 7: Deterministic Prompt Data-Flow Integration Tests

**Files:**
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts`
- Modify: `docs/core/system-prompt/ohbaby-e2e-test.md`

- [x] **Step 1: Add deterministic data-flow test for primary modes**

Add a contract or composition test that builds prompt messages in each mode and checks the first system message contains the matching task contract:

```typescript
for (const mode of ["ask", "plan", "agent"] as const) {
  it(`builds a ${mode} primary system prompt`, async () => {
    const composition = await createCompositionForTest({ policyMode: mode });
    const messages = await composition.buildPromptMessages({
      agentName: "build",
      projectRoot: "/repo",
      sessionId: `session_${mode}`,
    });

    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain(`Task: ${mode}`);
  });
}
```

- [x] **Step 2: Add deterministic data-flow test for subagent prompt boundaries**

Add a test that calls the subagent prompt builder path and asserts:

```typescript
expect(systemPrompt).toContain("<subagent_base>");
expect(systemPrompt).toContain("Task: explore");
expect(systemPrompt).not.toContain("<custom_instructions>");
expect(systemPrompt).not.toContain("You are ohbaby-agent");
```

- [x] **Step 3: Run tests and verify RED**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
```

Expected: FAIL until the runtime data flow passes task kind through system prompt assembly.

- [x] **Step 4: Implement smallest runtime wiring fix**

Use the provider/composition changes from Task 5. Do not add new runtime state if `options.policy.getMode()` and resolved subagent agent name are sufficient.

- [x] **Step 5: Run tests and verify GREEN**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
```

Expected: PASS.

---

## Task 8: Real API E2E Prompt Flow Check

**Files:**
- Modify: `tests/smoke/tui-real-provider.smoke.test.tsx`
- Modify: `docs/core/system-prompt/ohbaby-e2e-test.md`

- [x] **Step 1: Reuse existing gated real-provider smoke**

The existing smoke uses `OHBABY_RUN_REAL_TUI_SMOKE=1` and `ZAI_API_KEY` or `ZHIPU_API_KEY`. Keep API keys in process environment only.

- [x] **Step 2: Add prompt-flow assertions if deterministic tests cannot cover the final boundary**

If the deterministic composition tests already capture the final messages handed to the LLM client, do not add real-provider prompt text assertions. If the final boundary is still unobserved, add a gated smoke helper that records the outgoing system message before the real provider call without printing secrets or prompt text to stdout.

The recorded assertion should check only structural markers:

```typescript
expect(systemPrompt).toContain("<primary_task>");
expect(systemPrompt).toContain("<environment>");
expect(systemPrompt).toContain("<tool_guidance>");
expect(systemPrompt).not.toContain("ZAI_API_KEY");
expect(systemPrompt).not.toMatch(/OPENAI_API_KEY\s*=/);
```

- [x] **Step 3: Run real API smoke with primary prompt**

Passed on 2026-05-25 by loading the local root `ohbaby-e2e-test.md` key into the process environment only. Covered rendered TUI prompt submission, real `read`, and Tavily `web_search`.

Run from PowerShell with a process-only key:

```powershell
$env:OHBABY_RUN_REAL_TUI_SMOKE = "1"; $env:ZAI_API_KEY = "<process only>"; pnpm vitest run tests/smoke/tui-real-provider.smoke.test.tsx --testTimeout=360000
```

Expected: PASS for the primary real response and read-tool smoke.

- [x] **Step 4: Run real API smoke with subagent prompt**

Passed on 2026-05-25 by loading the local root `ohbaby-e2e-test.md` key into the process environment only. Covered explore child session creation/resume and child workspace tool execution.

Run:

```powershell
$env:OHBABY_RUN_REAL_TUI_SMOKE = "1"; $env:OHBABY_RUN_REAL_SUBAGENT_SMOKE = "1"; $env:ZAI_API_KEY = "<process only>"; pnpm vitest run tests/smoke/tui-real-provider.smoke.test.tsx --testTimeout=900000
```

Expected: PASS for explore subagent run/resume and workspace-tool subagent checks.

---

## Task 9: Full Verification

**Files:**
- No additional source files.

- [x] **Step 1: Run focused unit tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/core/system-prompt packages/ohbaby-agent/src/agents/manager.unit.test.ts
```

Expected: PASS.

- [x] **Step 2: Run integration and contract tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts tests/integration/core/lifecycle-tool-scheduler.integration.test.ts tests/integration/core/bash-tool-scheduler.integration.test.ts
```

Expected: PASS.

- [x] **Step 3: Run typecheck**

Run:

```powershell
pnpm run typecheck
```

Expected: exit code 0.

- [x] **Step 4: Run full unit/contract/integration suite**

Run:

```powershell
pnpm test
```

Expected: exit code 0.

- [x] **Step 5: Check worktree diff for secret leakage**

Run:

```powershell
git diff -- . ":(exclude)pnpm-lock.yaml" | rg -n "\bsk-[A-Za-z0-9_-]{20,}|ZAI_API_KEY[=]|OPENAI_API_KEY[=]|TAVILY_API_KEY[=]"
```

Expected: no matches.

- [x] **Step 6: Run the real API smokes**

Passed on 2026-05-25. Keys were used from the local root `ohbaby-e2e-test.md` file without copying values into worktree files.

Use the commands in Task 8. If the required real API key is not present in the process environment, record the skip reason in the final report and do not create a fake key.

- [x] **Step 7: Review final prompt data flow**

Manually inspect the final deterministic test output and code path:

```text
submitPromptInternal
  -> runtime.buildPromptMessages
  -> contextManager.assemble
  -> createSystemPromptProvider.build
  -> SystemPrompt.assemble
  -> system message sent to RunManager/Lifecycle/LLM client
```

Expected: primary prompt includes primary base + selected primary task + add-on + tool guidance + environment + custom instructions. Subagent prompt includes subagent base + selected subagent task + add-on + tool guidance + minimal environment only.
