<p align="center">
  <img src="assets/images/logo.png" alt="ohbaby-agent" width="150">
</p>

<p align="center">An open-source AI coding agent. The MVP interface is a CLI/TUI for your terminal.</p>

<p align="center">
  <a href="https://github.com/diverHansun/ohbaby-agent/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/diverHansun/ohbaby-agent/ci.yml?style=flat-square&label=CI&logo=github"></a>
  <a href="https://www.npmjs.com/package/ohbaby-cli"><img alt="npm" src="https://img.shields.io/npm/v/ohbaby-cli?style=flat-square&color=cb3837&logo=npm"></a>
  <a href="https://www.npmjs.com/package/ohbaby-cli"><img alt="downloads" src="https://img.shields.io/npm/dm/ohbaby-cli?style=flat-square&color=cb3837"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
  <img alt="node" src="https://img.shields.io/node/v/ohbaby-cli?style=flat-square&color=339933&logo=node.js">
  <img alt="typescript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <img src="assets/images/dashboard.png" alt="ohbaby-agent CLI/TUI" width="760">
</p>

---

**ohbaby-agent** is an open-source AI coding agent. In the current MVP, users interact
with it through a fast [Ink](https://github.com/vadimdemedes/ink)-based CLI/TUI, installed
from npm as `ohbaby-cli` and launched with the `ohbaby` command. The runtime and SDK are
kept separate so future web and app interfaces can adapt to the same agent core.

Bring your own API key from any OpenAI-compatible or Anthropic provider and start coding.

## ✨ Features

- **🤖 Provider-agnostic** — OpenAI, Anthropic/Claude, and any OpenAI-compatible
  endpoint (Zhipu/GLM, DeepSeek, Qwen/DashScope, and more). Your keys, your models.
- **🧩 MCP support** — connect [Model Context Protocol](https://modelcontextprotocol.io)
  servers so their tools, resources, and prompts become available to the agent.
- **🛠️ Skills** — extend ohbaby-agent with reusable skills that show up as slash commands.
- **🧰 Built-in tools** — file read/edit, shell execution, web search, and todo
  management, all behind a permission layer.
- **👥 Subagents** — delegate complex, multi-step work to focused subagents.
- **💬 CLI/TUI interface** — slash commands, session history, model switching, and live
  streaming output in the MVP.
- **🔐 Policy modes & permissions** — `auto` / `default` modes with explicit prompts
  before risky actions.

## 📦 Installation

Requires **Node.js >= 24**. Install the MVP CLI package:

```bash
npm install -g ohbaby-cli
```

This installs the `ohbaby` command globally.

## 🚀 Quick Start

**1. Launch the ohbaby-agent CLI/TUI:**

```bash
ohbaby
```

**2. Connect a model.** In the CLI/TUI, type `/connect` to open the provider setup panel,
fill in your provider, base URL, API key, and model name, then save.

<p align="center">
  <img src="assets/images/connect-providers.png" alt="ohbaby-agent /connect provider setup" width="760">
</p>

| Field | Description |
| --- | --- |
| Provider | `openai`, `anthropic` / `claude`, `zhipu`, … |
| Base URL | The SDK base URL (no `/chat/completions` suffix) |
| API key env | Environment variable that holds the key (e.g. `OPENAI_API_KEY`) |
| API key value | The key itself |
| Model name | e.g. `gpt-4.1`, `glm-5.1`, or your provider's model id |
| Context window / Max output tokens | Optional |

**3. Start coding.** That's it — describe what you want and ohbaby-agent gets to work.

## 🔍 Web Search (optional)

To enable the web search tool, get a free API key from
[Tavily](https://tavily.com) and add it to a `.env` file in either location:

- `~/.ohbaby-agent/.env` (global), or
- `<your-project>/.env` (project)

```dotenv
TAVILY_API_KEY=tvly-...
```

Shell environment variables take precedence over the project `.env`, which takes
precedence over the global one.

## 🧩 MCP & Skills

MCP servers can be configured globally or per project under `.ohbaby-agent/mcp/`.
Skills are discovered from ohbaby-agent-compatible skill directories and exposed as slash
commands. Use `/mcps` to inspect connected MCP servers and `/skills` to list available
skills.

## 📚 Documentation

Module designs, implementation notes, and problem lists live under [`docs/`](docs/).

Agent-recognized memory files (highest priority first): `OHBABY.md`, `AGENTS.md`, `CLAUDE.md`.

## 🛠️ Development

```bash
git clone https://github.com/diverHansun/ohbaby-agent.git
cd ohbaby-agent
pnpm install
pnpm build
pnpm start            # run the built CLI
pnpm test             # run tests
pnpm preflight        # format + lint + typecheck + test + build
```

The repo is a pnpm workspace with three published packages:

- **`ohbaby-cli`** — the MVP CLI/TUI package that installs the `ohbaby` command.
- **`ohbaby-agent`** — the backend runtime: adapters, tools, sessions, policy, MCP, skills.
- **`ohbaby-sdk`** — stable TypeScript contracts shared between the runtime and interfaces
  such as the current CLI/TUI and future web/app adapters.

Reference repositories checked out alongside the code (`claude-code/`, `opencode/`,
`DeepSeek-TUI/`, `deer-flow/`) are for design comparison only — they are not project
source and are never included in npm artifacts.

## 📄 License

[MIT](./LICENSE)
