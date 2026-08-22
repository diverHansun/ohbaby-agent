# 5. 实施验收文档

> 撰写时机：实施完成后，由规划会话的验收模式独立检查后撰写。
> 2026-08-21 二次审查发现跨会话状态归属缺口；`d56ee99` 修复后再做第三次独立审查（对照代码 + 定向复测，不单信实施方 05）。

## 5.1 元信息

| 项 | 值 |
|----|----|
| 议题 / 批次 | context improve-4：实时 Lifecycle tool schema 计量 + 自动压缩过程态 |
| 规划文档版本 | 工作区 00–04（实施边界提交 `b408e57`，其后有验收修订） |
| 实施范围 | 基线 `e59107b`；任务 A `45f6b1f`；任务 B `6e5cd82`；并发隔离 `a6a283f`；跨会话状态归属修复 `d56ee99` |
| 验收日期 | 2026-08-21（第三次独立审查） |
| 结论 | **通过（自动化）**：任务 A/B 主路径与跨会话状态归属修复均成立。上次 P2（切走后 `Compacting...` 卡住）已关闭。真实 provider 下 TUI/Web 手工观察仍留给用户，不阻断代码验收。 |

## 5.2 实施概况（对照 02）

| 02 条目 | 状态 | 实际实施摘要 | 证据 |
|---------|------|--------------|------|
| Phase 1 / 任务 A：实时请求计量含 tools | **完成** | Lifecycle 每步先 `resolveTools`；同一份 tools 交给 `prepareTurn`、所有压缩后重测、overflow retry 和 provider send。final step 为 `[]`。 | `lifecycle.ts`、`context-manager.ts`、`token-estimation.ts`；TC-1、TC-8 |
| Phase 1 边界：静态/手动保持粗估 | **完成（有意）** | `getContextUsage` / `compactSession` / `ContextManager.compact` 不传 provider tool schemas、不扩公开参数，继续 messages-only 粗估。 | `composition.unit.test.ts`；TC-11 |
| Phase 2 / 任务 B：开始信号 | **完成** | 非 `none/mask` 档位确定后、`pruneHistory` 前调用 `onCompactionStarted`；纯 prune、summary、overflow force 均覆盖。 | `context-manager.ts` `runCompaction`；TC-10 |
| Phase 2：Lifecycle → worker → UI | **完成** | generator 在函数体内 yield `context:compacting`；worker 映射 `run.context.compacting`；adapter 写既有 `UiRunStatus.title`；Web/TUI 读取 title。 | Lifecycle / worker / stream source / adapter / Web selector 测试 |
| Phase 2：结束、失败与跨会话归属 | **完成** | 同会话 prepared 清标题、失败由终态兜底；显式切换会话时按新 active session 重算全局 runtime status；后台 run 的 running/terminal 记录继续发布，但不再覆盖前台全局 status/reasoning；没有 active session 时保持 idle。 | `ui-inprocess.ts`、`run-stream-adapter.ts`、Web/TUI reducer；跨会话 contract + adapter unit |
| Out-of-scope 防线 | **完成** | 未改 cache usage、breakdown、memory hooks、Bus UI 订阅、DB、`tokenCounting.ts`、SDK 占用结构和 TUI usage 展示。 | diff / rg |
| 相邻文档 | **已授权** | `improve-5` 仅登记后续 cache 批次；`raw.md` 保留讨论原料，无对应产品代码。 | 文档 diff |

## 5.3 规划 vs 实际差异

