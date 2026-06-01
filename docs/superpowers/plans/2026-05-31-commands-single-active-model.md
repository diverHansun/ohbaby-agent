# Commands Single Active Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SDK command resolving the single slash-command authority, replace legacy model/permission/session command shapes with the confirmed catalog, and prepare `/models` for single active model display plus OpenAI-compatible single active model switching.

**Architecture:** Keep startup parsing separate from runtime slash command parsing. SDK owns command parse/resolve/filter semantics; `ohbaby-cli` TUI wraps SDK behavior for rendering and invocation creation. `ohbaby-agent` owns command handlers and a focused `config/llm` single-active-config write API that updates `model.json`, optionally writes `~/.ohbaby-agent/.env`, and invalidates the in-process runtime so subsequent requests use the new config.

**Tech Stack:** TypeScript, Vitest, Ink, ohbaby-sdk command DTOs, ohbaby-agent command service, `config/llm`, dotenv-compatible `.env` formatting, pnpm workspace scripts.

---

## Scope

This plan is for the first temporary branch only:

```powershell
git checkout -b codex/commands-sdk-resolver-models
```

In scope:

- SDK command contract and resolver authority.
- Catalog change to `/models`, `/sessions`, `/new`, `/compact`, `/resume`, `/permission`.
- Removal of visible `/tools`, `/abort`, `/model*`, `/session*`, `/permission default`, and `/permission full-access`.
- Hidden `permission.toggle-mode` handler remains.
- `/models` displays the single active model config.
- Backend/config contract can switch one active OpenAI-compatible config by provider, baseUrl, apiKeyEnv, optional apiKey, and model name.
- The explicit switching call path is `UiBackendClient.setActiveModelConfig(input)`. `/models` remains the TUI entry that opens the model surface; the full form that calls this client method is wired in a later TUI task.
- TUI keeps using current dialog infrastructure; full credential/config form is not part of this branch.

Out of scope:

- Moving `bin.ts` and CLI IO to `ohbaby-cli`.
- `yargs` startup parser implementation.
- Multi-provider provider-centric schema.
- Provider/model CRUD.
- Database/keychain secret storage.
- Migrating an in-flight LLM request to a new model.

## File Map

SDK command authority:

- Modify `packages/ohbaby-sdk/src/client.ts`: add `UiSetActiveModelConfigInput`, `UiModelSummary`, and `setActiveModelConfig`.
- Modify `packages/ohbaby-sdk/src/command/types.ts`: add command `title`, resolve options, surface error type.
- Modify `packages/ohbaby-sdk/src/command/parse.ts`: keep tokenizer and multiline behavior stable.
- Modify `packages/ohbaby-sdk/src/command/resolve.ts`: enforce surface and argv rules.
- Modify `packages/ohbaby-sdk/src/command/parse.unit.test.ts`.
- Modify `packages/ohbaby-sdk/src/command/resolve.unit.test.ts`.

TUI command wrapper:

- Modify `packages/ohbaby-cli/src/tui/command/runtime.ts`: delegate parse/resolve/filter to SDK.
- Modify `packages/ohbaby-cli/src/tui/command/completions.ts`: consume the SDK-backed wrapper.
- Modify `packages/ohbaby-cli/src/tui/command/runtime.unit.test.ts`.
- Modify `packages/ohbaby-cli/src/tui/store/snapshot.ts`: remove shadow drift where practical and keep compatibility types tied to SDK.
- Modify `packages/ohbaby-cli/src/tui/store/events.ts`: render `models.current`, `models.changed`, and `help`.

Agent commands:

- Modify `packages/ohbaby-agent/src/commands/catalog.ts`: new confirmed catalog.
- Modify `packages/ohbaby-agent/src/commands/builtin.ts`: new `/models`, `/sessions`, `/new`, `/compact`, `/resume`, `/permission`, and status/help behavior.
- Modify `packages/ohbaby-agent/src/commands/service.ts`: build help output from the active catalog.
- Modify `packages/ohbaby-agent/src/commands/types.ts`: extend model summaries and switching provider contract.
- Modify `packages/ohbaby-agent/src/commands/catalog.unit.test.ts`.
- Modify `packages/ohbaby-agent/src/commands/service.unit.test.ts`.

Single active LLM config:

- Modify `packages/ohbaby-agent/src/config/llm/types.ts`: add write input/result and include `apiKeyEnv` in resolved config.
- Modify `packages/ohbaby-agent/src/config/llm/loaders.ts`: expose config/env paths and atomic write helpers.
- Add `packages/ohbaby-agent/src/config/llm/writer.ts`: validate and write one active config.
- Modify `packages/ohbaby-agent/src/config/llm/manager.ts`: use `apiKeyEnv` in resolved config and expose set-active flow.
- Modify `packages/ohbaby-agent/src/config/llm/index.ts`: export public write API.
- Add `packages/ohbaby-agent/src/config/llm/__tests__/writer.test.ts`.
- Modify existing `packages/ohbaby-agent/src/config/llm/__tests__/*.test.ts` only where type expectations require `apiKeyEnv`.
- Modify `packages/ohbaby-agent/src/core/llm-client/types.ts`: expose `apiKeyEnv` in non-secret client config.
- Modify `packages/ohbaby-agent/src/core/llm-client/client.ts`: pass `apiKeyEnv` through from resolved config.
- Modify `packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts`: update client config expectations.

UI adapter wiring:

- Modify `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`: include baseUrl/apiKeyEnv in model summaries, expose single-active switch provider, and reset runtime for subsequent prompts after successful switch.
- Modify `packages/ohbaby-agent/src/adapters/ui-persistent.ts`: forward `setActiveModelConfig`.
- Modify `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts` where command catalog expectations mention removed command IDs.

Docs:

- Modify `docs/superpowers/specs/2026-05-31-cli-commands-boundary-design.md` if implementation reveals wording drift.
- Modify `docs/problem-lists/2026-05-31-model-center-and-llm-config.md` only for out-of-scope clarifications.

