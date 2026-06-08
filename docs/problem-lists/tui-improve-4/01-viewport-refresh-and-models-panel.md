# TUI Improve 4: Viewport Refresh and Models Panel

## Scope

This batch closes the high-noise TUI issues observed during live agent runs:

- `/models` overlay copy must avoid implementation-only switching details while remaining ready for future `/connect` model switching.
- Running tool rows must not flicker between gold and purple for the whole label.
- Streaming assistant output must reduce full-screen refresh pressure without breaking Windows Terminal native scrollback.

Display command cards such as `/status`, `/help`, `/mcps`, `/models`, and the future `/connect` card continue to use OverlayCard. Rich switch interaction for multiple model configs remains part of the connect-command model-switch work.

## Decisions

### `/models` Overlay

The card is split into two sections:

- `Models (current)`: current effective model fields.
- `Models (switch)`: selector-ready list for future multi-model switching.

The `Switching unavailable · single-active-config` row is intentionally hidden. It is a backend/config implementation detail, not useful product UI in the single-active-config phase.

### Running Tool Rows

The spinner owns only the animated glyph. Tool name and arguments are rendered with stable segments:

- tool name: low-brightness gold token
- tool argument/summary: dim text token

The spinner palette is reduced to a stable gold token to avoid gold/purple flashing in Windows Terminal.

### Transcript Scrollback

Transcript rendering stays on terminal-native scrollback:

- committed messages continue through `CommittedTranscript`, which can use Ink `<Static>` on Windows TTYs
- command notices, live tail, and UI notices remain separate lanes in chronological order
- the TUI does not intercept PageUp/PageDown/Home/End for transcript scrolling
- the terminal owns the scrollbar, mouse wheel, and scrollback buffer
- a managed virtual viewport is deferred until the renderer can support mouse/scroll interaction without hiding terminal history

The stream coalescer default flush cadence is 50ms. Non-delta events still flush pending deltas immediately so tool completion, permission, and command result state stay responsive.

## Acceptance

- `/models` shows `Models (current)` and `Models (switch)`, and does not show `Switching` or `single-active-config`.
- Running tool labels keep stable tool-name and argument colors outside the spinner glyph.
- Committed history is not clipped by an internal viewport; Windows Terminal can show its native scrollbar and mouse-wheel history.
- Submitted user prompts keep visible spacing before the following assistant output.
- Targeted TUI unit and contract tests pass before wider verification.
