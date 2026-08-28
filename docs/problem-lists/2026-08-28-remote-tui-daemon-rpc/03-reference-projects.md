# 3. 参考项目借鉴

> 调研快照：2026-08-28。参考用于验证 receiver 处理原则，不代表照搬完整 RPC 框架。

## 3.1 借鉴来源

| 项目 | 路径 / commit | 调研范围 | 与本问题的关系 |
|---|---|---|---|
| Kimi Code | `/Users/hansunwork26/workspace/projects/code-cli/kimi-code` @ `cfc335048` | `packages/agent-core/src/rpc/client.ts:createRPC/bindAllFunctions` | 同类 fake-RPC，预绑定解法 |
| deepseek-harness | `/Users/hansunwork26/workspace/projects/code-cli/deepseek-harness` @ `528c682e06` | `packages/api/gateway/src/index.ts:invoke` | 调用时显式 receiver 解法 |
| opencode | `/Users/hansunwork26/workspace/projects/code-cli/opencode` | `util/rpc.ts`、`app/src/utils/server-compat.ts:lazyApi`、`plugin/tui/runtime.ts` | 结构规避 + 局部 `Reflect.apply` |
| pi | `/Users/hansunwork26/workspace/projects/code-cli/pi` | `modes/interactive/interactive-mode.ts:createInteractiveTuiReference`、`modes/rpc/rpc-mode.ts` | 结构规避 + 局部 `Reflect.apply` |
| claude-code-best | `/Users/hansunwork26/workspace/projects/code-cli/claude-code-best` | `packages/acp-link/src/server/dispatch.ts`、`services/lsp/LSPClient.ts` | 结构规避：handler map / 闭包 client |
| codex | `/Users/hansunwork26/workspace/projects/code-cli/codex` | `codex-rs/app-server/src/in_process.rs`、`message_processor.rs`、`app-server-client/` | 统一协议 seam，enum 分发天然带 receiver |
| ohbaby 历史参考 | `docs/cli/improve-1/03-reference-patterns.md` | 2026-05-30 对 Kimi class binding 的既有结论 | 结论早已写下，实现未跟上 |

六个项目呈现出一条清晰的光谱：**要么根本不做"按方法名转发本地对象"的 fake-RPC（结构规避），要么做了就必然显式保留 receiver**。ohbaby 是目前唯一"做了动态转发却没保留 receiver"的，这正是 bug 本身。

## 3.2 Kimi Code：连接时绑定原型链方法

Kimi 的 `bindAllFunctions(obj)`（`packages/agent-core/src/rpc/client.ts:72-92`）：

1. 从 instance 沿原型链向上遍历；
2. 找到 function descriptor；
3. 用 `descriptor.value.bind(obj)` 固定 receiver；
4. RPC mapping 只消费已绑定函数。

它直接说明：RPC API implementation 可以是 class，transport 不能假定 method 脱离对象后仍可调用。

ohbaby 的旧参考文档早已在 `docs/cli/improve-1/03-reference-patterns.md:39` 写下相同结论，但当前 SDK 实现没有带入该能力，也没有对应测试。

测试证据：`packages/agent-core/test/rpc/create-rpc.test.ts` 中 class 方法内写 `this.approvals.push(...)`，断言 `hostImpl.approvals` 被修改，直接证明原型方法经 RPC 后 `this` 仍指向原实例。

> 核实备注：kimi 源码中导出的符号是 `leftClient`/`rightClient`（测试里称 `connectCore`/`connectHost`），并非 `connectImpl`/`createProxy`；后者是 ohbaby 自己的 API 命名。引用时注意区分。

### 借鉴取舍

- **Adopt**：class method receiver 必须跨 fake-RPC 保持。
- **Reject 原样复制**：不引入原型链遍历、绑定 map 和缓存；ohbaby 当前 proxy 每次动态取 method，一次 `Reflect.apply` 更贴合现状。

## 3.3 deepseek-harness：调用时显式 receiver

deepseek-harness gateway 先从 active service receiver 取 method，再执行（`packages/api/gateway/src/index.ts:145-184`）：

```text
const method = Reflect.get(receiver, implementation)
result = await Reflect.apply(method, receiver, args)
```

这与 ohbaby 的结构更同构：ohbaby 已有 connected `impl`，也已按 method name 动态取函数。把 `impl` 作为 receiver 可以保留标准方法语义，而无需预绑定或枚举方法。

测试证据：`packages/api/gateway/tests/gateway.host.spec.ts` 覆盖 scoped Proxy receiver（方法读 `this.ctx`）、继承方法（`InheritedMethodService`）等场景，间接但稳定地证明 `Reflect.apply(..., receiver, ...)` 保留 receiver。

### 借鉴取舍

- **Adapt**：采用调用时显式 receiver 的语义。
- **Reject 其余 gateway 复杂度**：ohbaby 不需要 service registry、descriptor、schema reflection 或 remote cancellation 类型体系；本问题只需要正确 invocation。