| 维度 | 规划方案（02） | 实际实施 | 差异原因 | 影响评估 |
|------|----------------|----------|----------|----------|
| 数据结构 | `PrepareTurnInput.tools`、`onCompactionStarted`、Lifecycle 过程事件 | 与规划一致；无 breakdown/cache 字段 | 无 | 向后兼容 |
| tools 数据流 | 测量与发送使用同一 tools 快照 | 与规划一致 | 无 | 实时占用不再漏 tool schemas |
| 过程事件 | ContextManager signal → Lifecycle yield → worker → UI title | 与规划一致 | 无 | 不新增 Bus UI 通道或 transcript 消息 |
| StreamBridge | 新过程事件映射 | 事件名原本就是开放 `string`；新增 producer/consumer mapping，无需中央枚举 | 既有协议形态 | 无运行差异 |
| 跨会话状态 | prepared/终态清理，后台不污染前台 | 验收时补充显式 active-session transition reconcile、原子 active-session status 条件写，以及 Web/TUI 对后台 `run.updated` / `run.interrupted` 的归属过滤 | 首次实现只覆盖“事件一开始就在后台”，未覆盖“前台显示后切走”、并发切换和 per-run 事件的消费侧 | 修复后 backend snapshot 与实时 Web/TUI 均保持当前选中会话状态；`activeSessionId=null` 明确为 idle，不扩 SDK |
| 依赖/存储 | 无新增 | 无新增 | 无 | 无 migration、无回滚负担 |

自动 compact 的“开始”语义没有偏移：整个实际自动压缩操作已经开始——档位已确定、首次 prune 尚未执行；不是摘要模型调用开始。

## 5.4 实施理由与维护注意事项

- Lifecycle 拥有 step/tools 上下文，一次解析后下传 ContextManager 与 provider；ContextManager 不依赖 tool registry，符合 SRP。
- token 密度算法仍由 `estimateTokensForText` 提供，占用信封仍由 context 组装；没有把 provider 请求形状下沉到 `tokenCounting.ts`。
- `getContextUsage` 与手动 compact 继续 messages-only 是 00/02 锁定的本批边界。它们必须在后续 context 占用监测/UI 实施前优化，不混入 improve-5 cache。
- 当前 heuristic 只按 ASCII/非 ASCII 字符权重计数；JSON key 重排不改变字符集合，因此本批不做 canonical JSON。计量与发送继续使用同一 tools 对象。
- 摘要按 improve-3 写入 synthetic `context-summary` assistant part，并在 UI reload 时投影成 `Context compacted` 边界；improve-4 新增的 progress 事件本身不 append 消息、不暴露摘要正文、不发成功 notice。
- `UiRunStatus` 仍是 workspace 级“当前选中会话状态”。显式会话迁移会按新会话重算，run stream 通过 store 内部原子条件写防止切换竞态；Web/TUI 也只让 active session 的 per-run 事件改变全局 runtime。后台 run 不持久化并重放 `Compacting...` 这种瞬时标题，重新切回时允许保守显示普通 `Working`。这是本批避免 per-session 状态模型的 KISS 取舍。

## 5.5 实施成果（对照 04）

### 5.5.1 验收项结果

| 验收 ID | 结果 | 证据 |
|---------|------|------|
| TC-1 有/无 tools | **通过** | wire heuristic、prepared heuristic/current usage 均覆盖 tools 与空数组 |
| TC-8 final maxSteps | **通过** | final step 的 prepare/send 共用局部 `tools=[]`；失败路径同时断言两端，成功路径断言 provider request |
| TC-11 静态/手动边界 | **通过** | `keeps provider tool schemas out of static usage and manual compaction` |
| TC-4 成功静默 + 占用更新 | **通过** | manager 验证压缩后 usage；adapter 验证 prepared usage 进入 tracker；成功 notice 保持静默 |
| TC-5 失败/inflated warning | **通过** | warning 文案与既有行为保持 |
| TC-9 Bus 非 UI 通道 | **通过** | manager 保留 Bus 发布；生产 adapter 不订阅 `ContextEvent` |
| TC-10 过程态 | **通过** | prune 前 signal、none/mask、纯 prune、summary、force、worker/source、prepared/失败清理、Web/TUI title、后台隔离、切换竞态和消费侧跨会话归属均有自动化证据 |

