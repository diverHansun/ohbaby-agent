# 2. 方案与改动面

> 本文是给实施会话的执行契约。决策来源见 [00](00-discussion.md)，现状证据见 [01](01-problem-analysis-and-current-state.md)，验收见 [04](04-test-and-acceptance.md)。路径缩写同 01。2026-11-06 经子代理审查修订。

## 2.1 方案总览

run 已经是后端真正的执行单位，只是缺两样信息：什么事件开启了它、它怎么结束的。本方案在创建 run 时写下触发来源，把触发来源和结局交给前端，再让 Web 和 TUI 按 run 划分一轮。prompt 退回到“一轮的可选附属信息”：有就用它的时间和插话信息，没有也照样成一轮。

```
创建 run                           视图                               界面
─────────                          ────                               ────
用户发消息      ─┐ trigger=user                                       每个有消息、已结束的主会话 run = 一轮
goal 续跑       ─┼─ trigger=goal ─► run_ledger ─► UiRun {              ├─ 最终答案：沿用现有规则
子代理唤醒      ─┤ trigger=subagent    .trigger     trigger            ├─ 折叠：outcome = succeeded 等条件
goal 期间唤醒   ─┘ trigger=subagent                  outcome }         ├─ 耗时：有 prompt 用 prompt，否则用 run
（提交方 owner 照旧，单独决定权限、todo 作用域、driver）               ├─ 复制：挂在答案上；常显跟最后一轮
                                                                      └─ trigger = subagent：Subagent update · Total Xs
视图里的 run = 已加载消息涉及的主会话 run + 运行中的主会话 run（新的在前）
翻历史时返回该页涉及的主会话 run
```

### 顺带的轻微调整

用户要求顺带修正不合理的地方，只做小改动。本方案包含四处，都在 Stage 1：

