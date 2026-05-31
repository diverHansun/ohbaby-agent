# ohbaby-agent

Backend runtime package for Ohbaby Agent.

This package owns:

- persistent local backend composition
- runtime adapters, built-in tools, sessions, policy, permissions, and provider
  wiring
- the `buildCoreAPIImpl` host factory consumed by the CLI frontend

It depends on `ohbaby-sdk` for frontend/backend contracts. The user-facing
`ohbaby` binary now lives in `ohbaby-cli`, which imports this package as the
backend runtime.

Development remains in the pnpm workspace. The intended public install command
is `npm install -g ohbaby-cli`, but the project should wait until the MCP phase
lands before the formal npm release.
