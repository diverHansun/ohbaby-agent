# ohbaby-agent

An AI coding assistant CLI with a local backend runtime, a shared frontend SDK,
and an Ink-based terminal UI. The current project is focused on making the
local CLI/TUI MVP reliable before opening the larger extension surface.

## MVP Status

The MVP closure target is the local `ohbaby` command:

- `ohbaby-agent`: user-facing CLI and backend runtime composition.
- `ohbaby-sdk`: stable TypeScript contracts between runtime adapters and UI
  frontends.
- `ohbaby-tui`: Ink terminal frontend that controls the backend through the SDK
  client contract.

The current MVP includes local prompt submission, streaming UI projection,
sessions, provider configuration, built-in file/shell/web/todo tools, policy
modes, permission prompts, subagent task plumbing, persistent state, and packed
npm smoke coverage.

MCP, plugins, and skills are intentionally not part of this MVP closure. They
remain planned extension modules. The project should not be formally published
to npm until the MCP phase has landed and the npm-facing package graph has been
verified again.

## Prerequisites

- Node.js >= 24.0.0
- pnpm >= 9.0.0

## Local Setup

```bash
git clone https://github.com/diverHansun/ohbaby-agent.git
cd ohbaby-agent
pnpm install
pnpm build
```

Copy `.env.example` to `.env` and add provider API keys there, or export the
same variables in your shell. Shell variables take priority over `.env`.

Create `~/.ohbaby-agent/model.json` for non-secret model settings:

```json
{
  "provider": "openai",
  "defaultModel": "gpt-4.1",
  "apiConfig": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "llmParams": {
    "temperature": 0.2,
    "maxTokens": 4096
  }
}
```

`model.json` stores provider/model/base URL/parameter settings. API keys stay in
environment variables.

## Running The CLI

Run the built CLI:

```bash
pnpm start
```

When stdin is a TTY and no prompt argument is provided, `pnpm start` opens the
Ink TUI. The TUI creates a persistent local backend client and controls it
through the shared SDK contract.

Run one non-interactive prompt:

```bash
pnpm start -- --prompt "Summarize this project"
```

Show CLI help and version:

```bash
pnpm start -- --help
pnpm start -- --version
```

For direct local testing after `pnpm build`:

```bash
node packages/ohbaby-agent/dist/bin.js --help
node packages/ohbaby-agent/dist/bin.js --version
```

## Provider Base URLs

`apiConfig.baseUrl` is the SDK base URL, not the final REST endpoint. Do not
include paths such as `/chat/completions`, `/messages`, or `/responses`; the
provider SDK appends the operation path.

OpenAI-compatible providers share the same Chat Completions adapter. For
example:

```json
{
  "provider": "zhipu",
  "defaultModel": "glm-5.1",
  "apiConfig": {
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKeyEnv": "ZAI_API_KEY"
  },
  "llmParams": {
    "temperature": 0.7,
    "maxTokens": 128000
  }
}
```

Other OpenAI-compatible vendors follow the same rule, such as Qwen/DashScope
with `https://dashscope.aliyuncs.com/compatible-mode/v1`. Anthropic is the
separate provider path: use `provider: "anthropic"` or `provider: "claude"` and
an Anthropic API base URL such as `https://api.anthropic.com`.

## NPM Packaging Policy

Development stays on the pnpm workspace. The npm-facing package graph is:

- `ohbaby-agent` depends on `ohbaby-tui` and `ohbaby-sdk`.
- `ohbaby-tui` depends on `ohbaby-sdk`.
- `ohbaby-sdk` has no runtime workspace dependency.

After the MCP phase is complete and the project is ready for a public release,
the intended user installation path is:

```bash
npm install -g ohbaby-agent
ohbaby
```

Until then, use local workspace commands for development. To smoke-test the
npm-facing artifacts locally, pack and install all three workspace packages into
a temporary npm global prefix or run the packaging smoke test:

```bash
pnpm exec vitest run tests/integration/cli/packaging-smoke.integration.test.ts --testTimeout=240000
```

The packed smoke verifies that `ohbaby --help` and `ohbaby --version` work after
installing the packed `ohbaby-sdk`, `ohbaby-tui`, and `ohbaby-agent` tarballs.

## Development Commands

```bash
pnpm test
pnpm test:unit
pnpm test:integration
pnpm test:smoke
pnpm typecheck
pnpm lint
pnpm build
pnpm preflight
```

`pnpm dev` currently watches the package library entrypoint. For interactive
TUI dogfooding, prefer `pnpm build` followed by `pnpm start`.

## Project Structure

```text
ohbaby-agent/
  packages/
    ohbaby-agent/     CLI, backend runtime, adapters, tools, sessions, policy
    ohbaby-sdk/       shared UI/backend contracts and command helpers
    ohbaby-tui/       Ink terminal UI frontend
  docs/               module designs, implementation notes, problem lists
  tests/              cross-package integration and smoke tests
  scripts/            workspace test helpers
```

Only the three packages under `packages/` are part of the current product code
surface. Local reference repositories such as `claude-code/`, `opencode/`,
`DeepSeek-TUI/`, `deer-flow/`, and `hermes-agent/` may be checked out beside the
code for design comparison, but they are not project source, are not package
inputs, and must not be included in npm artifacts.

## Documentation

See the `docs/` directory for detailed design documentation:

- [Coding Guide](./coding_guide.md) - development guidelines.
- [Module Documentation](./docs/) - individual module designs.
- [NPM Packaging Smoke](./docs/implementation/tui-productization/npm-packaging.md)
  - current packaging decision and packed install verification.
- [TUI Productization Verification](./docs/implementation/tui-productization/verification.md)
  - verification gates for the MVP closure slice.

Agent-recognized memory entry files:

- `OHBABY.md` (canonical, highest priority)
- `AGENTS.md` (OpenAI Agents/Codex-compatible fallback)
- `CLAUDE.md` (Anthropic Claude-compatible fallback)

## License

MIT
