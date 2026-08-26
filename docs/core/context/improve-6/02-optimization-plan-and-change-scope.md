# 2. 优化方案与改动面（后端契约）

> 交给后续实施会话。Web/TUI 交互见 [02-web-ui.md](./02-web-ui.md)、[02-tui.md](./02-tui.md)。行号为 2026-08-26 规划基线快照，定位以符号为准。

## 2.1 方案总览

在 **不改压缩阈值、不改 cache 请求策略、不改 inclusive occupancy 语义** 的前提下：

1. Lifecycle 每步解析出窄的 `ResolvedStepTools { definitions, requestTools }`；最终 `PreparedTurn` 确定后，计量点同时拿最终 `AssembledContext`、实际序列化 messages 与对应 definitions，用现有 `TokenCounter` 对七类分别估 token。内部压缩探针不重复计算 composition。
2. `ContextUsage` 保持纯粹，只表达压缩/预算控制总量；解释性 `ContextOccupancyComposition` 作为 `PreparedTurn` 与 `context:prepared` 的 optional 兄弟字段，经 UI adapter 映射到 `UiContextWindowUsage.composition`。顶栏/环百分比继续用校准总量。
3. **（下一轮）** Cache 走独立 `UiPromptCacheUsage`，**不**写入占用彩条字段；`/status` 增加 Cache 行。本批 `/status` 只读占用 composition。
4. **（下一轮）** cache 在 run 完成时按 00 §2.4 口径累加进 session 级 tracker，由 `/status` 读取；`/status` 不得依赖「用户碰巧开过面板」。

