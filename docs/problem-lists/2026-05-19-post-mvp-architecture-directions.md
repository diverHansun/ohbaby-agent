# 2026-05-19 Post-MVP 架构演进方向评估

本文记录对 Claude 提出的 4 个潜在优化点的评估，并结合本地参考项目 `opencode/`、`claude-code/`、`hermes-agent/` 与 ohbaby-agent 当前实现给出后续优先级。

结论先行：4 点总体方向都合理，但落地方式需要收敛。当前最应该补的是 **可附加 backend/server 边界** 与 **untrusted context / prompt injection guard**；不建议把 `Bus` 改造成跨进程总线，也不建议在 MVP 后立刻引入 Effect 全家桶。

---

## 当前 ohbaby-agent 位置

- `packages/ohbaby-agent/src/bus/bus.ts` 是同步、进程内、无 replay 的模块事件总线。
- `packages/ohbaby-agent/src/runtime/stream-bridge/` 已经承担跨进程事件流抽象：scope、event id、ring buffer、gap、heartbeat/end sentinel。
- `packages/ohbaby-agent/src/runtime/daemon/` 已经具备 bootstrap、pid/state 文件、优雅退出、app/command event adapter、RunManager/StreamBridge 装配。
- `packages/ohbaby-agent/src/adapters/ui-persistent.ts` 已经提供持久化 in-process backend，CLI/TUI 可以复用同一套 runtime surface。
- `packages/ohbaby-sdk/src/client.ts` 目前仍是进程内 `UiBackendClient` 接口，没有 HTTP/SSE/WebSocket remote client。
- `packages/ohbaby-agent/src/core/system-prompt/layers/custom.ts` 会加载 `OHBABY.md`、`AGENTS.md`、`CLAUDE.md` 并直接注入 system prompt，目前没有安全扫描或 trust 标记。

---

## 1. Bus 同步且不能跨进程

**判断：合理，但不应把 Bus 升级成跨进程组件。**

Claude 的问题描述准确：当前 `Bus.publish()` 同步遍历 subscriber，事件没有 id、顺序、持久化、replay，也没有跨进程能力。这种形态适合 core/runtime 内部解耦，不适合 daemon client、TUI detach/reconnect、远程访问或多客户端。

但 ohbaby 的文档与代码已经有正确方向：`Bus` 留在进程内，`StreamBridge` 作为外部事件协议边界。`runtime/daemon/command-events.ts` 已经在做 Bus event -> StreamBridge app scope 的翻译，`runtime/run-manager/worker.ts` 也把 run scope delta 发到 `StreamBridge`。

**建议：**

- 保持 `Bus` 简单同步，不引入 replay、网络、持久化。
- 后续工作集中在 `interfaces/server` 或等价模块：把 `StreamBridge.subscribe()` 暴露为 SSE/WebSocket，把 `UiBackendClient.getSnapshot()` 暴露为 snapshot endpoint。
- 对外协议只消费 SDK 事件类型，不暴露内部 Bus event。
- 若未来需要跨进程 command/control，也走 SDK/server command API，不让外部进程 publish 内部 Bus。

**优先级：P1。** 这是 attachable backend 的前置边界，不是 Bus 重构任务。

---

## 2. 缺少可附加服务器能力

**判断：非常合理，是 Post-MVP 最值得做的架构增强。**

opencode 的模式很清楚：`opencode serve` 启动 HTTP server，TUI 也是 server 的客户端；server 提供 OpenAPI、全局 SSE、session/message/command/file 等 API。这个设计天然支持多个客户端、IDE 接入、远程或本地 attach。

claude-code 参考项目里也能看到类似演进：daemon/worker 通过 state 文件管理进程，remote-control-server 用 Hono 暴露 SSE/WebSocket/API，并在 server 层做 token/JWT/session 级认证。

ohbaby 目前的关键差距不是 runtime，而是 transport：