| 现状 | 调整 | 理由 |
|---|---|---|
| 账本的 `TriggerSource` 只有 `"user"`，runner 和当前轮输入的读取各自写死 `"user"`（01 §1.3） | 扩成 `"user" \| "goal" \| "subagent"`，创建 run 时按实际来源写入，读取时用真实值 | 不再有写死的假值。提交方 `PromptOwner` 保持独立，它和触发来源取值相同但含义不同（01 §1.2） |
| 按触发来源取的默认策略表是 `Partial`，少配一项要到运行时才抛错（01 §1.3） | 策略表改为每个触发来源都必须有一项（`Record` 而不是 `Partial<Record>`），三项都用现在 `user` 的配置 | 新增来源时类型检查就能发现漏配 |
| 视图先取最近 50 个 run 再过滤子代理作用域，子代理的 run 白白占名额（01 §1.4） | 账本查询直接按主会话过滤，视图里的 run 跟着已加载消息走 | 和 prompt 的取法一致，名额问题随之消失 |
| `UiRun.status` 把成功和取消都抹成 `idle`，前端只能借 prompt 判断成败（01 §1.3） | 增加可选的 `outcome`，`status` 不变 | 判断留给有信息的后端，不改动别处依赖的 `status` |

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 一轮的单位 | 主会话（`contextScopeId` 为空）里**有消息**的一个 run；没有任何消息的 run（中途失败、被打断）不成为一轮 | run 有持久化的边界和状态；一个 run 正好一个 lifecycle turn（01 §1.1）；没有消息的 run 没有内容可显示，也没有位置可挂耗时行 | 继续按 prompt（漏掉唤醒和 goal 续跑）；把一条用户消息之后的几轮合成一次“交流”（00 §4 不做） | 投影的键从 prompt 换成 run，fixture 要改 |
| 触发来源怎么定 | 在 `submitPromptWork` 里算：带 `subagent-status` 运行时输入的记 `subagent`，否则等于提交方（`user` 或 `goal`）。经 runner 写入 `run_ledger.trigger`，通过 `UiRun.trigger` 交给前端 | “什么事件开启了这一轮”只有提交时知道；goal 期间的子代理唤醒提交方是 `goal`，但开启这一轮的是子代理（01 §1.2）。参考 ZCode `origin`、kimi-code `PromptOrigin`、codex `turn_trigger` | 直接拿提交方当触发来源（goal 期间的唤醒会标错）；前端从消息内容猜（每个读取方都要猜一遍） | 一个小函数 |
| 提交方 | `PromptOwner` 不变，继续决定修改上下文、todo 作用域和 `driver` | 它和触发来源是两件事 | 合并成一个类型 | 无 |
| 子代理自己的 run | 子代理作用域的 run 照旧记 `user`，本轮不区分 | 它们不在主会话里投影，不影响本议题；区分它们是另一件事 | 新增 `subagent-child` 等取值 | 账本里子代理的 run 仍记为 `user`，在 run 账本文档里注明 |
| 默认策略 | `DEFAULT_RUN_POLICY` 给 `goal`、`subagent` 各配一项，内容与 `user` 相同（`interactive`、`reject`、`continue`）；策略表类型改为必须覆盖每个触发来源 | 否则 `mergeRunDefaults` 在运行时抛错，goal 续跑和子代理唤醒全部失败（01 §1.3）；`reject` 保证主会话同一时间只有一个运行中的 run | 在 `mergeRunDefaults` 里回退到 `user`（掩盖漏配） | 测试里构造的策略也要补齐 |
| 结局 | `UiRun.outcome?: "succeeded" \| "failed" \| "cancelled" \| "interrupted"`，直接取账本状态；进行中的 run 没有这个字段 | 前端需要“是否成功结束”，现在的 `status` 把它抹掉了；后端本来就有 | 改 `UiRunStatus` 的取值（影响面大，别处靠 `idle` 判断空闲） | `UiRun` 多一个可选字段 |
| 旧数据 | 不迁移。前端兜底：`trigger` 为 `user` 但没有对应 prompt、且 run 里有 `subagent-status` 或 `subagent-result` 输入的，按 `subagent` 显示 | 旧会话也能显示对；规则只在投影里一处 | 写迁移回填（要扫消息内容，不值得） | 兜底规则以后可删 |
| 视图里的 run | 主会话视图返回“已加载消息涉及的主会话 run + 运行中的主会话 run”，**按新的在前排序**；视图裁剪消息时，run 一起裁到只剩“保留下来的消息涉及的 + 运行中的”；`UiSessionHistory` 增加 `runs`，翻历史时返回该页涉及的主会话 run | 和 prompt 的取法一致（01 §1.4）；长会话往上翻也能折叠和复制；保持新的在前，`seed` 选“最近一个 run”的逻辑不用改 | 调大上限（只是推迟问题）；改成按开始时间升序（会让 `seed` 选到最老的 run） | 账本查询要能按主会话过滤、按 ID 批量取；run 提供方要拿到已加载消息的 run ID |
| 轮次顺序 | 视图里的 run 保持新的在前；前端投影时按 run 的开始时间升序排列轮次 | 顺序是展示需要，由展示方决定 | 让后端改顺序 | 无 |
| 折叠条件 | 把“`prompt.status === "succeeded"`”换成“`run.outcome === "succeeded"`”；`outcome` 缺失时用 prompt 的状态代替，都没有就不折叠；定稿、无插话、有过程或思考等其余条件不变 | 2026-09-29 折叠议题的其余规则仍然合理；Web 与 daemon 一起发布，不另写一套兼容旧后端的投影（00 P11） | 重写折叠逻辑；为旧后端保留整条按 prompt 的路径 | 无 |
| 耗时 | 有 prompt 的轮次照旧用 prompt 的 `acceptedAt ?? createdAt` 到 `endedAt`；没有 prompt 的用 run 的 `startedAt` 到 `endedAt`；状态文字按 `outcome`（缺失时按 prompt 的状态） | 普通轮次显示不变，只补缺的 | 一律改用 run 的时间（普通轮次的数字会微变，无收益） | 耗时组件改成接收“时间和结局”，不再直接接收 prompt |
| 子代理标签 | `trigger` 为 `subagent` 的轮次，耗时行显示 `Subagent update · Total 12s` 这样的格式；goal 续跑不加标签 | 和 ZCode 的“后台结果”标题、deepseek-harness 的触发节点一致；goal 续跑已经有一条显示 goal 文字的用户消息 | 给每种来源都加标签 | 无 |
| 常显的复制行 | 挂在最后一个已结束轮次的最终答案上；有轮次在运行时不常显 | 与消息复制议题一致，只是轮次的来源变了 | — | 无 |
| TUI | 耗时行按 run 生成、按 `runId` 去重；规则与 Web 相同；子代理触发的显示同样的标签；翻历史时合并该页的 run | 和 Web 同一套规则 | TUI 加折叠、复制（不在本议题） | 无 |
| 组件名 | Web 的 `PromptDuration`、TUI 的 `PromptCompletion` 不改名，只在注释里说明现在按 run 工作 | 改名牵涉 20 多处引用，和目标无关（00 P12） | 改成 `TurnDuration` 等 | 名字和含义略有出入 |
| 折叠控件 ID | 用 `runId` 代替 `promptId` | 没有 prompt 的轮次也要有稳定 ID | — | 无 |

