<p align="center">
  <img src="assets/images/logo.png" alt="ohbaby-agent" width="150">
</p>

<p align="center">一个开源 AI 编程 Agent，提供终端 CLI/TUI 与本地 Web UI。</p>

<p align="center">
  <a href="https://github.com/diverHansun/ohbaby-agent/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/diverHansun/ohbaby-agent/ci.yml?style=flat-square&label=CI&logo=github"></a>
  <a href="https://www.npmjs.com/package/ohbaby-cli"><img alt="npm" src="https://img.shields.io/npm/v/ohbaby-cli?style=flat-square&color=cb3837&logo=npm"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D24-339933?style=flat-square&logo=node.js">
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

**ohbaby-agent** 是一个开源 AI 编程 Agent。用户可以通过
基于 [Ink](https://github.com/vadimdemedes/ink) 的 CLI/TUI 或本地浏览器界面与它交互：
使用 npm 安装 `ohbaby-cli`，然后通过 `ohbaby` 命令启动。运行时与 SDK 已拆分，后续
可以继续适配 app 等操作界面。

它不绑定任何模型厂商，可以通过 [MCP](https://modelcontextprotocol.io) server 和即插即用的
skills 扩展。带上你自己的 OpenAI、Anthropic、智谱等 LLM 厂商 API Key，就能开始编码。

## ✨ 特性

- **🤖 不绑定厂商** —— 支持 OpenAI、Anthropic、智谱、DeepSeek、通义千问/DashScope
  等 LLM 厂商或 OpenAI 兼容端点。你的 Key，你的模型。
- **🧩 MCP 支持** —— 接入 [Model Context Protocol](https://modelcontextprotocol.io)
  server，它们的工具、资源、prompt 会自动暴露给 Agent。
- **🛠️ Skills** —— 用可复用的 skill 扩展 ohbaby-agent，它们会作为 slash 命令出现。
- **🧰 内置工具** —— 文件读写、Shell 执行、Web 搜索、待办管理，全部经过权限层。
- **👥 子 Agent** —— 把复杂的多步任务委派给专注的子 Agent。
- **💬 CLI/TUI 操作界面** —— 终端里支持 slash 命令、会话历史、模型切换、实时流式输出。
- **🌐 本地 Web UI** —— `ohbaby serve` 启动显式本地 daemon，伺服 npm 包内置的 web
  assets，并为当前项目打开浏览器界面。
- **🔐 策略模式与权限** —— `auto` / `default` 模式，危险操作前显式确认。

## 📦 安装

需要 **Node.js >= 24**。安装当前 MVP 的 CLI 包：

```bash
npm install -g ohbaby-cli
```

安装后会得到全局 `ohbaby` 命令。

## 🚀 快速开始

**1. 启动 ohbaby-agent CLI/TUI：**

```bash
ohbaby
```

**2. 配置模型。** 在 CLI/TUI 里输入 `/connect` 打开 provider 配置面板，填入 provider、
base URL、模型名后保存即可。API key 相关字段对 LM Studio 等本地/无鉴权 endpoint
是可选的；如果输入密钥，它会持久化到 `~/.ohbaby-agent/.env`。

<p align="center">
  <img src="assets/images/connect-providers.png" alt="ohbaby-agent /connect 模型配置" width="760">
</p>

| 字段 | 说明 |
| --- | --- |
| Provider | `openai`、`anthropic`、`zhipu` …… |
| Base URL | SDK 的 base URL（不要带 `/chat/completions` 后缀） |
| API key env | 可选，存放 Key 的环境变量名（如 `OPENAI_API_KEY`） |
| API key value | 可选，Key 本身；本地无鉴权 endpoint 可留空 |
| Model name | 如 `gpt-5.5`、`claude-sonnet-4-5`、`glm-5.1`，或你的 provider 提供的模型 ID |
| Context window / Max output tokens | 可选 |

**3. 开始编码。** 就这样 —— 描述你想做的事，ohbaby-agent 就会动手。

## 🌐 本地 Web UI

npm 包已经内置构建后的 web assets。在你的项目根目录执行：

```bash
ohbaby serve
```

命令会打印并打开真实本地地址，例如：

```text
ohbaby web ready: http://127.0.0.1:4096
```

默认使用 `4096` 端口。如果默认端口已被占用，ohbaby 会自动选择可用端口并打印新的
URL。显式传入 `--port` 时仍保持严格语义，所以 `ohbaby serve --port 4096` 会在端口
被占用时给出清晰失败。

<p align="center">
  <img src="assets/images/ohbaby-web-v0.1.6.png" alt="ohbaby-agent 本地 Web UI" width="760">
</p>

## 🔍 Web 搜索（可选）

想启用 Web 搜索工具，先去 [Tavily](https://tavily.com) 申请一个免费 API Key，然后在
CLI/TUI 里输入 `/connect-search` 并填入 Key。ohbaby-agent 会把它作为
`TAVILY_API_KEY` 保存到 `~/.ohbaby-agent/.env`，并且只把搜索元数据写入
`~/.ohbaby-agent/tools/search.json`。

你也可以手动把 Key 写进 `.env` 文件：

- `~/.ohbaby-agent/.env`（全局），或
- `<你的项目>/.env`（项目）

```dotenv
TAVILY_API_KEY=tvly-...
```

优先级：shell 环境变量 > 项目 `.env` > 全局 `.env`。

## 🧩 MCP 与 Skills

MCP server 可以按全局或项目维度配置在 `.ohbaby-agent/mcp/` 下。Skills 会从
ohbaby-agent 兼容的 skill 目录中发现，并作为 slash 命令出现在 CLI/TUI 中。用 `/mcps`
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

仓库是一个 pnpm workspace，包含四个发布包：

- **`ohbaby-cli`** —— CLI/TUI 与本地 web 包，安装后提供 `ohbaby` 命令。
- **`ohbaby-agent`** —— 后端运行时：适配器、工具、会话、策略、MCP、skills。
- **`ohbaby-server`** —— 显式本地 server 与远程 client 传输包。
- **`ohbaby-sdk`** —— 运行时与操作界面之间共享的稳定 TypeScript 契约，当前服务于 CLI/TUI
  与本地 Web UI，后续也可服务于 app 适配。

## 📄 许可证

[MIT](./LICENSE)