- TUI 与 backend 仍绑定在同一进程内。
- SDK 只有接口，没有 remote implementation。
- 没有 `ohbaby serve` / `ohbaby attach` / `ohbaby status` 这样的用户入口。
- 没有 server auth、client identity、multi-client 权限语义。

**建议的实施顺序：**

1. **Local attach first**：先做只监听 `127.0.0.1` 的本地 server，不急着公网远程。
2. **Protocol shape**：HTTP JSON endpoint 负责 command/snapshot，SSE 负责 event stream；保持与 `UiBackendClient` 语义一致。
3. **SDK remote client**：在 `ohbaby-sdk` 增加 `createHttpUiBackendClient(baseUrl, token)` 或等价工厂，TUI 只依赖 SDK。
4. **单写入者约束**：同一 data dir 只允许一个 persistent backend/daemon 写 SQLite；其他客户端只能 attach。
5. **认证最小闭环**：本地随机 token + state file，后续再扩展 API key / pairing / remote auth。
6. **多客户端语义**：读事件可多客户端；提交 prompt、响应 permission、abort run 属于 control operation，需要 owner/lease 或冲突处理。

**优先级：P1。** 它是从“本地 CLI/TUI MVP”进入“长期 agent/runtime”阶段的分水岭。

---

## 3. 手动工厂 DI vs opencode Effect 体系

**判断：部分合理，但现在不建议迁移到 Effect。**

opencode 的 Effect 体系有明显工程收益：服务按 Layer/Context 注入，InstanceState 负责 per-directory state 和 scoped cleanup，background fibers/subscriptions 随 scope 自动释放。这对大型 server/runtime、多 workspace、多客户端确实很有价值。

但 ohbaby 当前代码已经有比较清晰的手动 composition root：

- `createUiRuntimeComposition()` 装配 lifecycle、tool scheduler、run manager、stream bridge、system prompt provider。
- `createPersistentUiBackendClient()` 装配 SQLite stores、persistent UI state、snapshot hook。
- `bootstrapRuntime()` 装配 daemon runtime 并管理 start/stop 顺序。
- 多数测试通过 options 注入 fakes/mocks，当前还没有到“必须换 DI 框架”的复杂度。

直接引入 Effect 的风险：

- 学习成本和迁移成本高，会拖慢 MVP 后收尾。
- 需要统一错误、资源、async、test runtime 语义，否则会出现半 Effect 半 Promise 的夹层。
- 当前最紧急的缺口是 server/security，不是 DI 表达力。

**建议：**

- 短期继续使用手动工厂，但把 composition 接口收紧：所有跨模块依赖都从 options 注入，避免模块顶层单例。
- 为 server/daemon/TUI 增加标准 test harness/fake backend，降低 mock 成本。
- 当出现以下任一信号时再评估 Effect 或轻量 IoC：
  - composition options 长期超过约 20 个且多个工厂重复装配同一组依赖；
  - scheduler/heartbeat/server/MCP/plugin 都需要 scoped cleanup，手写 cleanup 顺序频繁出错；
  - 多 workspace / 多 project instance 需要隔离相同服务实例。

**优先级：P3。** 先规范 composition，不做框架级迁移。

---

## 4. Prompt injection 检测

**判断：合理，而且应该尽早做。**

Hermes 的实现值得借鉴：它不只在一个位置做安全，而是在 context files、memory、cron prompts、MCP tool descriptions、skills install 等入口都做轻量静态扫描和 trust-aware policy。代表模式包括：

- context 文件加载前扫描 `ignore previous instructions`、`system prompt override`、隐藏 HTML、不可见 Unicode、secret exfil pattern；
- memory/cron prompt 因为会被注入 system prompt 或后台执行，采用更严格的 fail-closed；
- MCP tool description 只警告不阻断，降低误杀；
- skill/plugin 安装结合来源 trust level 决定 allow / warn / block。

ohbaby 当前风险面：