## Task 1: SDK Command Contract And Resolver

**Files:**

- Modify: `packages/ohbaby-sdk/src/client.ts`
- Modify: `packages/ohbaby-sdk/src/command/types.ts`
- Modify: `packages/ohbaby-sdk/src/command/resolve.ts`
- Test: `packages/ohbaby-sdk/src/command/resolve.unit.test.ts`
- Test: `packages/ohbaby-sdk/src/command/parse.unit.test.ts`

- [ ] **Step 1: Add SDK client model-switching DTOs**

Add focused UI-facing DTOs to `client.ts`:

```typescript
export interface UiModelSummary {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly active?: boolean;
}

export interface UiSetActiveModelConfigInput {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly apiKey?: string;
}

export interface UiBackendClient {
  // existing methods stay unchanged
  setActiveModelConfig(input: UiSetActiveModelConfigInput): Promise<UiModelSummary>;
}
```

This is the explicit backend call path that future `/models` TUI forms will use. Do not encode API keys in slash command text or `UiCommandInvocation.raw`.

- [ ] **Step 2: Write failing resolver tests for `/models`, surface filtering, and extra argv**

Add tests equivalent to:

```typescript
const commandCatalog: UiCommandCatalog = {
  version: "commands-v2",
  commands: [
    {
      argumentMode: "argv",
      category: "model",
      description: "Show and switch the active model",
      id: "models",
      path: ["models"],
      source: "builtin",
      surfaces: ["tui", "stdout", "headless"],
      title: "Models",
    },
    {
      argumentMode: "argv",
      category: "permission",
      description: "Choose permission level",
      id: "permission",
      parentBehavior: "interaction",
      path: ["permission"],
      source: "builtin",
      surfaces: ["tui", "stdout", "headless"],
      title: "Permission",
    },
    {
      acceptsArguments: true,
      argumentMode: "argv",
      argsHint: "--session_id <id>",
      category: "session",
      description: "Resume a session",
      id: "resume",
      path: ["resume"],
      source: "builtin",
      surfaces: ["tui", "stdout", "headless"],
      title: "Resume",
    },
  ],
};

it("resolves /models as the model command", () => {
  expect(resolveCommand(commandCatalog, parseSlashInput("/models"), { surface: "tui" })).toMatchObject({
    ok: true,
    command: { id: "models" },
    path: ["models"],
    argv: [],
  });
});

it("rejects unaccepted argv on non-argument commands", () => {
  expect(resolveCommand(commandCatalog, parseSlashInput("/permission default"), { surface: "tui" })).toMatchObject({
    ok: false,
    error: { code: "COMMAND_NOT_FOUND" },
  });
});

it("allows argv only when acceptsArguments is true", () => {
  expect(resolveCommand(commandCatalog, parseSlashInput("/resume session_1"), { surface: "tui" })).toMatchObject({
    ok: true,
    command: { id: "resume" },
    argv: ["session_1"],
    rawArgs: "session_1",
  });
});

it("rejects commands unavailable on the requested surface", () => {
  const stdoutOnly: UiCommandCatalog = {
    version: "surface",
    commands: [{ ...commandCatalog.commands[0], surfaces: ["stdout"] }],
  };
  expect(resolveCommand(stdoutOnly, parseSlashInput("/models"), { surface: "tui" })).toMatchObject({
    ok: false,
    error: { code: "COMMAND_NOT_AVAILABLE_ON_SURFACE" },
  });
});
```

- [ ] **Step 3: Run SDK command tests and confirm failure**

Run:

```powershell
pnpm vitest run packages/ohbaby-sdk/src/command/parse.unit.test.ts packages/ohbaby-sdk/src/command/resolve.unit.test.ts
```

Expected: resolver tests fail because `title`, resolve options, surface failure, and strict argv behavior are not implemented.

- [ ] **Step 4: Implement SDK type and resolver changes**

Use this shape in `types.ts`:

```typescript
export interface UiCommandSpec {
  readonly id: string;
  readonly path: readonly string[];
  readonly aliases?: readonly (readonly string[])[];
  readonly title?: string;
  readonly category: string;
  readonly description: string;
  readonly argsHint?: string;
  readonly acceptsArguments?: boolean;
  readonly argumentMode: UiCommandArgumentMode;
  readonly source: UiCommandSource;
  readonly surfaces: readonly UiCommandSurface[];
  readonly parentBehavior?: UiCommandParentBehavior;
}

export interface UiCommandResolveOptions {
  readonly surface?: UiCommandSurface;
}

export type UiCommandResolveErrorCode =
  | "NOT_A_COMMAND"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_NOT_AVAILABLE_ON_SURFACE"
  | "AMBIGUOUS_COMMAND";
```

Use this behavior in `resolve.ts`:

```typescript
export function resolveCommand(
  catalog: UiCommandCatalog,
  parsed: UiParsedSlashInput | null,
  options: UiCommandResolveOptions = {},
): UiCommandResolveResult {
  if (!parsed) {
    return {
      ok: false,
      error: { code: "NOT_A_COMMAND", message: "Input is not a slash command" },
    };
  }
  if (parsed.segments.length === 0) {
    return unknownCommand(parsed);
  }

  const allCandidates = findCandidates(catalog, parsed.segments);
  const surfaceCandidates = allCandidates.filter((candidate) =>
    supportsSurface(candidate.command, options.surface),
  );
  if (allCandidates.length > 0 && surfaceCandidates.length === 0) {
    return {
      ok: false,
      error: {
        code: "COMMAND_NOT_AVAILABLE_ON_SURFACE",
        message: `Command is not available on surface: ${options.surface ?? "unknown"}`,
      },
    };
  }

  for (const candidate of surfaceCandidates) {
    const matchedLength = candidate.usedAlias?.length ?? candidate.path.length;
    const hasRemainingArgs = parsed.segments.length > matchedLength;
    if (hasRemainingArgs && candidate.command.acceptsArguments !== true) {
      continue;
    }

    return {
      ok: true,
      command: candidate.command,
      path: candidate.path,
      usedAlias: candidate.usedAlias,
      raw: parsed.raw,
      rawArgs: rawArgsFromToken(parsed.commandLine, parsed.tokenSpans[matchedLength]),
      argv: parsed.segments.slice(matchedLength),
      body: parsed.body,
    };
  }

  return unknownCommand(parsed);
}

function supportsSurface(command: UiCommandSpec, surface?: UiCommandSurface): boolean {
  return surface === undefined || command.surfaces.includes(surface);
}
```

