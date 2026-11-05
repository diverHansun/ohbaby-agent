# 讨论记录与已确认要点

> 2026-11-05 与用户讨论定稿。第 2 至 4 节是讨论中确认的结论。第 5 节是写规划时根据代码勘测补充的决定，随整套文档提交用户审查。现状证据见 [01](01-problem-analysis-and-current-state.md)，实施方案见 [02](02-optimization-plan-and-change-scope.md)，参考项目见 [03](03-reference-projects.md)。

## 1. 背景与动机

子代理的最终报告超过 50KiB 时，系统会把全文导出成文件，再把路径交给父代理去读。这个文件现在放在平台数据目录 `~/Library/Application Support/ohbaby/storage/subagent-results/` 下，和会话存储区 `~/.ohbaby/sessions/<id>/` 分在两处。读它还要走一条专用的放行通道。

会话存储区设计好之后，用户提出在其他议题实施前先调整这个位置，并参考 code-cli 下的项目。讨论中还发现了一个问题：子代理提示词让子代理把长日志写进文件，却没说写到哪，结果这些文件都写进了用户的工作区。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|---|---|
| 议题 | 单独开一个议题，不并入会话存储区模块 |
| 位置 | `~/.ohbaby/sessions/<根会话ID>/subagents/<subagentId>/<executionId>.output` |
| 目录名 | `subagents/`，照 claude-code |
| 粒度 | 每个子代理一个目录，每次执行一个文件，和 kimi-code 一样。同一个子代理被 `send` 多次时，旧结果不会被覆盖 |
| 只导出报告 | 不额外导出对话记录或 `metadata.json`：两样数据库里都有，界面上也能看 |
| 扩展名 | 保留 `.output` |
| 权限 | 由会话存储区的两档可信路径负责：`subagents/` 属于只读那一档。`read`、`grep` 读取不弹确认，写入要确认，Bash 访问要确认 |
| 谁能读 | 整个根会话都能读，包括主会话、所有子代理和 side chat。现在只有发起调用的那个作用域能读 |
| 专用读取通道 | 删掉 `authorizeInternalRead`，由存储区的只读权限代替 |
| 父代理收到的内容 | 不改。不超过 50KiB 给全文，超过了只给路径、字节数和估算 token 数，不加预览 |
| 子代理提示词 | 改 [base.md:27](../../../../packages/ohbaby-agent/src/core/system-prompt/prompts/subagents/base.md)：完整日志和长篇分析写进 scratch 目录，文件名要能看出是哪个任务。`explore` 角色仍然完全不写文件 |
| `forceFile` | 删掉。它没有调用方 |
| 旧数据 | 不做兼容。本项目在快速迭代，还没有发布过正式版本 |

## 3. 已确认：边界

| 项 | 处理 |
|---|---|
| 失败、超时、被停止的执行保存部分结果 | 不在本议题。现在只有成功完成的执行才保存正文。这件事有价值，但和“存在哪”无关，登记为下一轮候选（02 §2.8） |
| 超过阈值时给开头预览 | 不做。参考项目在后台送达这条路径上都不截断预览，见 03 |
| fork 出来的会话读源会话的报告 | 照旧要确认，和 fork 议题 P11 一致 |
| 把旧目录里的文件搬过来 | 不做 |

## 4. 已确认：和以前决定的关系

[执行可靠性 improve-3 §2.7](../../2026-09-19-execution-reliability/improve-3/02-optimization-plan-and-change-scope.md) 定了现在的导出方案。本议题逐条对照如下：

| improve-3 的决定 | 本议题 |
|---|---|
| 路径 `<storageRoot>/subagent-results/<parentSessionId>/<subagentId>/<executionId>.output` | **改**：搬到会话存储区的 `subagents/` 下 |
| 系统负责生成，模型对这个目录没有写权限 | **保留**：靠存储区的只读那一档落实，写入要确认 |
| 不把整个 app home 设成通用的可写可信目录 | **保留**：可写的只有 `scratch/` |
| SQLite 是权威数据，文件可以重新导出 | **保留** |
| 短结果直接放进消息；“查状态时再导出” | 前一半保留；后一半没有实现过，相关参数 `forceFile` 一并删掉 |
| 只读的内部授权，只开放给发起调用的作用域 | **改**：由存储区的只读权限代替，整个根会话都能读 |
| 随会话删除清理文件，删除记录留墓碑 | **保留**：`deleteSession` 的逻辑不变；会话永久删除时，存储区整个目录一起删掉 |
| 不截断原文，不加截断预览 | **保留** |

