# Agents Role Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ambiguous `agent_name` subagent contract with a bounded optional `role`, a reserved default `generic` subagent, and metadata-only `name` / `description` fields.

**Architecture:** The tool layer validates and defaults `role`; the agents layer treats subagent role as the execution identity; `generic` is a registered built-in subagent with the research-style wide tool whitelist. System-prompt assembly receives subagent role guidance through provider options so `core/system-prompt` does not import `agents`.

**Tech Stack:** TypeScript, Vitest, pnpm, existing `AgentManager` / `AgentRegistry` / `ToolScheduler` / `SystemPrompt` modules.

---

## File Structure

- Create `packages/ohbaby-agent/src/agents/roles.ts`: shared subagent role constants, default role, and type guard.
- Create `packages/ohbaby-agent/src/agents/builtin/generic.ts`: built-in `generic` subagent config.
- Modify `packages/ohbaby-agent/src/agents/builtin/index.ts`: export/register `generic`.
- Modify `packages/ohbaby-agent/src/agents/registry.ts`: reject user config that attempts to override reserved `generic`.
- Modify `packages/ohbaby-agent/src/agents/manager.ts`: centralize mode guard and improve primary/subagent error messages.
- Modify `packages/ohbaby-agent/src/agents/types.ts`: subagent execution params/results use `role`, `name`, and `description`.
- Modify `packages/ohbaby-agent/src/agents/service.ts`: map subagent `role` to run/session `agentName`, return metadata, do not inject `name`/`description` into prompt.
- Modify `packages/ohbaby-agent/src/agents/tasks/types.ts`: add `role` and optional `name` to task records/open input.
- Modify `packages/ohbaby-agent/src/agents/tasks/manager.ts`: store and run by role, preserve metadata.
- Modify `packages/ohbaby-agent/src/tools/utils/params.ts`: add shared non-empty string and enum helpers.
- Create `packages/ohbaby-agent/src/tools/utils/subagent-role.ts`: shared `task` / `agent_open` role parser and recoverable role error text.
- Modify `packages/ohbaby-agent/src/tools/task.ts`: schema becomes `role/name/description/prompt`, default role is `generic`.
- Modify `packages/ohbaby-agent/src/tools/agent-task.ts`: align `agent_open`, reuse helpers.
- Modify `packages/ohbaby-agent/src/core/system-prompt/types.ts`: add prompt-info type and assemble option; remove `plan` from `SubagentTaskKind`.
- Modify `packages/ohbaby-agent/src/core/system-prompt/assembler.ts`: render subagent role guidance in primary prompts only; ensure subagent prompts cannot resolve to task kind `plan`.
- Modify `packages/ohbaby-agent/src/core/system-prompt/prompts/subagents/tasks.ts`: remove the subagent `plan` task prompt mapping.
- Delete `packages/ohbaby-agent/src/core/system-prompt/prompts/subagents/tasks/plan.md`: `plan` is primary-only.
- Regenerate `packages/ohbaby-agent/src/core/system-prompt/prompts/templates.generated.ts` with `pnpm --dir packages/ohbaby-agent prompt:generate`.
- Modify `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`: inject fixed subagent role guidance and remove `plan` from subagent task-kind resolution without changing primary `Shift+Tab` permission-mode handling.
- Modify `packages/ohbaby-agent/src/core/context/tool-metadata-projection.ts`: project `role/name/description` for task tools.
- Create `packages/ohbaby-agent/src/core/context/tool-metadata-projection.unit.test.ts`: focused projection tests; this file does not exist yet.
- Modify tests under the same directories plus `tests/smoke/tui-real-provider.smoke.test.tsx`.

---

### Task 1: Add `generic` Role And Reserved Identity

**Files:**
- Create: `packages/ohbaby-agent/src/agents/roles.ts`
- Create: `packages/ohbaby-agent/src/agents/builtin/generic.ts`
- Modify: `packages/ohbaby-agent/src/agents/builtin/index.ts`
- Modify: `packages/ohbaby-agent/src/agents/index.ts`
- Modify: `packages/ohbaby-agent/src/agents/registry.ts`
- Test: `packages/ohbaby-agent/src/agents/manager.unit.test.ts`
- Test: `packages/ohbaby-agent/src/agents/registry.unit.test.ts`

- [ ] **Step 1: Write failing role and generic tests**

Add tests that assert:

```ts
expect(manager.get("generic")).toMatchObject({
  mode: "subagent",
  name: "generic",
});
expect(manager.getAgentToolsConfig("generic", { isSubagent: true })).toMatchObject({
  "*": false,
  bash: true,
  edit: true,
  glob: true,
  grep: true,
  list: true,
  memory_list: true,
  read: true,
  todo_read: true,
  todo_write: true,
  web_fetch: true,
  web_search: true,
  write: true,
  task: false,
  agent_open: false,
  agent_eval: false,
  agent_status: false,
  agent_close: false,
});
```