- [ ] **Step 5: Run SDK command tests and confirm pass**

Run:

```powershell
pnpm vitest run packages/ohbaby-sdk/src/command/parse.unit.test.ts packages/ohbaby-sdk/src/command/resolve.unit.test.ts
```

Expected: both test files pass.

- [ ] **Step 6: Commit SDK resolver work**

```powershell
git add packages/ohbaby-sdk/src/client.ts packages/ohbaby-sdk/src/command
git commit -m "feat(sdk): make command resolver authoritative"
```

## Task 2: TUI Runtime Delegates To SDK Resolver

**Files:**

- Modify: `packages/ohbaby-cli/src/tui/command/runtime.ts`
- Modify: `packages/ohbaby-cli/src/tui/command/completions.ts`
- Modify: `packages/ohbaby-cli/src/tui/store/snapshot.ts`
- Test: `packages/ohbaby-cli/src/tui/command/runtime.unit.test.ts`

- [ ] **Step 1: Write failing TUI runtime tests against v2 catalog**

Replace the local test catalog with `/models`, `/sessions`, `/resume`, and `/permission`:

```typescript
const catalog: TuiCommandCatalog = {
  commands: [
    {
      argumentMode: "argv",
      category: "model",
      description: "Show and switch active model",
      id: "models",
      path: ["models"],
      source: "builtin",
      surfaces: ["tui"],
      title: "Models",
    },
    {
      argumentMode: "argv",
      category: "session",
      description: "Choose a session",
      id: "sessions",
      parentBehavior: "interaction",
      path: ["sessions"],
      source: "builtin",
      surfaces: ["tui"],
      title: "Sessions",
    },
    {
      acceptsArguments: true,
      argumentMode: "argv",
      argsHint: "--session_id <id>",
      category: "session",
      description: "Resume a session",
      id: "resume",
      path: ["resume"],
      source: "builtin",
      surfaces: ["tui"],
      title: "Resume",
    },
    {
      argumentMode: "argv",
      category: "permission",
      description: "Choose permission level",
      id: "permission",
      parentBehavior: "interaction",
      path: ["permission"],
      source: "builtin",
      surfaces: ["tui"],
      title: "Permission",
    },
  ],
  loadedAt: 1_771_000_000_000,
  surface: "tui",
  version: "v2",
};

it("delegates /models resolution to the SDK", () => {
  const result = resolveCommand(parseSlashInput("/models"), catalog, {
    sessionId: "session_1",
    surface: "tui",
  });

  expect(result).toMatchObject({
    kind: "resolved",
    invocation: {
      commandId: "models",
      path: ["models"],
      raw: "/models",
      rawArgs: "",
      sessionId: "session_1",
      surface: "tui",
    },
  });
});

it("does not resolve removed permission subcommands", () => {
  expect(resolveCommand(parseSlashInput("/permission default"), catalog, { surface: "tui" })).toMatchObject({
    kind: "not-found",
  });
});
```

- [ ] **Step 2: Run TUI runtime tests and confirm failure**

Run:

```powershell
pnpm vitest run packages/ohbaby-cli/src/tui/command/runtime.unit.test.ts
```

Expected: tests fail because `runtime.ts` still uses local parsing and old ranking behavior.

- [ ] **Step 3: Replace local resolver semantics with SDK wrappers**

First make `TuiCommandSpec` and `TuiCommandCatalog` structurally compatible with SDK command types. Do not keep optional `argumentMode`, `source`, `surfaces`, or `category` on catalog commands that are passed to SDK resolver:

```typescript
export type TuiCommandSpec = UiCommandSpec;

export interface TuiCommandCatalog extends UiCommandCatalog {
  readonly surface?: string;
  readonly loadedAt?: number;
}
```

Then keep the public TUI wrapper functions stable, but source semantics from SDK:

```typescript
import {
  filterCommandCatalog as filterSdkCommandCatalog,
  parseSlashInput as parseSdkSlashInput,
  resolveCommand as resolveSdkCommand,
} from "ohbaby-sdk";

export function parseSlashInput(input: string): ParsedSlashInput {
  const parsed = parseSdkSlashInput(input);
  if (!parsed) {
    return {
      argv: [],
      body: input,
      kind: "text",
      path: [],
      raw: input,
      rawArgs: "",
      rawPath: "",
      tokenSpans: [],
      tokens: [],
    };
  }

  return {
    argv: parsed.argv,
    body: parsed.commandLine,
    kind: "slash",
    path: parsed.path,
    raw: parsed.raw,
    rawArgs: parsed.rawArgs,
    rawPath: parsed.path.join(" "),
    tokenSpans: parsed.tokenSpans,
    tokens: parsed.segments,
  };
}
```

In `resolveCommand`, convert the SDK result to the existing TUI result:

