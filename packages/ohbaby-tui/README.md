# ohbaby-tui

Ink-based terminal UI package for Ohbaby Agent.

This package owns:

- the `OhbabyTerminalApp` Ink application
- prompt input, slash command menu, dialogs, transcript rendering, and status
  surfaces
- TUI state projection from `ohbaby-sdk` events and snapshots

It does not create backend behavior directly. The user-facing `ohbaby-agent`
package creates a backend client and injects it into this TUI. This package is a
runtime dependency of `ohbaby-agent` in the npm-facing package graph.