Also assert no additional tools are enabled beyond the research-style whitelist plus explicit subagent recursion denials.

Add a registry test:

```ts
await expect(
  registry.initialize(),
).rejects.toThrow(/generic.*reserved|generic.*cannot be overridden/i);
```

- [ ] **Step 2: Run failing tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/agents/manager.unit.test.ts packages/ohbaby-agent/src/agents/registry.unit.test.ts
```

Expected: FAIL because `generic` is not registered and reserved override rejection does not exist.

- [ ] **Step 3: Add role constants**

Create `packages/ohbaby-agent/src/agents/roles.ts`:

```ts
export const DEFAULT_SUBAGENT_ROLE = "generic" as const;

export const SUBAGENT_ROLES = [
  DEFAULT_SUBAGENT_ROLE,
  "explore",
  "research",
] as const;

export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

export function isSubagentRole(value: string): value is SubagentRole {
  return (SUBAGENT_ROLES as readonly string[]).includes(value);
}

export function formatSubagentRoles(): string {
  return SUBAGENT_ROLES.join(", ");
}
```

- [ ] **Step 4: Add built-in generic agent**

Create `packages/ohbaby-agent/src/agents/builtin/generic.ts`:

```ts
import type { AgentConfig } from "../types.js";

export const genericAgent: AgentConfig = {
  color: "#64748B",
  description:
    "General-purpose subagent for delegated bounded work when no specialized role is needed.",
  maxSteps: 30,
  mode: "subagent",
  name: "generic",
  permission: {
    bash: { "*": "ask" },
    edit: "ask",
    mcp: "ask",
    web: "allow",
  },
  tools: {
    include: [
      "read",
      "list",
      "glob",
      "grep",
      "write",
      "edit",
      "bash",
      "todo_read",
      "todo_write",
      "web_fetch",
      "web_search",
      "memory_list",
    ],
  },
};
```

Update `builtin/index.ts` so `genericAgent` is first in the built-in list:

```ts
import { genericAgent } from "./generic.js";

export const BUILTIN_AGENT_NAMES = [
  "generic",
  "build",
  "plan",
  "explore",
  "research",
] as const;

export const BUILTIN_AGENTS: readonly AgentConfig[] = [
  genericAgent,
  buildAgent,
  planAgent,
  exploreAgent,
  researchAgent,
];

export { buildAgent, exploreAgent, genericAgent, planAgent, researchAgent };
```

Update `agents/index.ts` to export `genericAgent` and role constants.

- [ ] **Step 5: Reject user override of generic**

In `packages/ohbaby-agent/src/agents/registry.ts`, add:

```ts
const RESERVED_NON_OVERRIDABLE_AGENT_NAMES = new Set(["generic"]);

function assertNotReservedOverride(key: string, agent: AgentConfig): void {
  if (
    RESERVED_NON_OVERRIDABLE_AGENT_NAMES.has(key) ||
    RESERVED_NON_OVERRIDABLE_AGENT_NAMES.has(agent.name)
  ) {
    throw new Error(`Agent name is reserved and cannot be overridden: generic`);
  }
}
```

Use it while loading user config:

```ts
for (const [key, agent] of Object.entries(userConfig.agents)) {
  validateAgent(agent);
  assertNotReservedOverride(key, agent);
  merged.set(agent.name, cloneAgent(agent));
}
```

- [ ] **Step 6: Run tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/agents/manager.unit.test.ts packages/ohbaby-agent/src/agents/registry.unit.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/ohbaby-agent/src/agents
git commit -m "feat(agents): add reserved generic subagent role"
```

---

### Task 2: Add Shared Parameter Helpers

**Files:**
- Modify: `packages/ohbaby-agent/src/tools/utils/params.ts`
- Test: `packages/ohbaby-agent/src/tools/utils/params.unit.test.ts`

- [ ] **Step 1: Write failing helper tests**

Create or extend `params.unit.test.ts`:

```ts
expect(requiredString({ prompt: "hello" }, "prompt")).toBe("hello");
expect(() => requiredString({ prompt: "" }, "prompt")).toThrow(
  'Expected parameter "prompt" to be a non-empty string.',
);
expect(optionalString({ name: "worker" }, "name")).toBe("worker");
expect(optionalString({}, "name")).toBeUndefined();
expect(
  optionalEnum(
    { role: "research" },
    "role",
    ["generic", "explore", "research"] as const,
    { defaultValue: "generic", invalidMessage: () => "bad role" },
  ),
).toBe("research");
expect(
  optionalEnum(
    {},
    "role",
    ["generic", "explore", "research"] as const,
    { defaultValue: "generic", invalidMessage: () => "bad role" },
  ),
).toBe("generic");
expect(() =>
  optionalEnum(
    { role: "AI Events Researcher" },
    "role",
    ["generic", "explore", "research"] as const,
    { defaultValue: "generic", invalidMessage: (value) => `bad ${value}` },
  ),
).toThrow("bad AI Events Researcher");
```

