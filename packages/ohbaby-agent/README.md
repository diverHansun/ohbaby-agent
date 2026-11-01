<p align="center">
  <img src="https://raw.githubusercontent.com/diverHansun/ohbaby-agent/v0.1.17/assets/images/lychee-logo.png" alt="ohbaby-agent" width="120">
</p>

# ohbaby-agent

Backend runtime package for ohbaby-agent.

This package owns:

- persistent local backend composition
- command execution recording in `src/host/command-record.ts`, alongside the
  command gateway and structured recorder
- runtime adapters, built-in tools, sessions, policy, permissions, and provider
  wiring
- the `buildCoreAPIImpl` host factory consumed by the current CLI/TUI interface

It depends on `ohbaby-sdk` for runtime/interface contracts and `ohbaby-llm` for
provider-neutral model clients. Both the CLI/TUI and bundled web UI in `ohbaby-cli`
use this backend runtime.

Most users should install `ohbaby-cli`, which includes both the terminal and web interfaces:

```bash
npm install -g ohbaby-cli
ohbaby
```

Development remains in the pnpm workspace, while this package is published so
the CLI can resolve the backend runtime from npm.

Shell analysis migration: the synchronous `parseCommand` and lightweight parser
exports have been removed. Use async `analyzeShellCommand(command, shellKind)`
and its `completeness` result. Default Windows execution now selects PowerShell;
Git Bash requires an explicit available native path. Incomplete commands require
one-time approval under the default permission level and cannot be remembered.

Command recording helpers remain internal. The package root exports only the
`UiCommandCorrelation`, `UiCommandRecord`, and `UiCommandRecorder` types from
that module for the server. The colocated `command-record.unit.test.ts` preserves
the recording behavior and redaction assertions; gateway, recorder, core API,
in-process adapter, and server create-app tests cover its composition.