```typescript
const sdkParsed = parseSdkSlashInput(parsed.raw);
const resolved = resolveSdkCommand(catalog, sdkParsed, {
  surface: options.surface,
});
if (!resolved.ok) {
  return resolved.error.code === "NOT_A_COMMAND"
    ? { kind: "not-slash", reason: resolved.error.message }
    : { kind: "not-found", reason: resolved.error.message };
}

return {
  command: resolved.command,
  invocation: {
    argumentMode: resolved.command.argumentMode,
    argv: resolved.argv,
    body: resolved.body,
    clientInvocationId: createInvocationId(),
    commandId: resolved.command.id,
    path: resolved.path,
    raw: resolved.raw,
    rawArgs: resolved.rawArgs,
    sessionId: options.sessionId,
    surface: "tui",
  },
  kind: "resolved",
};
```

- [ ] **Step 4: Run TUI runtime tests and SDK command tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-cli/src/tui/command/runtime.unit.test.ts packages/ohbaby-sdk/src/command/resolve.unit.test.ts
```

Expected: both suites pass.

- [ ] **Step 5: Commit TUI runtime wrapper work**

```powershell
git add packages/ohbaby-cli/src/tui/command packages/ohbaby-cli/src/tui/store/snapshot.ts
git commit -m "refactor(cli): delegate slash resolution to sdk"
```

## Task 3: Command Catalog And Builtin Handlers

**Files:**

- Modify: `packages/ohbaby-agent/src/commands/catalog.ts`
- Modify: `packages/ohbaby-agent/src/commands/builtin.ts`
- Modify: `packages/ohbaby-agent/src/commands/service.ts`
- Modify: `packages/ohbaby-agent/src/commands/types.ts`
- Test: `packages/ohbaby-agent/src/commands/catalog.unit.test.ts`
- Test: `packages/ohbaby-agent/src/commands/service.unit.test.ts`

- [ ] **Step 1: Write failing catalog tests for the confirmed visible commands**

Expected catalog IDs:

```typescript
expect(buildCommandCatalog().commands.map((command) => command.id)).toEqual([
  "status",
  "exit",
  "help",
  "models",
  "sessions",
  "new",
  "compact",
  "resume",
  "permission",
]);
```

Add a negative assertion:

```typescript
expect(buildCommandCatalog().commands.map((command) => command.id)).not.toEqual(
  expect.arrayContaining([
    "tools",
    "abort",
    "model",
    "model.list",
    "model.current",
    "session",
    "session.new",
    "session.compact",
    "session.resume",
    "permission.default",
    "permission.full-access",
  ]),
);
```

- [ ] **Step 2: Write failing service tests for `/models`, `/permission`, and `/help`**

Use this shape for `/models`:

```typescript
const switchModel = vi.fn().mockResolvedValue({
  baseUrl: "https://api.deepseek.com/v1",
  id: "deepseek:deepseek-chat",
  label: "deepseek-chat",
  model: "deepseek-chat",
  provider: "deepseek",
});

const { events, service } = createServiceHarness({
  models: {
    currentModel() {
      return {
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrl: "https://api.openai.com/v1",
        id: "openai:gpt-4.1",
        label: "gpt-4.1",
        model: "gpt-4.1",
        provider: "openai",
      };
    },
    listModels() {
      return [
        {
          apiKeyEnv: "OPENAI_API_KEY",
          baseUrl: "https://api.openai.com/v1",
          id: "openai:gpt-4.1",
          label: "gpt-4.1",
          model: "gpt-4.1",
          provider: "openai",
        },
      ];
    },
    switchModel,
  },
});

await service.executeCommand(makeInvocation("models", ["models"]));

expect(events.at(-1)).toMatchObject({
  output: {
    kind: "data",
    subject: "models.current",
    data: {
      current: {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4.1",
        provider: "openai",
      },
      switching: {
        mode: "single-active-config",
        available: true,
        clientMethod: "setActiveModelConfig",
      },
    },
  },
  type: "result",
});
```

For `/permission`, update tests so only `permission` is executable through the public catalog. Keep `permission.toggle-mode` as a direct hidden handler test.

For `/help`, assert the output contains `/models` and does not contain removed commands.

- [ ] **Step 3: Run command tests and confirm failure**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/commands/catalog.unit.test.ts packages/ohbaby-agent/src/commands/service.unit.test.ts
```

Expected: failures show the old catalog and handler IDs.

- [ ] **Step 4: Replace builtin catalog**

Set catalog version to a v2 value and use this command set:

```typescript
const BUILTIN_COMMANDS: readonly UiCommandSpec[] = [
  {
    argumentMode: "argv",
    category: "system",
    description: "Show backend status",
    id: "status",
    path: ["status"],
    source: "builtin",
    surfaces: COMMON_SURFACES,
    title: "Status",
  },
  {
    aliases: [["quit"], ["q"]],
    argumentMode: "argv",
    category: "system",
    description: "Exit the current UI surface",
    id: "exit",
    path: ["exit"],
    source: "builtin",
    surfaces: ["tui", "stdout"],
    title: "Exit",
  },
  {
    aliases: [["?"]],
    argumentMode: "argv",
    category: "system",
    description: "List all available commands",
    id: "help",
    path: ["help"],
    source: "builtin",
    surfaces: COMMON_SURFACES,
    title: "Help",
  },
  {
    argumentMode: "argv",
    category: "model",
    description: "Show and switch the active model configuration",
    id: "models",
    parentBehavior: "interaction",
    path: ["models"],
    source: "builtin",
    surfaces: COMMON_SURFACES,
    title: "Models",
  },
  {
    argumentMode: "argv",
    category: "session",
    description: "Browse and switch sessions",
    id: "sessions",
    parentBehavior: "interaction",
    path: ["sessions"],
    source: "builtin",
    surfaces: COMMON_SURFACES,
    title: "Sessions",
  },
  {
    argumentMode: "argv",
    category: "session",
    description: "Start a new session",
    id: "new",
    path: ["new"],
    source: "builtin",
    surfaces: COMMON_SURFACES,
    title: "New Session",
  },
  {
    acceptsArguments: true,
    argsHint: "[--session_id <id>] [--force]",
    argumentMode: "argv",
    category: "session",
    description: "Compact the current session context",
    id: "compact",
    path: ["compact"],
    source: "builtin",
    surfaces: COMMON_SURFACES,
    title: "Compact Session",
  },
  {
    acceptsArguments: true,
    argsHint: "--session_id <id>",
    argumentMode: "argv",
    category: "session",
    description: "Resume a session",
    id: "resume",
    path: ["resume"],
    source: "builtin",
    surfaces: COMMON_SURFACES,
    title: "Resume Session",
  },
  {
    argumentMode: "argv",
    category: "permission",
    description: "Choose the permission level",
    id: "permission",
    parentBehavior: "interaction",
    path: ["permission"],
    source: "builtin",
    surfaces: COMMON_SURFACES,
    title: "Permission Level",
  },
];
```

