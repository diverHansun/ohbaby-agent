# TUI Application Scenarios Review

Date: 2026-05-21

## Scope

This report reviews the current TUI behavior and its related backend data flow:

- Tool rendering for builtin tools and network tools.
- Tool success, failure, rejected, cancelled, and error states.
- Permission and HITL rendering.
- Slash command registration, execution, and TUI state changes.
- Policy mode rendering.
- Real API streaming token rendering.
- Session switching, persistence, and recovery.
- Project root selection and whether the `project` module is actually used in runtime paths.

No production code was changed while preparing this report.

## Current Behavior

### Tool Rendering

TUI renders tool calls and tool results as message parts:

- `tool-call`: `tool <name> (<running|completed|failed>)`
- `tool-result`: `tool result <callId>` plus either `output:` or `error:`
- Inputs and outputs are truncated to 180 characters in `packages/ohbaby-cli/src/tui/components/message/parts/tool-part.tsx`.

This is readable for small tool results, but it still exposes a slice of raw output in the main transcript. For `web_search`, `web_fetch`, `read`, `grep`, and `bash`, even 180 characters can expose content the user did not ask to pin in the TUI.

### Permission Rendering

Permission requests are rendered as a blocking dialog:

- Title: `Permission: <title>`
- Description
- Choices with a `>` marker
- Default selection prefers deny/abort.

Keyboard behavior exists but is mostly implicit:

- Arrow keys or Tab change selection.
- Enter confirms the selected choice.
- Esc chooses the safe default.
- Ctrl+C is handled at the app layer to abort the run.

### Policy Rendering

Policy mode currently appears in the bottom status bar:

`status: idle | session: session_1 | mode: agent/ask-before-edit`

The mode is visible, but it is not directly under the input box as requested. Slash `/mode` commands also emit JSON-like command notices into the message area, which makes mode feedback feel more like debug output than UI state.

### Commands

Command catalog and command handlers are coupled unevenly:

- `extraCommands` can be added to the catalog.
- Execution handlers are builtin-only.
- An extra command can appear in completion but fail as `COMMAND_NOT_FOUND`.

Command results are rendered as global command notices in the message list. They are not scoped to the active session and are not truncated.

### Streaming

The TUI already handles streaming `message.part.delta` and has tests for avoiding duplicated text. Real provider smoke and real TUI + real `bash` tool e2e both passed in the previous round.

### Sessions

Persistent sessions restore messages and can be switched with `/resume --session_id <id>`. However, command notices are global and survive session replacement, so old command output can visually leak into the new session view.

### Project Root

The `project` module is used when persistent sessions are created, but runtime execution still mostly uses the backend `workdir/projectDirectory/process.cwd()`:

- Session records store `projectRoot`.
- `UiSession` drops `projectRoot`.
- Resuming a session restores messages, but the next prompt may run with the current backend workdir instead of the session's original project root.

This affects tool cwd, sandbox root, context assembly, memory lookup, and model config loading.

## Findings

### P0 / Correctness

1. Restored sessions do not use their own saved `projectRoot`.

   Impact: after `/resume`, tools and context may run against the current startup directory instead of the session's project. This is the biggest data-flow correctness issue.

2. Initial project root is not unified through the `project` module.

   Impact: CLI/TUI startup cwd, session project metadata, context project root, and tool sandbox root can diverge.

3. Active session state is global, not project-scoped.

   Impact: in multi-project use, the TUI can restore or list recent sessions from another project.

### P1 / UX and State Trust

4. Permission resolution can briefly show `idle` while the run is still continuing.

   Impact: after the user approves a tool, the status bar may become misleading until the next run/tool event arrives.

5. Initial snapshot can overwrite already-arrived events.

   Impact: on startup or reconnect, async `getSnapshot()` may replace newer local message/run/policy increments with an older snapshot.

6. Tool results expose raw output in the main transcript.

   Impact: network, read, grep, and bash outputs may clutter the TUI or reveal content that should stay in model context but not be displayed permanently.

7. Policy mode is visible but not placed where requested.

   Impact: the mode is in the footer/status bar, not directly under the input box. Mode command notices also add noisy JSON-like output.

8. Command notices are not session-scoped and are not truncated.

   Impact: `/tools`, `/mode`, `/resume`, or future large command outputs can pollute the message list across sessions.

### P2 / Extensibility and Fidelity

9. Extra command registration is incomplete.

   Impact: commands can be registered into the catalog without an execution handler.

10. Tool failure states are compressed into `failed`.

   Impact: `policy denied`, `permission rejected`, `cancelled`, `timeout`, and `execution error` are not visually distinct enough.

11. Stream gaps are not surfaced.

   Impact: `stream.gap` events exist in the stream bridge, but TUI projection ignores them.