## 5. 规划中补充的决定

勘测代码时发现、讨论阶段没有覆盖的细节，理由见 01 和 02。

| 编号 | 决定 | 一句话理由 |
|---|---|---|
| P1 | 路径里的会话 ID 用执行记录的 `rootSessionId` | 存储区按根会话分。子代理不能再创建子代理，所以它现在和 `parentSessionId` 的值一样，但 `rootSessionId` 的含义和存储区的归属一致 |
| P2 | 在 `A/paths/session-storage.ts` 加 `resolveSessionStorageRoot(options?)`（返回 `<OHBABY_HOME>/sessions`）和常量 `SUBAGENTS_DIR = "subagents"`。结果导出用前者作存储根，键为 `[rootSessionId, "subagents", subagentId, "<executionId>.output"]` | 现有的 `Storage` 和 `PathResolver` 不用改。路径穿越检查、原子写入、符号链接检查照旧在这个根下工作。ID 由系统生成，`PathResolver` 的键校验已经挡住 `/`、`..` 这类穿越，不再另加存储区那套字符集校验 |
| P3 | 导出时建目录改用 `mkdir(dirname(path), { recursive: true, mode: 0o700 })`，代替现在的 `resolver.ensureParent(path)` | 正常情况下父会话运行过，会话目录已经在了。万一目录被删，重新建出来也是 0700，不会变成默认权限 |
| P4 | 删掉 `composition.ts` 的选项 `resultStorageRoot`。结果导出的根固定用 `resolveSessionStorageRoot()`，和存储区回调登记可信路径时算的是同一个位置 | 两处各自算路径，就可能不一致：文件写在 A 处，可信路径登记在 B 处，读的时候又要弹确认。测试照仓库约定用 `vi.stubEnv("OHBABY_HOME", ...)` 指到临时目录。`cleanupDeletedSessionFiles` 保留可选的 `sessionStorageRoot`（存储区第一期加的），daemon 不传，只给测试用，不会造成两处不一致 |
| P5 | `cleanupDeletedSessionFiles` 删掉 `subagent-results/<id>` 那一段和 `resultStorageRoot` 依赖 | 存储区第一期已经会删 `sessions/<id>`，子代理报告就在里面 |
| P6 | `OHBABY_STORAGE_ROOT` 和 `PathResolver` 的默认根不动 | 快照还在用它（`A/snapshot/diff-engine.ts:70`）。本议题只是不再把它用于子代理结果 |
| P7 | 数据库里旧记录的路径还指向旧位置，不写迁移代码 | 现有逻辑在记录的路径和新算出的路径不一致时会重新导出（`result-artifacts.ts:153-157`），下次送达时自动写到新位置。旧会话历史里写着的旧路径，读取时按外部路径确认 |
| P8 | `deleteSession`（`SessionEvent.Removed` 触发）和墓碑逻辑不改，只是路径换了 | 它管的是数据库里的导出状态，和目录清理是两回事 |

## 6. 用户确认记录

- 2026-11-05：用户提出调整子代理结果的存储位置，要求参考 code-cli 下的项目。
- 2026-11-05：用户确认单独开议题、目录名照 claude-code 叫 `subagents/`。
- 2026-11-05：用户确认子代理提示词要改；不做旧数据兼容；读取范围放宽到整个根会话，并删掉 `authorizeInternalRead`；目录结构、父代理收到的内容、能否改写结果文件三点向参考项目学习（结论见 03）。
- 2026-11-05：用户确认实施顺序：存储区第一期，本议题，存储区第二期，然后是复制、撤销重发、fork、side chat。
- 2026-11-05：用户确认会话目录按 `scratch/`（可写）、`subagents/`、`tool-results/`（只读）这棵树定。
- 第 5 节 P1 至 P8 随整套文档提交用户审查。