- [ ] **Step 5: Update model and session handler IDs**

Rename handler IDs and output subjects:

```typescript
async function emitModelsState(
  options: CommandServiceOptions,
  context: CommandRunContext,
): Promise<void> {
  const current = await currentModel(options);
  const models = await listModels(options);
  context.emitOutput(
    dataOutput("models.current", {
      current,
      models,
      switching: {
        mode: "single-active-config",
        available: typeof options.models?.switchModel === "function",
        clientMethod: "setActiveModelConfig",
        fields: ["provider", "baseUrl", "apiKeyEnv", "apiKey", "model"],
      },
    }),
  );
}
```

Use handler IDs:

```typescript
{ id: "models", execute(_invocation, context) { return emitModelsState(options, context); } }
{ id: "sessions", execute(_invocation, context) { return handleSessionParent(options, context); } }
{ id: "new", execute(_invocation, context) { return handleSessionNew(options, context); } }
{ id: "compact", execute(invocation, context) { return handleSessionCompact(options, invocation, context); } }
{ id: "resume", execute(invocation, context) { return handleSessionResume(options, invocation, context); } }
{ id: "permission", execute(_invocation, context) { return handlePermissionLevelSelection(options, context); } }
{ id: "permission.toggle-mode", execute(_invocation, context) { return handleModeToggle(options, context); } }
```

- [ ] **Step 6: Implement help output in the command service**

Before handler lookup in `executeCommand`, handle `help` from the active catalog filtered to the invocation surface:

```typescript
if (invocation.commandId === "help") {
  const catalog = filterCommandCatalogBySurface(
    await buildCatalog(options),
    invocation.surface,
  );
  context.emitOutput({
    kind: "data",
    subject: "help",
    data: {
      commands: catalog.commands.map((command) => ({
        argsHint: command.argsHint,
        description: command.description,
        id: command.id,
        path: command.path,
        title: command.title ?? command.description,
      })),
    },
  });
  return;
}
```

- [ ] **Step 7: Run command tests and confirm pass**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/commands/catalog.unit.test.ts packages/ohbaby-agent/src/commands/service.unit.test.ts
```

Expected: both command suites pass.

- [ ] **Step 8: Commit command catalog and handler work**

```powershell
git add packages/ohbaby-agent/src/commands
git commit -m "feat(agent): align builtin slash command catalog"
```

## Task 4: Single Active LLM Config Write API

**Files:**

- Modify: `packages/ohbaby-agent/src/config/llm/types.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/loaders.ts`
- Add: `packages/ohbaby-agent/src/config/llm/writer.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/manager.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/index.ts`
- Test: `packages/ohbaby-agent/src/config/llm/__tests__/writer.test.ts`
- Test: `packages/ohbaby-agent/src/config/llm/__tests__/manager.test.ts`

- [ ] **Step 1: Write failing writer tests**

Create `writer.test.ts` with these cases:

```typescript
it("writes one active OpenAI-compatible config and persists the api key", async () => {
  const root = await makeTempHome();
  const modelJsonPath = path.join(root, ".ohbaby-agent", "model.json");
  const envPath = path.join(root, ".ohbaby-agent", ".env");
  await fs.mkdir(path.dirname(modelJsonPath), { recursive: true });
  await fs.writeFile(
    modelJsonPath,
    JSON.stringify({
      provider: "openai",
      defaultModel: "gpt-4.1",
      apiConfig: {
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      llmParams: {
        temperature: 0.7,
        maxTokens: 4096,
      },
    }),
    "utf-8",
  );

  const result = await setActiveLLMConfig(
    {
      apiKey: "sk-deepseek",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      provider: "deepseek",
    },
    {
      envPath,
      modelJsonPath,
      env: {},
    },
  );

  await expect(fs.readFile(modelJsonPath, "utf-8")).resolves.toContain('"provider": "deepseek"');
  await expect(fs.readFile(modelJsonPath, "utf-8")).resolves.toContain('"defaultModel": "deepseek-chat"');
  await expect(fs.readFile(envPath, "utf-8")).resolves.toContain('DEEPSEEK_API_KEY="sk-deepseek"');
  expect(result.wroteApiKey).toBe(true);
});

it("rejects missing api key when no existing env value is available", async () => {
  await expect(
    setActiveLLMConfig(
      {
        apiKeyEnv: "MISSING_API_KEY",
        baseUrl: "https://api.example.com/v1",
        model: "example-model",
        provider: "example",
      },
      {
        env: {},
        envPath: "D:/tmp/.ohbaby-agent/.env",
        modelJsonPath: "D:/tmp/.ohbaby-agent/model.json",
      },
    ),
  ).rejects.toMatchObject({ code: "MISSING_API_KEY" });
});
```

- [ ] **Step 2: Run writer tests and confirm failure**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/config/llm/__tests__/writer.test.ts
```

Expected: fail because `writer.ts` and `setActiveLLMConfig` do not exist.

- [ ] **Step 3: Add write types**

Add to `types.ts`:

```typescript
export interface SetActiveLLMConfigInput {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly apiKey?: string;
}

export interface SetActiveLLMConfigOptions {
  readonly modelJsonPath?: string;
  readonly envPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly projectDirectory?: string;
}

export interface SetActiveLLMConfigResult {
  readonly config: LLMConfig;
  readonly modelJsonPath: string;
  readonly envPath: string;
  readonly wroteApiKey: boolean;
}
```

Extend `LLMConfig`:

```typescript
readonly apiKeyEnv: string;
```

Extend `ConfigErrorCode`:

```typescript
| "WRITE_FAILED"
```

- [ ] **Step 4: Add path and atomic write helpers**

In `loaders.ts`, expose path helpers and write helper:

```typescript
export interface LoadModelJsonOptions {
  readonly modelJsonPath?: string;
}

export interface LoadApiKeyOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly envPath?: string;
}

export function getGlobalEnvPath(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, CONFIG_DIR_NAME, ".env");
}

export async function loadModelJson(
  options: LoadModelJsonOptions = {},
): Promise<unknown> {
  const configPath = options.modelJsonPath ?? getModelJsonPath();
  // keep existing read/parse/error behavior, but use configPath
}

export async function loadApiKey(
  envVarName: string,
  options: LoadApiKeyOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const fromEnv = env[envVarName];
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  if (!options.envPath) {
    return undefined;
  }
  const parsed = await loadDotenvFile(options.envPath);
  return parsed[envVarName];
}

export async function writeTextFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${String(process.pid)}.${String(Date.now())}.tmp`,
  );
  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, filePath);
}
```

Implement `loadDotenvFile(envPath)` in the same file with `dotenv.parse`. If the env file is absent, return `{}`. If it exists but cannot be read or parsed, throw `ConfigError` with `LOAD_FAILED`.

- [ ] **Step 5: Implement `writer.ts` as focused file I/O**

`writer.ts` must not import `index.ts`, because `index.ts` re-exports the writer-facing public API. Keep this file focused on validation and file writes:

```typescript
import { parse as parseDotenv } from "dotenv";
import { ConfigError, type ModelJsonConfig, type SetActiveLLMConfigInput, type SetActiveLLMConfigOptions } from "./types.js";
import { getGlobalEnvPath, getModelJsonPath, writeTextFileAtomic } from "./loaders.js";
import { validateApiKey, validateModelJson } from "./validation.js";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ActiveLLMConfigWriteResult {
  readonly envPath: string;
  readonly modelJson: ModelJsonConfig;
  readonly modelJsonPath: string;
  readonly wroteApiKey: boolean;
}

