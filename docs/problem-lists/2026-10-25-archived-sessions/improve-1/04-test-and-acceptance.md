# 4. 测试与验收标准

> 验收会话按本文逐项核对。测试文件命名沿用仓库规则：`*.unit.test.ts`、`*.contract.test.ts`、`*.integration.test.ts`。命令都在仓库根目录执行。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| 集成测试 | 核心恢复与删除（真实 SQLite）、归档前检查、3 个 REST 接口 |
| 单元测试 | Web 的 Archived 分区、侧栏归档按钮禁用 |
| 浏览器走查 | Settings › Archived 的完整流程，手机宽度 |

风险最高的是永久删除：删错了无法挽回，删不干净会留下孤儿数据。测试重点放在删除的前置检查和清理范围上。

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | Stage |
|---|---|---|---|---|
| T1 | 运行中不能归档 | 集成 | 以下任一情况归档都抛 `SessionRunBusyError`，会话状态仍是 `active`：会话自己有活跃运行；有排队的消息；某个后代会话（子代理）有活跃运行。都结束后可以归档 | 1 |
| T2 | 恢复规则 | 集成（`services/session/archive.integration.test.ts`，新增） | 4 种情况：工作区和下一轮目录都在 → 回到原工作区，待切换目录不变；工作区不在、下一轮目录在 → `workspaceDirectory` 为空，待切换目录不变；工作区在、下一轮目录不在 → 待切换目录为工作区目录；都不在 → `workspaceDirectory` 为空，待切换目录为默认目录。每种情况恢复后 `status = 'active'`，`updated_at` 更新 | 1 |
| T3 | 恢复的前置检查 | 集成 | 不存在 → `SESSION_NOT_FOUND`；子会话 → `SESSION_NOT_ROOT`；未归档 → `SESSION_NOT_ARCHIVED`；出错时数据不变 | 1 |
| T4 | 删除范围 | 集成 | 准备一个三层会话树（根、子、孙），带消息、运行记录、`current_run_input`、快照检查点和补丁、排队与重发的消息、目标记录、子代理执行与实例记录。删除根会话后：3 个会话都不在；`message`、`part`、`run_ledger`、`current_run_input`、`snapshot_checkpoint`、`snapshot_patch`、`prompt_submission`、`prompt_resubmission`、`goal_record`、`subagent_execution`、`subagent_instance` 里没有这些会话 ID 的行；其他会话的数据完好。返回值包含 3 个会话 ID 和全部检查点 | 1 |
| T5 | 删除的前置检查 | 集成 | 未归档会话 → `SESSION_NOT_ARCHIVED`，什么都不删；子会话 → `SESSION_NOT_ROOT`；不存在 → `SESSION_NOT_FOUND` | 1 |
| T6 | 列表接口 | 集成（服务端） | `GET /v1/sessions?status=archived` 只返回已归档的根会话，包括隐藏工作区里的；按 `updated_at` 倒序，游标翻页正确；不带 `status` 时行为不变；`status=foo` 返回 400 和 `INVALID_QUERY` | 2 |
| T7 | 恢复接口 | 集成（服务端） | 成功返回 `UiGlobalSession`；原工作区被隐藏时恢复后 `GET /v1/scopes` 里重新出现；没有工作区注册表时恢复照常成功；错误码与 HTTP 状态对应 2.5 | 2 |
| T8 | 删除接口与文件清理 | 集成（服务端；清理函数的依赖可注入） | 成功返回 `deletedSessionIds`；会话的工作目录已被删除时，快照引用仍被删掉；子会话 ID 下的子代理结果目录也被删掉；注入的清理依赖抛错时，接口仍返回成功并记日志；删除未归档会话返回 409 `SESSION_NOT_ARCHIVED` | 2 |
| T9 | 运行中归档的对外表现 | 集成 | `PATCH /v1/sessions/:id/archive` 对运行中的会话返回 409，响应体 `error.code` 为 `SESSION_RUNNING`；JSON-RPC 的错误数据里带同样的错误码 | 2 |
| T10 | Archived 分区 | 单元（`ui/settings/ArchivedSection.unit.test.tsx`，新增） | 加载中、出错重试、空状态；行的说明文字（工作区名或 `No workspace`、相对时间）；`Show more` 加载下一页 | 3 |
| T11 | 恢复与删除交互 | 单元 | Restore 后行消失、会话进入全局目录；Delete 先弹确认，焦点默认在 Cancel，确认后行消失；接口失败时确认框显示错误且行保留 | 3 |
| T12 | 侧栏禁用归档 | 单元（`ui/sidebar/Sidebar.unit`） | `activity` 为 `running` 或 `awaiting` 时归档菜单项和悬停按钮不可用，并有提示文字；`idle` 时可用 | 3 |
| T13 | 浏览器走查 | 手工（mock 的 `archived` 场景和真实 daemon 各一遍） | 见 4.5 发布门第 5 项 | 3 |
| T14 | 文档同步 | 文本检查 | `rg -n "5 个分区\|五个分区\|归档列表的浏览界面\|不提供 Undo\|无法撤销\|不能撤销" docs/ohbaby-web/redesign-2026-10/0*.md docs/ohbaby-web/redesign-2026-10/README.md` 没有命中，且新增内容与实现一致 | 4 |

