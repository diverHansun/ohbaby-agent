# 3. 参考项目借鉴

> 2026-10-25 由子代理只读调研，主代理整理。路径相对 `/Users/hansun025/Projects/code-cli/` 下的各项目根目录；未经运行验证的结论标注“推断”。

## 3.1 借鉴来源

| 项目 | 本地路径 | 调研范围 |
|---|---|---|
| deepseek-harness | `deepseek-harness` | 归档集合、运行中归档、恢复位置 |
| ZCode | `ZCode` | 设置里的归档管理、先归档才能删、软删除 |
| kimi-code | `kimi-code` | 归档、恢复、删除的清理范围 |
| opencode | `opencode/packages/core` | 归档、取消归档、递归删除 |
| pi | `pi` | 删除确认、不能删正在使用的会话 |
| Codex、Cursor | 用户提供的截图与描述 | 归档会话放在设置里，可恢复或删除 |

## 3.2 各项目的做法

| 项目 | 归档 | 恢复 | 永久删除 | 运行中 |
|---|---|---|---|---|
| deepseek-harness | 全局集合 `archivedSessionIds`，会话保留在原分组里的位置（`packages/workspace/workspace/src/spec.ts:47-57`） | 回到原位置；不检查目录是否存在（`index.ts:390-395`），目录缺失时状态为 `missing-dir` | 没有 | 默认拒绝，传 `stopActivity` 才先停再归档（`index.ts:59-69,102-145`）；已归档会话不能运行（`archived-session-gate.ts:36-52`） |
| ZCode | `archived` 字段，可自动归档 | 只清标记，不恢复项目、不改目录（推断） | 只能删已归档的，数据层检查 `archived === 1`（`packages/services/src/session/taskIndexRepo.ts:1068`）；软删除；有“删除全部已归档” | 未调研 |
| kimi-code | `archived` 加 `archivedAt`，归档时排空 agent 并关闭会话（`sessionLifecycleService.ts:445`） | 先恢复会话再清标记（`:471`） | 不要求先归档；删会话目录、索引和文件历史（`:481`） | 归档时主动排空 |
| opencode | `archive` / `unarchive`（`src/session.ts:187-188`） | 有 | `remove` 递归删除子会话并发布删除事件（`:374-383`） | 未调研 |
| pi | 没有归档 | 不适用 | 选择器里删除，先确认；不能删当前正在使用的会话（`session-selector.ts:158-160,406-409`）；优先移到废纸篓 | 不适用 |

ZCode 的归档管理页在设置里，按“主机 + 项目”分组，无项目的会话归为 “Unclassified”，项目已删除的分组带 “Removed” 标记（`docs/superpowers/specs/2026-09-11-archive-management.md:7-16`）。

## 3.3 可借鉴点

| 做法 | 来源 | ohbaby 取舍 |
|---|---|---|
| 归档管理放在设置里 | ZCode、Codex、Cursor | **采纳**（D9） |
| 只能删除已归档的会话，在数据层强制 | ZCode | **采纳**（D2），检查写在核心事务里 |
| 运行中的会话默认不能归档 | deepseek-harness | **采纳**（D3），只做拒绝，不提供“先停再归档” |
| 删除时递归删除子会话 | opencode | **采纳**（D8） |
| 删除前二次确认 | pi、ZCode | **采纳**，用现有 `ConfirmDialog` |
| 恢复后回到原分组 | deepseek-harness | **采纳并补充**（D4、D6）：目录不在时回到无工作区，下一轮改到默认目录 |
| 归档时间单独存一列 | kimi-code | **不采纳**（D7），用 `updated_at` |

## 3.4 明确不借鉴

| 做法 | 来源 | 原因 |
|---|---|---|
| 软删除 | ZCode | 用户要的是永久删除；软删除还需要再做一层清理 |
| 删除不要求先归档 | kimi-code | 与用户确认的规则相反 |
| 按项目分组展示归档列表、“删除全部已归档” | ZCode | D10，本轮不做 |
| 归档时自动停止运行中的任务 | kimi-code、deepseek-harness 的 `stopActivity` | 会悄悄丢掉进行中的工作，选择直接拒绝 |
| 移到废纸篓 | pi | ohbaby 会话在 SQLite 里，不是单个文件 |

## 3.5 对 02 的影响

- 恢复和删除的规则写在核心层、由服务端统一执行，来自 ZCode “在数据层强制” 的做法。
- 删除递归子会话来自 opencode；清理无外键表和文件是 ohbaby 自己的数据结构决定的。
- 运行中拒绝归档来自 deepseek-harness 的默认行为。
