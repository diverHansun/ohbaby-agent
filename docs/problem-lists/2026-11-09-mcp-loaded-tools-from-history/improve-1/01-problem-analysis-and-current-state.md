# 1. 现状与问题分析

> 本文只讲现状，方案见 [02](02-optimization-plan-and-change-scope.md)。下文代码路径省略 `packages/ohbaby-agent/src/` 前缀，行号是 2026-11-09 的快照。

## 1.1 问题陈述

模型用 `select_tools` 加载 MCP 工具后，“这个会话加载了哪些、按什么顺序”只存在内存里。下面三种情况会把它弄丢或弄乱：

| 情况 | 现在的结果 |
|---|---|
| daemon 重启、会话恢复 | 已加载的工具全部消失。模型照着历史调用，被 `accessGuard` 拒绝：“MCP tool is not loaded. Use select_tools to search or load it first.” 工具列表变短，缓存从工具列表开始失效 |
| MCP 刷新失败或服务断开 | 所有会话里属于这些工具的已加载记录被永久删掉。服务连回来后，模型要重新 `select_tools`，而模型通常不知道要这么做 |
| side chat、fork 新建会话 | 新会话拿不到源会话的已加载工具。原计划另加 `copyScope` 复制内存状态 |

另外有两个相关问题：会话累计上限 8 个没有写明理由，又没有卸载功能，装错几个名额就被永久占掉；工具顺序靠内存里的 `ScopeToolSequence` 记住，重启或重连后的顺序和原来不一样，缓存失效。

## 1.2 已加载状态存在哪

两份状态，都按 `sessionId + "\0" + (contextScopeId ?? "")` 分开存，都在 `adapters/ui-runtime/composition.ts:334-335` 新建：

| 状态 | 位置 | 内容 | 谁改它 |
|---|---|---|---|
| `McpToolMenu.loadedByScope` | `mcp/integration/dynamic-tool-menu.ts:215` | 每个作用域加载了哪些工具名（`Set`，按加载顺序） | `select()`（:270-289）、`setAvailable()` 删掉不可用的（:228-234）、`disposeSession`（:291）、`disposeScope`（:299） |
| `ScopeToolSequence.states` | `mcp/integration/tool-sequence.ts:50` | 每个作用域第一次发出的工具顺序、各工具的签名、`epoch` | `snapshot()`（:52-104）、`disposeScope`、`disposeSession` |

没有任何地方从历史重建这两份状态。

读已加载名单的地方：

| 读取方 | 位置 | 用途 |
|---|---|---|
| `accessGuard` | `composition.ts:414-425` | MCP 工具不在名单里就拒绝调用 |
| `resolvePromptTools` | `composition.ts:569-603` | 每一步组装工具列表：`[...内置工具, ...已加载 MCP 工具]`，再交给 `ScopeToolSequence.snapshot` |
| `resolveMcpToolNames` | `composition.ts:634-655` | 给 `mcp-catalog` 提醒算“可加载但还没加载”的名字 |
| `select_tools` 执行 | `dynamic-tool-menu.ts` 的 `createSelectToolsTool` | 加载前判断哪些已经加载过 |

清理时机：子代理作用域释放时 `disposeScope`（`composition.ts:885-893`），会话被删除时 `disposeSession`（`composition.ts:1020-1027`）。

## 1.3 历史里已经有的数据

`select_tools` 执行成功后返回：

```ts
metadata: { mcpSelection: { candidates, loaded, alreadyLoaded, limitReached, unknown } }
```

这份 metadata 原样存进数据库：