export async function writeActiveLLMConfigFiles(
  input: SetActiveLLMConfigInput,
  options: SetActiveLLMConfigOptions = {},
): Promise<ActiveLLMConfigWriteResult> {
  const provider = requireNonEmpty(input.provider, "provider");
  const model = requireNonEmpty(input.model, "model");
  const baseUrl = requireNonEmpty(input.baseUrl, "baseUrl");
  const apiKeyEnv = requireEnvName(input.apiKeyEnv);
  const env = options.env ?? process.env;
  const modelJsonPath = options.modelJsonPath ?? getModelJsonPath();
  const envPath = options.envPath ?? getGlobalEnvPath();

  const apiKey =
    input.apiKey ?? env[apiKeyEnv] ?? (await readEnvValue(envPath, apiKeyEnv));
  validateApiKey(apiKey, apiKeyEnv);

  const current = await loadModelJsonFromPath(modelJsonPath);
  validateModelJson(current);
  const next: ModelJsonConfig = {
    ...current,
    provider,
    defaultModel: model,
    apiConfig: {
      ...current.apiConfig,
      apiKeyEnv,
      baseUrl,
    },
  };
  validateModelJson(next);

  if (input.apiKey !== undefined) {
    await writeEnvKey(envPath, apiKeyEnv, input.apiKey);
  }
  await writeTextFileAtomic(modelJsonPath, `${JSON.stringify(next, null, 2)}\n`);

  if (input.apiKey !== undefined) {
    env[apiKeyEnv] = input.apiKey;
  }

  return {
    envPath,
    modelJson: next,
    modelJsonPath,
    wroteApiKey: input.apiKey !== undefined,
  };
}
```

In the same file, implement `requireNonEmpty`, `requireEnvName`, `loadModelJsonFromPath`, `readEnvValue`, and `writeEnvKey`. `writeEnvKey` must preserve unrelated keys and format the updated value as a double-quoted dotenv value with backslash, quote, carriage-return, and newline escaping.

- [ ] **Step 6: Add manager-level public switching flow**

Add `setActive()` to `LLMConfigManager`. It calls `writeActiveLLMConfigFiles()`, clears the cache, then reloads through the same manager instance. Extend `LLMConfigLoadOptions` with testable path/env overrides:

```typescript
export interface LLMConfigLoadOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly envPath?: string;
  readonly modelJsonPath?: string;
  readonly projectDirectory?: string;
}
```

`performLoad()` must call:

```typescript
const rawConfig = await loadModelJson({ modelJsonPath: options.modelJsonPath });
const apiKey = await loadApiKey(apiKeyEnvName, {
  env: options.env,
  envPath: options.envPath ?? getGlobalEnvPath(),
});
```

The cache key must include `projectDirectory`, resolved `modelJsonPath`, resolved `envPath`, and whether a custom `env` object was supplied. Do not cache custom-env loads if that keeps the code simpler and safer for tests.

The public API must be:

```typescript
export async function setActiveLLMConfig(
  input: SetActiveLLMConfigInput,
  options: SetActiveLLMConfigOptions = {},
): Promise<SetActiveLLMConfigResult> {
  return LLMConfigManager.getInstance().setActive(input, options);
}
```

`setActive()` returns:

```typescript
return {
  config: await this.reload({
    env: options.env,
    envPath: writeResult.envPath,
    modelJsonPath: writeResult.modelJsonPath,
    projectDirectory: options.projectDirectory,
  }),
  envPath: writeResult.envPath,
  modelJsonPath: writeResult.modelJsonPath,
  wroteApiKey: writeResult.wroteApiKey,
};
```

- [ ] **Step 7: Run config tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/config/llm/__tests__/writer.test.ts packages/ohbaby-agent/src/config/llm/__tests__/manager.test.ts packages/ohbaby-agent/src/config/llm/__tests__/loaders.test.ts
```

