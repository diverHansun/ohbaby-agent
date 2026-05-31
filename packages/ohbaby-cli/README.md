# ohbaby-cli

CLI frontend package for Ohbaby Agent. It owns the `ohbaby` binary, startup
commands, non-interactive stdout rendering, and the Ink-based TUI under
`src/tui/`.

This package owns:

- the `ohbaby` binary entrypoint
- yargs startup commands under `src/cli/commands/`
- the `OhbabyTerminalApp` Ink application
- prompt input, slash command menu, dialogs, transcript rendering, and status
  surfaces
- TUI state projection from `ohbaby-sdk` events and snapshots

It starts the default local backend through a lazy runtime loader, while
programmatic callers can inject a different `CoreAPI` host. The UI talks to that
backend through the `ohbaby-sdk` `CoreAPI` contract. TUI slash command helpers under `src/tui/slash-commands/` are separate from
yargs startup commands; they handle `/models`, `/sessions`, `/permission`, and
other commands after the TUI has started.
