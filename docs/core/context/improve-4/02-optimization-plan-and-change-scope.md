# 2. 优化方案与改动面

> 实施契约。完成事实与验证结果写入 05。
> 一套文档、两个先后任务：A = Phase 1 计量；B = Phase 2 自动压缩过程态。

---

## 2.1 方案总览

把「实时 Lifecycle 发给模型的那一次请求」当作占用测量事实：messages + tool schemas，用现有启发式与现有校准链路计量。压缩过程态不新开 Bus 订阅：Lifecycle 在实际自动 compact 档位确定后、任何 prune/summary 动作开始前，把 in-progress 事件交给现有 TUI/Web 运行状态。`getContextUsage` 与手动 compact 暂留 messages-only 粗估；现有总量占用条继续用。本批不改 provider cache usage、不加三类占比。

```
resolveTools
    │
    ▼
prepareTurn({ tools, onCompactionStarted })
    assemble → render messages
    total = estimate(wire messages + tools json) × factor
    decideCompactionRung(total)
    if rung is prune/prune-summary/force:
        onCompactionStarted()          // 只发信号；发生在 prune 前
        pruneHistory()
        generateSummary（仍有需要时）
    return prepared

Lifecycle（与上面并发，不是回调里 yield）：
    Promise.race(preparedPromise, compactingSignal)
      → 先收到信号：yield context:compacting（整个实际 compact 尚未完成）
      → prepareTurn 返回：yield context:prepared
    │
    ▼
streamChatCompletion(messages, tools)
    │
    ▼
updateCalibrationFactor(prompt_tokens, sentHeuristic)  // 保持 improve-3 现契约
    │
    ▼
UiContextWindowUsage { currentTokens, ... }   // 仍是总量；无 breakdown
```

---

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| 计数单一来源 | 算法=`estimateTokensForText`；占用入口=`measureUsage` | 已符合 goals-duty D2；improve-3 F9 | 再写一套 tokenizer；合并 mask 与 occupancy 为一个函数 | mask 仍用 domain 文本估 part，需在注释/文档写清「不是占用账」 |
| 工具谁解析 | Lifecycle 解析后传入 `prepareTurn` | ContextManager 不依赖 tool registry（SRP） | ContextManager 自己 resolveTools | Lifecycle 时序要改：tools 在压缩决策之前 |
| 静态/手动估算 | `getContextUsage` 与手动 compact 本批保持 messages-only | 两者缺少实时 agent/step/tools 上下文；避免扩 API 和触发动态解析副作用（KISS/YAGNI） | 本批让所有入口都 resolveTools | 同一产品暂有两档精度；须在占用监测/UI 前偿还 |
| provider cache usage | **本批不改** | 接口形状与服务端 cache 语义是不同维度；另立 improve-5 | 在本批预埋 cache 字段 | 暂不提供 cache 统计/成本估算 |
| factor 持久化 | **不写库**（00 已锁） | 重启后 1.0 起、随本进程 usage 重新生成 | `app_state` 一行 | 首轮未校准 |
| Bus ContextEvent | **不新增生产订阅** | 避免双通道；权威在 Lifecycle | UI 直接 subscribe Bus | mask dark ship 仍无生产观察；可后续加日志订阅，不阻塞本批 |
| 成功 compact notice | **不发** | 00 已锁；现有占用**总量**变化即成功信号 | info notice / token delta 粘底 | 用户不看到「Compacted」字样，只看到用量变 |
| compact 过程态 | **spinner，不是对话 message** | 手动路径已有；自动路径补 in-progress | 把摘要 LLM 插入 transcript | 自动压缩需一条非 transcript 的过程信号 |
| 占用三类 UI | **本批不做** | 00 已收口；先把总量和过程态做对 | 本批顺手加 breakdown 字段 | 用户仍看不到构成；后续批次补 |
| 存储 | SQLite 不动 | daemon 租约、part 级更新、逐 part compact | JSONL | 无 |

---

## 2.3 分阶段实施

两个任务按 A → B 实施，但保持独立验收与回滚；不再保留硬依赖待确认项。

### Phase 1 / 任务 A — Token counting 做准

**目标**：实时 Lifecycle 的占用**总量**包含即将发出的 messages + tools。现有 TUI/Web 总量条继续显示，只是补上此前遗漏的 tool schema。

**改动**

1. `PrepareTurnInput` 增加可选 `tools`（OpenAI-compatible tools JSON 形态，与 `streamChatCompletion` 一致）。
2. `lifecycle.ts`：非 final step 先 `resolveTools`，再 `prepareTurn({ tools })`；final step `tools=[]` 与发送一致。
3. `measureUsage` / `estimateWireHeuristic`：在 messages 之外加上 `JSON.stringify(tools)`（空数组则 0）。`sentHeuristic` 必须含 tools，否则 F1「分母钉死发出去的那份」再次被打破。
4. prune、summary candidate、projected context、final prepared context 的每一次重测都必须携带同一份 tools；overflow force retry 复用本 step 已解析的 tools，不再次 resolve。
5. `updateCalibrationFactor` 的 usage 语义与 EMA α=0.5 **本阶段不改**，避免把 cache 设计混入 tool schema 修复。
6. `composition.getContextUsage`、`composition.compactSession` 与 `ContextManager.compact` **保持现状**：不解析 tools、不扩展公开参数，估算明确为 messages-only。任务 A 不宣称修准这两条路径。
7. **禁止**本阶段扩展 cache usage、给 `ContextUsage` / SDK 加 `breakdown` 字段或修改占用展示文案。

