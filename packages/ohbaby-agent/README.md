# ohbaby-agent

User-facing CLI and backend runtime package for Ohbaby Agent.

This package owns:

- the `ohbaby` binary entrypoint
- CLI argument routing for interactive TUI and one-shot prompt modes
- persistent local backend composition
- runtime adapters, built-in tools, sessions, policy, permissions, and provider
  wiring

It depends on `ohbaby-sdk` for frontend/backend contracts and `ohbaby-tui` for
the default terminal frontend.

Development remains in the pnpm workspace. The intended public install command
is `npm install -g ohbaby-agent`, but the project should wait until the MCP phase
lands before the formal npm release.
