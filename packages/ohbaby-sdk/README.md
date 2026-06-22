# ohbaby-sdk

Shared TypeScript contracts for the ohbaby-agent runtime and user interfaces.

This package owns:

- `UiBackendClient`, snapshots, events, permissions, and interactions
- slash command parsing and resolution helpers
- web-safe slash passthrough allowlist/filter helpers shared by server and browser adapters
- stable DTOs shared by `ohbaby-agent` and the current `ohbaby-cli` interface

It has no runtime workspace dependency. It is part of the npm-facing package graph so
`ohbaby-agent`, the current CLI/TUI, and future web/app adapters can share contracts
cleanly.

Most users should install the MVP CLI package:

```bash
npm install -g ohbaby-cli
ohbaby
```