- [ ] **Step 2: Run failing helper tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/tools/utils/params.unit.test.ts
```

Expected: FAIL because helpers do not exist.

- [ ] **Step 3: Implement helpers**

Add to `params.ts`:

```ts
export function requiredString(
  params: Record<string, unknown>,
  name: string,
): string {
  const value = params[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be a non-empty string.`,
    );
  }
  return value;
}

export function optionalString(
  params: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be a non-empty string when provided.`,
    );
  }
  return value;
}

export function optionalBoolean(
  params: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be a boolean when provided.`,
    );
  }
  return value;
}

export function optionalEnum<const T extends readonly string[]>(
  params: Record<string, unknown>,
  name: string,
  allowed: T,
  options: {
    readonly defaultValue: T[number];
    readonly invalidMessage: (value: string) => string;
  },
): T[number] {
  const value = params[name];
  if (value === undefined) {
    return options.defaultValue;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolParameterError(options.invalidMessage(String(value)));
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ToolParameterError(options.invalidMessage(value));
  }
  return value as T[number];
}
```

- [ ] **Step 4: Run tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/tools/utils/params.unit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/ohbaby-agent/src/tools/utils/params.ts packages/ohbaby-agent/src/tools/utils/params.unit.test.ts
git commit -m "refactor(tools): share parameter validators"
```

---

### Task 3: Update `task` And `agent_open` Tool Contracts

**Files:**
- Modify: `packages/ohbaby-agent/src/tools/task.ts`
- Modify: `packages/ohbaby-agent/src/tools/agent-task.ts`
- Create: `packages/ohbaby-agent/src/tools/utils/subagent-role.ts`
- Modify: `packages/ohbaby-agent/src/agents/types.ts`
- Modify: `packages/ohbaby-agent/src/agents/tasks/types.ts`
- Test: `packages/ohbaby-agent/src/tools/task.unit.test.ts`
- Test: `packages/ohbaby-agent/src/tools/agent-task.unit.test.ts`

- [ ] **Step 1: Write failing tool schema and parameter tests**

Assert `task.parametersJsonSchema`:

```ts
expect(task.parametersJsonSchema.required).toEqual(["prompt"]);
expect(task.parametersJsonSchema.properties).toMatchObject({
  role: {
    default: "generic",
    enum: ["generic", "explore", "research"],
    type: "string",
  },
  name: { type: "string" },
  description: { type: "string" },
  prompt: { type: "string" },
});
expect(JSON.stringify(task.parametersJsonSchema)).not.toContain("agent_name");
```

Assert execution default:

```ts
await task.execute(
  {
    description: "AI Events Researcher",
    name: "events-scout",
    prompt: "Find events.",
  },
  context,
);
expect(execute).toHaveBeenCalledWith(
  expect.objectContaining({
    description: "AI Events Researcher",
    name: "events-scout",
    prompt: "Find events.",
    role: "generic",
  }),
);
```

Assert illegal role:

```ts
await expect(
  task.execute({ role: "AI Events Researcher", prompt: "Find events." }, context),
).rejects.toThrow(/Allowed roles are: generic, explore, research/);

await expect(
  task.execute({ role: "plan", prompt: "Make a child plan." }, context),
).rejects.toThrow(/build and plan are primary agents, not subagent roles/);

await expect(
  task.execute({ role: "build", prompt: "Build in child." }, context),
).rejects.toThrow(/build and plan are primary agents, not subagent roles/);
```

Repeat the same schema-default and illegal-role assertions for `agent_open`, including `role: "plan"` and `role: "build"`.

- [ ] **Step 2: Run failing tool tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/tools/task.unit.test.ts packages/ohbaby-agent/src/tools/agent-task.unit.test.ts
```

Expected: FAIL because schemas and params still use `agent_name`.

- [ ] **Step 3: Update subagent types**

In `agents/types.ts`, change `SubagentExecuteParams` to:

```ts
export interface SubagentExecuteParams {
  readonly role: SubagentRole;
  readonly name?: string;
  readonly parentSessionId: string;
  readonly prompt: string;
  readonly description?: string;
  readonly resumeSessionId?: string;
  readonly signal?: AbortSignal;
  readonly environment?: ToolExecutionEnvironment;
}
```

Update `SubagentResult`:

```ts
export interface SubagentResult {
  readonly role: SubagentRole;
  readonly name?: string;
  readonly description?: string;
  readonly sessionId: string;
  readonly success: boolean;
  readonly output: string;
  readonly summary: {
    readonly toolCalls: readonly SubagentToolCallSummary[];
    readonly steps: number;
    readonly duration: number;
  };
}
```

In `agents/tasks/types.ts`, update open input and record:

```ts
export interface AgentTaskRecord {
  readonly taskId: string;
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly role: SubagentRole;
  readonly name?: string;
  readonly description?: string;
  readonly prompt: string;
  readonly status: AgentTaskStatus;
  readonly output?: string;
  readonly error?: string;
  readonly pendingInputCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface AgentTaskOpenInput {
  readonly role: SubagentRole;
  readonly name?: string;
  readonly parentSessionId: string;
  readonly prompt: string;
  readonly description?: string;
  readonly environment?: ToolExecutionEnvironment;
  readonly signal?: AbortSignal;
}
```

- [ ] **Step 4: Add shared subagent role parser**

Create `packages/ohbaby-agent/src/tools/utils/subagent-role.ts`:

```ts
import {
  DEFAULT_SUBAGENT_ROLE,
  SUBAGENT_ROLES,
  type SubagentRole,
} from "../../agents/roles.js";
import { optionalEnum } from "./params.js";

export function invalidSubagentRoleMessage(value: string): string {
  return [
    `Invalid subagent role: "${value}".`,
    "Allowed roles are: generic, explore, research. Omit role to use generic.",
    'Use description for descriptive role text such as "AI Events Researcher".',
    "Use name for the displayed subagent instance name.",
    "build and plan are primary agents, not subagent roles.",
  ].join(" ");
}

export function subagentRoleParam(
  params: Record<string, unknown>,
): SubagentRole {
  return optionalEnum(params, "role", SUBAGENT_ROLES, {
    defaultValue: DEFAULT_SUBAGENT_ROLE,
    invalidMessage: invalidSubagentRoleMessage,
  });
}
```

- [ ] **Step 5: Update `task.ts` schema and parser**

Set schema:

```ts
properties: {
  role: {
    description:
      "Optional subagent behavior role. Allowed: generic, explore, research. Omit for generic.",
    default: DEFAULT_SUBAGENT_ROLE,
    enum: [...SUBAGENT_ROLES],
    type: "string",
  },
  name: {
    description:
      "Optional display name for this subagent instance. Metadata only.",
    type: "string",
  },
  description: {
    description:
      "Optional UI/log description. Metadata only; include behavioral instructions in prompt.",
    type: "string",
  },
  prompt: { type: "string" },
  resume_session_id: { type: "string" },
},
required: ["prompt"],
```

Execute with:

```ts
const result = await executor.execute({
  role: subagentRoleParam(params),
  name: optionalString(params, "name"),
  description: optionalString(params, "description"),
  parentSessionId: context.sessionId,
  prompt: requiredString(params, "prompt"),
  resumeSessionId: optionalString(params, "resume_session_id"),
  signal: context.signal,
  environment: context.environment,
});
```

- [ ] **Step 6: Update `agent-task.ts` schema and parser**

Mirror the `role/name/description/prompt` schema for `agent_open`, with `required: ["prompt"]`. `role` must include the same enum and schema-visible `default: DEFAULT_SUBAGENT_ROLE`. Use `subagentRoleParam(params)` from `tools/utils/subagent-role.ts`.

The open call should be:

```ts
const task = await controller.open({
  role: subagentRoleParam(params),
  name: optionalString(params, "name"),
  description: optionalString(params, "description"),
  environment: context.environment,
  parentSessionId: context.sessionId,
  prompt: requiredString(params, "prompt"),
  signal: context.signal,
});
```

- [ ] **Step 7: Run tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/tools/task.unit.test.ts packages/ohbaby-agent/src/tools/agent-task.unit.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add packages/ohbaby-agent/src/tools packages/ohbaby-agent/src/agents/types.ts packages/ohbaby-agent/src/agents/tasks/types.ts
git commit -m "feat(tools): replace subagent agent_name with role metadata contract"
```

---

### Task 4: Wire Role Through Synchronous Subagent Execution

**Files:**
- Modify: `packages/ohbaby-agent/src/agents/service.ts`
- Test: `packages/ohbaby-agent/src/agents/service.unit.test.ts`

- [ ] **Step 1: Write failing AgentService tests**

Add assertions:

```ts
await service.execute({
  role: "generic",
  name: "events-scout",
  description: "AI Events Researcher",
  parentSessionId: "parent",
  prompt: "Find events.",
});

expect(runAgentSpy).toHaveBeenCalledWith(
  expect.anything(),
  expect.objectContaining({
    agentName: "generic",
    initialUserPrompt: "Find events.",
  }),
);
expect(result).toMatchObject({
  role: "generic",
  name: "events-scout",
  description: "AI Events Researcher",
});
```

Add resume mismatch assertion:

```ts
await expect(
  service.execute({
    role: "research",
    parentSessionId: "parent",
    prompt: "resume",
    resumeSessionId: "child_generic",
  }),
).rejects.toThrow(/belongs to agent generic, not research/);
```

- [ ] **Step 2: Run failing service tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/agents/service.unit.test.ts
```

Expected: FAIL because service still reads `agentName` and result lacks metadata.

- [ ] **Step 3: Map role to runtime agent and session**

In `executeTask`, use:

```ts
const runtimeAgent = await this.options.agentManager.getRuntimeAgent(
  params.role,
  { isSubagent: true },
);
const session = await this.resolveSession(params);
```

Pass run input:

```ts
agentName: params.role,
initialUserPrompt: params.prompt,
```

Return:

```ts
return {
  description: params.description,
  name: params.name,
  output,
  role: params.role,
  sessionId: session.id,
  success: result.success,
  summary: {
    duration: this.now() - startedAt,
    steps: result.steps ?? 0,
    toolCalls: result.toolCalls ?? [],
  },
};
```

In `resolveSession`, store session identity as role:

```ts
if (resumed.agentName !== params.role) {
  throw new Error(
    `Session ${params.resumeSessionId} belongs to agent ${resumed.agentName}, not ${params.role}`,
  );
}

return this.options.sessionManager.create(parent.projectRoot, {
  agentName: params.role,
  parentId: parent.id,
  title: params.description,
});
```

- [ ] **Step 4: Keep local subagent primary-mode guard until centralization**

Leave this local block in `AgentService.executeTask` for now:

```ts
if (runtimeAgent.config.mode === "primary") {
  throw new Error(`Agent ${params.role} cannot be used as a subagent`);
}
```

Task 6 centralizes mode guard in `AgentManager` and removes this duplicated local block.

- [ ] **Step 5: Run service tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/agents/service.unit.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/ohbaby-agent/src/agents/service.ts packages/ohbaby-agent/src/agents/service.unit.test.ts
git commit -m "feat(agents): pass subagent role through task execution"
```

---

### Task 5: Wire Role Through Background Agent Tasks

**Files:**
- Modify: `packages/ohbaby-agent/src/agents/tasks/manager.ts`
- Modify: `packages/ohbaby-agent/src/agents/tasks/in-memory-store.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/agents/tasks/manager.unit.test.ts`

- [ ] **Step 1: Write failing background task tests**

Assert open:

```ts
const task = await manager.open({
  role: "generic",
  name: "events-scout",
  description: "AI Events Researcher",
  parentSessionId: "parent",
  prompt: "Find events.",
});

expect(task).toMatchObject({
  role: "generic",
  name: "events-scout",
  description: "AI Events Researcher",
});
```

Assert run:

```ts
expect(runAgentSpy).toHaveBeenCalledWith(
  expect.anything(),
  expect.objectContaining({
    agentName: "generic",
    initialUserPrompt: "Find events.",
  }),
);
```

- [ ] **Step 2: Run failing task manager tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/agents/tasks/manager.unit.test.ts packages/ohbaby-agent/src/agents/tasks/in-memory-store.unit.test.ts
```

Expected: FAIL because task records still use `agentName`.

- [ ] **Step 3: Store role and metadata**

In `open`, resolve:

```ts
const runtimeAgent = await this.options.agentManager.getRuntimeAgent(
  input.role,
  { isSubagent: true },
);
```

Create session:

```ts
const session = await this.options.sessionManager.create(parent.projectRoot, {
  agentName: input.role,
  parentId: parent.id,
  title: input.description,
});
```

Create record:

```ts
const record = await this.store.create({
  createdAt: now,
  description: input.description,
  name: input.name,
  parentSessionId: input.parentSessionId,
  pendingInputCount: 0,
  prompt: input.prompt,
  role: input.role,
  sessionId: session.id,
  status: "pending",
  taskId,
  updatedAt: now,
});
```

- [ ] **Step 4: Use role for resumed state and runTurn**

In `ensureState`:

```ts
const runtimeAgent = await this.options.agentManager.getRuntimeAgent(
  task.role,
  { isSubagent: true },
);
```

In `runTurn`:

```ts
agentName: state.runtimeAgent.config.name,
initialUserPrompt: prompt,
```

`state.runtimeAgent.config.name` should be `generic`, `explore`, or `research`.

- [ ] **Step 5: Run tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/agents/tasks/manager.unit.test.ts packages/ohbaby-agent/src/agents/tasks/in-memory-store.unit.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/ohbaby-agent/src/agents/tasks
git commit -m "feat(agents): preserve role metadata for background tasks"
```

---

### Task 6: Centralize Mode Guard And Prompt Role Guidance

**Files:**
- Modify: `packages/ohbaby-agent/src/agents/manager.ts`
- Modify: `packages/ohbaby-agent/src/core/system-prompt/types.ts`
- Modify: `packages/ohbaby-agent/src/core/system-prompt/assembler.ts`
- Modify: `packages/ohbaby-agent/src/core/system-prompt/prompts/subagents/tasks.ts`
- Delete: `packages/ohbaby-agent/src/core/system-prompt/prompts/subagents/tasks/plan.md`
- Modify: `packages/ohbaby-agent/src/core/system-prompt/prompts/templates.generated.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`
- Test: `packages/ohbaby-agent/src/agents/manager.unit.test.ts`
- Test: `packages/ohbaby-agent/src/core/system-prompt/__tests__/assembler.test.ts`
- Test: `packages/ohbaby-agent/src/core/system-prompt/__tests__/prompt-assets.unit.test.ts`
- Test: `packages/ohbaby-agent/src/core/system-prompt/__tests__/provider.test.ts`
- Test: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts`

- [ ] **Step 1: Write failing mode guard and prompt tests**

Manager:

```ts
for (const primaryAgentName of ["build", "plan"] as const) {
  await expect(
    manager.getRuntimeAgent(primaryAgentName, { isSubagent: true }),
  ).rejects.toThrow(/primary agents|subagent roles|generic, explore, research/i);
}
```

Assembler:

```ts
const prompts = SystemPrompt.assemble({
  agentName: "build",
  availableSubagentRoles: [
    { default: true, description: "General-purpose", role: "generic" },
    { description: "Fast exploration", role: "explore" },
    { description: "Deep research", role: "research" },
  ],
  environment: ENVIRONMENT,
  isSubagent: false,
});
const fullPrompt = prompts.join("\n\n");
expect(fullPrompt).toContain("Subagent roles for task / agent_open");
expect(fullPrompt).toContain("generic");
expect(fullPrompt).toContain("Omit role to use generic");
expect(fullPrompt).toContain("description and name are metadata only");
expect(fullPrompt).toContain("build and plan are primary-agent modes");
```

Subagent:

```ts
const subagentPrompt = SystemPrompt.assemble({
  agentName: "generic",
  availableSubagentRoles: [{ default: true, description: "General-purpose", role: "generic" }],
  environment: ENVIRONMENT,
  isSubagent: true,
}).join("\n\n");
expect(subagentPrompt).not.toContain("Subagent roles for task / agent_open");
```

Subagent task-kind boundary:

```ts
const subagentPrompt = SystemPrompt.assemble({
  agentName: "generic",
  environment: ENVIRONMENT,
  isSubagent: true,
  taskKind: "plan",
}).join("\n\n");
expect(subagentPrompt).not.toContain("Task: plan");
expect(subagentPrompt).toContain("Task: generic");
```

Composition primary/subagent boundary:

```ts
// In composition.unit.test.ts, use a primary session with permission mode "plan".
expect(primaryBuildPrompt).toContain("Task: plan");
expect(primaryBuildPrompt).toContain("Subagent roles for task / agent_open");

// In a subagent session, even if stale task-kind input asks for plan, it cannot render plan.
expect(genericSubagentPrompt).not.toContain("Task: plan");
expect(genericSubagentPrompt).toContain("Task: generic");
```

- [ ] **Step 2: Run failing tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/agents/manager.unit.test.ts packages/ohbaby-agent/src/core/system-prompt/__tests__/assembler.test.ts packages/ohbaby-agent/src/core/system-prompt/__tests__/prompt-assets.unit.test.ts packages/ohbaby-agent/src/core/system-prompt/__tests__/provider.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts
```

Expected: FAIL because prompt guidance and centralized mode guard do not exist.

- [ ] **Step 3: Centralize AgentManager mode guard**

Add in `manager.ts`:

```ts
function modeErrorMessage(agent: AgentConfig, isSubagent: boolean): string {
  if (isSubagent) {
    return [
      `Agent ${agent.name} is a primary agent and cannot be used as a subagent.`,
      `Allowed subagent roles are: ${formatSubagentRoles()}.`,
      "Omit role to use generic.",
    ].join(" ");
  }
  return `Agent ${agent.name} is a subagent and cannot be used as a primary agent.`;
}

function assertRuntimeMode(agent: AgentConfig, isSubagent: boolean): void {
  if (agent.mode === "all") {
    return;
  }
  if (isSubagent && agent.mode === "primary") {
    throw new Error(modeErrorMessage(agent, isSubagent));
  }
  if (!isSubagent && agent.mode === "subagent") {
    throw new Error(modeErrorMessage(agent, isSubagent));
  }
}
```

Call it in `getRuntimeAgent` before building the prompt:

```ts
const isSubagentAgent = options.isSubagent ?? isConfiguredSubagent(agent);
assertRuntimeMode(agent, isSubagentAgent);
```

Remove duplicated mode guards from `AgentService` and `AgentTaskManager` after this test passes.

- [ ] **Step 4: Remove subagent `plan` task kind**

In `core/system-prompt/types.ts`, keep primary `plan` but remove subagent `plan`:

```ts
export type PrimaryTaskKind = "ask" | "plan" | "agent";
export type SubagentTaskKind = "explore" | "research" | "generic";
export type PromptTaskKind = PrimaryTaskKind | SubagentTaskKind;
```

In `assembler.ts`, make `isSubagentTaskKind` reject `plan`:

```ts
function isSubagentTaskKind(value: unknown): value is SubagentTaskKind {
  return value === "explore" || value === "research" || value === "generic";
}
```

Update `prompts/subagents/tasks.ts` so the record only maps `explore`, `research`, and `generic`. Delete `prompts/subagents/tasks/plan.md`.

Update `prompt-assets.unit.test.ts` to remove the subagent `plan.md` case. Run:

```powershell
pnpm --dir packages/ohbaby-agent prompt:generate
```

Expected generated output: `templates.generated.ts` no longer exports `SUBAGENT_TASK_PLAN_PROMPT_TEMPLATE`.

- [ ] **Step 5: Add prompt role info types**

In `core/system-prompt/types.ts`:

```ts
export interface SubagentRolePromptInfo {
  readonly role: string;
  readonly description: string;
  readonly default?: boolean;
}

export interface AssembleOptions {
  readonly availableSubagentRoles?: readonly SubagentRolePromptInfo[];
  ...
}
```

- [ ] **Step 6: Render primary-only role guidance**

In `assembler.ts`:

```ts
function generateSubagentRolesPrompt(
  roles: readonly SubagentRolePromptInfo[] | undefined,
): string {
  if (!roles || roles.length === 0) {
    return "";
  }
  const lines = roles.map((role) => {
    const suffix = role.default === true ? " (default)" : "";
    return `- ${role.role}${suffix}: ${role.description}`;
  });
  return [
    "<subagent_roles>",
    "Subagent roles for task / agent_open:",
    ...lines,
    "",
    "Omit role to use generic.",
    'Do not put descriptive names such as "AI Events Researcher" in role.',
    "Put those in description. Put display names in name.",
    "description and name are metadata only. If the subagent must follow a persona, scope, constraints, known files, or expected output format, include those details inside prompt.",
    "build and plan are primary-agent modes, not subagent roles.",
    "</subagent_roles>",
  ].join("\n");
}
```

Add it to the primary branch before tool guidance:

```ts
generateSubagentRolesPrompt(options.availableSubagentRoles),
toolGuidance,
```

- [ ] **Step 7: Add provider option and composition injection**

In `SystemPromptProviderOptions`:

```ts
readonly availableSubagentRolesProvider?: (
  input: SystemPromptProviderInput,
) =>
  | Promise<readonly SubagentRolePromptInfo[]>
  | readonly SubagentRolePromptInfo[];
```

Resolve it in `createSystemPromptProvider` only for primary prompts:

```ts
const availableSubagentRoles = input.isSubagent
  ? []
  : await (options.availableSubagentRolesProvider?.(input) ?? []);
```

Pass into primary `SystemPrompt.assemble`.

In `composition.ts`, inject:

```ts
availableSubagentRolesProvider() {
  return SUBAGENT_ROLES.map((role) => {
    const agent = agentManager.get(role);
    return {
      default: role === DEFAULT_SUBAGENT_ROLE,
      description: agent?.description ?? `${role} subagent`,
      role,
    };
  });
},
```

Remove `plan` from `resolveSubagentTaskKind`:

```ts
return agentName === "explore" || agentName === "research"
  ? agentName
  : "generic";
```

Do not change the primary branch:

```ts
if (!input.isSubagent) {
  return options.permissionState.getMode() === "plan" ? "plan" : "agent";
}
```

This preserves `Shift+Tab` primary mode switching.

- [ ] **Step 8: Run tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/agents/manager.unit.test.ts packages/ohbaby-agent/src/core/system-prompt/__tests__/assembler.test.ts packages/ohbaby-agent/src/core/system-prompt/__tests__/prompt-assets.unit.test.ts packages/ohbaby-agent/src/core/system-prompt/__tests__/provider.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add packages/ohbaby-agent/src/agents/manager.ts packages/ohbaby-agent/src/core/system-prompt packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts
git commit -m "feat(system-prompt): document subagent role contract"
```

---

### Task 7: Project Role Metadata To Model Context

**Files:**
- Modify: `packages/ohbaby-agent/src/core/context/tool-metadata-projection.ts`
- Create: `packages/ohbaby-agent/src/core/context/tool-metadata-projection.unit.test.ts`

- [ ] **Step 1: Write failing metadata projection tests**

Add:

```ts
expect(
  projectToolMetadataForModel("task", {
    subagent: {
      description: "AI Events Researcher",
      name: "events-scout",
      role: "generic",
      sessionId: "child",
      success: true,
    },
  }),
).toEqual({
  description: "AI Events Researcher",
  name: "events-scout",
  role: "generic",
  sessionId: "child",
  success: true,
});
```

Add equivalent test for `agent_open` with nested `agentTask`.

- [ ] **Step 2: Run failing projection tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/core/context/tool-metadata-projection.unit.test.ts
```

Expected: FAIL because projection omits `role/name/description`.

- [ ] **Step 3: Update projection whitelist**

In `task` case, include:

```ts
return subagent === undefined
  ? {}
  : copyMetadataFields(subagent, [
      "sessionId",
      "role",
      "name",
      "description",
      "success",
      "error",
    ]);
```

In `agent_open` / `agent_eval` / `agent_status` / `agent_close` case, include:

```ts
return copyMetadataFields(agentTask, [
  "taskId",
  "sessionId",
  "role",
  "name",
  "description",
  "status",
  "pendingInputCount",
  "error",
]);
```

- [ ] **Step 4: Run tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/core/context/tool-metadata-projection.unit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/ohbaby-agent/src/core/context/tool-metadata-projection.ts packages/ohbaby-agent/src/core/context/tool-metadata-projection.unit.test.ts
git commit -m "feat(context): project subagent role metadata"
```

---

### Task 8: Update Integration And Real Smoke Coverage

**Files:**
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`
- Modify: `tests/smoke/tui-real-provider.smoke.test.tsx`
- Test: `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`
- Test: `tests/smoke/tui-real-provider.smoke.test.tsx`

- [ ] **Step 1: Update fake task tool events**

Change test helpers from:

```ts
argumentsDelta: JSON.stringify({
  agent_name: input.agentName ?? "explore",
  description: input.description,
  prompt: input.prompt,
  resume_session_id: input.resumeSessionId,
}),
```

to:

```ts
argumentsDelta: JSON.stringify({
  role: input.role ?? "explore",
  description: input.description,
  name: input.name,
  prompt: input.prompt,
  resume_session_id: input.resumeSessionId,
}),
```

Update helper input types from `agentName` to `role`.

- [ ] **Step 2: Add default generic contract assertion**

In an existing task contract test, create a tool call without `role`:

```ts
taskToolCallEvent({
  callId: "call_generic_task",
  description: "AI Events Researcher",
  name: "events-scout",
  prompt: "Inspect marker files.",
  role: undefined,
});
```

Assert the child session uses `generic`.

- [ ] **Step 3: Update real smoke prompts**

Change prompts such as:

```text
Call the task tool exactly once with agent_name explore.
```

to:

```text
Call the task tool exactly once with role explore.
```

Add a real default generic smoke prompt:

```text
Call the task tool exactly once without a role field. Set description to "AI Events Researcher" and name to "events-scout". Ask the child in prompt to inspect the marker files and answer with the exact token OHBABY_REAL_GENERIC_SUBAGENT_OK.
```

- [ ] **Step 4: Run integration/contract tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run opt-in smoke when credentials are available**

Agentic workers must not open, read, quote, or summarize `ohbaby-e2e-test.md`. Run this opt-in smoke only when the required environment variables are already present in the process from a human-managed shell or CI secret store. If credentials are not already present, skip this step and record `credentials unavailable` in the implementation notes.

When credentials are already present, run:

```powershell
$env:OHBABY_RUN_REAL_TUI_SMOKE='1'
$env:OHBABY_RUN_REAL_SUBAGENT_SMOKE='1'
pnpm vitest run tests/smoke/tui-real-provider.smoke.test.tsx
```

Expected: PASS when external services are healthy. If an external provider fails, record the status code or timeout without printing API keys.

- [ ] **Step 6: Commit**

```powershell
git add packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts tests/smoke/tui-real-provider.smoke.test.tsx
git commit -m "test(agents): cover generic subagent role contract"
```

---

### Task 9: Full Regression And Documentation Check

**Files:**
- Modify: `docs/core/agents/improve-1/01-problem-analysis.md`
- Modify: `docs/core/agents/improve-1/02-design-and-references.md`
- Modify: `docs/core/agents/improve-1/03-test-and-acceptance.md`
- Modify: `docs/core/agents/improve-1/04-implementation-plan.md`

- [ ] **Step 1: Search for stale source/test contract references**

Run:

```powershell
rg -n "agent_name|actual_role|requested_role|role.*降级|降级.*role|SUBAGENT_TASK_PLAN|subagents/tasks/plan" packages/ohbaby-agent/src tests
```

Expected: no source/test hits for the old tool input contract or subagent `plan` prompt. If a test intentionally asserts that `agent_name` is absent, keep that assertion and make the expectation explicit in the test name.

- [ ] **Step 2: Run focused test set**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/agents/manager.unit.test.ts packages/ohbaby-agent/src/agents/registry.unit.test.ts packages/ohbaby-agent/src/tools/task.unit.test.ts packages/ohbaby-agent/src/tools/agent-task.unit.test.ts packages/ohbaby-agent/src/agents/service.unit.test.ts packages/ohbaby-agent/src/agents/tasks/manager.unit.test.ts packages/ohbaby-agent/src/core/system-prompt/__tests__/assembler.test.ts packages/ohbaby-agent/src/core/system-prompt/__tests__/prompt-assets.unit.test.ts packages/ohbaby-agent/src/core/system-prompt/__tests__/provider.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts packages/ohbaby-agent/src/core/context/tool-metadata-projection.unit.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run repo verification**

Run:

```powershell
pnpm run lint
pnpm run typecheck
pnpm run test
```

Expected: PASS.

- [ ] **Step 4: Commit documentation alignment**

```powershell
git add docs/core/agents/improve-1
git commit -m "docs(agents): align improve-1 role contract plan"
```