Expected: all selected config tests pass.

- [ ] **Step 8: Commit config write API**

```powershell
git add packages/ohbaby-agent/src/config/llm
git commit -m "feat(config): support single active llm config switching"
```

## Task 5: Wire Single Active Model Provider Into UI Adapter

**Files:**

- Modify: `packages/ohbaby-sdk/src/client.ts`
- Modify: `packages/ohbaby-agent/src/commands/types.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-persistent.ts`
- Modify: `packages/ohbaby-agent/src/core/llm-client/types.ts`
- Modify: `packages/ohbaby-agent/src/core/llm-client/client.ts`
- Test: `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`
- Test: `packages/ohbaby-agent/src/commands/service.unit.test.ts`
- Test: `packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Add an adapter-level test that creates the in-process backend with a fake `createLLMClient`, then invokes the model provider through `/models` and asserts baseUrl/apiKeyEnv are visible in the output. Add a separate direct provider test if the current contract harness exposes command provider options.

Expected output shape:

```typescript
expect(lastCommandOutput).toMatchObject({
  kind: "data",
  subject: "models.current",
  data: {
    current: {
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1",
      provider: "openai",
    },
    switching: {
      mode: "single-active-config",
      available: true,
    },
  },
});
```

Add a direct client-method test for switching:

```typescript
await expect(
  client.setActiveModelConfig({
    apiKey: "sk-test",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    provider: "deepseek",
  }),
).resolves.toMatchObject({
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  provider: "deepseek",
});
```

- [ ] **Step 2: Extend command model types**

Use this type shape:

```typescript
export interface CommandModelSummary {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly active?: boolean;
}

export interface CommandModelSwitchInput {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly apiKey?: string;
}

export interface CommandModelProvider {
  listModels(): Promise<readonly CommandModelSummary[]> | readonly CommandModelSummary[];
  currentModel(): Promise<CommandModelSummary | null> | CommandModelSummary | null;
  switchModel?(input: CommandModelSwitchInput): Promise<CommandModelSummary> | CommandModelSummary;
}
```

Use `UiModelSummary` and `UiSetActiveModelConfigInput` from SDK where possible so TUI/client contracts and command provider contracts do not drift.

- [ ] **Step 3: Include baseUrl/apiKeyEnv in current model summaries**

In `ui-inprocess.ts`, return:

```typescript
return {
  active: true,
  apiKeyEnv: client.config.apiKeyEnv,
  baseUrl: client.config.baseUrl,
  id: `${client.config.provider}:${client.config.model}`,
  label: client.config.model,
  model: client.config.model,
  provider: client.config.provider,
};
```

Also map `client.config.modelProfiles` into `listModelsFromOptions()` so `/models` can show configured profiles:

```typescript
const current = await currentModelFromOptions();
const client = options.llmClient ?? (await resolveLLMClient());
const profiles = client.config.modelProfiles ?? [];
const profileSummaries = profiles.map((profile) => ({
  active:
    profile.provider === client.config.provider &&
    profile.model === client.config.model,
  apiKeyEnv: client.config.apiKeyEnv,
  baseUrl: client.config.baseUrl,
  id:
    profile.id ??
    `${profile.provider ?? client.config.provider}:${profile.model}`,
  label: profile.label ?? profile.model,
  model: profile.model,
  provider: profile.provider ?? client.config.provider,
}));
return dedupeModelSummaries([...(current ? [current] : []), ...profileSummaries]);
```

- [ ] **Step 4: Add `switchModel` provider wiring**

Inside the `models` provider passed to `createCommandService`, add:

```typescript
async function switchModelFromInput(
  input: CommandModelSwitchInput,
): Promise<CommandModelSummary> {
  if (promptInFlight) {
    throw new Error("Cannot switch models while a prompt is running");
  }
  if (options.llmClient) {
    throw new Error("Cannot switch models when a fixed test llmClient is injected");
  }
  await setActiveLLMConfig(input);
  runtimePromise = undefined;
  const current = await currentModelFromOptions();
  if (!current) {
    throw new Error("Model switch completed but no active model could be loaded");
  }
  return current;
}

const commandModelProvider: CommandModelProvider = {
  currentModel: currentModelFromOptions,
  listModels: listModelsFromOptions,
  switchModel: switchModelFromInput,
};
```

Import `setActiveLLMConfig` from `../config/llm/index.js`.

Expose the SDK client call path in the returned `UiBackendClient`:

```typescript
async setActiveModelConfig(input): Promise<UiModelSummary> {
  return switchModelFromInput(input);
}
```

In `ui-persistent.ts`, forward `setActiveModelConfig(input)` to the wrapped in-process client.

- [ ] **Step 5: Run adapter and command tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts packages/ohbaby-agent/src/commands/service.unit.test.ts packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts
```

Expected: selected tests pass after updating catalog expectations.

- [ ] **Step 6: Commit adapter wiring**

```powershell
git add packages/ohbaby-sdk/src/client.ts packages/ohbaby-agent/src/adapters/ui-inprocess.ts packages/ohbaby-agent/src/adapters/ui-persistent.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts packages/ohbaby-agent/src/commands packages/ohbaby-agent/src/core/llm-client
git commit -m "feat(agent): expose single active model switching contract"
```

## Task 6: TUI Output Formatting And Contract Cleanup

**Files:**

