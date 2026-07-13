# Ohbaby System Prompt E2E Test

## Goal

Verify that the final system prompt sent through the runtime data flow has the expected primary/subagent identity, task contract, tool guidance, environment, and custom-instruction boundaries.

## Scope

This checklist covers the `system-prompt` optimization branch. It validates deterministic prompt assembly first, then uses a real provider API key for end-to-end behavior through the existing TUI smoke harness.

## Data Flow Under Test

```text
User prompt
  -> createInProcessUiBackendClient.submitPrompt
  -> submitPromptInternal
  -> runtime.buildPromptMessages
  -> ContextManager.assemble
  -> createSystemPromptProvider.build
  -> SystemPrompt.assemble
  -> system ChatCompletionMessage
  -> RunManager
  -> Lifecycle
  -> LLM client
```

## Expected Prompt Shape

Primary prompt:

```text
primary base identity
+ primary task contract: plan | agent at runtime; ask remains a static supported template
+ optional agent prompt add-on
+ optional subagent role guidance
+ tool guidance
+ full environment
+ custom instructions
+ memory appended by runtime prompt-context
```

Subagent prompt:

```text
subagent base identity
+ subagent task contract: explore | research | generic
+ optional agent prompt add-on
+ tool guidance
+ minimal environment
```

Subagent prompt must not include:

- primary identity text
- project or global custom instructions
- primary memory injection
- recursive subagent tool permission text

## Deterministic Checks

Run focused prompt tests:

```powershell
pnpm vitest run packages/ohbaby-agent/src/core/system-prompt packages/ohbaby-agent/src/agents/manager.unit.test.ts
```

Expected:

- primary `ask`, `plan`, and `agent` static task contracts remain independently testable
- normal runtime resolves primary prompts to `plan` or `agent`
- subagent `explore`, `research`, and `generic` task contracts appear in assembled prompts
- configured `AgentConfig.prompt` appears inside an add-on block
- configured `AgentConfig.prompt` does not replace default base/task prompt text
- subagent prompts omit custom instructions

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

- the real model creates an `explore` child session through `task`
- the model resumes the same child session
- background `agent_open`, `agent_eval`, `agent_status`, and `agent_close` continue to work
- child workspace-tool execution remains isolated to the child session

## Prompt Format Inspection

Do not print full system prompts during real-provider runs. If a test needs to inspect final prompt format, capture the outgoing system prompt in memory and assert structural markers only:

```typescript
expect(systemPrompt).toContain("<primary_task>");
expect(systemPrompt).toContain("<environment>");
expect(systemPrompt).toContain("<tool_guidance>");
expect(systemPrompt).not.toContain("ZAI_API_KEY");
expect(systemPrompt).not.toMatch(/OPENAI_API_KEY\s*=/);
```

For subagents:

```typescript
expect(systemPrompt).toContain("<subagent_base>");
expect(systemPrompt).toContain("<subagent_task>");
expect(systemPrompt).toContain("<environment>");
expect(systemPrompt).not.toContain("<custom_instructions>");
expect(systemPrompt).not.toContain("You are Lychee");
```

## Final Acceptance

The branch is acceptable only when:

- focused system-prompt tests pass
- AgentManager add-on semantics tests pass
- runtime composition and in-process contract tests pass
- `pnpm run typecheck` passes
- `pnpm test` passes
- real-provider smoke passes, or the final report records that no real key was present in the process environment
- secret scan returns no matches

## Execution Result: 2026-05-25

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
