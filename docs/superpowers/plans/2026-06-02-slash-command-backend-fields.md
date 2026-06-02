# Slash Command Backend Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement方案 B for slash-command backend fields: categorized `/help`, richer `/status`, server-status `/mcps`, and skill-list `/skills`, with minimal TUI formatting and no commit before user review.

**Architecture:** Keep SDK slash-command types unchanged and preserve the agent command service/provider pattern. Add focused command-layer providers for MCP server summaries, context usage, and project root, then wire them from `ui-inprocess` through `UiRuntimeComposition`. TUI consumes the structured output only for concise readable text.

**Tech Stack:** TypeScript, Vitest, pnpm workspace scripts, ohbaby-sdk slash-command DTOs, ohbaby-agent command service, MCP manager, context manager, Ink/TUI store event formatting.

---

## File Map

- Modify `packages/ohbaby-agent/src/commands/types.ts`: add skill scope/source fields, MCP server provider types, context/project callbacks.
- Modify `packages/ohbaby-agent/src/commands/index.ts`: export new provider and summary types.
- Modify `packages/ohbaby-agent/src/commands/catalog.ts`: add `/mcps` with alias `/mcp`, add `/skills`.
- Modify `packages/ohbaby-agent/src/commands/builtin.ts`: add `/mcps` and `/skills` handlers, enhance `/status`, enhance `/help`.
- Modify `packages/ohbaby-agent/src/commands/service.ts`: ensure dynamic skill command generation still uses updated skill summary shape.
- Modify `packages/ohbaby-agent/src/adapters/ui-runtime/types.ts`: expose MCP server summaries and context usage.
- Modify `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`: implement runtime methods using MCP manager and context manager.
- Modify `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`: wire command providers.
- Modify `packages/ohbaby-cli/src/tui/store/events.ts`: add minimal formatting for `help`, `status`, `mcps`, `skills`.
- Test `packages/ohbaby-agent/src/commands/catalog.unit.test.ts`: catalog IDs, aliases, surfaces.
- Test `packages/ohbaby-agent/src/commands/service.unit.test.ts`: command output contracts and graceful fallback.
- Test `packages/ohbaby-cli/src/tui/store/events.unit.test.ts`: formatting behavior if existing helpers allow direct store event tests.
- Test `packages/ohbaby-cli/src/tui/app.contract.test.tsx`: only if store-level coverage is insufficient for command notices.

## Constraints

- Do not commit.
- Do not merge.
- Do not implement TUI modal, pagination, or interaction redesign.
- Do not add `pluginId` to `/skills`.
- Do not output concrete MCP tools from `/mcps`.
- Follow TDD: test first, verify failure, implement, verify pass.

## Task 1: Catalog Contract

**Files:**

- Modify: `packages/ohbaby-agent/src/commands/catalog.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/commands/catalog.ts`

- [ ] **Step 1: Write failing catalog tests**

Add expectations that builtin IDs include `mcps` and `skills`, `/mcps` has alias `/mcp`, and both commands are available on `tui`, `stdout`, and `headless`.

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/commands/catalog.unit.test.ts
```

Expected: FAIL because `mcps` and `skills` are missing.

- [ ] **Step 2: Implement catalog entries**

Add these specs to `BUILTIN_COMMANDS`:

```typescript
{
  id: "mcps",
  path: ["mcps"],
  aliases: [["mcp"]],
  argumentMode: "argv",
  category: "system",
  description: "List MCP server status",
  source: "builtin",
  surfaces: COMMON_SURFACES,
  title: "MCP Servers",
},
{
  id: "skills",
  path: ["skills"],
  aliases: [],
  argumentMode: "argv",
  category: "skill",
  description: "List available skills",
  source: "builtin",
  surfaces: COMMON_SURFACES,
  title: "Skills",
},
```

Run the same command. Expected: PASS.

## Task 2: Command Types

**Files:**

- Modify: `packages/ohbaby-agent/src/commands/types.ts`
- Modify: `packages/ohbaby-agent/src/commands/index.ts`
- Modify tests only where TypeScript fixtures require the new `scope`.

- [ ] **Step 1: Write failing service tests that use new provider shape**

In `service.unit.test.ts`, add tests that call `/skills` with skill summaries containing `scope` and optional `source`, and `/mcps` with MCP server summaries. TypeScript should fail until the command types exist.

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/commands/service.unit.test.ts
```

