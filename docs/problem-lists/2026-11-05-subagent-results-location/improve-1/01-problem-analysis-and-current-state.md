# 1. 现状与问题分析

> 2026-11-05 勘测，行号是勘测时的快照。路径缩写：`A/` = `packages/ohbaby-agent/src/`，`S/` = `packages/ohbaby-server/src/`。

## 1.1 一句话现状

子代理报告的全文存在数据库里。超过 50KiB 时导出一份文件到平台数据目录，父代理拿到路径后用 `read` 去读，读取走一条专用通道，只放行发起调用的那个作用域。子代理自己写的长日志没有指定位置，会落进用户的工作区。

## 1.2 结果怎么产生、怎么送达

| 环节 | 现状 | 锚点 |
|---|---|---|
| 正文保存 | 执行记录 `subagent_execution.output`，只有状态为 `completed` 时才保存 | `A/services/database/schema.ts:94-122`、`A/agents/subagent-host.ts:1736` |
| 送达方式 | 全部走后台：父会话下一步开始前，由续接协调器把结果作为运行时输入消息插进去，不走工具结果。前台模式已经去掉 | `A/agents/subagents/continuation-coordinator.ts:108-139`、`A/tools/subagent.ts:68-76` |
| 短结果 | 不超过 `INLINE_SUBAGENT_RESULT_BYTES = 51_200` 字节时，在身份信息后面附上完整正文，不截断 | `A/agents/subagents/result-artifacts.ts:16`、`:227-235` |
| 长结果 | 导出文件，消息里只有 `Complete result: <路径>`、`sizeBytes`、`estimatedTokens`，没有预览 | `result-artifacts.ts:153-161`、`:196-199` |
| 导出失败 | 重试 3 次，仍失败就告诉父代理“原文在数据库里，文件不可用” | `result-artifacts.ts:162-218` |
| `forceFile` | `prepare()` 有这个选项，但没有任何调用方。它是 improve-3 设想的“查状态时再导出”留下的，那个功能没有做，现在也没有 status 动作 | `result-artifacts.ts:30`、`:228`；`A/tools/subagent.ts:29-38` 的动作只有 `spawn, send, list, monitor, stop, close` |

## 1.3 文件放在哪

| 项 | 现状 | 锚点 |
|---|---|---|
| 存储根 | `$OHBABY_STORAGE_ROOT`，没设时是 `<平台数据目录>/storage` | `A/services/storage/path-resolver.ts:7-12` |
| 键 | `["subagent-results", parentSessionId, subagentId, "<executionId>.output"]` | `result-artifacts.ts:60-65` |
| 注入 | `composition.ts` 用选项 `resultStorageRoot` 建 `Storage` 和 `rootDir` | `A/adapters/ui-runtime/composition.ts:213`、`:360-376` |
| 写入保护 | 写之前检查父目录没有被换成符号链接，写完核对真实路径；文件状态（`preparing`、`ready`、`deleted`、`error`）记在执行记录的 `artifact` 列 | `result-artifacts.ts:100-111`、`:174-195` |
| 路径变了会怎样 | 记录里的路径和新算出的路径不一致时，重新导出 | `result-artifacts.ts:153-157` |

本机的数据目录里只有 `ohbaby.db` 和备份，没有 `storage/`，说明从来没导出过结果文件。

## 1.4 怎么读

父代理读报告时，读请求先经过 sandbox 的可信路径判断。报告不在任何可信路径里，所以要走专用通道 `authorizeInternalRead`。这条通道贯穿 9 个文件：

