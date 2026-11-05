# 3. 参考项目

> 2026-11-05 由子代理只读调研，主代理汇总。路径都在 `/Users/hansun025/Projects/code-cli/` 下，行号是调研时的快照。

## 3.1 调研范围

| 项目 | 看了什么 |
|---|---|
| claude-code | 子代理对话记录、后台任务输出文件、scratchpad、`tool-results/`、读写权限、清理 |
| kimi-code | 会话目录结构、子代理任务输出、超长输出存盘、读写权限 |
| ZCode | 子代理目录、产物目录、清理清单 |
| minimax-code | 会话目录结构、scratchpad、只读授权 |
| deepseek-harness（下称 dsh）、codex、opencode、pi、Step-Code | 子代理结果怎么回传、会话文件放在哪 |

## 3.2 子代理结果放在哪

| 项目 | 位置 | 内容 |
|---|---|---|
| claude-code | `~/.claude/projects/<cwd>/<会话>/subagents/agent-<id>.jsonl` 加 `.meta.json`（`src/utils/sessionStorage.ts:248-291`） | 完整对话记录 |
| kimi-code | `<home>/sessions/<工作区>/<会话>/agents/<agentId>/tasks/<taskId>/output.log`（`agent/task/persist.ts:97-99`） | 每次任务的最终文本 |
| ZCode | `~/.zcode/cli/agents/<父会话>/<agentId>/output.txt` 加 `metadata.json`（`core/src/subagent/runner.ts:897-904`） | 最后一次的最终文本 |
| minimax-code | 子代理是子会话，有自己的会话目录 | 消息记录 |
| dsh、codex、opencode | 子代理是独立的会话，结果只在会话记录里 | — |

共同点：结果挂在会话名下，没有一家放在和数据库并列的公共目录里。只有 claude-code 和 ZCode 额外写元数据文件，因为它们的记录本身就是文件；本项目的执行记录在数据库里，不需要。

## 3.3 父代理收到什么

预览只出现在**同步工具结果**这条路径上；本项目的子代理结果全部走**后台送达**。两条路径要分开看：

| 项目 | 后台送达 | 同步工具结果 |
|---|---|---|
| claude-code | 通知里放全文，没找到截断（`src/tasks/LocalAgentTask/LocalAgentTask.tsx:302-315`） | 超过 50K 字符存进 `tool-results/`，给路径加 2KB 预览（`src/utils/toolResultStorage.ts:109`、`:189-199`） |
| kimi-code | 只给文件路径和字节数；没有文件时才给 3000 字节预览（`task/taskService.ts:1374-1381`、`:173`） | 全文；超过 50,000 字符存盘，给开头 4096 加结尾 1024 字符 |
| ZCode | 通知里放全文，整条通知超过 120K 字符才截断（`runtime-task/notification.ts:18`、`:401-404`） | 超过 120KB 存盘，给开头预览 |
| opencode | 全文，没找到截断（`session/subagent-completion.ts:21-45`） | 超过 2000 行或 50KiB 存盘，给开头若干行 |
| dsh、codex | 全文，不设阈值 | — |

## 3.4 会话目录怎么组织

| 做法 | 项目 | 说明 |
|---|---|---|
| 一个会话一个目录，按内容分子文件夹 | kimi-code、minimax-code | kimi-code：`sessions/<工作区>/<会话>/` 下有 `state.json`、`media-originals/`、`agents/<id>/{wire.jsonl, tasks/, tool-results/, plans/, blobs/, file-history/}`。minimax：`sessions/<日期>/<会话>/` 下有 `manifest.json`、`messages.jsonl`、`snapshots/`、`reports/tool-outputs/`。删除会话时整个目录一次删掉（kimi-code `sessionLifecycleService.ts:580`） |
| 按类型分顶层目录，类型下再按会话分 | codex、ZCode、claude-code（大部分） | ZCode 删除会话时要把 `artifacts`、`exec`、`agents`、`sessions` 逐个点名删（`adapters/src/storage/session-data-files/index.ts:16-31`），而 `image-cache`、`pdf-cache`、`video-cache`、`exec/bash-startup`、`mailbox` 这几个按会话分的目录不在清单里。claude-code 按类型定时清理，`<会话>/subagents/` 从来不会被删（`src/utils/cleanup.ts:147-153`） |
| 按项目目录分，文件平铺 | pi、Step-Code、dsh | 会话不能换项目，所以按 cwd 分组没有问题 |

