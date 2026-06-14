# ohbaby-sdk

Shared TypeScript contracts for Ohbaby Agent frontends and runtime adapters.

This package owns:

- `UiBackendClient`, snapshots, events, permissions, and interactions
- slash command parsing and resolution helpers
- stable DTOs shared by `ohbaby-agent` and `ohbaby-cli`

It has no runtime workspace dependency. It is part of the npm-facing package
graph so `ohbaby-agent` and `ohbaby-cli` can resolve cleanly once the project is
published.

Most users should install the CLI package:

```bash
npm install -g ohbaby-cli
ohbaby
```