- `OHBABY.md` / `AGENTS.md` / `CLAUDE.md` 会进入 system prompt。
- search/fetch provider 后续会带来网页内容和外部文档。
- MCP/skill/plugin 一旦启用，会引入第三方描述、schema、hook、命令。
- 后台/daemon 模式会降低人工实时观察度，prompt injection 的代价会变高。

**建议的 MVP+ guard：**

- 新增 `core/security` 或 `core/prompt-security`，提供 `scanPromptLikeContent(content, source)`。
- 扫描对象第一批覆盖：system prompt custom instructions、memory 写入内容、future cron/scheduler prompt、MCP/tool/plugin description。
- 输出结构化 finding：`severity`、`category`、`patternId`、`sourcePath`、`line`、`action`。
- 对本地项目 context 默认策略：critical block、high warn+omit 或 ask、low warn；允许用户显式 trust project 后降级。
- 对外部搜索/网页内容不要直接当 instructions 注入，应包进 `<untrusted_context>`，并在 system prompt 中声明其只能作为资料，不可覆盖系统/用户指令。
- 初期用高置信静态规则，不优先做 LLM 分类器；等误报/漏报样本积累后再加可选智能检测。

**优先级：P0/P1。** 最好在 MCP/skill/plugin 和远程 attach 大规模开放前完成第一版。

---

## 推荐后续实施顺序

### P0：MVP+ 安全与收口

- 给 `system-prompt` custom instruction loader 接入 prompt-injection/static guard。
- 为 `OHBABY.md` / `AGENTS.md` / `CLAUDE.md` 加安全测试：block critical、warn non-critical、空文件/大文件/Unicode 正常。
- 在 TUI/status 或 backend warnings 中暴露“某个 context 文件被跳过”的可见性。

### P1：Local attachable backend

- 新增 `interfaces/server` 或 `adapters/ui-http-server`。
- 增加 `ohbaby serve` 启动本地 server，持有 persistent backend。
- 增加 SDK remote client，TUI 可通过 SDK attach 到已有 server。
- 实现 snapshot + app event stream + run event stream 的最小闭环。
- 加本地 token/state file，默认仅 loopback 监听。

### P2：多客户端和后台语义硬化

- 明确 control operation lease：submit prompt、permission response、abort run 的并发冲突怎么处理。
- 完善 disconnect mode：interactive client 断开时是 cancel、continue 还是 wait-for-attach。
- 完善 event gap 恢复：server 侧 snapshot endpoint 与 SDK reducer 对齐。
- 补 daemon/status/stop/attach 命令体验。

### P3：扩展层再进入

- MCP / skill / plugin 在安全 guard 与 attachable backend 后进入更稳。
- Plugin/skill 的 install/enable 应复用同一套 trust-aware scanner。
- MCP description 初期以 warning/audit 为主，tool execution 仍走 permission/policy/sandbox。

### P4：DI/Effect 复盘

- 暂不迁移。
- 等 server、MCP、plugin、scheduler 全部落地后，再基于实际复杂度决定是否引入 Effect、轻量 container，或继续手动 composition。

---

## 非目标

- 不把 `Bus` 做成跨进程网络总线。
- 不让 daemon 直接承担 HTTP/RPC/server 业务；daemon 保持装配层，server 是独立接口层或由 daemon 持有的子服务。
- 不在默认配置下暴露公网远程 server。
- 不在当前阶段引入完整 Effect 迁移。
- 不把所有 context 文件都视为完全可信 system instruction；至少需要 trust/source 标记。

---

## 一句话路线

ohbaby-agent 后续应保持当前分层：`Bus` 做进程内解耦，`StreamBridge` 做事件协议，`server/SDK` 做进程外 attach，`security guard` 管住所有会进入 prompt 或工具描述的外部文本。先补 server 与安全边界，再扩 MCP/skill/plugin，最后再判断是否需要 Effect 级 DI。