## 3.4 opencode：主路径走 HTTP，局部 Proxy 显式保留 receiver

opencode 的 TUI ↔ server 主路径是 **HTTP（OpenAPI SDK）**：本地经 Bun Worker 转发 `fetch` 到 `Server.Default().app.fetch`，远程直接打 `http://host:port`。业务调用是 `sdk.session.prompt(...)` 这种属性访问再调用，天然带 receiver，不存在"拆方法"的缝。

它有两处与本问题直接相关的对照：

1. **Worker RPC**（`packages/opencode/src/util/rpc.ts:5-12`）写法是 `rpc[parsed.method](parsed.input)`——与 ohbaby 的 bug 写法同类，会丢 `this`。但 impl 是**对象字面量**、方法不依赖 `this`，靠实现形状规避，不是靠调用层修正。这恰好反证：一旦 impl 换成 class，这种写法立即炸。
2. **局部 Proxy 全部显式保留 receiver**：
   - `lazyApi`（`packages/app/src/utils/server-compat.ts:94-105`）：`Reflect.apply(method, value, args)`；
   - TUI plugin keymap Proxy（`packages/opencode/src/plugin/tui/runtime.ts:143-157`）：`value.apply(target, args)`，并有专门测试 `plugin-loader.test.ts` 的 "plugin keymap proxy preserves real keymap receiver"。

### 借鉴取舍

- **Adopt**：凡是"从对象取出方法、稍后调用"的 Proxy 层，必须显式带 receiver——opencode 两个局部 Proxy 都是这么做的，还有测试锁住。
- **参考**：opencode 的 Worker RPC 说明"impl 用无 `this` 的对象字面量"也是一种合法规避，但 ohbaby 的 `RemoteDaemonClient` 需要封装连接/SSE/初始化状态，class 是合理选择，不应为调用层的错误改实现形状。

## 3.5 pi：本地直接调用，唯一的转发 Proxy 显式保留 receiver

pi 的交互式 TUI 与 `AgentSession` 同进程**直接方法调用**（`this.session.prompt(...)`）；跨进程走 stdin/stdout JSONL（rpc mode）或 CBOR（实验性 client/server），分发侧是 `switch (command.type)` 后 `session.xxx(...)`——都不是 `impl[name](...args)`。

全仓唯一"取出方法再调用"的地方是 TUI 热切换 renderer 的稳定引用 `createInteractiveTuiReference`（`packages/coding-agent/src/modes/interactive/interactive-mode.ts:428-455`）：

```text
const value = Reflect.get(tui, property, tui)
return (...args) => Reflect.apply(method, methodTui, args)
```

并有回归测试 `test/suite/regressions/7731-tui-method-wrapping.test.ts`：提取 `tui.requestRender` 后调用仍生效、替换底层 renderer 后路由到新实现。

### 借鉴取舍

- **Adopt**：与 deepseek 相同的结论——per-call `Reflect.apply` 是"动态 method lookup + 保留 receiver"的标准写法；pi 还演示了目标对象可热替换时如何重新 `Reflect.get`。
- **参考**：pi 的 `switch` 分发说明"显式枚举方法"也能规避问题，但 ohbaby 的 `CoreAPI` 有二十多个方法且由 `UiBackendClient` 派生，手抄 case 清单会随接口漂移，已明确不采用。

## 3.6 claude-code-best：单体同进程 + 闭包 client + 显式 handler map

claude-code-best 是 Claude Code 的逆向复原可运行工程。默认路径 TUI 与 QueryEngine **同进程直接调用**，没有 fake-RPC。跨边界通信（UDS、LSP、MCP、ACP）都是真序列化协议；其中 ACP 的 JSON-RPC 分发（`packages/acp-link/src/server/dispatch.ts:204-245`）是**显式 handler map**：`Record<string, { handle }>` 映射到独立函数，不从 class 上抠方法。它的 client 实现（ACP/LSP/Bridge）普遍用**工厂函数 + 闭包状态**，故意不依赖 `this`。

唯一的 class receiver 保护在 UI 层：Ink 组件用 `autoBind(this)` 防事件回调丢 receiver——说明"callback 场景丢 receiver"是这类项目的已知坑，只是它们把保护放在事件发生处。

### 借鉴取舍

- **没有可直接抄的修复代码**（它没有这条 fake-RPC 缝），但提供了架构对照：同进程就别伪装 RPC；必须按名分发就用 handler map 或闭包 client。
- **对 ohbaby 的意义**：ohbaby 保留统一 fake-RPC seam 是有意为之（local/remote 同构、JSON clone 边界可测），不比 claude-code-best 的单体差，但前提是调用语义正确——这正是本次要修的一行。

## 3.7 codex：统一协议 seam，分发层天然持有 receiver