完整矩阵（跨会话修复后）：

| 命令 | 结果 |
|------|------|
| `pnpm run test:unit` | 213 files；**1907 passed，2 skipped** |
| `pnpm run test:integration` | 42 files；**287 passed** |
| `pnpm run test:contract` | 12 files；**229 passed** |
| `pnpm run typecheck` | **通过** |
| `pnpm run lint` | **通过** |

跨会话合同按 red → green 验证：修复前“切到空闲 B”“切到运行中 B”两项均失败；修复后两项通过，并额外验证 A 后台终态不会把仍在运行的 B 改成 idle、旧 session reconcile 不会覆盖新选择，以及归档唯一运行中会话后 `activeSessionId=null` / `status=idle`。

未自动化的最终观察：使用真实 provider 在 TUI/Web 确认有 tools 时总量合理上升、自动压缩时出现 spinner，并手工切换一次会话。该项需要真实运行条件，不阻断本次代码验收。

### 5.5.2 二次审查发现与关闭

| 发现 | 原严重性 | 处理结果 |
|------|----------|----------|
| A 已显示 `Compacting...` 后切到 B，A prepared 因归属守卫不再清全局标题 | P2 | **已关闭**：UI 导航设置 active session 后调用既有 `reconcileRuntimeStatus()`；覆盖 B 空闲与 B 运行中 |
| A 后台终态仍可能把 B 的全局状态写成 idle | P2（同一归属问题的后半段） | **已关闭**：run 记录照常更新；adapter 只为 active session 发布 global status，Web/TUI 也不再把后台 `run.updated` 当成全局状态 |
| active-session 检查与 status 写入之间存在 TOCTOU 窗口 | P2 并发风险 | **已关闭**：条件检查与 status 更新收进 `UiStateStore.updateStatusForActiveSession` 同一同步临界段，并有受控交错测试 |
| `activeSessionId=null` 被无参 active-run 查询误解为“任意唯一 run” | P2 状态语义 | **已关闭**：null 明确不解析 active run；归档唯一运行中会话合同断言 workspace idle |
| 后台 run 终态清空 Web 前台 reasoning | P2 消费侧归属 | **已关闭**：Web 与 TUI 均只允许 active session 的 terminal/interrupted 事件清理前台 reasoning |
| `getContextUsage` / 手动 compact 不计 tools | 非缺陷 | 维持 00/02 边界，登记为占用监测/UI 前置 |
| JSON key 顺序、`Promise.race` 无 latch | 非当前缺陷 | 当前 heuristic 与同 tick 测试均不支持扩大设计；不新增 canonicalizer/latch |
| synthetic summary 出现在持久 transcript | 非缺陷 | improve-3 的压缩边界；progress 通道没有新增原始摘要消息 |

### 5.5.3 SWE 层面评估（聚焦改动面）

结论：改动保持了原有分层，没有用新状态机掩盖所有权问题。显式会话迁移路径复用“选择会话 + 重算 runtime status”的内部 helper；stream projection 仍负责 run/message 投影，但通过 state store 原子条件写确保只有 active session 能更新 workspace-global status。Web/TUI 将 per-run 集合更新与全局 runtime 更新分开处理。

| 发现 | 评价 | SWE 依据 | 状态 |
|------|------|----------|------|
| Lifecycle 作为 step/tools 单一编排者 | 正向 | SRP / Information Expert | 保持 |
| ContextManager 不解析 registry、tokenCounting 不理解请求信封 | 正向 | DIP / 关注点分离 | 保持 |
| compact progress 使用局部 Promise signal | 正向 | KISS / YAGNI | 不引入 hooks 或全局压缩状态机 |
| active session 迁移原先只改 ID、不重算全局 status | 已修 P2 | 状态所有权 / 最小惊讶原则 | 显式 UI 迁移 helper + 合同测试 |
| 条件检查与写入原先分成两个 await | 已修 P2 | 并发正确性 / TOCTOU | store 内原子条件更新 + 可控交错测试 |
| 后台 run 终态原先能覆盖前台 status | 已修 P2 | 信息隐藏 / 并发隔离 | adapter 与 Web/TUI 均分开处理 run 记录和 workspace status |
| null active session 原先可能投影唯一后台 run | 已修 P2 | 空值语义 / 最小惊讶原则 | null 显式解析为无 active run + 归档合同 |
| 未建立 per-session progress 状态 | 合理取舍 | KISS / 错误抽象护栏 | 当前需求不值得扩 SDK/store/selectors |