## 2.3 分阶段实施

全部 Stage 都属于 improve-1。每个 Stage 结束时 `pnpm typecheck`、`pnpm lint` 和相关测试保持通过。

### Stage 1：后端

**目标**：每个 run 都记下正确的触发来源；视图和事件里的 `UiRun` 带 `trigger` 和 `outcome`；视图和历史返回已加载消息涉及的主会话 run。

**改动**：

1. **触发来源与默认策略**
   - `A/runtime/run-ledger/types.ts`：`TriggerSource` 改为 `"user" | "goal" | "subagent"`。
   - `A/runtime/run-manager/types.ts`：`RunDefaultsPolicy.defaults` 改为 `Readonly<Record<TriggerSource, RunDefaults>>`。
   - `A/adapters/ui-runtime/composition.ts`：`DEFAULT_RUN_POLICY` 补上 `goal`、`subagent`，内容与 `user` 相同。各测试里构造的策略一并补齐。
   - 触发来源从提交一路传到创建 run：`A/adapters/ui-inprocess.ts` 的 `submitPromptWork` 按 2.2 的规则算出触发来源 → `A/agents/service.ts` → `A/core/agents/types.ts` 的 `AgentTurnInput`、`AgentRunCreateOptions`（入参从写死的 `"user"` 放宽为 `TriggerSource`）→ `A/core/agents/instance.ts` → `A/core/agents/runner.ts`（:239 不再写死）。子代理派生子 run 的路径（`A/agents/subagent-host.ts:1837` 附近）照旧传 `user`。
   - `A/runtime/prompt-scheduler/current-run-inputs.ts:825` 读 run 时用真实的 `trigger` 列。
   - 账本读写（`database.ts`、`in-memory.ts`）原样存取新值。旧行全是 `user`，不迁移。
2. **`UiRun` 字段**
   - `K/contract/snapshot.ts` 的 `UiRun` 增加 `trigger?` 和 `outcome?`（见 2.5）。
   - `A/adapters/ui-state/persistent-store.ts` 的 `runToUiRun` 和 `A/adapters/ui-inprocess.ts` 的 `projectRunRecord` 填上这两个字段；`outcome` 只在账本状态为终态时给出。
   - `run.updated` 事件里的 run 走同一个投影；确认 `A/adapters/ui-state/source-session-projection.ts` 的增量合并保留新字段。
3. **账本查询**
   - `listBySession` 增加只取主会话 run 的选项，在 SQL 里过滤 `context_scope_id IS NULL`，不再先取再滤。
   - 新增按 ID 批量查询（例如 `listByIds(sessionId, runIds)`），SQLite 和内存实现都要有。
   - 取运行中 run 的地方按主会话过滤：`getActiveRuns(sessionId)` 也会返回子代理作用域的 run（01 §1.4），调用时加上过滤或给它加同样的选项。