Expected: FAIL or TypeScript transform error because `mcps`, `scope`, and MCP summary types are not recognized.

- [ ] **Step 2: Add command-layer types**

Add:

```typescript
export type CommandSkillScope = "user" | "project";

export interface CommandSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly scope: CommandSkillScope;
  readonly source?: string;
}

export type CommandMcpServerStatus =
  | "connected"
  | "failed"
  | "disconnected"
  | "disabled";

export interface CommandMcpServerSummary {
  readonly name: string;
  readonly status: CommandMcpServerStatus;
}

export interface CommandMcpProvider {
  listServers():
    | Promise<readonly CommandMcpServerSummary[]>
    | readonly CommandMcpServerSummary[];
}
```

Extend `CommandServiceOptions`:

```typescript
readonly mcps?: CommandMcpProvider;
readonly getContextUsage?: (input: {
  readonly sessionId?: string;
}) => Promise<ContextUsage | null> | ContextUsage | null;
readonly getProjectRoot?: () => Promise<string> | string;
```

Import `ContextUsage` from `../core/context/index.js` so command output remains aligned with the existing context module.

Export the new types from `commands/index.ts`.

Run the service test command again. Expected: still FAIL because handlers are not implemented.

## Task 3: Builtin Handler Output Contracts

**Files:**

- Modify: `packages/ohbaby-agent/src/commands/service.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/commands/builtin.ts`
- Modify: `packages/ohbaby-agent/src/commands/service.ts`

- [ ] **Step 1: Add failing tests for `/help` categories**

Assert `/help` emits `data.commands` and `data.categories`. Verify categories are grouped by category and include dynamic skill commands.

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/commands/service.unit.test.ts -t help
```

Expected: FAIL because `categories` is missing.

- [ ] **Step 2: Implement categorized help**

Add a local helper in `builtin.ts`:

```typescript
function categorizeCommands(commands: readonly UiCommandSpec[]) {
  const groups = new Map<string, UiCommandSpec[]>();
  for (const command of commands) {
    groups.set(command.category, [...(groups.get(command.category) ?? []), command]);
  }
  return Array.from(groups.entries()).map(([name, commands]) => ({
    commands,
    name,
    title: formatCategoryTitle(name),
  }));
}
```

Emit:

```typescript
dataOutput("help", {
  categories: categorizeCommands(catalog?.commands ?? []),
  commands: catalog?.commands ?? [],
})
```

Run the help-focused test. Expected: PASS.

- [ ] **Step 3: Add failing tests for `/mcps`**

Assert `/mcps` emits `subject: "mcps"` and `{ servers }` from `options.mcps.listServers()`, and missing provider returns `{ servers: [] }`.

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/commands/service.unit.test.ts -t mcps
```

Expected: FAIL because the handler is missing.

- [ ] **Step 4: Implement `/mcps` handler**

Add `handleMcps()` and register handler `id: "mcps"`.

Run the mcps-focused test. Expected: PASS.

- [ ] **Step 5: Add failing tests for `/skills`**

Assert `/skills` emits skills with `name`, `description`, `path`, `commandId`, `scope`, and optional `source`, and missing provider returns `{ skills: [] }`.

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/commands/service.unit.test.ts -t skills
```

Expected: FAIL because the handler is missing.

- [ ] **Step 6: Implement `/skills` handler**

Map each skill summary to:

```typescript
{
  commandId: `skill.${skill.name}`,
  description: skill.description,
  name: skill.name,
  path: [skill.name],
  scope: skill.scope,
  ...(skill.source === undefined ? {} : { source: skill.source }),
}
```

Run the skills-focused test. Expected: PASS.

- [ ] **Step 7: Add failing tests for enhanced `/status`**

Assert `/status` keeps `model`, `models`, and `status`, and adds `sessionId`, `tools`, `skillsCount`, `mcps`, `context`, and `projectRoot`.

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/commands/service.unit.test.ts -t status
```

Expected: FAIL because the fields are missing.