```text
resolvePromptTools → ResolvedStepTools { definitions, requestTools }
        │                                  │
        │                                  └─► PreparedModelRequest.tools（实际发送）
        ▼
history provenance + exact request envelope
        ├─► estimateCompositionHeuristic（七类，解释性）
        └─► estimatePreparedRequestHeuristic（总量，现有控制语义）
                │
                ▼
PreparedTurn { usage: ContextUsage, composition? }
        → context:prepared { usage, composition? }
        → run worker → stream bridge
                            ├─► stream-bridge-run-event-source（LifecycleEvent roundtrip）
                            └─► run-stream-adapter / tracker
                                    → UiContextWindowUsage { …existing, composition? }
                                                │
                                ┌───────────────┴────────────┐
                                Web 环/面板/`status`          TUI 继续只读总量
                                （下一轮 `/status` + UiPromptCacheUsage）
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| step-local 工具快照 | `ResolvedStepTools { definitions, requestTools }`，readonly、仅活到当前 step | 两者必须来自同一次解析；只有一个生产 resolver，改动面可控 | 平行参数；registry 反查；全局 side map；source 塞入 wire schema | 多一个窄 DTO；不得演化成 manager/cache |
| 分桶输入 | definitions + 实际 request + messages/history，不是 flattened tools 单独一份 | `toOpenAiTools` 丢 source，但占用必须按真正发送 envelope 量 | `JSON.stringify(ToolDefinition)`；按 tool name 反查 registry | 调用方必须成对传递快照 |
| 七类 key | 见 00 §2.1 | 对标 Cursor，且 summary/runtime/subagent 已有 provenance | 三类；Rules/Memory 行 | Skills 正文进 conversation；runtime 菜单归 System prompt |
| runtime 归因 | `model-context:runtime:v1` 归 `system-prompt`，wire role 不变 | 内容由 Ohbaby 生成；占用归因不等于 provider role | 继续归 Conversation；移动到 `role: system`；解析 runtime XML 再细拆 | MCP lazy menu 本轮也归 System prompt |
| `module` | 并入 `builtin-tools` | 生产无 module 工具 | 第八行 | 将来 module 不可见为独立类 |
| 总量 vs 组成 | Web 条长=校准总量%；段宽=组成相对比例；Web 总量/分类数字标 `~`；TUI 保持既有总量格式、不标 `~` | 学 dsh；同时保持已回归的 TUI 契约 | 强制七类加总=currentTokens；为表面统一改 TUI formatter | 用户看到「对不齐」需 Web `~`；存在有意的平台显示差异 |
| composition 所在层 | `ContextUsage` 不变；composition 放 `PreparedTurn`/事件兄弟字段，由 adapter 投影 | 防止 UI 解释字段反向影响压缩控制 | 把 buckets 塞进 `ContextUsage` | 事件/adapter 多传一个 optional 字段 |
| Cache 类型（下一轮） | 独立于 `UiContextWindowUsage` 展示字段 | 00；cache 与占用是两种事实 | 塞进 occupancy | `/status` 多一个读取口 |
| Cache 口径（下一轮） | **session aggregate 唯一显示**；run aggregate 后端计数作原料、前端不显示 | 00 §2.4；dsh StatsLine | last-step 百分比；双口径并显 | 需新增 session 级累加器 |
| 命中率公式（下一轮） | Cache-Read Share：`ΣcacheRead / Σ(uncached+cacheRead+cacheWrite)`；无 `observed.cacheRead` 或无任何可信数据 → `—`，不得显示 0% | 知识库公式；improve-5 observed 语义 | 缺字段当 0%；分母不含 cacheWrite | 分母含 write 防冷启动抖动 |
| 子代理 | 主窗口只计 `subagent_*` call arguments + result/status/close | 00 的 exchanges | Cursor definitions；child transcript | schema 仍在 Built-in tools |
| TUI 本轮 | footer 与 `/status` 都只显示现有总量；忽略 optional composition | 四个参考都把常驻 TUI 保持紧凑；先验证 Web | 同步做七行/ASCII 条；新 `/context` | TUI 暂无分类能力，后续按反馈另议 |
| SDK 兼容 | 旧字段保持必填；本轮 `composition` optional；下一轮独立 cache 类型/字段也必须 optional | 旧客户端忽略新字段；两批契约不混为一个对象 | 打破 snapshot 合同 | 各批合同测试都必须允许缺省 |

## 2.3 分阶段实施

### Phase A · 组成计量（后端）

- 目标：保留 `measureUsage` 的现有总量语义；只对最终 `PreparedTurn` 对应的 final context/request 一次性产出七类启发式；`ContextUsage` 不增 buckets。
- 改动：`token-estimation.ts`、`context-manager.ts`、`types.ts`；Lifecycle/composition 在 flatten 边界产出 `ResolvedStepTools`，把 definitions 与实际 request tools 成对传给 Context；`context:prepared` 同级携带 optional composition。
- 规则：summary 读现有 `context-summary` provenance；runtime 读 `isModelContextPart`；subagent 在 part/tool-call 粒度切分，不能把同一 assistant message 的普通文本一并归入 exchanges。自动压缩时必须基于压缩、二次 reduction 后的 final request 计算，禁止从 unreduced/compact probe 复用旧明细。
- DoD：unit 覆盖七类规则、module 并入 builtin、skill schema≠SKILL.md 正文、summary/runtime/subagent 边界、definitions/requestTools 同步；总量测试不回退。

### Phase B · SDK 占用契约

- 目标：`UiContextWindowUsage.composition` optional；event/snapshot/contract 允许并断言有则形状合法。
- 改动：`ohbaby-sdk/src/context-window.ts`、`events.ts`、`snapshot.ts`、`context-window.contract.test.ts`。
- 推送：`context:prepared` 的 composition 先由 `runtime/run-manager/worker.ts` 白名单序列化到 stream bridge，随后分两路显式消费：`run-stream-adapter.ts` 直接读取 raw bridge event 并交给 tracker；`stream-bridge-run-event-source.ts` 独立重建 LifecycleEvent，供 event-source/runAgent 路径使用。两条是并行分支，不得误接成串行主链。手动 compact 或任何 total-only tracker update 都以整对象覆盖并清旧 composition；cache-miss static get 只产生 total-only，cached static get 保持已有快照，不改 getter 控制流；下一次 prepare 再补齐。
- DoD：无 composition 的旧 payload 仍可解析；有 composition 时七 key 齐全、非负整数；worker→bridge→UI tracker 与 bridge→LifecycleEvent roundtrip 两条分支都不丢字段；total-only 更新会清掉旧 composition。

### Phase C · Cache 通道 + `/status` Cache 行（**下一轮实施**，本批不动代码）

- 目标：session 级 cache 累加器；`/status` data 增加 Cache 行（`Cache hit 61%` / `Cache hit —`）。
- 改动：新窄模块（session 级累加，输入为 run 完成时的 `LifecycleTokenUsage`）；`commands/builtin.ts` `handleStatus` 增加 `promptCache` 字段。
- 语义：`usageComplete=false` 或无 `inputBreakdown` 的轮**跳过累加**，内部记 `incompleteRuns`；session 桶继续显示已有累计。
- DoD：见 04 §4.7（下一轮测试清单）。

### Phase D · Web UI

- 见 [02-web-ui.md](./02-web-ui.md)。依赖 A+B。本批 `/status` 卡片只含占用详情，不含 Cache 行。

### Phase E · TUI 兼容回归（无新分类 UI）

- 见 [02-tui.md](./02-tui.md)。底栏与 `/status` 格式不变；optional composition 到达 SDK 后，TUI 继续只读总量。本 Phase 只有回归验证，不新增 ASCII 分类 renderer。

### Phase F · 权威文档同步

- `docs/core/context/{architecture,data-model,goals-duty}.md`；重写或标注 `docs/ui/components/status-bar.md` 过时并改为指向现码。

A 必须先于 B；D 不得在 A 的 unit 未过时接假数据。E 可与 B 契约回归一起完成。C 整体属于下一轮，不阻塞本批发布。

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `ohbaby-agent/src/core/context/` | composition 估计算子/类型 | `token-estimation.ts`、`types.ts`、`context-window-usage.ts`、`context-manager.ts` | 无 | 单一总量入口仍是 `measureUsage`；composition 与 ContextUsage 分离 |
| `ohbaby-agent/src/core/lifecycle/` | `ResolvedStepTools` 类型 | `types.ts`、`lifecycle.ts` | 无 | 每 step 同步持有 definitions + requestTools，不新增状态服务 |
| `ohbaby-agent/src/adapters/ui-runtime/` | — | `composition.ts`、`stream-bridge-run-event-source.ts`、`run-stream-adapter.ts` | 无 | resolver 产窄快照；bridge 重建与主推送路径投影 composition |
| `ohbaby-agent/src/runtime/run-manager/` | — | `worker.ts` | 无 | `run.context.prepared` 白名单序列化显式携带 optional composition |
| `ohbaby-agent/src/commands/` | — | 本轮原则上无需为 composition 修改 `handleStatus` | 无 | `/status` 已透传 tracker 的 `UiContextWindowUsage`；`promptCache` 下一轮再改 |
| `ohbaby-sdk/` | — | `context-window.ts`、events、snapshot | 无 | optional 字段（cache 类型下一轮） |
| `apps/ohbaby-web/` | 环/popover 小组件 | `App.tsx`、`selectors.ts`、`slashCommands.ts` | 无 | 见 02-web |
| `ohbaby-cli/src/tui/` | 无 | 原则上无生产改动；必要时仅兼容类型 | 无 | 见 02-tui；底栏和 `/status` 均保持总量 |

## 2.5 API / 协议 / 迁移与兼容

建议占用 composition 形状（字段名实施时可微调，key 必须与 00 一致）：

```ts
interface UiContextOccupancyComposition {
  readonly "system-prompt": number;
  readonly "builtin-tools": number;
  readonly mcp: number;
  readonly skills: number;
  readonly conversation: number;
  readonly "summarized-conversation": number;
  readonly "subagent-exchanges": number;
}