- 工具片段整个以 JSON 存在 `part.data`（`core/message/database-store.ts:79-89`）。结果写在 `part.state.metadata`，由 `resultToToolState` 原样复制（`core/lifecycle/lifecycle.ts:281-311`），调度器再加上 `uiToolSource: "builtin"`（`core/tool-scheduler/scheduler.ts:1015-1019`）。
- `loaded` 只含这次**新加载**的名字；已经加载过的写在 `alreadyLoaded`。
- 参数不合法时 `select_tools` 直接抛异常（`dynamic-tool-menu.ts:305-376`），片段变成 error，没有 `mcpSelection`，也不会改动名单。
- 崩溃后，恢复流程把未完成的片段改成 error，并丢掉 `state.metadata`（`runtime/execution-recovery/history.ts:67-101`）。
- 发给模型的历史里，`core/context/tool-metadata-projection.ts:37-68` 已经在读 `mcpSelection`。

作用域：

- 每条消息都有 `contextScopeId`，`message` 表有带索引的 `context_scope_id` 列；`part` 表没有这一列，作用域只在 JSON 里（`services/database/migrations.ts:36-50`、`:254-262`）。
- `listBySession(sessionId, filter)`（`core/message/database-store.ts:701-752`）：不传 `filter` 读全部作用域；`{ contextScopeId: undefined }` 读主上下文（`context_scope_id IS NULL`）；传具体 ID 读这个作用域。
- 主上下文的 `contextScopeId` 为空。子代理放在同一个子会话里，各自的 `contextScopeId` 等于子代理 ID（`agents/subagent-host.ts:1381-1415`）。

压缩：只给片段打上 `time.compacted` 标记（`database-store.ts:551-698`），不删除。`listBySession` 总是返回全部片段，“只看未压缩的”在之后的 `getActiveHistory` 里过滤。

## 1.4 已有的“从历史重建”写法

`TodoService`（`tools/todo.ts:173-209`、`:289-327`）：

- 第一次读某个作用域时，用 `listBySession` 读历史，从完成的 `todo_write` 片段里恢复 todo；已压缩的片段也算（`recoverTodoSnapshotFromMessages`，:428-474）。
- 同一作用域同时只跑一次加载（`loadingBySession`），结果缓存在 `loadedBySession`。
- `release`、`releaseScope` 清缓存，下次再重建。

`skill-usage` 提醒（`services/reminder/skill-usage.ts:53-73`）也从完整历史里统计用过的 skill，包括已压缩的片段。

## 1.5 压缩与缓存

一次请求的发送顺序是工具列表 → 系统提示词 → 消息：

```
tools[]   内置工具（启动时注册，顺序固定）→ select_tools → skill → skill_resource
          → mcp_resource / mcp_prompt → 已加载的 MCP 工具
system    每轮 run 固定一次；没有日期、目录、MCP、skills 清单
messages  [压缩摘要] → 历史（提醒存库并钉在对应回答前）→ 本步插话 → 本步提醒 → [最后一步的收尾指令]
```

- 压缩请求是正常请求末尾追加一条总结指令，系统提示词和工具列表都不变（`core/context/context-manager.ts:669-692`、`:907-911`）。实测压缩请求读缓存 98.95%，压缩后第一次请求 33.94%，下一次 99.12%（[压缩缓存议题 06](../../2026-10-10-compact-cache-and-tool-output/06-overall-acceptance.md) 第 79-80 行）。
- 压缩后工具列表不变：压缩流程不碰 `McpToolMenu` 和 `ScopeToolSequence`。`dynamic-tool-menu.unit.test.ts:114` 测的就是“压缩后保留已加载工具”。
- 压缩后，已加载的工具只在工具列表里有定义；`mcp-catalog` 提醒只列未加载的（`composition.ts:634-655`、`mcp/system-prompt.ts:7-36`）。

## 1.6 工具顺序

- 工具注册表是 `Map`：重新注册保留原位置，先删后加则排到末尾（`core/tool-scheduler/registry.ts:55-117`）。内置工具、`select_tools`、`skill`、`skill_resource`、`mcp_resource`、`mcp_prompt` 都在启动时注册（`composition.ts:1093-1127`、`:1251-1254`）。会话中途不会出现新的内置工具；`skill` 描述变化时重新注册，位置不变。
- `ScopeToolSequence.snapshot`：第一次的顺序原样记下；之后消失的删掉，新出现的追加到末尾，签名变化的原地替换，有变化就 `epoch + 1`。
- 生产代码只用 `snapshot().tools`，`epoch` 只有测试读（`tool-sequence.ts:99`、`:119`）。
- 后果：MCP 工具断开再连回来，会被追加到末尾；进程重启后状态清空，顺序回到“内置工具 + 加载顺序”。两种情况下的顺序都和断开前或重启前不同。

