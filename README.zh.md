<p align="center">
  <img src="assets/images/logo.png" alt="ohbaby" width="150">
</p>

<p align="center">一个跑在终端里的开源 AI 编程 Agent。</p>

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
  <img src="assets/images/dashboard.png" alt="ohbaby 终端界面" width="760">
</p>

---

**ohbaby** 是一个住在终端里的 AI 编程 Agent。它不绑定任何模型厂商，可以通过
[MCP](https://modelcontextprotocol.io) server 和即插即用的 skills 扩展，并自带一个
基于 [Ink](https://github.com/vadimdemedes/ink) 的高性能终端 UI。带上你自己的
OpenAI 兼容或 Anthropic API Key，就能开始编码。

## ✨ 特性

- **🤖 不绑定厂商** —— 支持 OpenAI、Anthropic/Claude，以及任意 OpenAI 兼容端点
  （智谱/GLM、DeepSeek、通义千问/DashScope 等）。你的 Key，你的模型。
- **🧩 MCP 支持** —— 接入 [Model Context Protocol](https://modelcontextprotocol.io)
  server，它们的工具、资源、prompt 会自动暴露给 Agent。
- **🛠️ Skills** —— 用可复用的 skill 扩展 ohbaby，它们会作为 slash 命令出现。
- **🧰 内置工具** —— 文件读写、Shell 执行、Web 搜索、待办管理，全部经过权限层。
- **👥 子 Agent** —— 把复杂的多步任务委派给专注的子 Agent。
- **💬 交互式 TUI** —— slash 命令、会话历史、模型切换、实时流式输出。
- **🔐 策略模式与权限** —— `auto` / `default` 模式，危险操作前显式确认。

## 📦 安装

需要 **Node.js >= 24**。

```bash
npm install -g ohbaby-cli
```

安装后会得到全局 `ohbaby` 命令。

## 🚀 快速开始

**1. 启动 ohbaby：**

```bash
ohbaby
```

**2. 配置模型。** 在 TUI 里输入 `/connect` 打开 provider 配置面板，填入 provider、
base URL、API Key、模型名后保存即可。

<p align="center">
  <img src="assets/images/connect-providers.png" alt="ohbaby /connect 模型配置" width="760">
</p>

| 字段 | 说明 |
| --- | --- |
| Provider | `openai`、`anthropic` / `claude`、`zhipu` …… |
| Base URL | SDK 的 base URL（不要带 `/chat/completions` 后缀） |
| API key env | 存放 Key 的环境变量名（如 `OPENAI_API_KEY`） |
| API key value | Key 本身 |
| Model name | 如 `gpt-4.1`、`glm-5.1`，或你的 provider 提供的模型 ID |
| Context window / Max output tokens | 可选 |

**3. 开始编码。** 就这样 —— 描述你想做的事，ohbaby 就会动手。

## 🔍 Web 搜索（可选）

想启用 Web 搜索工具，去 [Tavily](https://tavily.com) 申请一个免费 API Key，然后写进
任意一个位置的 `.env` 文件：

- `~/.ohbaby-agent/.env`（全局），或
- `<你的项目>/.env`（项目）

```dotenv
TAVILY_API_KEY=tvly-...
```

优先级：shell 环境变量 > 项目 `.env` > 全局 `.env`。

## 🧩 MCP 与 Skills

MCP server 可以按全局或项目维度配置在 `.ohbaby-agent/mcp/` 下。Skills 会从
ohbaby 兼容的 skill 目录中发现，并作为 slash 命令出现在 TUI 中。用 `/mcps`
查看已连接的 MCP server，用 `/skills` 查看可用 skill。

## 📚 文档

模块设计、实现笔记、问题清单都在 [`docs/`](docs/) 下。

Agent 识别的记忆文件（优先级从高到低）：`OHBABY.md`、`AGENTS.md`、`CLAUDE.md`。

## 🛠️ 开发

```bash
git clone https://github.com/diverHansun/ohbaby-agent.git
cd ohbaby-agent
pnpm install
pnpm build
pnpm start            # 运行构建后的 CLI
pnpm test             # 运行测试
pnpm preflight        # format + lint + typecheck + test + build
```

仓库是一个 pnpm workspace，包含三个发布包：

- **`ohbaby-cli`** —— `ohbaby` 可执行文件、启动命令、stdout 渲染器、TUI。
- **`ohbaby-agent`** —— 后端运行时：适配器、工具、会话、策略、MCP、skills。
- **`ohbaby-sdk`** —— 运行时与前端之间共享的稳定 TypeScript 契约。

与代码并排 checkout 的参考仓库（`claude-code/`、`opencode/`、`DeepSeek-TUI/`、
`deer-flow/`）仅用于设计对比 —— 它们不是项目源码，也绝不会进入 npm 产物。

## 📄 许可证

[MIT](./LICENSE)