interface UiContextWindowUsage {
  // 现有必填字段不变
  readonly composition?: UiContextOccupancyComposition;
}
```

下一轮 cache 批次建议形状（**本批不实现**，session aggregate 口径，见 00 §2.4）：

```ts
interface UiPromptCacheUsage {
  readonly sessionId: string;
  readonly estimatedAt: string;         // session 累加器最后一次更新的时间
  readonly totalInputTokens: number;  // Σ(uncached + cacheRead + cacheWrite)
  readonly cacheReadTokens: number;   // ΣcacheRead
  readonly cacheReadShare: number | null; // 0–1；null = 尚无可信数据 → UI 显示 "Cache hit —"
  readonly incompleteRuns: number;    // 跳过的不完整轮计数（排查用，前端不显示）
}
```

内部建议形状：

```ts
interface ResolvedStepTools {
  readonly definitions: readonly ToolDefinition[];
  readonly requestTools: ChatCompletionCreateParams["tools"];
}

interface PreparedTurn {
  readonly usage: ContextUsage;
  readonly composition?: ContextOccupancyComposition;
  // 其余现有字段不变
}
```

`ResolvedStepTools` 不是持久模型，不进入 SDK；`requestTools` 是唯一发送事实，definitions 只提供同一步 provenance。final step 禁用工具时两者同时为空。旧 `LifecycleSessionParams.tools` 若携带非空 flattened schemas、却没有 definitions，则总量仍可测但 composition 整体省略。

`/status` data 本批在现有 `contextWindow` 上透传带 composition 的 usage；下一轮新增 `promptCache` 对象。旧 TUI 只读 `currentTokens`，无需理解 composition。

无存储迁移。进程重启后 composition 与现有占用 tracker 一样从内存空开始，随下一次 prepare/step 填充；manual compact 或其他 total-only tracker update 后先回到 total-only，避免旧明细。cache-miss static get 同样只产 total-only；cached static get 返回已有快照，不额外清理。下一轮 session cache 累加器同为内存级，重启归零（与 dsh 持久日志投影不同，可接受，下一轮再评估是否持久化）。

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 七类加总 ≠ 总量被当成 bug | Web UI `~`；测试断言的是规则不是等式 | 隐藏 composition，总量条保留 |
| 把 SKILL.md 误计入 Skills | 正文只走 tool result → conversation；单测锁死 | — |
| runtime 因 wire role 被误算 Conversation | 明确按 `isModelContextPart` 归因；不移动真实 message | 回退总量-only |
| 自动压缩后仍展示压缩前组成 | 只对 final context/request 计算一次；集成测试覆盖 summary 与被裁剪 parts | 临时隐藏 composition |
| compact 后沿用压缩前 composition | total-only 更新覆盖旧值；下一 prepare 重算 | 临时隐藏 composition |
| Context 去查 tool registry | 禁止；definitions 由调用方传入 | — |
| SDK 合同过严导致旧 snapshot 失败 | composition optional | 字段改为完全忽略 |
| （下一轮）cache `—` 误报为 0% | helper 要求 observed；分母含 cacheWrite | `/status` 不加 Cache 行 |

## 2.7 与 00 边界对齐检查

- 七类英文名、Skills 目录 vs 正文、summary、runtime 归因、Subagent exchanges、module 并入、Web 环、TUI total-only、cache 不进彩条：均落入 2.2–2.3 与 02-web/02-tui。
- 本批只有 Web `/status` 展示七类；TUI `/status` 保持总量。Cache 行下一轮（00 §2.4 已冻结设计）。
- 不做：子代理主 UI、精确 tokenizer、压缩阈值、价格、Rules/Memory 行。

## 2.8 不在本批

与 00 §3 相同，另加：不为 `/status` 或 `/context` 新建 TUI 命令；不做 TUI 七类/ASCII 条；不把 kimi 式 cache/input/output **计费条**当成占用组成；不把 runtime prompt 改造成 typed contribution；**cache 实施整体属下一轮**（session 累加器、`UiPromptCacheUsage`、`/status` Cache 行），本批仅冻结其设计。

## 2.9 关键改动清单

> 行号为规划基线快照，定位以符号为准。本表不是进度表；实施中不勾选、不回写。ID 跳号说明：原 C10（`InputTokenBreakdown` helper）已随 cache 批次移入下方 N 表（N4），C 表不再含 C10。

| ID | 类型 | 路径 | 符号/小节 | 行号快照 | 要改什么 | 为何承重 |
|----|------|------|-----------|----------|----------|----------|
| C1 | 代码 | `packages/ohbaby-sdk/src/context-window.ts` | `UiContextWindowUsage` | L1–7 | 增加 optional composition；不把 cache 放进此类型 | UI/SDK 合同 |
| C2 | 代码 | `packages/ohbaby-agent/src/core/context/token-estimation.ts` | `estimatePreparedRequestHeuristic` | L3–13 | 保留总量函数；新增分桶估算，共用 TokenCounter | 组成数字源头 |
| C3 | 代码 | `packages/ohbaby-agent/src/core/context/context-manager.ts` / `types.ts` | `assembleModelRequest` / `measureContext` / `PreparedTurn` | L429–525, L1506–1630 / L192–200 | 同一步 definitions 只在 final context/request 确定后计算一次 composition；不让内部 compact probes 重复扫描；composition 与 ContextUsage 分离 | 最终请求一致性与内部契约 |
| C4 | 代码 | `packages/ohbaby-agent/src/core/context/context-window-usage.ts` | `contextUsageToContextWindowUsage` / tracker update | L24–75 | adapter 映射 optional composition；total-only 更新清旧 composition | 防 stale UI |
| C5 | 代码 | `packages/ohbaby-agent/src/core/lifecycle/types.ts` / `lifecycle.ts` | `LifecycleDeps.resolveTools` / step loop | L28–33 / L353–398 | resolver 返回窄 `ResolvedStepTools`；final step 成对清空 | 保证 source 与实际发送 schema 同步 |
| C6 | 代码 | `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts` | `resolvePromptTools` / Lifecycle `resolveTools` | L355–388, L511–519 | 从同一 definitions 构造并返回 requestTools，不加 side map | 唯一生产 resolver |
| C7 | 代码 | `packages/ohbaby-agent/src/core/message/origin.ts`；`packages/ohbaby-agent/src/core/context/serializer.ts`；`packages/ohbaby-agent/src/core/message/types.ts` | `isModelContextPart` / summary serialization / `ToolPart.tool` | L3–35 / L98–167 / ~L96 | 复用 provenance 做 summary/runtime/subagent part-level 分类，不改持久模型 | 七类消息边界 |
| C8 | 代码 | `packages/ohbaby-agent/src/runtime/run-manager/worker.ts`；`packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts`；`packages/ohbaby-agent/src/adapters/ui-runtime/stream-bridge-run-event-source.ts` | `context:prepared` publish / `handleContextWindowUsage` / bridge reconstruction | L366–383 / L506–525 / L252–269 | worker 写入 bridge 后分叉：raw event→UI tracker；独立 event source→LifecycleEvent roundtrip。两路都透传 usage + composition，并分别测试 | 防字段中转丢失，避免误画串行链 |
| C9 | 代码 | `apps/ohbaby-web/src/ui/App.tsx` | `StatusBar` / `StatusCommandResult` | L1273–1312, L1646–1663 | 环+hover+click；七类卡片详情（无 Cache 行） | Web 产品面 |
| D1 | 文档 | `docs/core/context/architecture.md` | §八 UI projection | L155–161 | 登记 composition 投影；注明 cache 通道下一轮 | 权威架构 |
| D2 | 文档 | `docs/core/context/data-model.md` | occupancy 节 | ~L103–109 | 登记 composition 派生字段 | 权威模型 |
| D3 | 文档 | `docs/ui/components/status-bar.md` | 全文 | L1–94 | 与现码对齐或标明 superseded，改指向 Web/TUI 现实现 | 过时文档会误导实施 |

### 下一轮 cache 批次承重项（本批不动）

| ID | 类型 | 路径 | 符号/小节 | 行号快照 | 要改什么 | 为何承重 |
|----|------|------|-----------|----------|----------|----------|
| N1 | 代码 | `packages/ohbaby-agent/src/commands/builtin.ts` | `handleStatus` | L253–265 | data 增加 `promptCache`（`UiPromptCacheUsage`，§2.5） | cache 唯一出口 |
| N2 | 代码 | `packages/ohbaby-agent/src/core/lifecycle/token-usage.ts` | `aggregateTokenUsage` / `LifecycleTokenUsage` | L41–67 | run 聚合（已存在）作为 session 累加原料；勿用 title/summary usage | 累加原料 |
| N3 | 代码 | 新窄模块（session cache 累加器） | — | — | run 完成时累加进 session 桶；`usageComplete=false` 跳过并记 `incompleteRuns` | session 口径核心 |
| N4 | 代码 | `packages/ohbaby-agent/src/services/interface-providers/types.ts` | `InputTokenBreakdown` | L40–48 | 只消费，不改语义；导出 Cache-Read Share helper（分母含 cacheWrite） | cache 事实源 |
| N5 | 代码 | `ohbaby-sdk` | 新 cache 类型文件 | — | `UiPromptCacheUsage`（§2.5） | SDK 合同 |
| N6 | 代码 | `apps/ohbaby-web` / `ohbaby-cli` | `/status` 卡片与面板 | — | 增加 `Cache hit {n}%` / `Cache hit —` 单行 | 前端显示 |

### 连带影响面（不逐行列出）

- `packages/ohbaby-agent/src/core/agents/runner.ts` `toOpenAiTools`：保持 wire schema 无 source，只由生产 resolver 调用。
- `packages/ohbaby-agent/src/skill/tool.ts`、`src/tools/subagent.ts`：分类规则的名字常量应对齐工具名。
- `apps/ohbaby-web/src/ui/selectors.ts`、`slashCommands.ts`；`ohbaby-cli/src/tui/render/usage.ts` / `status-panel.ts` 只做回归、不加分类。
- `ohbaby-sdk/src/events.ts` `UiContextWindowUpdatedEvent`、`snapshot.ts` `contextWindowUsages`、`context-window.contract.test.ts`。
- `ui-inprocess.ts` manual compact / cache-miss static get usage 后 `context.window.updated`（~L1764–1807）：total-only 更新省略 composition；cached static get 保持已有 tracker 快照。
- `docs/core/context/goals-duty.md` 补一句：composition 是 occupancy 投影，cache 不是 Context 的 vendor 解析职责。
