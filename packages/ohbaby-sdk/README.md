<p align="center">
  <img src="https://raw.githubusercontent.com/diverHansun/ohbaby-agent/v0.1.17/assets/images/lychee-logo.png" alt="ohbaby-agent" width="120">
</p>

# ohbaby-sdk

Shared TypeScript contracts for the ohbaby-agent runtime and user interfaces.

This package owns:

- `UiBackendClient`, snapshots, events, permissions, and interactions
- slash command parsing and resolution helpers
- web-safe slash passthrough allowlist/filter helpers shared by server and browser adapters
- stable DTOs shared by `ohbaby-agent` and the current `ohbaby-cli` interface

It has no runtime workspace dependency. It is part of the npm-facing package graph so
`ohbaby-agent`, the CLI/TUI, and the web UI can share contracts cleanly.

Most users should install `ohbaby-cli`, which includes both the terminal and web interfaces:

```bash
npm install -g ohbaby-cli
ohbaby
```
