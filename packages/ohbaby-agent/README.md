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

Most users should install the CLI package:

```bash
npm install -g ohbaby-cli
ohbaby
```

Development remains in the pnpm workspace, while this package is published so
the CLI can resolve the backend runtime from npm.
