# Goal State Contract Simplification

## Decision

`blocked` is no longer a resident goal state. A goal either exists and is
`active`, exists and is `paused`, or does not exist.

`complete` remains a transient model/tool declaration: the store announces the
completion event, appends a clear record, and the next durable snapshot is
`null`.

## State Model

| State | Meaning | Driver behavior | UI visibility |
| --- | --- | --- | --- |
| `active` | The goal exists and GoalDriver may continue it. | Continue driving. | Show. |
| `paused` | The goal exists but will not continue until the user explicitly resumes it. | Stop. | Show. |
| `null` | No current goal exists for the session. | Stop. | Hide. |

Reasons that previously produced `blocked` now produce `paused` with a
`pauseReason`:

- user interruption
- user `/goal pause`
- process resume normalization
- model self-audit says more progress is impossible or requires user input
- configured budget reached
- safety cap reached
- runtime failure

All paused goals share the same recovery path: `/goal resume`.

## Field Naming

`terminalReason` is renamed to `pauseReason` in goal snapshots and UI-facing
contracts. The old name implied a terminal state, but the value is only meaningful
while a goal exists and is paused. Completed and cancelled goals have no resident
snapshot, so they do not expose a reason field.

Persistence replay may still accept old records containing `status: "blocked"`
or `reason` and normalize them to `status: "paused"` plus `pauseReason`. New
records should write `pauseReason`.

## Tool Contract

`UpdateGoal` accepts `active`, `paused`, and `complete`.

- `complete`: the objective is done; clear the goal.
- `paused`: the model cannot usefully continue without user intervention, the
  budget or safety cap stopped the loop, or the goal should otherwise stop.
- `active`: accepted only as an idempotent report that an active goal is already
  active; paused goals are resumed only by the user through `/goal resume`.

The schema should no longer advertise `blocked`.

## CLI And Web Contract

CLI keeps command-style control through `/goal`.

Web also uses `/goal`, but on the Web surface `/goal...` opens the Goal panel
instead of directly executing lifecycle subcommands. Arguments are interpreted as
panel intent:

- `/goal` opens the panel.
- `/goal <objective>` opens the panel with the create field prefilled.
- `/goal pause`, `/goal resume`, `/goal cancel`, and `/goal replace <objective>`
  open the panel and highlight/prefill the matching action.

The actual CLI/Web visual implementation is deferred. This document only defines
the backend and SDK contract they will consume.