12. Permission dialog lacks keyboard hints and choice intent labels.

   Impact: discoverability is weak, especially for first-time HITL operation.

## What Should Be Displayed

### Tool Calls

Recommended default display:

- Tool name.
- Status: `running`, `completed`, `failed`, `rejected`, `cancelled`, `timed out`.
- Small input summary, redacted by tool type.
- Duration if available later.
- Result summary only, not raw output.

Recommended examples:

```text
tool web_search (completed)
  query: "OpenAI Codex CLI"
  result: 5 results available
```

```text
tool read (completed)
  file: packages/ohbaby-agent/src/tools/read.ts
  result: 120 lines read
```

```text
tool bash (failed)
  command: pnpm test
  error: Command timed out after 120000ms
```

Raw output should stay available to the model/backend, but not be rendered in the main TUI by default.

### Permission / HITL

Recommended display:

- Permission title.
- Tool name and risk category.
- Key target: file path, command root, URL/domain, or operation summary.
- Choices with intent labels.
- Keyboard hint line: `Enter select | Tab/Arrows move | Esc safe default | Ctrl+C abort run`.
- Default selection remains deny/abort.

### Policy Mode

Recommended display near the prompt:

```text
mode: agent / ask-before-edit
```

This should be directly below or above the input line, not only in the footer. The footer can keep compact status, but the prompt area should own editing policy visibility.

### Commands

Recommended display:

- Human-readable notices instead of JSON for common commands.
- Truncated output for large command data.
- Command notices scoped to the active session, or cleared on session switch.
- A real handler registration interface if `extraCommands` remains supported.

## Proposed Optimization Plan

### Phase 1: TUI Rendering Policy

Goal: make tool, permission, policy, and command rendering clear without changing deep runtime contracts.

- Hide raw tool result output by default.
- Render tool result summaries by tool type.
- Add explicit status labels for failed/rejected/cancelled/error.
- Add permission keyboard hints and intent labels.
- Move policy mode display into the prompt area.
- Truncate command notices and make `/mode` output human-readable.

Suggested tests:

- Tool result output is not rendered for `web_search`, `read`, and `bash`.
- Tool status shows failed/error clearly in no-color text.
- Permission dialog shows keyboard hints and keeps safe default.
- Policy mode is rendered near the prompt.
- Large command output is truncated.

### Phase 2: TUI State Correctness

Goal: remove misleading state transitions and stale UI artifacts.

- Fix permission-resolved status so the UI returns to `running`, not transient `idle`, while a run continues.
- Guard initial snapshot replacement with event ordering or merge strategy.
- Scope or clear command notices on session switch.
- Consider `command.completed` or local completion state for command lifecycle.

Suggested tests:

- After permission approval, status remains `running` or `waiting` until the tool/run result arrives.
- A stale initial snapshot cannot remove already-rendered streaming tokens or tool status.
- `/resume` clears or scopes old command notices.

### Phase 3: Project and Session Root Semantics

Goal: make `project` the source of truth for startup root and restored session root.

- Resolve startup root through `Project.fromDirectory()` once.
- Pass canonical project root into runtime workdir/sandbox/context/model config.
- Add project metadata to `UiSession` or an internal selected-session lookup so resumed sessions run in their original `projectRoot`.
- Scope active session and session listing by project.

Suggested tests:

- Starting from a subdirectory uses the git project root consistently.
- Resuming a session from another cwd uses that session's stored `projectRoot`.
- `/session` lists current-project sessions by default.
- Active session is persisted per project.

### Phase 4: Command and Stream Extensibility

Goal: make extension points honest and observable.

- Pair `extraCommands` with handler registration, or rename it to catalog-only metadata.
- Surface `stream.gap` as a warning notice.
- Distinguish tool `rejected`, `cancelled`, `timeout`, and `execution error` states when backend data permits.

Suggested tests:

- Extra registered command executes with its handler.
- Missing handler cannot appear as an executable command.
- Stream gap produces a warning notice.

## Recommended Order

Recommended next implementation order:

1. Phase 1 rendering policy.
2. Phase 2 state correctness.
3. Phase 3 project/session root semantics.
4. Phase 4 extension cleanup.

Reasoning: Phase 1 improves daily dogfooding quickly and makes later state tests easier to read. Phase 2 prevents misleading UI state. Phase 3 is deeper and touches persistence/runtime contracts, so it should be planned with tighter tests. Phase 4 can follow once the core behavior is reliable.

## Open Decisions

1. Should raw tool output ever be visible in TUI, or should it always be hidden with a future explicit command/detail view?
2. Should session lists default to current project only, with an explicit global session command later?
3. Should policy mode persist globally, per project, or per session?
4. Should resumed sessions always force their original project root, even if that path no longer exists?