codex（Rust）把 CLI/TUI 与 agent 核心统一在 `app-server` 的 JSON-RPC 2.0 协议上：远程走 stdio/WebSocket，**本地 in-process 路径只是把同一套 `MessageProcessor` 换到内存 channel 上**（`app-server/src/in_process.rs:1-24` 明确写 "transport-local but not protocol-free"），刻意不引入第二套调用契约。

分发方式是 enum `match` 后调用持有 `&self`/`Arc<Self>` 的 processor 方法（`message_processor.rs:1103-1113`）：

```text
ClientRequest::ThreadStart { params, .. } =>
    self.thread_processor.thread_start(request_id, params, ...).await
```

Rust 没有 JS 的 receiver 陷阱，但它的设计决策与本案直接同构：**分发层拥有实现体上下文，方法永远在实现体身上调用**；本地路径优化的是运输（typed channel 替代 socket），不是绕过契约。`app-server-client` 的 facade 还刻意不暴露 direct core handles，防止调用方绕过 seam。

### 借鉴取舍

- **Adopt（思想层面）**：ohbaby 的 fake-RPC 就是 codex 的 "in-process transport"——它应该保留与真实 RPC 一致的语义（包括"方法在 impl 上调用"这一隐含契约），而不是因为同进程就丢失。`Reflect.apply(method, impl, args)` 正是把这条隐含契约显式化。
- **Reject 照搬**：ohbaby 是 TS 单进程 monorepo，不需要 enum 协议宏、双 transport 或 typed channel 体系。

## 3.8 跨项目模式总结

| 模式 | 项目 | 对 ohbaby 的适用性 |
|---|---|---|
| 结构规避：同进程直接调用 / 真序列化边界 | pi、claude-code-best、opencode（主路径） | ohbaby 有意保留 fake-RPC seam（统一 clone/error/abort 边界），不改为直接调用 |
| impl 用无 `this` 的闭包/对象字面量 | opencode worker、claude-code-best ACP/LSP | `RemoteDaemonClient` 需要实例状态，class 合理，不改形状 |
| 显式 handler map / switch 分发 | claude-code-best ACP、pi rpc-mode、codex（enum match） | 方法表会随 `UiBackendClient` 漂移，违反 DRY，不采用 |
| 连接时预绑定原型链 | Kimi Code `bindAllFunctions` | 有效但引入遍历/缓存/去重复杂度，不照搬 |
| **调用时 `Reflect.apply(method, receiver, args)`** | **deepseek-harness、opencode lazyApi、pi TUI reference** | **与 ohbaby 现有动态 lookup 形状一致，一行修正，推荐** |

测试层面的共识也值得记录：kimi（class 方法写实例字段断言）、deepseek（scoped proxy receiver）、opencode（"preserves real keymap receiver"）、pi（提取方法后调用仍生效）都有**专门锁住 receiver 语义的测试**。ohbaby 现有 34 项相关测试全部用 closure/`vi.fn`，恰好全部绕开了这个维度——这是测试盲区，不是测试缺失。

## 3.9 明确不借鉴

| 方案 | 不采用原因 |
|---|---|
| 完整复制 Kimi 双向 RPC 与 bindAllFunctions | ohbaby 已有稳定 createRPC、callback seam 和 AbortSignal 处理；复制会扩大改动面 |
| 完整复制 deepseek gateway reflection | 本问题没有 service lookup/schema dispatch 需求，属于 YAGNI |
| 把 RemoteDaemonClient 全部改为 arrow fields | 每实例生成函数、改动二十多个方法，只治症状不治通用边界 |
| 给 CLI 增 local/remote 分支绕过 fake-RPC | 破坏统一 seam，并让测试/行为继续分叉 |
| 改走 opencode 式纯 HTTP SDK 主路径 | ohbaby 的 in-process fake-RPC 是有意的统一边界（clone/error/abort 可测），推翻它远超本批范围 |
| 引入 codex 式 enum 协议/handwritten dispatch | TS 单进程 monorepo 无此需求，方法清单会漂移 |

## 3.10 对 02 的直接影响

1. receiver preservation 是已验证的 RPC 基础语义，不是 ohbaby 特殊补丁——六个项目中凡存在"取方法再调用"的层（kimi、deepseek、opencode 两处、pi 一处）无一例外显式保留 receiver。
2. 选择 deepseek 风格的 per-call `Reflect.apply`，因为它与 ohbaby 当前动态 method lookup 形状一致；opencode `lazyApi` 与 pi `createInteractiveTuiReference` 是同一写法的独立佐证。
3. Kimi 的原型链 binding 只作为"class API 必须受支持"的反证和测试启发，不作为实现模板。
4. 测试必须使用真正依赖 receiver 的 class/stateful implementation；继续只测 closure 无法证明问题已修。kimi 的 `this.approvals.push` 断言模式可直接搬到 ohbaby 的 U1 回归测试。
5. codex 的 "transport-local but not protocol-free" 原则为 02 的"保留 fake-RPC seam、只修调用语义"提供了架构层面的正当性：同进程优化不应破坏协议语义。