4. **视图里的 run**
   - `source-session-projection.ts` 的 `seed`：先用“只取主会话、取 1 个”的查询或运行中的主会话 run 选出最近一个 run（逻辑与现在相同，只是不再受子代理 run 干扰），装载它的消息；消息装载完后，再按已加载消息的 run ID 批量取 run，并上运行中的主会话 run，**按新的在前排序**作为视图的 run 列表。
   - run 提供方的签名相应改为能拿到 run ID 列表（例如 `runs(sessionId, runIds)`），`ui-inprocess.ts:780-789` 照此实现，不再用 `limit: 50`。
   - `run.updated` 增量合并时不再截断到 50 个；`trim()`（:499-539）裁剪消息时，run 列表一起裁到“保留下来的消息涉及的 + 运行中的”。
   - 翻历史：`K/contract/session-view.ts` 的 `UiSessionHistory` 增加必填的 `runs`；`source-session-projection.ts` 的 `history()`（:582-610）返回该页消息涉及的主会话 run。子代理执行和作用域历史（`source-session-projection.ts:544-578` 附近）返回 `runs: []`。
   - 传输层已核实：Web 的 `http.ts:279-291`、JSON-RPC 客户端、服务端 `session-access.ts:177` 都原样透传历史响应，没有逐字段挑选，不需要改。
5. **测试**：见 04 的 T1 至 T6。

**完成定义**：04 的 T1 至 T6（含 T1b）通过。

### Stage 2：Web

**目标**：Web 按 run 划分一轮；子代理唤醒和 goal 续跑的轮次能折叠、有耗时行和复制按钮，子代理触发的带标签。

**改动**：

1. **store 与数据流**
   - `W/store/store.ts`：像 `loadedPrompts` 一样保存翻历史拿到的 run（例如 `loadedRuns`），与视图里的 run 按 ID 合并，视图优先。`W/api/daemon/eventReducer.ts` 对 `run.updated` 的处理保持按 ID 更新。
   - `W/ui/session/selectors.ts` 提供本会话的全部 run；`SessionConversation` 把它交给 `ConversationStream`（新增 `runs` 入参）。`activeRun` 保持原样。
2. **投影**
   - `W/ui/conversation/run-process.ts`：`projectRunProcesses` 改为以 run 为键。入参增加 `runs`；对每个本会话、已结束（有 `endedAt`）、并且至少有一条消息的主会话 run，关联 `runId` 相同的 prompt（可以没有），按 run 的开始时间升序排列。
   - `RunProcess` 携带 `run`、可选的 `prompt`、`trigger`（含旧数据兜底）、耗时用的开始与结束时间和结局；`answerId`、`processIds` 的算法不变；`afterId` 在没有 prompt 时用该 run 的最后一条消息。
   - 折叠条件按 2.2。
   - 旧数据兜底要看被隐藏前的消息（子代理运行时输入在 `ConversationStream.tsx:97-103` 已被过滤），所以投影接收未过滤的消息，或由调用方在过滤前算好兜底标记再传入。
3. **显示**
   - `W/ui/conversation/ExecutionProgress.tsx`：`PromptDuration` 改为接收“开始时间、结束时间、结局、结束时间来源、可选标签”，不再直接接收 prompt。标签为 `Subagent update` 时显示为 `Subagent update · Total 12s`。
   - `ConversationStream.tsx`：`runKey` 不变（本来就是 `[sessionId, runId]`）；折叠控件 ID 改用 `runId`；复制的 `answerIds` 和常显行沿用现有逻辑，数据换成按 run 的投影。
   - `W/dev/mock-runtime.ts` 补一个带子代理唤醒轮次的场景，便于走查。
4. **测试**：见 04 的 T7 至 T14。

**完成定义**：04 的 T7 至 T15（含 T7b）通过（T15 为浏览器走查）。

### Stage 3：TUI

**目标**：TUI 的耗时行按 run 生成，子代理触发的带标签。

**改动**：