**DoD**：见 04 场景 TC-1、TC-8、TC-11。

### Phase 2 / 任务 B — 自动压缩过程态（不 hooks）

**目标**：成功 = 现有占用总量重算后变化；过程 = spinner；失败 = warning。不接 Bus，不写 transcript，不加三类 UI。

**改动**

1. **不** `subscribe(ContextEvent.*)` 到 UI。
2. **保持** `noticeFromCompactResult` 对 `compacted` / `pruned` / `not-needed` 静默。禁止加成功 info notice。
3. 占用闭环：`context:prepared` 之后 `handleContextWindowUsage` 必须用压缩后的 `usage` 更新 tracker（现状已如此；任务 A 做准数字后这条才真闭环）。
4. **自动压缩过程态（后端必须通知前端）**：今天 `await prepareTurn()` 把完整 compact 操作包在一个 Promise 里。Lifecycle 是 async generator，**不能在普通回调里写 `yield`**（JS 语法不允许）。KISS 默认做法：
   - `prepareTurn` 增加 `onCompactionStarted?: () => void`。
   - `runCompaction` 先决定档位；`none/mask` 直接返回且不回调。其余实际执行档位在任何 `pruneHistory` / `generateSummary` 之前回调，因此纯 prune 与 prune+summary 语义一致。
   - Lifecycle 用 `Promise.race(preparedPromise, compactingSignal)`：先收到信号就 `yield { type: "context:compacting" }`，再 `await` 完 `prepareTurn`。
   - 溢出强制压缩（`lifecycle.ts` 里第二次 `prepareTurn({ force: true })`）走同一套。
   - `Promise.race` 必须处理“回调与 prepare 同一 tick 完成”的竞态，保证已触发回调时 compacting 事件不被 prepared 抢先。
   - 若 race 难测，允许拆成「计量+决定」和「真正执行」两步，让 Lifecycle 在中间 yield。不要为此引入 pi-style hooks。
   - worker 映射 `run.context.compacting`；UI adapter 把现有 `UiRunStatus.title` 设为 `Compacting...`。TUI 已消费该 title；Web 状态 pill 补充消费 title。`context:prepared` 到达后恢复普通 working，并用压缩后 `usage` 更新占用总量；若 prepare 提前失败，既有 terminal run 状态兜底清理。
   - **禁止**把摘要模型输出写成 assistant/user 消息，也禁止做成成功 notice。
5. 手动 `/compact`：保持 TUI `Compacting...`、Web `Compacting session`（已有 `command.started`）；成功后只刷新占用总量。
6. Bus 事件：本批 **保留发布**（mask dark ship / 单测），注明「非 UI 通道」。不删。

**DoD**：见 04 TC-4、TC-5、TC-9、TC-10。

### 后续批次（不是 Phase 3，本批无此阶段）

占用三类监测/UI：`ContextUsage.breakdown`、SDK 可选字段、TUI/Web 三行 `~`。分类已在 00 锁定为 KISS 三类。本批实施者若「顺手加上」，视为超出范围。

该后续批次进入实施前有一个明确前置任务：重新设计 `getContextUsage` 与手动 compact 如何获得与目标场景一致的 agent/step/tools 上下文，并把两者从 messages-only 粗估升级。此任务属于 context 占用监测/UI 的准备工作，不并入 improve-5 的 cache accounting。

---

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `core/context` | 无 breakdown 类型 | `token-estimation.ts`、`context-manager.ts`（tools 计入 heuristic；`onCompactionStarted`） | 无 | 回调位于非 `none/mask` 档位确定后、prune 前；不删 ContextEvent；不扩展占用分类字段 |
| `core/lifecycle` | `context:compacting` 事件类型 | `lifecycle.ts`：先 tools 再 prepareTurn；对 compacting **信号** `yield`（Promise.race 或拆步，禁止回调内 yield） | 无 | 解开「await 包住整个 compact 过程」 |
| `runtime/run-manager` | 映射 `run.context.compacting` | `worker.ts`、stream-bridge 类型 | 无 | 与 `run.context.prepared` 并列 |
| `adapters/ui-runtime` | 自动压缩 in-progress 事件投影到现有 spinner | 不改成功 notice 政策；`composition.getContextUsage` / `compactSession` 的 messages-only 行为不变 | 无 | 不解析动态 tools，不扩这两个入口的 API，不把摘要写入 transcript |
| `ohbaby-sdk` | 无 | **无**（`UiContextWindowUsage` 不加 breakdown） | 无 | 总量契约不变 |
| `ohbaby-cli` TUI | 无 | 无需产品代码改动；既有 WorkingSpinner 已读取 runtime title | 无 | **不改** `render/usage.ts` 展示形态 |
| `apps/ohbaby-web` | 无 | 状态 pill 在 live running 时读取既有 `UiRunStatus.title` | 无 | **不改** SDK 状态结构与用量展示组件形态 |
| `services/llm-model/tokenCounting.ts` | 无 | 无（算法不动） | 无 | 单一算法来源 |

