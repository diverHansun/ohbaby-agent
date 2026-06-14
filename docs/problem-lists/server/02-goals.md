# 02 · 目标与需求

> **文档职责**：定义本通信层规划要达到的目标、非功能需求，以及明确**不做**什么（YAGNI 红线）。
> **配套**：现状见 `01`，借鉴见 `03`，两条路线见 `04`/`05`。

---

## 一、背景与定位

`terminal-daemon` Phase 1-4 已交付：单写者 daemon、HTTP JSON-RPC + SSE 协议、per-client 审批路由、全局 FIFO、auto-spawn。**多 CLI 终端已完整可用。**

本规划的定位：在这套已验证的协调基座上，**让非 CLI 前端（本机 web 端、未来 app 端）也能接入**，而不重新架构、不污染领域核心。

核心资产是 `ohbaby-sdk` 的 `CoreApiHost`/`UiBackendClient`/`UiEvent` 契约——它是协议中性的 seam，所有目标都挂在它上面。

---

## 二、功能目标

| 优先级 | 目标 | 说明 |
|--------|------|------|
| P0 | **本机浏览器 web UI 可接入** | 浏览器经 HTTP+SSE 消费现有 `CoreApiHost`，提交 prompt、看流式输出、响应审批 |
| P0 | **断线重连不丢事件** | web/app 刷新、弱网抖动后重连，补发断开期间的事件 |
| P1 | **多前端并发** | CLI + web 同时连一个 daemon，分别操作不同 session 互不干扰；审批路由到发起方 |
| P2 | **（未来）app 端 over LAN** | 同网段 app 发现并连接 daemon —— 需求驱动，本期仅留架构余地 |
| P3 | **（未来）IDE 集成 ACP / agent 委派 A2A** | 作为 `CoreApiHost` 上的协议适配器后加 —— 需求驱动 |

---

## 三、非功能需求

| 维度 | 要求 | 依据问题 |
|------|------|---------|
| **可靠性** | 事件投递可恢复（seqNum + 重放），重连后前后端状态一致 | S1 |
| **安全（本机基线）** | 鉴权 fail-closed；浏览器 CORS 白名单；不在 query string 放 secret | S2/S4 |
| **依赖隔离** | 重协议依赖（Hono/ACP/A2A SDK）不进领域包 `ohbaby-agent` | S6（路线 A） |
| **可演进** | 新增协议 = 新增适配器，核心零改（OCP） | S5/S6 |
| **可逆性** | 每步增量、可回退；嵌入式/`--in-process` 逃生舱保留 | 全局 |
| **契约稳定** | `UiBackendClient` 契约不破坏；remote 与 in-process 跑同一行为套件 | 全局 |

---

## 四、YAGNI 红线（明确不做）

这些不是疏漏，是**有意识地推迟到真实需求出现**：

- ❌ **不引入 ACP / A2A**：没有 IDE 集成或多 agent 委派的真实需求前不建。架构上留 `CoreApiHost` 这条缝即可，适配器按需后加（claude/opencode 证明 ACP 约 7 文件薄适配）。
- ❌ **不做远程/跨网络**：不绑 `0.0.0.0`、不上 TLS、不做多用户 authz。localhost 信任模型对当前正确；远程 app 是独立工作包。
- ❌ **不引入 Effect 等范式框架**（opencode 用 Effect）：范式迁移成本远超收益，结论同 `terminal-daemon/03-reference-projects.md`。
- ❌ **不为想象中的未来预先抽象领域事件**（除非选路线 A 且确认 ACP/A2A 近期上）：当前 CLI+web 共用 `UiEvent` 无痛点，提前抽象属于"为未来付费"。

---

## 五、成功标准

### 本机 web 端（P0，本期）

- [ ] 浏览器从独立 origin（如 vite dev）能调通 daemon 的 RPC 与 SSE（CORS 通过）。
- [ ] 浏览器刷新/断线重连后，通过 `lastEventId` 补回断开期间事件，UI 状态与后端一致。
- [ ] daemon 鉴权 fail-closed：无 token 头的请求被拒，而非放行。
- [ ] CLI 与 web 同连一个 daemon，审批弹窗只发给发起 run 的前端。
- [ ] `UiBackendClient` 契约未破坏；现有 daemon/CLI 测试全绿。

### 演进余地（P2/P3，验收"不堵死"）

- [ ] 接入 web 协议未改动 `ohbaby-agent` 领域核心代码（仅传输层变化）。
- [ ] 文档明确记录：远程 app、ACP、A2A 的接入点是 `CoreApiHost` 上的新适配器，触发条件已写明（见 04 触发点）。

---

## 六、决策清单（需拍板）

| 决策 | 选项 | 影响 |
|------|------|------|
| 路线选择 | A（新包）/ B（就地） | 见 04/05；推荐先 B |
| 事件层 | UiEvent 直发 / 抽协议中性领域事件 | 仅路线 A 且 ACP/A2A 近期时选后者；否则 YAGNI 直发 |
| 包命名（若走 A） | `ohbaby-server` / `ohbaby-host` / 保留 `daemon` | "gateway" 对单后端名不副实，建议 `ohbaby-server` |
