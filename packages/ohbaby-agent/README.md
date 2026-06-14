# ohbaby-agent

Backend runtime package for ohbaby-agent.

This package owns:

- persistent local backend composition
- runtime adapters, built-in tools, sessions, policy, permissions, and provider
  wiring
- the `buildCoreAPIImpl` host factory consumed by the current CLI/TUI interface

It depends on `ohbaby-sdk` for runtime/interface contracts. The current MVP user
interface is the CLI/TUI in `ohbaby-cli`, which imports this package as the backend
runtime. Future web or app interfaces can reuse the same runtime boundary.

Most users should install the MVP CLI package:

```bash
npm install -g ohbaby-cli
ohbaby
```

Development remains in the pnpm workspace, while this package is published so
the CLI can resolve the backend runtime from npm.