- Modify: `packages/ohbaby-cli/src/tui/store/events.ts`
- Test: `packages/ohbaby-cli/src/tui/store/events.unit.test.ts`
- Modify: `packages/ohbaby-cli/src/tui/app.contract.test.tsx`
- Modify: `docs/ui/views/help-view.md` if visible command hints are asserted there.

- [ ] **Step 1: Update command notice formatting tests**

Where tests expect old `model.current` or `model.list`, switch to `models.current`:

```typescript
expect(formatCommandOutputForNotice({
  kind: "data",
  subject: "models.current",
  data: {
    current: {
      label: "gpt-4.1",
      model: "gpt-4.1",
      provider: "openai",
    },
  },
})).toBe("model: openai/gpt-4.1");
```

- [ ] **Step 2: Update formatter implementation**

Add cases:

```typescript
case "models.current": {
  const current = getRecord(output.data, "current");
  const label = current
    ? (getString(current, "label") ?? getString(current, "model") ?? getString(current, "id"))
    : undefined;
  const provider = current ? getString(current, "provider") : undefined;
  return label && provider ? `model: ${provider}/${label}` : JSON.stringify(output.data);
}
case "models.changed": {
  const current = getRecord(output.data, "current");
  const label = current
    ? (getString(current, "label") ?? getString(current, "model") ?? getString(current, "id"))
    : undefined;
  const provider = current ? getString(current, "provider") : undefined;
  return label && provider ? `model switched: ${provider}/${label}` : JSON.stringify(output.data);
}
case "help": {
  const commands = Array.isArray(output.data.commands) ? output.data.commands.length : 0;
  return commands > 0 ? `commands: ${String(commands)} available` : "commands: none";
}
```

- [ ] **Step 3: Run TUI contract and runtime tests**

Run:

```powershell
pnpm vitest run packages/ohbaby-cli/src/tui/command/runtime.unit.test.ts packages/ohbaby-cli/src/tui/store/events.unit.test.ts packages/ohbaby-cli/src/tui/app.contract.test.tsx
```

Expected: tests pass after replacing old command IDs.

- [ ] **Step 4: Commit TUI cleanup**

```powershell
git add packages/ohbaby-cli/src/tui
git commit -m "fix(cli): render updated command outputs"
```

## Task 7: Documentation And Drift Cleanup

**Files:**

- Modify: `docs/superpowers/specs/2026-05-31-cli-commands-boundary-design.md`
- Modify: `docs/problem-lists/2026-05-31-model-center-and-llm-config.md`
- Modify: `docs/commands/improve-1/05-slash-command-catalog.md` only if the user wants the draft improve docs updated in the same branch.

- [ ] **Step 1: Search for stale command names in touched docs and tests**

Run:

```powershell
rg -n '"/model|`/model|model\\.list|model\\.current|permission\\.default|permission\\.full-access|"/session|`/session|session\\.new|session\\.compact|session\\.resume' docs packages
```

Expected: matches remain only in historical docs, tests explicitly asserting removal, or problem-list context.

- [ ] **Step 2: Update active docs only**

Keep historical docs untouched unless they are active acceptance docs for this branch. For active docs, use this wording:

```markdown
`/models` is the single active model entry. It displays the current OpenAI-compatible provider/baseUrl/apiKeyEnv/model tuple and exposes a backend switching contract. Full TUI credential forms and multi-provider CRUD remain outside this branch.
```

- [ ] **Step 3: Commit docs**

```powershell
git add docs/superpowers/specs/2026-05-31-cli-commands-boundary-design.md docs/problem-lists/2026-05-31-model-center-and-llm-config.md
git commit -m "docs: clarify single active model switching scope"
```

## Task 8: Final Verification

**Files:**

- No source edits in this task unless verification finds a concrete failure.

- [ ] **Step 1: Run focused suites**

Run:

```powershell
pnpm vitest run packages/ohbaby-sdk/src/command/parse.unit.test.ts packages/ohbaby-sdk/src/command/resolve.unit.test.ts packages/ohbaby-cli/src/tui/command/runtime.unit.test.ts packages/ohbaby-cli/src/tui/store/events.unit.test.ts packages/ohbaby-agent/src/commands/catalog.unit.test.ts packages/ohbaby-agent/src/commands/service.unit.test.ts packages/ohbaby-agent/src/config/llm/__tests__/writer.test.ts packages/ohbaby-agent/src/config/llm/__tests__/manager.test.ts packages/ohbaby-agent/src/config/llm/__tests__/integration.test.ts packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
```

Expected: all selected suites pass.

- [ ] **Step 2: Run broader checks**

Run:

```powershell
pnpm run lint
pnpm run typecheck
pnpm run test:unit
```

Expected: no lint errors, typecheck passes, unit tests pass. Existing warnings may remain if they predate this branch and are unrelated.

- [ ] **Step 3: Build packages**

Run:

```powershell
pnpm run build
```

Expected: workspace packages build successfully.

- [ ] **Step 4: Request code review**

Use `superpowers:requesting-code-review` against the branch diff:

```powershell
$base = git merge-base HEAD mvp
$head = git rev-parse HEAD
```

Reviewer context:

```markdown
Implemented commands branch only:
- SDK slash resolver authority.
- Confirmed v2 builtin command catalog.
- `/models` single active model display and switching backend contract.
- Single active LLM config write API using model.json plus optional ~/.ohbaby-agent/.env API key persistence.
- TUI runtime delegates to SDK resolver.

Out of scope:
- CLI bin migration.
- yargs startup parser.
- Full TUI credential form.
- Multi-provider provider-centric schema.
```

- [ ] **Step 5: Fix review findings before user acceptance**

Critical and important findings must be fixed in the branch. Minor findings can be documented if they are unrelated to this branch.

- [ ] **Step 6: Prepare acceptance summary**

Summarize:

- Branch name.
- Commits.
- Behavior changes.
- Verification commands and results.
- Any deferred Model Center items that remain in `docs/problem-lists/`.
