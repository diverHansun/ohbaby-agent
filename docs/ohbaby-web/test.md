# ohbaby-web · test（测试设计）

> 围绕职责与交互边界验证，不围绕代码结构。前置：[`goals-duty.md`](./goals-duty.md)、[`dfd-interface.md`](./dfd-interface.md)、[`use-case.md`](./use-case.md)。
>
> **项目级测试规则**：遵循 `docs-test/`——四类 `*.unit.test.ts` / `*.contract.test.ts` / `*.integration.test.ts` / `*.smoke.test.ts`，源码旁 colocated，root Vitest。本文只补 web 特有场景。

---

## 1. Test Scope（测试范围）

**覆盖**（web 职责）：
- 连接层纯逻辑：`events` SSE 解析 / `Last-Event-ID` 游标 / `resync` 处理；`eventReducer` 投影；ConnectionState 五态迁移；`bootstrap` 解析注入。
- web ↔ `/v1` 契约：daemon 客户端讲对 `/v1`、行为符合 `UiBackendClient` 语义。
- 串联：`client` + `store` + `eventReducer` 消费模拟 SSE 流 → ViewState 正确（UC1–4）。
- 起站冒烟：`dist` 能被伺服、页面能起、核心闭环走通。

**不覆盖**（外部职责）：
- `/v1` 路由内部、协调、replay 缓冲正确性（属 `ohbaby-server`）。
- agent run 执行、工具调用、持久化（属 `ohbaby-agent`）。
- workspace scope 解析与启动锁（属 server/runtime，依赖 S-D）。
- 组件像素级视觉回归（v0.1.6 不做）。

---

## 2. Critical Scenarios（关键场景，不可接受失败）

| 场景 | 预期结果 |
|------|---------|
| 流式增量累积 | 多个 `message.part.delta` 顺序累积成正确 StreamingMessage，`message.updated` 定稿不错位 |
| **SSE 先开 + snapshot 基线** | 只应用 seq>基线的缓冲事件，无漏拍、无重复 |
| **`resync-required`** | 丢弃 ViewState → 重拉 snapshot → 回 live，绝不静默错位（核心正确性） |
| reconnect 退避有界 | 断线重连不紧循环空转 |
| 权限错主 403 | UI 提示，且不误标为已处置 |
| prompt 202 后断线 | 不自动重发，提示用户重提（对齐 N3） |
| 401 token 失效 | 全局可见，进 `disconnected`，不静默 |
| 输出消毒 | 恶意 markdown/HTML 经 sanitize 后不执行脚本 |

---

## 3. Integration Points（集成点）

| 集成对象 | 验证重点 | 失败时预期 |
|---------|---------|-----------|
| `/v1` daemon（真 `app.fetch`） | web 客户端能驱动 `/v1` 并回流事件 | 错误以 UI 可见错误呈现，不崩 |
| **跨 transport 契约**（呼应 server ADR-001） | web `/v1` 客户端与 `UiBackendClient` 契约行为等价 | 行为分叉即失败 |
| `store` ↔ React | `useSyncExternalStore` 精准订阅、增量不全量重渲 | 渲染抖动/丢更新即失败 |

---

## 4. Verification Strategy（验证策略）

- **分类对位**：纯逻辑 → `unit`；web↔`/v1` 接口契约 → `contract`；client+store+reducer 串联 → `integration`；起站+核心闭环 → `smoke`。colocated + root vitest。
- **契约测试打真 server `app.fetch`**：web 的 `contract` 测试注入真实 `ohbaby-server` 的 `app.fetch`（不开端口），把 ADR-001"跨 transport 参数化契约"的消漂移保证延伸到浏览器客户端。代价：web 测试 devDep 依赖 `ohbaby-server`（monorepo 内可接受）。
- **纯逻辑用 fixture / fake SSE 流**：`eventReducer`、`events` 的解析与 resync 用构造的事件序列驱动，不依赖真 daemon。
- **e2e 仅一条 smoke**：起真 daemon + 浏览器侧客户端走通"连接→发话→收流→审批"。重型 Playwright 视觉回归暂缓。

> 关键场景与 [`use-case.md`](./use-case.md) §4 的失败点一一对应；§2 的"基线对齐"与"resync"依赖 server 的 S-A（snapshot 带 seqNum），契约测试应一并断言该字段存在。
