# ohbaby-server · goals-duty（目标与职责）

> 模块设计第一份文档。它定义 `packages/ohbaby-server` **为什么存在、做什么、刻意不做什么**。后续 architecture / interface / test 文档都不得引入超出本文 Duties 的职责。
>
> 前置背景：本包是 `docs/problem-lists/server/` 规划中"路线 A"的落地。当前触发条件的含义是：我们已经决定把显式 server 边界先建好，为后续 web/app 与未来 ACP/A2A 铺路；不是说默认 CLI 要依赖 server，也不是说本期要同时交付完整 web/app。

---

## 一句话存在意义

把**唯一的 agent backend**，通过**显式 server**暴露给多个前端（CLI / web / 未来 app），并把传输、协议、多客户端协调这些"非领域"关注点，连同重协议依赖，一起隔离在 `ohbaby-agent` 之外。

不叫 "gateway"：网关是"一个入口 + 后面 N 个服务做聚合路由"，而 ohbaby 是**单写者、一个 backend**，后面没有要聚合的多服务。准确定位是 **server**（暴露唯一 backend 给多前端）。

---

## 背景：三种进程模型（边界的根基）

本包的职责边界，建立在对"到底有几种进程、谁需要被管理"的清晰区分上：

| 模型 | 进程数 | 谁管它生死 | 需要 pid/state/supervisor/spawn | 归属 |
|------|--------|-----------|------------------------------|------|
| **默认 CLI（in-process）** | 1：UI + agent runtime 同进程 | 终端 / 用户 Ctrl+C | ❌ 不需要 | 不经过本包 |
| **foreground server（`ohbaby serve`）** | 1：server + agent runtime 同进程 | 终端 / 用户 Ctrl+C | ❌ 基本不需要 | 本包主路径 |
| **detached server（后台常驻）** | 独立后台进程，脱离终端 | 无人盯守 → 靠管家文件 | ✅ 唯一需要 | 本包降级抽屉 |

两条关键判断：

1. **`ohbaby-agent` 是库，没有独立进程。** 它被 CLI 进程或 server 进程 import 进去运行，跟宿主进程一起生死。因此 agent 天然没有"进程生命周期"，那套管家代码绝不放 agent。
2. **进程生命周期管理只为 detached server 服务。** 而 detached 后台常驻 = openclaw / hermes-agent 那类"全天候跑在服务器、用户随时唤醒"的全自动 agent；**ohbaby 是 coding CLI，产品形态是"用户即开/即关"**。所以 detached 不是主战场，foreground + in-process 才是。这套代码因此是本包内一个"降级保留、暂不主用"的抽屉。

---

## Design Goals（设计目标）

- **G1 关注点分离**：传输 / 协议 / 多客户端协调，与领域核心是两个不同的变化原因（协议随生态变，领域随业务变），必须分开演进。
- **G2 依赖隔离（最硬正当性）**：Hono、`@agentclientprotocol/sdk`、`@a2a-js/sdk` 等重协议依赖**只进本包，绝不进 `ohbaby-agent`**。
- **G3 协议中性**：同一个 backend 能同时服务 CLI（jsonrpc）和 web（REST+SSE），未来 app / ACP / A2A 接入时对领域核心零摩擦。
- **G4 显式生命周期**：server 永远由用户**显式启动、显式连接、显式停止**，绝不作为默认 CLI 的隐藏依赖。
- **G5 单写者不变量**：后面只有一个 backend；本包是"把唯一 backend 暴露给多前端"，不是网关/多服务聚合。依赖方向恒为 `protocols → coordination → CoreApiHost(sdk 契约)`，核心永远看不见适配器，无环。

---

## Duties（职责）

- **D1 传输层**：提供 HTTP/SSE server（未来可扩 WebSocket），负责绑定、监听、路由。
- **D2 协议适配**：
  - jsonrpc（供 CLI attach 与集成测试）。
  - web（供浏览器的 REST + SSE）。
- **D3 多客户端协调**（仅 server 模式）：
  - prompt queue（全局 FIFO，server 统一调度）。
  - permission routing（审批事件回到发起方）。
  - 事件分发 + **SSE replay**（修 S1：带 seqNum + 环形缓冲，支持断线补发）。
- **D4 横切中间件**：
  - auth（token，**fail-closed**，修 S4；常量时间比较）。
  - CORS（origin 白名单，修 S2，让本机 web 可跨 origin 访问）。
- **D5 remote client**：提供 remote `UiBackendClient`，供 `ohbaby attach <url>` 与"启动 server 后用 client 验证"的集成测试复用。
- **D6 foreground 生命周期**：`ohbaby serve` 前台启动一个 server 进程，前台停止、退出即清理。这是本包生命周期能力的**主路径**。

---

## Non-Duties（非职责）

- **N1 不承载领域逻辑**：agent runtime、session、tool 执行、持久化属 `ohbaby-agent`。本包只驱动 `createPersistentUiBackendClient` 暴露出的 backend。
- **N2 不做默认 CLI 的隐藏 daemon**：默认 `ohbaby`（in-process）**不经过本包**，不 discover / spawn / reuse 后台进程。迁移完成后，local/remote 模式选择由 `ohbaby-cli` 的命令层负责：local 调 `ohbaby-agent`，remote/serve 调 `ohbaby-server`。`ohbaby-agent` 不反向 import 本包。
- **N3 不自动重放 prompt**：server 断线后只提示用户重新提交，不自动重发（避免重复执行工具、重复改文件、重复扣费）。
- **N4 不默认开放 LAN / mDNS / TLS / 多用户**：远程访问、网络绑定、多用户 authn/authz 是后续触发点（远程 app 立项）才做。
- **N5 不定义领域事件契约**：协议中性的领域事件契约（若将来需要）属 `ohbaby-sdk`；本包只做 wire 信封与 SSE replay，不在本期抽象"领域事件 → 各协议形状"的投影层（采纳 A2：UiEvent 直发 + replay；ACP/A2A 接入时再补投影，遵循 YAGNI）。
- **N6 detached 后台常驻不作主路径**：supervisor / pid-file / state-file / spawn 作为"降级抽屉"保留在 `lifecycle/`，仅当真有"后台常驻 server"需求时激活。本期不把它当作稳定性补丁，更不为它单独建包（只被本包复用、跟本包一起演进）。

---

## 自检

- **一句话存在意义？** ✅ 见顶部。
- **能清楚说出不该做什么？** ✅ N1–N6。
- **与其他模块职责重叠风险？**
  - 与 `ohbaby-agent`：边界清晰——agent 出 backend 工厂 + sdk 契约，本包出传输/协议/协调；`core-api-factory.ts` 留 agent（N2）。
  - 与 `ohbaby-cli`：CLI 默认 in-process 不经过本包；只有 `serve` / `attach` / 显式 remote 命令触达本包。
  - 与 `ohbaby-sdk`：sdk 只出契约，本包消费契约，不反向定义领域类型（N5）。

---

## 待后续文档处理的遗留项（不在本文范围）

- `daemon/bootstrap.ts`、`daemon/app-events.ts` 疑似废弃（S7），迁移前先审计：废弃则删，不盲目搬。
- S8（`__fresh__` lane 过度串行）、S9（`disconnectClient` 空 stub）记为 backlog，迁 `coordination/` 时顺手处理。
- C1（默认 CLI 回 in-process）是本包抽取的**前置实施步骤**，发生在 `ohbaby-cli` / `ohbaby-agent`，不在本包设计范围，但必须先于抽包完成。v0.1.4 中 C1 与本包迁移可以分阶段实施、同一 release gate 发布。
