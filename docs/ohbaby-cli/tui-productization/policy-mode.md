# Policy Mode Surface

## Semantics

The SDK snapshot exposes a `policy` object with two fields:

- `mode`: one of `agent`, `ask`, or `plan`.
- `agentState`: one of `ask-before-edit` or `edit-automatically`.

`agent` is the normal coding mode. Read-only, network, memory, skill, and
subagent tool categories are allowed by policy. Write tools ask for permission
while `agentState` is `ask-before-edit`; write tools are allowed after
`agentState` changes to `edit-automatically`. Dangerous tools continue to ask.

`ask` and `plan` are non-editing modes for this backend contract. They keep
always-allowed categories available and deny write, dangerous, and subagent
categories. Entering either mode resets `agentState` to `ask-before-edit`;
`edit-automatically` is only valid while `mode` is `agent`.

The in-process backend publishes a `policy.updated` SDK event whenever the
mode or agent state actually changes. Repeating the current value is a no-op
and should not publish another event.

## Commands

The command catalog exposes a `/mode` family on all built-in command surfaces:

- `/mode` reports the current policy state.
- `/mode agent` changes `mode` to `agent`.
- `/mode ask` changes `mode` to `ask`.
- `/mode plan` changes `mode` to `plan`.
- `/mode auto-edit` toggles `agentState` between `ask-before-edit` and
  `edit-automatically`. Because automatic edit is only valid in `agent`, this
  command also puts the backend in `agent` mode before toggling when needed.

Command results use data outputs with subject `policy.mode` and the current
policy state. State-changing commands also emit a `policy.mode.updated` action
so UI surfaces can react without parsing display text.

## TUI Surface

The Ink TUI keeps `policy` in local store state and renders it in the status
footer as `mode: <mode>/<agentState>`. Snapshot replacement preserves the
backend policy from the snapshot, while `policy.updated` applies live changes.

`Shift+Tab` cycles policy modes using the existing command path:

- `agent` -> `/mode ask`
- `ask` -> `/mode plan`
- `plan` -> `/mode agent`

The binding is disabled while a permission dialog is active. Plain `Tab`
remains reserved for slash completion.

## Tests

Coverage for this slice is contract-focused plus a small TUI integration path:

- SDK contract tests cover the `UiPolicyState` shape and the `policy.updated`
  event type.
- In-process backend contract tests cover snapshot policy exposure and
  `policy.updated` publication when `/mode` commands mutate state.
- Command service unit tests cover catalog entries plus `/mode`, `/mode ask`,
  `/mode plan`, `/mode agent`, and `/mode auto-edit` outputs/actions.
- TUI store/app tests cover policy rendering, live `policy.updated`, and the
  `Shift+Tab` mode-cycle binding.
- TUI main-chain integration covers slash mode switching plus keyboard mode
  cycling against the real in-process backend.
