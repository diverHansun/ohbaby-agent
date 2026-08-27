# 2. 优化方案与改动面

> 给后续开发会话的执行契约。本规划会话不写代码。

## 2.1 方案总览

在 **不改 cache 请求策略、不改 occupancy、不改 normalization** 的前提下：在 `ui-inprocess` 外层增加一个主代理 session 内存 tracker，在 **primary run 完成**时把可信的 `LifecycleTokenUsage.inputBreakdown` 累加进去；`/status` 读 tracker，画出一行 `Cache hit {n}%` 或 `Cache hit —`。

```text
Lifecycle.run (purpose=agent-step)
  → RunCompletion.usage
  → RunManager 窄完成回调（恰好一次、失败隔离）
  → 若 !isSubagent 且轮可信：promptCacheUsage.record(sessionId, usage)
  → handleStatus 读 promptCacheUsage.get(sessionId)
  → Web / TUI `/status` 独立行
```

可信轮：`usageComplete && inputBreakdown && observed.cacheRead`。
Share：`ΣcacheRead / Σ(uncached+cacheRead+cacheWrite)`；没有任何可信轮 → `cacheReadShare = null`。先累计 token 后相除，禁止平均 step / turn / run 的百分比。

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| 文档落点 | 本 problem-list | 00；跨 lifecycle + commands + UI | `context/improve-7`、`llm-client/improve-1` | 发现路径靠 README 交叉链接 |
| 累加器位置 | `adapters/ui-inprocess/prompt-cache-usage.ts`；由 `createInProcessUiBackendClient` 外层创建，跨 runtime reset 存活 | session `/status` 投影属于 UI adapter 生命周期；不扩大 Context/llm-client/Lifecycle core 职责 | 放进 `core/lifecycle`、`prompt-cache.ts` 或 occupancy tracker | adapter 多一个小型内存 Map |
| Helper 位置 | 与 tracker 同文件的纯函数，只消费 `LifecycleTokenUsage.inputBreakdown` | 当前只有一个消费者；KISS，避免为公式扩大 provider/core 公共 API | Context 里算命中率；预建通用 metrics 层 | 将来出现第二个稳定消费者时再提取 |
| RunManager 协作 | 一个同步、optional、cache-agnostic 的完成回调，参数只含 `sessionId / isSubagent / usage`；回调错误隔离；abort 覆盖终态时保留 worker 已返回的 `result.usage` | 唯一能覆盖成功、失败、取消及启动握手异常，并保证每个 run 恰好一次 | RunManager 直接依赖 tracker；只在 `submitPromptInternal` 正常返回后 record | `RunManagerDeps` 多一个窄端口；需修正现有取消覆盖会丢 result 的窄缺口 |
| 折入时机 | run **完成**（成功/失败/取消都看 usage 是否可信），不是每 step、不是 `/status` 打开时 | `/status` 不得靠「碰巧开过面板」 | 在 llm-client 每请求加 | 取消且 `usageComplete=false` 的轮被跳过 |
| 子代理 | `isSubagent === true` 不 record；子代理 session 的 get 返回 `null`，UI **不画 Cache 行** | 00；与占用 child→null 对齐 | 按 sessionId 混加；子会话显示 `—` | 子代理自身命中率本批不可见 |
| compact / 换模型 | 桶上没有这两个钩子 | 00 明确不清 | compact 后清零；按 modelId 分桶 | 压缩后百分比被旧轮拉高/拉低，这是要的 |
| 持久化 | 内存 Map；重启空；`disposeSession`/删 session 时删该 key | YAGNI；占用 tracker 同构 | 写 SQLite / 日志重放 | 重启后先 `—` |
| 推送 | 不新增 event/snapshot 字段 | YAGNI | `cache.updated` SSE | `/status` 才刷新数字 |
| 命令字段名 | 正式采用 `promptCacheUsage` | 避开 `apiConfig.promptCache` | 沿用 improve-6 的 `promptCache` | optional 新字段，旧客户端忽略 |
| UI 载荷 | SDK 类型固定为 `sessionId/accountedInputTokens/cacheReadTokens/cacheReadShare`；面板只渲染 share | 数量与比例可解释；不把厂商 observation 误叫 estimate 或全量 total | 加 `estimatedAt`、`incompleteRuns`；把 token 明细画成长串 | JSON 可看到累计样本量，UI 保持单行 |
| UI adapter | Web/TUI 各自在现有 status 解析层增加一个小型 adapter；做结构与范围校验，失败关闭 | unknown command payload 必须先收窄；两个消费端已有各自局部 adapter 结构 | 组件直接断言；为两个消费者新建跨包 validator 框架 | 两份很小的校验需用同一 contract 用例锁住 |
| 占用类型 | 不改 `UiContextWindowUsage` | 两套账 | 可选 `cacheReadShare` 塞占用 | 旧占用消费者被污染 |