| 环节 | 锚点 |
|---|---|
| 判断逻辑：只放行 `read` 操作；路径必须恰好四段、第二段等于发起者的会话 ID；按 `contextScopeId ?? "primary"` 查执行记录，记录要处于 `ready`、没被删除，文件不能是符号链接 | `result-artifacts.ts:246-282` |
| 注入 sandbox | `composition.ts:472-476` |
| 类型 | `A/sandbox/types.ts:137`、`:178`；`A/core/tool-scheduler/types.ts:73` |
| 传递 | `A/sandbox/manager.ts:170`、`A/sandbox/lease.ts:52-80`、`A/runtime/run-manager/worker.ts:114`、`A/adapters/ui-runtime/host-local-environment.ts:127` |
| 读路径解析时先问它 | `lease.ts:102` |
| 权限分类 | `A/core/tool-scheduler/scheduler.ts:121`、`:1459`、`:1474`、`:1904-1907`、`:1981`：命中时，这次读按只读类别评估外部目录权限，并且不把路径登记成可信路径 |

结果是：只有发起调用的那个作用域能读。一个子代理读不到兄弟子代理的报告；side chat 读不到主会话子代理的报告。

## 1.5 怎么删

| 时机 | 动作 | 锚点 |
|---|---|---|
| 会话被移除（`SessionEvent.Removed`） | `deleteSession`：把相关执行记录的导出状态标成 `deleted`（墓碑），再逐个删文件 | `result-artifacts.ts:283-291`、`composition.ts:1006-1009` |
| 归档会话被永久删除 | daemon 调 `cleanupDeletedSessionFiles`，对会话树里每个 ID 删 `subagent-results/<id>` | `A/services/session/archive-files.ts:31-39`、`S/runtime/daemon/main.ts:557-566` |
| 归档 | 不删 | `A/adapters/ui-inprocess.ts:3299-3306` |

## 1.6 子代理自己写的文件

| 项 | 现状 | 锚点 |
|---|---|---|
| 提示词 | “Write full logs or lengthy analysis to a file and return its path.” 没说写到哪 | `A/core/system-prompt/prompts/subagents/base.md:27` |
| 子代理知道的位置 | 只有运行目录、平台、日期和 git 信息 | `A/core/system-prompt/layers/environment.ts:78-98`、`A/services/reminder/environment.ts:12-19` |
| 结果 | 长日志落进运行目录，有工作区的会话会弄脏用户的仓库 | 推断 |
| sandbox 上下文 | 每个子代理按“子会话 ID + subagentId”有自己的上下文，新建时只有 `workspace` 一个可信路径；存储区第一期会通过回调补上根会话的存储区 | `A/runtime/run-manager/manager.ts:400-404`、`A/sandbox/manager.ts:123`、`A/sandbox/trusted-roots.ts:26-31` |
| `explore` 角色 | 提示词要求只读，不改文件 | `A/core/system-prompt/prompts/subagents/tasks/explore.md:9` |

## 1.7 问题清单

| 编号 | 问题 | 影响 |
|---|---|---|
| Q1 | 一个会话的文件分在两处：报告在平台数据目录，存储区在 `~/.ohbaby/sessions/` | 用户和排查的人要知道两个位置；删除会话时要两处各删一次 |
| Q2 | 读报告靠一条专用通道，贯穿 8 个文件 | 和存储区的可信路径是两套机制，要分别维护和测试 |
| Q3 | 只有发起调用的作用域能读 | 兄弟子代理、side chat 读不到报告；而存储区里 scratch 的文件它们都能读，规则不一致 |
| Q4 | 子代理的长日志写进用户的工作区 | 弄脏用户的仓库；没选工作区的会话把文件堆在共用的默认目录里 |
| Q5 | `forceFile` 没有调用方 | `prepare()` 多一个永远走不到的分支 |

## 1.8 SWE 视角

- **复杂度在转移，不在减少。** 专用通道是为了给“不在可信路径里的文件”开一个口子。存储区有了只读那一档之后，这个口子就多余了。
- **耦合。** sandbox 是通用组件，现在却要透传一个只为子代理结果服务的回调。去掉之后，sandbox 只认可信路径一种机制。
- **YAGNI。** `forceFile` 是为没做的功能预留的参数，应该删掉。
- **可逆性。** 数据库是权威数据，文件随时能重新导出。本议题没有不可逆的改动。