1. `T/store/transcript.ts` 的 `appendPromptCompletions`：对每个有消息、已结束的主会话 run 生成一行耗时，按 `runId` 去重（原来按 `promptId`）；插入位置规则不变（恢复会话时插在这一轮最后一条消息之后，平时追加在末尾）。时间与结局规则与 Web 相同。
2. TUI store 已经保存 run（`T/store/events.ts:79, 201, 570`），确认 `run.updated` 带上新字段。
3. `T/session-recovery.ts` 翻历史时（:614-660）把 `UiSessionHistory.runs` 和该页的 prompt 一并合并进 store，不再只合并消息。
4. `T/components/transcript/prompt-completion.tsx` 显示标签：子代理触发的显示为 `Subagent update · Total 12s`。
5. **测试**：见 04 的 T16、T17。

**完成定义**：04 的 T16、T17 通过，T18 手工走查通过。

### Stage 4：权威文档同步

| 文档 | 改什么 |
|---|---|
| `docs/runtime/run-ledger/data-model.md`、`dfd-interface.md` | `trigger` 的三个取值、由谁在何时写入、与提交方的区别、子代理作用域的 run 仍记 `user`；只取主会话和按 ID 批量的查询 |
| `docs/runtime/run-manager/` 中描述默认策略的文档 | 策略表必须覆盖每个触发来源 |
| `docs/ohbaby-sdk/data-model.md`、`dfd-interface.md` | `UiRun.trigger`、`UiRun.outcome`、`UiSessionHistory.runs`；视图里 run 的覆盖规则与顺序 |
| `docs/ohbaby-web/redesign-2026-10/03-ui-layout-and-style.md` §4.3、`05-components.md` | 一轮按 run 划分；子代理触发的轮次带标签；复制常显行跟最后一轮 |
| `docs/problem-lists/2026-09-29-web-run-process-collapse/README.md` | 注明“成功只来自 prompt、不加 SDK 字段”的前提已被本议题取代 |
| `docs/ohbaby-cli/refactor/package-design.md` 中 `PromptCompletion` 的说明 | 耗时行按 run，带标签 |

## 2.4 按包的改动面

| 包 / 目录 | 新增 | 修改 |
|---|---|---|
| `packages/ohbaby-agent` | 账本的按 ID 批量查询、只取主会话的选项 | `runtime/run-ledger/{types,database,in-memory}.ts`、`runtime/run-manager/types.ts`、`adapters/ui-runtime/composition.ts`、`agents/service.ts`、`core/agents/{types,instance,runner}.ts`、`runtime/prompt-scheduler/current-run-inputs.ts`、`adapters/ui-state/{persistent-store,source-session-projection}.ts`、`adapters/ui-inprocess.ts` |
| `packages/ohbaby-sdk` | 无新文件 | `contract/snapshot.ts`（`UiRun`）、`contract/session-view.ts`（`UiSessionHistory.runs`） |
| `packages/ohbaby-server` | 无 | 无（已核实原样透传） |
| `apps/ohbaby-web` | 无新文件 | `store/store.ts`、`api/daemon/eventReducer.ts`（如需）、`ui/session/{selectors,SessionConversation}.tsx`、`ui/conversation/{run-process.ts,ConversationStream.tsx,ExecutionProgress.tsx}`、`dev/mock-runtime.ts` |
| `packages/ohbaby-cli` | 无新文件 | `tui/store/{transcript,events}.ts`、`tui/session-recovery.ts`、`tui/components/transcript/prompt-completion.tsx` |

不需要数据库迁移。

## 2.5 接口与兼容

```ts
// A/runtime/run-ledger/types.ts
export type TriggerSource = "user" | "goal" | "subagent";

// A/runtime/run-manager/types.ts
export interface RunDefaultsPolicy {
  readonly defaults: Readonly<Record<TriggerSource, RunDefaults>>;
}

// K/contract/snapshot.ts
export interface UiRun {
  // …现有字段不变
  /** What started the run: a user prompt, a goal turn or a subagent update. */
  readonly trigger?: "user" | "goal" | "subagent";
  /** How a finished run ended; absent while it runs. */
  readonly outcome?: "succeeded" | "failed" | "cancelled" | "interrupted";
}

// K/contract/session-view.ts
export interface UiSessionHistory extends UiHistoryBoundary {
  // …现有字段不变
  readonly runs: readonly UiRun[];
}
```