---

## 2.5 API / 协议 / 迁移与兼容

- SDK `UiContextWindowUsage`：**不改**。仍是总量。
- JSON-RPC `getContextWindowUsage`：同一对象，无新方法。由实时 Lifecycle 更新 tracker 时数字会计入 tools；主动静态查询回填仍为 messages-only 粗估，调用方本批不得假定两者同精度。
- **自动压缩过程事件（新，向后兼容）**：
  - ContextManager：非 `none/mask` 实际档位确定后、prune 前调用 `onCompactionStarted`
  - Lifecycle：收到 compacting 信号后，在 generator 函数体 `yield context:compacting`（`Promise.race` 或拆步；禁止回调内 yield）
  - Stream bridge：`run.context.compacting`
  - 前端：只改 runtime spinner 标题，不 append transcript，不 append notice，不改占用条布局
  - 结束：仍用已有 `context:prepared` / `context.window.updated`，不另发明成功事件；终态 run update 负责异常/取消兜底
  - 溢出强制压缩第二次 `prepareTurn({ force: true })` 同样要发过程事件
- `InterfaceProviderTokenUsage`：**不改**。cache usage 留给 improve-5。
- 无 DB migration（factor 不写库）。
- 行为变化：实时 Lifecycle 占用**总量**会 **上升**（补上 tools），自动压缩可能比现在稍早触发。这是修正低估，不是阈值调整。静态 `getContextUsage` 与手动 compact 的估算数值本批不变。发布说明写清两档精度。

不可逆决策：**无**。字段可选、时序可回退、不改存储。

---

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 先 resolveTools 再 prepareTurn 造成额外延迟或循环 | tools 解析本就发生在每步；只是前移。测 step 延迟 | 恢复旧顺序，测量改为 prepare 后补算（压缩仍不含 tools，记入 05） |
| 占用数字突然变大引起「压缩变勤」投诉 | changelog 说明；阈值仍 0.95 | 可临时 feature flag 不计 tools（不建议默认） |
| 实施时顺手加三类 breakdown | 02/04 明确禁止；code review 卡 SDK/`usage.ts` | 删掉字段，只留总量 |
| 实时与静态/手动两档精度被误认为 bug 或同一契约 | API/发布说明明确数据来源；TC-11 固定本批边界 | 回退只影响任务 A 的实时 tools 输入，不通过扩大静态 API 临时补洞 |
| 在 `onCompactionStarted` 回调里直接 `yield` | 非法。Lifecycle 必须用 Promise.race（或拆步）在 **generator 函数体** 里 yield | 回退为无过程 spinner；压缩功能仍可跑 |
| 把“compact 开始”放在 `generateSummary` 前 | 纯 prune 不可见，语义错误 | 回调上移到实际档位确定后、prune 前；用纯 prune 与 `none/mask` 测试固定 |

---

## 2.7 与 00 边界对齐检查

- 本批不做三类占比：✓
- 不学 pi hooks：✓
- 不订阅 Bus 做 UI：✓
- 不换 SQLite：✓
- 不写 memory 工具 / hooks：✓
- factor 不写库，重启后从 1.0 重新生成：✓
- 成功 compact 不 notice，成功靠现有占用总量：✓
- compact 过程用 spinner，不写对话 message：✓
- 自动压缩后端必须发 in-progress 事件（非 notice、非 transcript）：✓
- Prompt cache 字段、启用、统计和预测均移出本批：✓
- 任务 A 只修实时 Lifecycle；`getContextUsage` / 手动 compact 暂留 messages-only：✓
- 静态/手动估算优化登记为占用监测/UI 的前置，不混入 improve-5：✓

---

## 2.8 不在本批

- 占用三类 breakdown 字段、SDK 扩展、TUI/Web 分类展示 / 占用监测面板（方向 3）
- `getContextUsage` / 手动 compact 的 tools-aware 估算（方向 3 实施前置；当前保留 messages-only）
- Prompt cache usage 字段、cache policy、命中率/成本统计、命中预测（独立 improve-5）
- 长期记忆工具 / hooks（方向 4）
- 打开 `maskEnabled`
- 删除 Bus `ContextEvent`
- 校准因子写库
- 成功 compact 的 info notice
- 把 compact 摘要插入 transcript
- EMA α 调整
- 精确 tokenizer
- dsh 式 event-sourced surface / shadow price / ContextMeter 圆环
- pi `firstKeptEntryId` 替换现有 part 级 `compacted` 标记
