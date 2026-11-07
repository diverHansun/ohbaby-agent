# 2. 方案与改动面

> 本文是给实施会话的执行契约。决策来源见 [00](00-discussion.md)，现状证据见 [01](01-problem-analysis-and-current-state.md)，验收见 [04](04-test-and-acceptance.md)。`W/` 表示 `apps/ohbaby-web/src/`，`A/` 表示 `packages/ohbaby-agent/src/`。按用户要求，本文只写到文件一级，不列关键改动清单。

## 2.1 方案总览

两处修复互不依赖：

```
问题 1（只改 Web）
  实时视图 ──► loaded（消息）            已有
          ──► loadedRuns / loadedPrompts  新增：已结束的 run 和 prompt 和消息一样缓存
  install() 只用“仍被显示中的消息引用”的缓存副本，实时副本优先

问题 2（后端一处 + Web 一个条件）
  messageToUiMessage 删掉隐藏工具片段 ──► 消息加 hiddenToolCalls: true
  run-process 判定答案 ──► 带这个标记的消息不算答案
  复制按钮仍然只挂在 answerId 上
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 问题 1 修在哪一层 | Web store | 留哪些旧消息由 Web 决定，Web 就该留住它们的 run 和 prompt | 后端视图多返回 run：后端不知道 Web 留着哪些消息 | 无 |
| 缓存什么 | 已结束的 run 和已结束的 prompt 都缓存 | 普通轮次靠 prompt 找回自己，子代理轮次靠 run（01 §1.3.3） | 只缓存 run：普通轮次照样丢 | 无 |
| 什么时候用缓存 | 组合快照时只用仍被显示中的消息引用的副本；表里的条目不逐条删除 | 和后端 `visibleRuns` 同一条规则；撤销、压缩删掉消息后，旧副本不再出现在快照里 | 组合时不过滤：残留的 prompt 会让已删除的轮次重新出现 | `install()` 多一次过滤 |
| 运行中的副本 | 运行中的 run、未结束的 prompt 不进缓存（实时和历史页两处都一样） | 它们一定在实时视图里；已结束的副本不会再变，也就不存在旧副本盖掉新副本的问题。缓存的 run 还会被“有没有活动 run”的判断读取（01 §1.3.4），不能留过期的运行中副本 | 缓存全部 run 再按 `updatedAt` 比新旧：run 的 `updatedAt` 在运行中不变，比不出来 | 无 |
| 问题 2 的事实留在哪里 | 后端投影时在消息上留 `hiddenToolCalls: true` | 后端是唯一知道这一步调用过隐藏工具的地方；codex 也把“这一步还要继续”留在源头 | 工具数据照发给客户端、由界面隐藏（deepseek-harness、kimi-code、ZCode）：要重新划分后端、Web、TUI、导出的隐藏职责，超出修复范围 | SDK `UiMessage` 多一个可选字段 |
| Web 怎么判断 | 用这个标记，不用 `finishReason` | 标记记录的是事实 | 看 `finishReason`：模型报 `stop` 却带工具调用时会判错（01 §1.4.4） | 无 |
| 中断的轮次 | 仍然可以有答案 | 用户 2026-11-07 已确认 Stop 后可复制半段正文 | 中断一律没有答案（codex）：与已确认结论冲突 | 无 |
| 复制规则 | 继续只认 `answerId` | 复制和答案判定只有一套规则 | 复制另写宽松规则：deepseek-harness、kimi-code 因此出现同类问题 | 无 |

## 2.3 分阶段实施

两个 Stage 互不依赖，可以任意顺序，也可以并行。每个 Stage 结束时 `pnpm typecheck`、`pnpm lint` 和相关测试保持通过。

### Stage 1：Web 留住旧消息的 run 和 prompt

**改动**（`W/store/store.ts`）：

1. `setSessionSync` 缓存消息的循环里，同时把 `view.runs` 中已结束的 run（有 `outcome` 或 `endedAt`）写入 `loadedRuns`，把已结束的 `view.prompts` 写入 `loadedPrompts`。未结束的仍由实时视图负责，和 `installSessionHistory` 处理 prompt 的方式一致。
2. `installSessionHistory` 写入 `loadedRuns` 时同样跳过运行中的 run。prompt 已有的 `updatedAt` 比较保留不动。
3. `install()` 组合 run 和 prompt 时：实时视图的副本全部保留且优先；缓存副本只取仍被显示中的消息引用的（run 看消息的 `runId`；prompt 看 `userMessageId` 或 `runId`）。只经 prompt 引用、自己没写过消息的 run 不取用，与后端 `visibleRuns`、历史页的 run 选取规则一致；这样的轮次仍由 prompt 算出，不要另行补救。
4. 切换会话时清空缓存的逻辑保持不变。

**完成定义**：04 的 T1 至 T4 通过。

### Stage 2：隐藏工具留下标记

**改动**：

1. `packages/ohbaby-sdk/src/contract/snapshot.ts`：`UiMessage` 增加可选字段 `hiddenToolCalls?: true`，注释只写事实：“这一步调用过界面不显示的工具”。“因此不是最终答案”写在 `run-process.ts` 的注释里。
2. `A/adapters/ui-state/persistent-store.ts`：`messageToUiMessage` 在删掉任一隐藏工具片段时，给结果加上 `hiddenToolCalls: true`。没有隐藏工具时不加这个字段。工具片段照样不出现在 `parts` 里。
3. `W/ui/conversation/run-process.ts`：判定答案时，最后一条 AI 消息带这个标记就不算答案。其余判断不变：后面还有收尾答复时，这一步的正文计入过程；没有答案时，耗时行跟在这条消息后面。
4. 同步文档 `docs/tools/todo-list/architecture.md` 的“Transcript 静默但保留底层事务”一节：补一句投影会留下 `hiddenToolCalls`，供客户端判断最终答案。

**完成定义**：04 的 T5 至 T8 通过。

## 2.4 按包的改动面

| 包 / 目录 | 修改 | 说明 |
|---|---|---|
| `apps/ohbaby-web` | `store/store.ts`、`ui/conversation/run-process.ts` 及各自测试 | Stage 1、Stage 2 |
| `packages/ohbaby-sdk` | `contract/snapshot.ts` | Stage 2，只加可选字段 |
| `packages/ohbaby-agent` | `adapters/ui-state/persistent-store.ts` 及测试、`adapters/ui-persistent.integration.test.ts` | Stage 2 |
| `docs/tools/todo-list` | `architecture.md` | Stage 2 第 4 步 |

不改：`A/adapters/ui-runtime/run-stream-adapter.ts`、TUI、`W/ui/conversation/MessageRow.tsx` 的 `filterTodoToolMessages`。

## 2.5 接口与兼容

- `UiMessage.hiddenToolCalls` 是可选字段。旧客户端忽略它；新 Web 连旧 daemon 时字段缺失，行为和现在一样。沿用轮次投影 P11：Web 和 daemon 一起发布，不为新旧混搭另写规则。
- `filterTodoToolMessages` 复制消息时保留其他字段（`{ ...message, parts }`），标记能传到 `run-process`。
- 不需要数据迁移。旧数据重开时由投影重新计算标记。

## 2.6 风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| 缓存表本身不逐条清理，长会话占内存 | 与已缓存的消息同量级（消息缓存本来也不清理） | 只缓存已结束的副本；切换会话时整体清空 |
| 缓存里出现过期的运行中 run | 轮次算不出来，“有没有活动 run”的判断也会出错 | 运行中的 run 不进缓存（Stage 1 第 1、2 步） |
| 一条消息只有隐藏工具、没有正文 | 不影响 | 它本来就因正文为空而不是答案 |
| 成功结束的轮次最后一步调用了隐藏工具 | 这一轮没有答案按钮 | 与“调用过工具就不是答案”一致；正常情况下工具之后模型还会再走一步 |
| 工具片段被上下文压缩标记后不再是活跃片段 | 这条消息的标记消失（可见工具片段本来也一样，属存量行为） | 本轮不处理，记为已知限制 |

回滚：两个 Stage 各自独立，撤回对应文件即可；新字段可选，撤回后无残留数据。

## 2.7 与 00 对齐

| 00 结论 | 02 落点 |
|---|---|
| §3 修在 Web store | Stage 1、决策表第 1 行 |
| §3 已结束的 run 和 prompt 一起缓存 | Stage 1 第 1 步 |
| §3 只用仍被消息引用的副本 | Stage 1 第 3 步 |
| §3 运行中的副本不进缓存 | Stage 1 第 1、2 步 |
| §4 规则包含隐藏工具 | Stage 2 第 3 步 |
| §4 后端只改一处 | Stage 2 第 2 步 |
| §4 复制只认 `answerId` | 决策表最后一行 |
| §4 不改 `run-stream-adapter`、TUI | 2.4 |
| §2 不列关键改动清单 | 本文开头 |
| （实施附带）同步 `docs/tools/todo-list/architecture.md` | Stage 2 第 4 步 |
| （实施附带）improve-1 的 05 是否补写 | 2.8 |

## 2.8 不在本轮

| 项 | 去向 |
|---|---|
| 已加载过历史后，“加载更早消息”的起点不再跟随实时视图更新（`W/store/store.ts:417`，未验证） | 以后核查 |
| 隐藏名单四份重复，Web 的 `filterTodoToolMessages` 缺 `select_tools`（01 §1.4.5） | 以后统一隐藏层时处理 |
| improve-1 的 05 验收文档 | 本轮修完后与用户确认是否补写 |