不可逆决策：**无。** optional 命令字段 + 内存桶可整段回滚。禁止把 cache 写入占用语义或 snapshot 合同（那才是一扇门）。

## 2.3 分阶段实施

顺序固定。A 的 unit 未绿不得接 UI 假数据。

### Phase A · Share helper + session 桶

- **目标**：纯逻辑可测。无 UI、无命令。
- **改动**
  - 在 `adapters/ui-inprocess/prompt-cache-usage.ts` 导出内部纯函数：`observed.cacheRead !== true` 或分母 ≤ 0 → `null`；否则 `cacheRead / (uncached+cacheRead+cacheWrite)`。不要求 `observed.cacheWrite`。
  - `createPromptCacheUsageTracker()`：`record(sessionId, usage)` / `get(sessionId)` / `clearSession` / `clear`。不可信轮直接跳过，不额外保存当前无消费者的诊断字段。可信轮：`accountedInputTokens += uncached+cacheRead+cacheWrite`、`cacheReadTokens += cacheRead`，再从两个累计数重算 share。
  - 保持 `aggregateTokenUsage` 的 run 级完整性规则：多 step 工具循环任一步缺 `inputBreakdown` 时，整 run 的 breakdown 缺失，tracker 整轮不记。不得绕过 run aggregate 按 step 挑选数据；这是“数字不撒谎”优先于覆盖率的产品决定。
  - 三桶之和为本轮分母，但 tracker 只持久保存本批真正需要的两个累计数；不为未来 UI 预存未消费的逐桶 DTO。
  - **不要**在 compact、`context.window.updated`、换模型路径调用 `clearSession`。
- **DoD**：04 U1–U9。

### Phase B · run 完成折入 + `/status` 读取

- **目标**：主代理跑完，打开 `/status` 就能读到桶；子代理 run 不进桶。
- **改动**
  - `createInProcessUiBackendClient` 外层创建 tracker，与 backend client 同寿命；不要创建在会被 `resetRuntime()` 销毁的 runtime composition 内。换模型重建 runtime 时，将指向同一 tracker 的回调重新注入新的 RunManager。
  - **唯一 record 点**：`RunManager.finalizeRun` 得到 `RunCompletion` 之后，调用一次同步完成回调。回调参数只含 `sessionId / isSubagent / usage`，且抛错不得改变 run completion。`isSubagent === true` 跳过；否则 `record(sessionId, usage)`。失败/取消同样走这条，由 record 判断可信。
  - 修正 `RunManager.startRun` 的取消覆盖：worker 已返回 outcome 后若 abort signal 已置位，只把终态改为 cancelled 并更新取消原因，必须保留已有 `outcome.result`，使 provider 已完整返回的 usage 仍能进入 completion；取消发生在 usage 完整之前时仍由可信轮规则跳过。不要改 Lifecycle 聚合公式。
  - 不要在 `submitPromptInternal`、`streamChatCompletion`、title/summary client 或 `/status` getter 上 record。多个调用方重复 `waitForCompletion` 不能重复记账。
  - 同一 `sessionId` 的 `record` 依赖现有「一 session 一活跃 run」与 JS 同步 Map，不另做异步队列或锁。
  - `CommandServiceOptions` 增加 `getPromptCacheUsage({ sessionId })`。无 `sessionId` → 不写该字段。子代理 session → `null`（对标占用 child guard，UI 不画行）。主代理 session 即使 tracker 尚无可信数据，也返回 `accountedInputTokens=0 / cacheReadTokens=0 / cacheReadShare=null` 的对象（UI `Cache hit —`），不要省略字段。
  - 外层 tracker 直接订阅同一个 `bus` 的 `SessionEvent.Removed` 并 `clearSession(payload.sessionId)`；backend dispose 时先取消该订阅再 `clear()`。不要把清理回调塞进会被重建的 runtime composition。
  - `archiveSessionInternal` 在 archive 成功后直接 `clearSession(sessionId)`；当前 archive 没有恢复路径，按 UI session 移除处理。compact / 换模型 / `context.window.updated` **禁止** clear。所有 clear 保持幂等。
