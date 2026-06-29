<p align="center">
  <img src="https://raw.githubusercontent.com/diverHansun/ohbaby-agent/main/assets/images/logo.png" alt="ohbaby-agent" width="150">
</p>

<p align="center">The MVP CLI/TUI package for ohbaby-agent.</p>

<p align="center">
  <a href="https://github.com/diverHansun/ohbaby-agent/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/diverHansun/ohbaby-agent/ci.yml?style=flat-square&label=CI&logo=github"></a>
  <a href="https://www.npmjs.com/package/ohbaby-cli"><img alt="npm" src="https://img.shields.io/npm/v/ohbaby-cli?style=flat-square&color=cb3837&logo=npm"></a>
  <a href="https://github.com/diverHansun/ohbaby-agent/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D24-339933?style=flat-square&logo=node.js">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/diverHansun/ohbaby-agent/main/assets/images/dashboard.png" alt="ohbaby-agent CLI/TUI" width="760">
</p>

---

**ohbaby-agent** is a provider-agnostic AI coding agent. This package provides its
current MVP interface: a fast [Ink](https://github.com/vadimdemedes/ink)-based CLI/TUI
installed from npm as `ohbaby-cli` and launched with the `ohbaby` command. The same
runtime can support future web or app interfaces.

## Installation

Requires **Node.js >= 24**.

```bash
npm install -g ohbaby-cli
```

This installs the `ohbaby` command globally.

## Quick Start

1. Launch the ohbaby-agent CLI/TUI:

   ```bash
   ohbaby
   ```

2. Type `/connect` in the CLI/TUI to configure your model provider (provider, base URL,
   model name, and optional API key fields), then save. Local keyless endpoints such as
   LM Studio can leave the API key fields blank.

   <p align="center">
     <img src="https://raw.githubusercontent.com/diverHansun/ohbaby-agent/main/assets/images/connect-providers.png" alt="ohbaby-agent /connect provider setup" width="760">
   </p>

3. Start coding.

Supports OpenAI, Anthropic/Claude, and any OpenAI-compatible endpoint (Zhipu/GLM,
DeepSeek, Qwen/DashScope, …).

**Web search (optional):** get a free [Tavily](https://tavily.com) API key and add
`TAVILY_API_KEY=tvly-...` to `~/.ohbaby-agent/.env` or your project's `.env`.

**MCP & Skills:** configure MCP servers globally or per project under `.ohbaby-agent/mcp/`.
Skills are discovered from ohbaby-agent-compatible skill directories and exposed as slash commands.

## Documentation

Full docs, configuration, and source: **https://github.com/diverHansun/ohbaby-agent**
([English](https://github.com/diverHansun/ohbaby-agent/blob/main/README.md) ·
[简体中文](https://github.com/diverHansun/ohbaby-agent/blob/main/README.zh.md))

## License

[MIT](https://github.com/diverHansun/ohbaby-agent/blob/main/LICENSE)