## 4.3 集成边界

| 边界 | 风险 | 对应用例 |
|---|---|---|
| 核心事务 ↔ SQLite 外键级联 | 漏删表或删多了 | T4、T5 |
| 核心 ↔ 文件系统（快照引用、结果文件） | 清理失败影响删除结果 | T8 |
| 运行账本 ↔ 归档检查 | 跨进程运行中的会话被归档 | T1 |
| daemon 全局路由 ↔ 工作区注册表 | 恢复后工作区仍隐藏 | T7 |
| Web 接口层 ↔ daemon | 字段或错误码不一致 | T6 至 T9、T11 |

## 4.4 回归清单

- 侧栏归档：空闲会话仍能一键归档，不弹确认，乐观移除，失败时行回来。
- 全局列表、全局搜索：默认仍只返回活跃会话。
- 移动会话、隐藏工作区、置顶不受影响。
- 设置里原有 5 个分区的行为不变，手机宽度下导航和内容分屏正常。
- 子代理执行与结果文件：未被删除的会话不受影响。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|---|---|---|
| 1 | 类型检查通过 | `pnpm typecheck` |
| 2 | 测试全部通过 | `pnpm test:unit`、`pnpm test:contract`、`pnpm test:integration` |
| 3 | 删除只发生在已归档的根会话上 | T5、T8；代码评审确认检查在核心事务内 |
| 4 | 删除后没有孤儿数据 | T4 |
| 5 | 浏览器走查 | 归档一个会话 → Settings › Archived 里出现；Restore → 回到原工作区并排在侧栏顶部；对工作区文件夹已删除的会话 Restore → 出现在 Recents，下一轮在默认目录运行；Delete → 确认后消失，再搜索找不到；运行中的会话不能归档；手机宽度下分区可用 |
| 6 | 文档同步 | T14 |

## 4.6 对抗性审查要点

| 攻击面 | 可能的错误 | 防御 | 残余风险 |
|---|---|---|---|
| 删除接口被直接调用 | 绕过界面删掉活跃会话 | 核心事务内检查状态和根会话；T5、T8 | 无 |
| 递归查询 | 父子关系成环导致死循环 | `WITH RECURSIVE` 用 `UNION`（去重）而不是 `UNION ALL` | 正常数据不会成环 |
| 删除时有别的进程正在读这个会话 | 读到一半数据消失 | D3 保证已归档会话不在运行；SQLite 事务保证一致 | 另一个标签页里还开着这个会话时，下次请求得到 404 并显示现有的错误提示 |
| 恢复时目录检查与实际不一致 | 检查时目录在，下一轮时被删 | 下一轮开始时已有的目录检查会报错 | 用户可再移动会话 |
| 归档检查竞态 | 检查后立刻有新任务开始 | 窗口很小，不加锁 | 任务在已归档会话里跑完，恢复后可见 |