- [ ] **Step 8: Implement enhanced `/status`**

Use `Promise.all` to collect models, current model, tools, skills, MCP servers, context usage, and project root. Count tools by exact source keys `builtin`, `module`, `skill`, `mcp`; unknown source values do not increment those buckets.

Run the status-focused test. Expected: PASS.

## Task 4: Runtime and Adapter Wiring

**Files:**

- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/types.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`

- [ ] **Step 1: Add failing adapter/runtime tests if existing harness permits**

Search existing adapter contract tests for command service wiring and add coverage for MCP server provider and skill scope mapping.

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
```

Expected: FAIL if the new command outputs are exercised; if existing harness cannot reach command execution with MCP fixtures, keep service tests as primary evidence and add typecheck as the wiring guard.

- [ ] **Step 2: Add runtime methods**

Expose:

```typescript
listMcpServerSummaries(): Promise<readonly CommandMcpServerSummary[]>;
getContextUsage(input: {
  readonly projectRoot: string;
  readonly sessionId: string;
}): Promise<ContextUsage>;
```

Implement MCP summaries from `mcpManager.getStatus()`. Implement context usage with `contextManager.assemble()` plus `contextManager.getUsage()`.

- [ ] **Step 3: Wire command service providers**

In `ui-inprocess.ts`, pass:

```typescript
mcps: {
  async listServers() {
    return (await getRuntime()).listMcpServerSummaries();
  },
},
getProjectRoot: resolveProjectRoot,
async getContextUsage(input) {
  if (!input.sessionId) return null;
  const runtime = await getRuntime();
  return runtime.getContextUsage({
    projectRoot: await resolveProjectRoot(),
    sessionId: input.sessionId,
  });
},
```

Map `SkillInfo` to command summaries with `scope` and optional `source`.

Run:

```powershell
pnpm run typecheck
```

Expected: PASS after type issues are resolved.

## Task 5: TUI Minimal Formatting

**Files:**

- Modify: `packages/ohbaby-cli/src/tui/store/events.unit.test.ts`
- Modify: `packages/ohbaby-cli/src/tui/app.contract.test.tsx` if needed
- Modify: `packages/ohbaby-cli/src/tui/store/events.ts`

- [ ] **Step 1: Add failing formatting tests**

Use store event tests to dispatch `command.result.delivered` events for `help`, `status`, `mcps`, and `skills`, then assert command notice text contains readable labels such as `/status`, `mcps:`, `connected`, `skills:`, and `project`.

Run:

```powershell
pnpm vitest run packages/ohbaby-cli/src/tui/store/events.unit.test.ts
```

Expected: FAIL because new subjects fall back to JSON or missing formatting.

- [ ] **Step 2: Implement formatting**

Add cases in `formatDataCommandOutput()` for `help`, `mcps`, `skills`, and enhance `status`.

Run the store event test. Expected: PASS.

## Task 6: Verification and E2E

**Files:**

- No production file changes expected unless tests expose gaps.

- [ ] **Step 1: Run focused tests**

```powershell
pnpm vitest run packages/ohbaby-agent/src/commands/catalog.unit.test.ts packages/ohbaby-agent/src/commands/service.unit.test.ts packages/ohbaby-cli/src/tui/store/events.unit.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run broader checks**

```powershell
pnpm run typecheck
pnpm run test:unit
pnpm run test:contract
pnpm run test:integration
```

Expected: PASS, or document exact unrelated failures with evidence.

- [ ] **Step 3: Run real/e2e checks with `.env` API key**

Load `.env` into the current PowerShell process before running real smoke/e2e commands:

```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
  }
}
pnpm run test:smoke:real
pnpm run test:e2e:snapshot
```

Expected: PASS, or document exact unavailable external dependency.

- [ ] **Step 4: Subagent or independent review**

Use an available subagent/review mechanism if available. If no subagent tool is callable, perform an independent review pass using git diff, tests, and requirement checklist, and report that fallback clearly.

- [ ] **Step 5: Final state**

Run:

```powershell
git status --short
git branch --show-current
```

Expected: branch is `codex/slash-command-backend-fields`; changes are unstaged or staged only if explicitly requested later. Do not commit.
