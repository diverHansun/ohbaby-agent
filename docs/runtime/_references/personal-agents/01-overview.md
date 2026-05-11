# personal-agents 01 — 项目背景与定位

本文介绍 hermes-agent、openclaw 两个个人 AI agent 项目的整体形态、源码位置、公网资料链接，以及它们与 ohbaby-agent 在定位上的根本差异。后续 `02-mechanism-comparison` 与 `03-problem-comparison` 都建立在本文的"项目定位"之上。

---

## 一、Hermes-Agent

**定位**：以 IM 平台为中心的多通道个人助理。把一个 LLM agent loop 接到 Telegram / Discord / Slack / WhatsApp / Signal / Matrix / Email / SMS 等 15+ 通道，让用户用熟悉的聊天软件"和它说话"。Nous Research 出品，2026-02 发布。

**技术栈**：Python，单进程 gateway daemon。

**本地源码**：`D:\Projects\agent-components\personal\hermes-agent`

**关键模块**：
- `gateway/` — 平台适配器（`platforms/*.py`）+ session 管理 + delivery 路由 + stream consumer
- `tui_gateway/` — 双传输 JSON-RPC 服务器（stdio + WebSocket），同时服务 CLI 和 Web/手机端
- `cron/` — scheduler 每 60s tick，触发定时任务并通过 DeliveryRouter 路由结果

**公网资料**：
- 官方主页：<https://hermes-agent.nousresearch.com/>
- 官方文档：<https://hermes-agent.nousresearch.com/docs/>
- GitHub：<https://github.com/NousResearch/hermes-agent>
- Messaging Gateway 概览：<https://hermes-agent.nousresearch.com/docs/user-guide/messaging/>
- Sessions 概览：<https://hermes-agent.nousresearch.com/docs/user-guide/sessions>
- DeepWiki 安全与配对：<https://deepwiki.com/NousResearch/hermes-agent/7.4-security-and-pairing>
- 第三方深度文档：<https://github.com/mudrii/hermes-agent-docs>
- 部署/教程类博客：<https://blakecrosley.com/guides/hermes>、<https://www.tencentcloud.com/techpedia/143916>

---

## 二、OpenClaw

**定位**：以"设备实时控制平面"为中心的本地优先 AI 助理。让一个 daemon 同时被 macOS app / iOS / Android / Web 扩展 / CLI / MCP 客户端连上来，所有设备共享 agent，并能在后台被远程唤醒。MIT 协议，全开源，本地优先（记忆以 Markdown 文件存盘）。

**技术栈**：TypeScript / Node.js，pnpm monorepo。

**本地源码**：`D:\Projects\agent-components\personal\openclaw`

**关键模块**：
- `src/gateway/` — WebSocket 多路复用器（默认 `127.0.0.1:18789`，loopback-only），帧类型 `Request / Response / Event`
- `src/daemon/` — 进程托管：macOS launchd、Linux systemd user unit、Windows Task Scheduler
- `src/pairing/` — challenge-response 设备配对，本地 keychain 存 token
- `src/infra/heartbeat-wake.ts` — 250ms 合并窗的 wake coordinator（**与公网文档说的"agent-tick heartbeat"不是同一件事**，详见 `04-takeaways`）
- `src/channels/` — IM 通道适配 + stall watchdog
- `src/mcp/` — stdio MCP 服务器，作为 LLM 工具桥接回本机 gateway
- `apps/macos`、`apps/ios`、`apps/android` — 设备端原生 app

**公网资料**：
- 官方文档（架构）：<https://docs.openclaw.ai/concepts/architecture>
- 官方文档（heartbeat）：<https://docs.openclaw.ai/gateway/heartbeat>
- GitHub：<https://github.com/openclaw/openclaw>
- 架构深度分析（Substack）：<https://ppaolo.substack.com/p/openclaw-system-architecture-overview>
- 节点架构与子 agent：<https://medium.com/@databytoufik/how-openclaw-nodes-work-8bd3b1cb14ed>
- 安全与加固指南：<https://nebius.com/blog/posts/openclaw-security>
- DeepWiki 通道章节：<https://deepwiki.com/openclaw/openclaw/8-channels>
- 配对机制指南：<https://skywork.ai/skypage/en/openclaw-gateway-pairing/2037432393570009088>

---

## 三、Ohbaby-Agent 的定位（用于对照）

**当前定位**：以"装配 + 协议"为中心的进程内 SDK runtime。单进程、SQLite 单写入者、对外靠 SDK 协议事件流，daemon 是装配层而不是连接层。

**与上述两者的根本差异**：

| 维度 | hermes-agent | openclaw | ohbaby-agent |
|---|---|---|---|
| 一句话定位 | 把 agent 接到 IM 平台上去 | 把多种设备实时连到 daemon 上来 | 把 agent runtime 做成进程内 SDK |
| 主要客户 | 在 IM 软件里和 bot 聊天的人 | 在 macOS/iOS/Android 上点击 app 的人 | 调用 SDK 的上层 application 代码 |
| 远程接入面 | IM 平台原生协议（多种） | 单端口 WebSocket（统一） | 暂无（同进程） |
| 协议表面 | 各 IM 平台原生消息 | WebSocket JSON-RPC 帧 | SDK UiEvent + `command.*` / `interaction.*` |
| 持久化 | SQLite + JSONL（transcript） | 本地 Markdown（memory）+ 各通道适配器自管 | SQLite 单写入者（run-ledger） |
| 进程托管 | 自托管（用户启 systemd/screen 等） | daemon 模块自动注册 OS 服务 | 显式声明"不做进程托管"，由 OS 工具承担 |

**这条对照的意义**：三者解决的工程问题不同。读后续两篇对照文档时，**不要把任一项目的设计当成"标准答案"**。借鉴的方向也不是"补齐 gateway"，而是从对照中看出"未来如果做远程接入层，应该如何与 runtime 解耦"。
