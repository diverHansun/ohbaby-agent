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
- slash web 闭环：`GET /v1/commands?surface=web` / `POST /v1/commands`、browser resolve、候选面板/Tab 补全 helper、`command.*` 事件投影为 CommandNotice/结构化只读 modal。
- 结构化 overlay 闭环：`/connect`、`/connect-search`、`/compact` 从 slash palette 打开 overlay，但提交分别走 model/search/compact REST；覆盖只读 context-window probe、敏感字段不回显、compact usage/result。
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
| slash 解析失败 | 不调用 `/v1/commands`，显示错误且 draft 不丢 |
| slash 候选与补全 | 展示 passthrough 命令与 overlay 命令；Tab 补全当前选中命令；输入/选择不改变 composer 尺寸 |
| slash 执行结果 | `command.started`→running notice，`command.result.delivered`→只读结果 modal 或 fallback notice |
| slash 执行失败 | `command.failed`→错误 notice，不影响后续 prompt |
| interaction slash | `/sessions`、`/permission` 等 `parentBehavior: "interaction"` 命令不出现在 web catalog，手写 POST 也被 400 拒绝 |
| overlay slash 手写 POST | `/connect`、`/connect-search`、`/compact` 即使出现在 `surface=web` palette，也不能经 `POST /v1/commands` 执行 |
| 命令目录更新 | `command.catalog.updated` 使 web catalog 缓存失效，后续 slash 重新 GET `/v1/commands` |
| `/connect` probe | `POST /v1/model/context-window-probe` 不写配置、不 reset runtime；detected 优先，失败按用户值或 128k fallback |
| `/connect` 保存 | `POST /v1/model` 根据 `baseUrl` 推断 interface provider，保存成功后返回不含真实 key 的 current model |
| `/connect-search` 保存 | `POST /v1/settings/search-api-key` 支持 `.env`/env 解析，成功后不回显 key |
| `/compact` | 先读 usage，再执行 compact；结果展示 before/after/saved/pruned，失败不丢 overlay 草稿 |

---

## 3. Integration Points（集成点）

| 集成对象 | 验证重点 | 失败时预期 |
|---------|---------|-----------|
| `/v1` daemon（真 `app.fetch`） | web 客户端能驱动 `/v1` 并回流事件 | 错误以 UI 可见错误呈现，不崩 |
| **跨 transport 契约**（呼应 server ADR-001） | web `/v1` 客户端与 `UiBackendClient` 契约行为等价 | 行为分叉即失败 |
| `store` ↔ React | `useSyncExternalStore` 精准订阅、增量不全量重渲 | 渲染抖动/丢更新即失败 |
| 浏览器端 E2E（Playwright MCP） | 真实 `ohbaby serve --web-assets-dir` 页面：空态可见、键盘发送、mode/policy、slash palette、slash `/status` modal、三类 overlay、基础响应式 | 页面崩溃/控制不可用即失败 |
| 真实链路 E2E | 使用项目 `.env` 中配置的 Zhipu `glm-4.7` 与 Tavily key，经浏览器保存模型/搜索配置并发送短 prompt | API key 不打印；若外部服务失败，保留失败日志摘要与可重跑命令 |

---

## 4. Verification Strategy（验证策略）

- **分类对位**：纯逻辑 → `unit`；web↔`/v1` 接口契约 → `contract`；client+store+reducer 串联 → `integration`；起站+核心闭环 → `smoke`。colocated + root vitest。
- **契约测试打真 server `app.fetch`**：web 的 `contract` 测试注入真实 `ohbaby-server` 的 `app.fetch`（不开端口），把 ADR-001"跨 transport 参数化契约"的消漂移保证延伸到浏览器客户端。代价：web 测试 devDep 依赖 `ohbaby-server`（monorepo 内可接受）。
- **纯逻辑用 fixture / fake SSE 流**：`eventReducer`、`events` 的解析与 resync 用构造的事件序列驱动，不依赖真 daemon；web-safe slash allowlist/过滤逻辑在 `ohbaby-sdk` 侧单测，server/web 只验证消费同一 helper 后的行为。
- **e2e 分两层**：先跑 deterministic（fake backend/app.fetch/headless browser），再跑 real-link（真 `ohbaby serve` + `.env` + Zhipu/Tavily）。使用 Playwright MCP 做真实浏览器检查；重型像素级视觉回归暂缓。

> 关键场景与 [`use-case.md`](./use-case.md) §4 的失败点一一对应；§2 的"基线对齐"与"resync"依赖 server 的 S-A（snapshot 带 seqNum），契约测试应一并断言该字段存在。