- **DoD**：04 I1–I9、C1–C2。

### Phase C · Web / TUI `/status` 一行

- **目标**：用户看见文案；占用块仍然没有 Cache。
- **改动**
  - `ohbaby-sdk`：新类型文件（不要写进 `context-window.ts`），`index.ts` 导出。
  - Web：在 `slashCommands.ts` 增加 `statusPromptCacheUsage(data)`，沿用 `statusContextWindowUsage` 的 unknown-payload adapter 形态；`statusRows` 在 `context` **之后**插入 label `cache` + value `hit — / hit 0% / hit {n}%`。最终可见文案只出现一次 `cache hit …`，不得生成 `cache Cache hit …`。占用七类块 text 仍不得包含 Cache。字段缺失或值为 `null` → 不画该行。Adapter 要求 sessionId 非空、两个 token 数为非负整数且 `cacheReadTokens <= accountedInputTokens`；accounted=0 时只接受 read=0/share=null，accounted>0 时只接受有限的 0–1 share。非法值 fail closed，不 clamp，也不在 UI 重算 share。
  - TUI：在 `status-panel.ts` 同层增加 `toPromptCacheUsage(value)`，遵循现有 `toContextWindowUsage` 的局部 adapter 结构；`renderStatusPanel` 在 Context 与 Tools 之间调用 `row("Cache", "hit 61%")`（未知为 `hit —`、零命中为 `hit 0%`）。标签和值合成后的可见行是 `Cache hit …`，不得生成 `Cache Cache hit …`。底栏不动。
  - 不为两个消费者新建跨包 validator 包；用同一组 contract fixture 锁住等价行为。出现第三个稳定 unknown-payload 消费者后再评估提取。
  - 拆开 Web 断言：占用块不含 Cache；独立 `cache` 行按 share 渲染。
- **DoD**：04 W1–W4、T1–T2、C1–C2。

### Phase D · 权威文档

- `docs/core/context/architecture.md` §八：命中率不再写「下一轮」，改为指向本目录。
- `docs/core/context/data-model.md`：补 session prompt-cache usage 投影及其与 `UiContextWindowUsage`/snapshot 分离的边界。
- `docs/ui/components/status-bar.md`：把“本轮不得出现 Cache 行”改为 `/status` 独立 Cache 行，并锁定 Web/TUI 最终可见文案；顶栏环仍不显示。
- `docs/core/context/goals-duty.md`：保留“Context 不解析 vendor cache”Non-Duty，并指向本批独立通道。
- `docs/core/lifecycle/goals-duty.md`：只澄清 run completion 可通过窄 observer 向 adapter 提供 usage；session 累计仍不是 Lifecycle core 职责。
- `docs/core/context/improve-6/README.md`：一句移交，避免后人在 improve-6 实施 cache。
- **DoD**：文字与 00 一致；不改 occupancy 语义段落。

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `ohbaby-agent/src/core/lifecycle/` | — | — | 无 | 不改 `aggregateTokenUsage`，不放 session tracker |
| `ohbaby-agent/src/runtime/run-manager/` | — | `types.ts` 增加窄完成回调；`manager.ts` 保留取消前已完成 result，并在 finalize 后恰好一次调用、隔离错误 | 无 | 不依赖 cache 类型或 tracker |
| `ohbaby-agent/src/adapters/ui-inprocess/` | `prompt-cache-usage.ts` + unit | `ui-inprocess.ts` 外层创建 tracker、订阅 SessionEvent.Removed、注入 callback、child get→null、archive/dispose 清桶并取消订阅 | 无 | 跨 runtime reset 存活；不共用 occupancy Map |
| `ohbaby-agent/src/adapters/ui-runtime/` | — | composition options 透传完成回调到 RunManager | 无 | 只做装配，不持有 tracker |
| `ohbaby-agent/src/commands/` | — | `types.ts`、`builtin.ts` `handleStatus` | 无 | 正式字段 `promptCacheUsage` |
| `ohbaby-sdk/` | cache usage 类型文件 | `index.ts` | 无 | 不改 `UiContextWindowUsage` |
| `apps/ohbaby-web/` | — | `slashCommands.ts`、`App.tsx`、unit test | 无 | `/status` 一行 |
| `ohbaby-cli/src/tui/render/` | — | `status-panel.ts` + unit test | 无 | 底栏不改 |
| `docs/core/context/` | — | `architecture.md`、`data-model.md`、`goals-duty.md`、improve-6 README 指针 | 无 | 不改 improve-6 00 正文，不改 occupancy 语义 |
| `docs/core/lifecycle/` | — | `goals-duty.md` | 无 | 只记录窄 observer 协作，session 累计仍是 Non-Duty |
| `docs/ui/components/` | — | `status-bar.md` | 无 | `/status` 独立 Cache 行；顶栏环不动 |