## 1.7 会话累计上限

- `MAX_MCP_TOOLS_PER_SELECTION = 8`、`MAX_MCP_TOOLS_PER_SESSION = 8`（`dynamic-tool-menu.ts:23-24`）。
- 累计上限：`select()` 里 `loaded.size >= MAX_MCP_TOOLS_PER_SESSION` 时把名字放进 `limitReached`，输出“Session/context scope tool limit reached”（:277-288、:390-393）。没有卸载。
- 来源：提交 `bcd6492b`（2026-07-14）。设计文档 `docs/core/system-prompt/improve-3/02-optimization-plan-and-change-scope.md:90` 只写了数值；`docs/mcp/improve-1/01-problem-analysis-and-current-state.md:13` 已把“槽位紧张且不可释放”列为问题。
- 参考的七个项目都没有会话累计上限（[03](03-reference-projects.md)）。

## 1.8 测试现状

| 文件 | 覆盖 | 本议题后 |
|---|---|---|
| `mcp/integration/dynamic-tool-menu.unit.test.ts` | 加载、作用域隔离、压缩后保留（:114）、累计上限（:179）、单次上限（:210）、并发加载不超限（:405） | :179 删除；:405 改成“并发加载都成功”；新增从历史重建的用例 |
| `mcp/integration/tool-sequence.unit.test.ts` | 追加、删除、epoch、“重启后在新序列里从头开始”（:115） | 随 `ScopeToolSequence` 一起删除 |
| `core/context/tool-metadata-projection.unit.test.ts:152,161` | `mcpSelection` 投影形状，含 `limitReached: []` | 不改。旧数据仍有这个字段 |

没有测试覆盖“重启后已加载工具还在”“断开再连上工具回到原位”。

## 1.9 SWE 原则审视

- **同一事实存了两份**：历史里有 `select_tools` 的结果，内存里又有一份已加载名单，只有内存那份被当真。重启时两者不一致，出错的是内存那份。改成历史为准、内存只做缓存，事实只有一个来源。
- **状态越少越好**：`ScopeToolSequence` 记住的顺序本可以从注册顺序和历史算出来，多存的这份状态正是顺序对不上的原因。
- **没有理由的约束**：累计上限没有写明理由，又和“不能卸载”叠在一起产生问题，属于过度设计。
- **复制状态不是解法**：side chat、fork 的 `copyScope` 是在给“状态只在内存”打补丁，每多一种新建会话的方式就要多复制一次。

## 1.10 与既有文档的关系

| 文档 | 现在怎么写 | 本议题后 |
|---|---|---|
| `docs/core/system-prompt/improve-3/02-optimization-plan-and-change-scope.md` 第 90、93、183 行 | 每个作用域最多 8 个；已加载名单由 composition 持有、不在历史里，重启清空 | 被取代 |
| `docs/core/context/improve-5/` 00 第 155-163 行，02 §2.7.1 | `ScopeToolSequence` 冻结顺序、新工具追加；重启算新的工具批次 | 顺序规则改为按注册顺序和历史计算，重启后顺序不变；“新加载的 MCP 工具追加在最后”仍然成立 |
| `docs/mcp/` data-model、architecture、dfd-interface、improve-1 | 已加载名单只在内存；累计上限 8 | 以历史为准；没有累计上限 |
| side chat 02 Stage 1 第 5a 步、04 T13b | 打开时 `copyScope` 两份状态 | 不再需要，依赖本议题 |
| fork 00、02、04 T12b | 提交后 `copyScope` | 同上 |
| 撤销重发 02 | 撤销后 `todoService.release` | 还要清已加载工具的缓存 |