- **视图里 run 的语义变化**：从“最近 50 个（含子代理作用域，过滤后可能更少）”改为“已加载消息涉及的主会话 run + 运行中的主会话 run，新的在前”。现有读取方里，`seed` 取第一个或运行中的 run，Web 的 `selectActiveRun` 和子代理视图只看运行中的 run，都不受影响。
- **前后端同时发布**：Web 随 daemon 发布，TUI 进程内运行，不为“新前端连旧后端”保留单独的投影路径；字段缺失时按 2.2 的逐字段规则处理即可。
- **旧数据**：没有迁移，兜底规则见 2.2。

## 2.6 风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| 漏配某个触发来源的默认策略 | 那类 run 创建时抛错，整类执行失败 | 策略表类型改为必须覆盖全部触发来源；T1b |
| goal 期间的子代理唤醒标成 `goal` | 唤醒那一轮没有标签，看起来像没头没尾的回答 | 触发来源按“是否带子代理状态输入”判断，不直接用提交方；T1 第四种情况 |
| 某个创建 run 的路径漏传触发来源 | 那类轮次被标成 `user`，只是少了标签，折叠和复制照常 | 创建入口只有 runner 一处；T1 覆盖四种情况 |
| 视图里的 run 改为按消息取后，运行中的 run 还没有消息 | 刚开始的一轮在视图里找不到 | 规则里显式并上运行中的主会话 run；T3 |
| `seed` 选错“最近的 run” | 打开会话时补载的是很老的一轮 | 视图里的 run 保持新的在前；`seed` 用只取主会话的查询选最近一个；T3 |
| run 列表随会话增长 | 长时间开着的会话内存变大 | 与消息一起裁剪；T4 |
| 轮次顺序 | 两个 run 时间重叠时顺序错 | 默认策略 `reject` 保证主会话同一时间只有一个运行中的 run；前端按开始时间升序排列；T12 |
| 旧数据兜底误判 | 一个没有 prompt 的用户轮次被标成子代理 | 兜底只认 `subagent-status`、`subagent-result` 的运行时输入标记；T10 |
| 2026-09-29 折叠议题的回归 | 普通轮次的折叠、展开记忆、阅读锚点出错 | 原有测试改用 run fixture 后全部保留；T9 |

回滚：前端可以单独退回按 prompt 的投影；后端新增的都是可选字段，保留无害；策略表补齐的两项保留无害。

## 2.7 与 00 边界对齐

| 00 结论 | 02 落点 |
|---|---|
| 从源头修，一轮按 run | 2.2 第 1 行；Stage 2 第 2 步 |
| 每次唤醒单独成一轮，各自折叠、答案、复制、耗时 | Stage 2 第 2、3 步 |
| 标明子代理触发 | 2.2“触发来源怎么定”“子代理标签”；Stage 2 第 3 步；Stage 3 第 4 步 |
| 后端记录触发来源 | Stage 1 第 1、2 步 |
| 范围含 TUI | Stage 3 |
| 不写关键改动清单、不写模块级文档 | 2.4 只到文件一级；Stage 4 同步权威文档 |
| fork、撤销、side chat 文档落地后再改 | 2.8 |
| P1 至 P12 | 决策表与 Stage 1 至 3、2.8 |

## 2.8 不在本轮

| 项 | 去向 |
|---|---|
| 把一条用户消息之后的几轮唤醒合成一次“交流”，只显示最后一个答案 | 不做，00 §4 |
| 右侧栏子代理详情的折叠、耗时、复制 | 下一轮候选：子代理视图要先提供自己的 run 列表 |
| 区分子代理作用域里的 run 是由谁开启的 | 不做；那些 run 不在主会话里投影 |
| TUI 的折叠与复制 | 不做 |
| fork、撤销、side chat 文档改为按 run 定切点和范围 | 本议题落地后在各自议题里修订 |
| `subagent_execution.root_prompt_id` 从未写入（01 §1.8） | 在撤销议题修订时一并处理：撤销可以改用已有的 `root_run_id`，或在派生子代理时补写 `root_prompt_id` |
| `/loop` 的触发来源 | `/loop` 实现时再给 `TriggerSource` 增加取值（策略表的类型会强制补配） |