## 2.5 API / 协议 / 迁移与兼容

确认后的协议形状：

```ts
interface UiPromptCacheUsage {
  readonly sessionId: string;
  readonly accountedInputTokens: number; // 仅可信轮的 Σ(uncached+cacheRead+cacheWrite)
  readonly cacheReadTokens: number;       // 仅可信轮的 ΣcacheRead
  readonly cacheReadShare: number | null; // cacheReadTokens/accountedInputTokens
}
```

`/status` data 增加 optional `promptCacheUsage?: UiPromptCacheUsage | null`。

| 情况 | data | UI |
|------|------|-----|
| 旧服务端 / 字段缺失 | 无键 | 不画行 |
| 子代理 session 或读失败 | `null` 或无键 | 不画行 |
| 主代理、尚无可信轮 | 对象，`cacheReadShare: null` | `Cache hit —` |
| 主代理、有可信轮 | 对象，share ∈ [0,1] | `Cache hit {n}%`（含 `0%`） |
| payload 形状或 share 非法 | 消费端解析失败 | 不画行，禁止 clamp 后伪装成合法值 |

旧客户端忽略未知字段。不得把该对象放进 `UiSnapshot.contextWindowUsages`。

无存储迁移。

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| `—` 被做成 `0%` | helper 要求 `observed.cacheRead`；UI 只认 `null` | 去掉 Cache 行 |
| 子代理折进主桶 | record 前看 `isSubagent`；单测 I2 | 关闭 record |
| title/summary 进桶 | 只从 `RunCompletion.usage` 折入 | 同上 |
| compact 被顺手 clear | 禁止在 compact/占用更新路径调 clear；04 I3 | — |
| `/status` 字段与配置 `promptCache` 混淆 | 正式使用 `promptCacheUsage`；contract 锁字段 | 删除 optional 新字段即可 |
| 占用单测「不含 Cache」误伤独立行 | Phase C 改断言范围 | — |
| 换模型销毁 runtime 时误清累计 | tracker 在 `ui-inprocess` 外层；模型切换回归测试 | 移除完成回调与字段 |
| 多次 wait 同一 completion 重复累计 | record 只在 `finalizeRun` 调一次 | 关闭 callback |
| 取消覆盖丢掉已返回的可信 usage | 保留 worker outcome.result；04 I9 覆盖取消前后两种时机 | 回退为取消轮一律跳过并同步收窄产品口径 |
| 外层 tracker 没收到 session removed | 外层直接订阅 bus；archive 直接清；dispose 取消订阅并清全部 | 删除清理钩子，退回进程寿命 |

## 2.7 与 00 边界对齐检查

- 主代理-only、compact/换模型不清、session 唯一显示、分母含 write、`—`≠`0%`、不进彩条/顶栏、内存重启归零、正式字段名与 DTO：均落入 2.2–2.5。
- 不做：llm-client/context 塞桶、SSE、持久化、计费、TUI 七类、请求策略。

## 2.8 不在本批

与 00 §3 相同。另：不把 improve-6 N 表当行号权威；不在 02 写关键改动清单。
