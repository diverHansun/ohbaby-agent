# Ohbaby System Prompt E2E Test

## Goal

Verify that the final model request has the expected primary/subagent identity, task contract and custom instructions in its stable system content, with environment and scoped MCP menus in the separate runtime context.

## Scope

This checklist covers the `system-prompt` optimization branch. It validates deterministic prompt assembly first, then uses a real provider API key for end-to-end behavior through the existing TUI smoke harness.

## Data Flow Under Test

```text
User prompt
  -> createInProcessUiBackendClient.submitPrompt
  -> Agent runner / RunManager (projectRoot + execution directory)
  -> Lifecycle
  -> ContextManager.createRunPromptSnapshot
  -> createSystemPromptProvider.build / SystemPrompt.assemble
  -> ContextManager.prepareTurn
  -> PreparedModelRequest
  -> LLM client / protocol adapter
```

## Expected Prompt Shape

Primary prompt:

```text
primary base identity
+ primary task contract: plan | agent
+ optional agent prompt add-on
+ optional subagent role guidance
+ optional global / project instructions (Global -> Project)
```

Subagent prompt:

```text
subagent base identity
+ subagent task contract: explore | research | generic
+ optional agent prompt add-on
+ optional global / project instructions (Global -> Project)
```

Environment and scoped MCP menus are produced separately by `buildRuntimeContext()` and attached to the initiating user model-context part. The environment tag is `<environment_context>`; child runtime uses the minimal form. They are not part of the stable system string.

Subagent prompt must not include:

- primary identity text
- recursive subagent tool permission text

## Deterministic Checks

Run focused prompt tests:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/core/system-prompt packages/ohbaby-agent/src/core/agents/runner.unit.test.ts
```

Expected:

- primary `plan` and `agent` task contracts remain independently testable
- subagent `explore`, `research`, and `generic` task contracts appear in assembled prompts
- configured `AgentConfig.prompt` appears inside an add-on block
- configured `AgentConfig.prompt` does not replace default base/task prompt text
- primary and subagent prompts load optional scoped instructions exactly once; projectRoot selects files and directory describes execution

Run runtime prompt data-flow tests:

```powershell
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
```

Expected:

- `/mode plan` or policy mode `plan` reaches the first system message as `Task: plan`
- `agent` mode reaches the first system message as `Task: agent`
- subagent session prompt uses the resolved child agent name as task kind when it is `explore` or `research`
- generic and unknown subagent names resolve to `Task: generic`

## Real API Key Rules

Use real provider keys only through process environment variables. Do not write keys to:

- repo files
- shell history snippets in docs
- test snapshots
- logs committed to git

Before staging, run:

```powershell
git diff -- . ":(exclude)pnpm-lock.yaml" | rg -n "\bsk-[A-Za-z0-9_-]{20,}|ZAI_API_KEY[=]|ZHIPU_API_KEY[=]|OPENAI_API_KEY[=]|TAVILY_API_KEY[=]"
```

Expected: no matches.

## Real Provider Smoke Commands

The existing real TUI smoke accepts `ZAI_API_KEY` or `ZHIPU_API_KEY`. Run from PowerShell with the key set only for the current process.

Primary real-provider smoke:

```powershell
$env:OHBABY_RUN_REAL_TUI_SMOKE = "1"; $env:ZAI_API_KEY = "<process only>"; pnpm vitest run tests/smoke/tui-real-provider.smoke.test.tsx --testTimeout=360000
```

Expected:

- the rendered TUI submits a real prompt
- the model returns the expected token for the primary response
- the model can call `read` once and return the expected token
- final TUI frame returns to idle

Subagent real-provider smoke:

```powershell
$env:OHBABY_RUN_REAL_TUI_SMOKE = "1"; $env:OHBABY_RUN_REAL_SUBAGENT_SMOKE = "1"; $env:ZAI_API_KEY = "<process only>"; pnpm vitest run tests/smoke/tui-real-provider.smoke.test.tsx --testTimeout=900000
```

Expected:

- the real model creates an `explore` child session through `subagent_run`
- the model resumes the same child session
- `subagent_status` and `subagent_close` continue to work
- child workspace-tool execution remains isolated to the child session

## Prompt Format Inspection

Do not print full system prompts during real-provider runs. If a test needs to inspect final prompt format, capture the outgoing system prompt in memory and assert structural markers only:

```typescript
expect(systemPrompt).toContain("<primary_task>");
expect(systemPrompt).not.toContain("<environment_context>");
expect(systemPrompt).not.toContain("<tool_guidance>");
expect(systemPrompt).not.toContain("ZAI_API_KEY");
expect(systemPrompt).not.toMatch(/OPENAI_API_KEY\s*=/);
```

Inspect the initiating user model-context part separately for `<environment_context>`. When an admitted MCP tool remains unloaded, assert that runtime menu contains its exact local name and fixed instructions, but not its server-supplied description or schema.

For subagents:

```typescript
expect(systemPrompt).toContain("<subagent_base>");
expect(systemPrompt).toContain("<subagent_task>");
expect(systemPrompt).not.toContain("<environment_context>");
// With safe instruction files in the isolated project/global fixture:
expect(systemPrompt).toContain("<custom_instructions>");
expect(systemPrompt).not.toContain("You are Lychee");
```

## Final Acceptance

The branch is acceptable only when:

- focused system-prompt tests pass
- AgentManager add-on semantics tests pass
- runtime composition and in-process contract tests pass
- `pnpm run typecheck` passes
- `pnpm test` passes
- the final report distinguishes deterministic wire checks from real-model behavior; if real-provider smoke is not run, record that limitation explicitly
- secret scan returns no matches

## Execution Result: 2026-05-25 (historical; not evidence for the current change)

Real-provider keys were loaded from the local root `ohbaby-e2e-test.md` file into the test process environment only. No key value was copied into this worktree document, test snapshot, or source file.

Deterministic verification:

- `pnpm run typecheck`: passed
- `pnpm run lint`: passed with 0 errors and 10 existing explicit-return-type warnings
- targeted prompt/runtime suite: 13 files, 107 tests passed
- `pnpm test`: 114 files, 811 tests passed, with gated real smoke skipped in the non-real run
- `pnpm run build`: passed

Real-provider E2E verification:

- Primary/TUI smoke with real model: passed
- Real `read` tool smoke: passed
- Real Tavily `web_search` smoke: passed
- Real `task` explore subagent creation and resume smoke: passed
- Real child workspace-tool smoke for `bash`, `read`, `write`, and `edit`: passed

Security note:

- The local root `ohbaby-e2e-test.md` contains real secret material. Keep it out of commits and prefer moving those values to local environment variables or an ignored secret file.