## 3.5 模型能不能写、能不能读

| 项目 | 草稿目录 | 系统生成的文件 |
|---|---|---|
| claude-code | `<tmp>/<cwd>/<会话>/scratchpad/`，免确认读写，子代理共用（`src/utils/permissions/filesystem.ts:380-386`、`:1504-1514`） | `tool-results/`、子代理记录免确认读（`:1638-1679`）；它们在 `~/.claude` 下，这个目录在危险目录名单里，写入要确认（`:74-79`） |
| minimax-code | `scratchpads/<根会话ID>/scratchpad.md`，和子会话共用 | 每个会话只读授权 `tool-outputs`、压缩快照、会话工作区和附件四类（`session-readable-grants.ts:3-27`） |
| kimi-code | 没有 | `read` 默认放行，写入走正常确认，只有计划文件例外（`permissionPolicy/policies/default-tool-approve.ts:7-31`） |
| ZCode | 没有 | `read` 是只读工具，直接放行；写入在 build 模式下要确认 |
| dsh | 没有 | 设计笔记写明超长输出文件是“运行时产物，不是模型写的工作区文件”，不经过模型的写工具（`.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md:168`） |

## 3.6 可借鉴点与本项目取舍

| 借鉴 | 来源 | 本项目 |
|---|---|---|
| 子代理结果挂在会话名下 | 全部 | **采用**：`sessions/<根会话>/subagents/` |
| 目录名 `subagents/` | claude-code | **采用** |
| 每个子代理一个目录、每次执行一个文件 | kimi-code | **采用**：`<subagentId>/<executionId>.output` |
| 一个会话一个目录，删除时一次删掉 | kimi-code、minimax | **采用**：由存储区第一期负责 |
| 草稿目录可写，系统文件只读 | claude-code、minimax、dsh | **采用**：存储区两档权限 |
| 草稿目录由根会话和子代理共用 | claude-code、minimax | **采用**：存储区归属规则 |
| 后台送达给全文或只给路径，不截断 | claude-code、kimi-code、ZCode、opencode | **保留现状**：50KiB 以内给全文，超过了只给路径 |

## 3.7 明确不借鉴

- **元数据文件**（claude-code、ZCode）：执行记录在数据库里。
- **导出完整对话记录**（claude-code）：对话记录在数据库里，Web 和 TUI 都能只读查看。
- **超过阈值时给预览**（claude-code、kimi-code 的同步工具结果）：本项目走后台送达，参考项目在这条路径上都不截断；improve-3 也定过不用截断预览冒充结果。
- **按类型分顶层目录**（ZCode、codex）：删除时要逐类清理，ZCode 和 claude-code 都因此漏删。
- **按工作区或项目分组**（kimi-code、claude-code、pi）：本项目的会话可以在工作区之间移动。
- **fork 时复制会话目录**（kimi-code）：本项目历史里写的是绝对路径，复制了也还指向源会话；ZCode 复制产物引用后，删除时还要先查引用。

## 3.8 对 02 的影响

| 02 决策 | 来源 |
|---|---|
| 位置、目录名、粒度 | claude-code、kimi-code |
| 读取走只读可信路径，删掉专用通道 | claude-code、minimax、dsh |
| 送达格式不变 | claude-code、kimi-code、ZCode、opencode 的后台路径 |
| 子代理长日志写进 scratch | claude-code（coordinator 模式让 worker 用 scratchpad） |