### 5.5.4 第三次独立审查（本轮）

对照 `d56ee99` 与当前 adapter / in-process / Web·TUI reducer，结论如下。

上次 P2 已关闭：导航走 `setActiveSessionAndReconcileStatus`；status 写入用 store 同步 `updateStatusForActiveSession`；后台 run 终态不再覆盖前台。合同覆盖切到空闲 B、切到运行中 B、以及 TOCTOU 交错。

本轮复测：相关 8 个 unit 文件 **221 passed**；跨会话 contract 4 项 **passed**。全量 213 files 矩阵本轮未重跑。

残余不改结论：切回不重放 `Compacting...`（有意 KISS）；`submitPromptAndWait` 切 active session 不走 reconcile（短暂旧 status）；persistent-store 新方法无单独单测；Web `runtime.updated` 无 sessionId、依赖后端不乱 publish。

## 5.6 重要文件修改清单

| 文件 | 修改摘要 | 类型 |
|------|----------|------|
| [context-manager.ts](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts) | 实时重测带 tools；实际档位开始回调 | 修改 |
| [token-estimation.ts](../../../../packages/ohbaby-agent/src/core/context/token-estimation.ts) | 非空 tools JSON 进入 heuristic | 修改 |
| [context/types.ts](../../../../packages/ohbaby-agent/src/core/context/types.ts) | `PrepareTurnInput.tools` / `onCompactionStarted` | 修改 |
| [lifecycle.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts) | 先解析 tools；`prepareTurnWithProgress` race/yield | 修改 |
| [worker.ts](../../../../packages/ohbaby-agent/src/runtime/run-manager/worker.ts) | `run.context.compacting` 映射 | 修改 |
| [run-stream-adapter.ts](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts) | 自动压缩标题与 active-session status 写入守卫 | 修改 |
| [ui-inprocess.ts](../../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts) | active session 迁移后统一 reconcile runtime status | 修改 |
| [ui-state/types.ts](../../../../packages/ohbaby-agent/src/adapters/ui-state/types.ts) | 内部原子 active-session status 更新契约 | 修改 |
| [stream-bridge-run-event-source.ts](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/stream-bridge-run-event-source.ts) | 过程事件 round-trip | 修改 |
| [selectors.ts](../../../../apps/ohbaby-web/src/ui/selectors.ts) | live/running 时读取既有 title | 修改 |
| [eventReducer.ts](../../../../apps/ohbaby-web/src/api/daemon/eventReducer.ts) | 后台 per-run 事件不覆盖 Web 全局 runtime/reasoning | 修改 |
| [events.ts](../../../../packages/ohbaby-cli/src/tui/store/events.ts) | 后台 per-run 事件不覆盖 TUI runtime/reasoning | 修改 |
| 相关 `*.unit.test.ts` / contract | tasks A/B、失败清理、后台隔离、切换竞态、null 归档与跨会话回归 | 修改 |

## 5.7 后续事项

1. 用户最终审查时完成真实 provider + TUI/Web 手工观察，尤其是压缩中切换会话。
2. 在 context 占用监测/UI 实施前，先优化 `getContextUsage` 与手动 compact 的 messages-only 粗估。
3. cache 字段、命中率与成本统计继续在 improve-5 单独设计；不回填到 improve-4。
