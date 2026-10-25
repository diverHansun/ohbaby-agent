# 5. 后端实施与验收

## 5.1 范围与结论

- 日期：2026-10-25。
- 实施分支：`codex/archived-sessions-backend`，基于 `71f97f3d`。
- 本次范围：02 的 Stage 1、2，核心会话规则、全局 HTTP 路由、SDK 契约、OpenAPI 与后端测试。
- 分工以本次用户请求为准：agent 完成后端并提交；用户验收并实施前端；前端完成后再做原生浏览器端到端验证，最后才合并到 main 并 push。00、02 保留原规划，不回写历史分工。
- 本轮仍未全部完成：Stage 3、4 的前端界面、Web mock、浏览器走查和 Web 设计文档同步尚未实施。

## 5.2 前端对接

下列全局接口只需要 daemon 鉴权，不需要 `x-ohbaby-directory`、客户端注册或加载工作区实例。归档接口仍沿用原来的实例路由及客户端注册要求。

| 操作 | 接口 | 成功响应 | 说明 |
|---|---|---|---|
| 归档列表 | `GET /v1/sessions?status=archived&limit=100&cursor=...` | `{ ok: true, sessions: UiGlobalSession[], nextCursor?: string }` | 只列根会话，包括隐藏工作区；按 `updatedAt`、ID 倒序。省略 `status` 仍列活跃会话 |
| 恢复 | `POST /v1/sessions/:id/unarchive` | `{ ok: true, session: UiGlobalSession }` | 无请求体；恢复成功后可将返回行写回全局目录并刷新 |
| 永久删除 | `DELETE /v1/sessions/:id` | `{ ok: true, deletedSessionIds: string[] }` | 包含根及所有后代；前端应先确认再调用 |
| 归档 | `PATCH /v1/sessions/:id/archive` | `{ ok: true }` | 会话树有活跃运行或待执行消息时拒绝 |

错误响应沿用 `{ ok: false, error: { code, message } }`：

| HTTP 状态 | code | 处理建议 |
|---|---|---|
| 400 | `INVALID_QUERY` / `INVALID_CURSOR` | 校正查询参数；`status` 只接受 `active`、`archived` |
| 404 | `SESSION_NOT_FOUND` | 会话已不存在，刷新列表 |
| 409 | `SESSION_NOT_ROOT` | 只能操作根会话 |
| 409 | `SESSION_NOT_ARCHIVED` | 会话已被恢复或从未归档，刷新列表 |
| 409 | `SESSION_RUNNING` | 先停止任务或处理队列，再归档或删除 |

SDK 导出 `UiGlobalSessionStatus`、`UiSessionDeleteResult`、`SESSION_RUNNING_ERROR_CODE`、`SESSION_NOT_ARCHIVED_ERROR_CODE`。恢复复用 `UiGlobalSession`。JSON-RPC 的归档失败同样携带 `SESSION_RUNNING`，不新增恢复或删除 RPC 方法。

归档时间继续使用 `updatedAt`。恢复更新该时间，所以回到正常列表后排在最近位置。归档列表的搜索、分组、批量删除不在本次范围。

## 5.3 实现及与规划的差异

| 项 | 实际实现 | 与 02 的关系 |
|---|---|---|
| 归档忙碌检查 | 检查本进程活跃 prompt、数据库运行账本、跨 scope 的未完成 prompt；遍历 `listChildren` 直到所有后代检查完毕，以 Set 防止循环 | 比规划多检查后代的待执行消息和 `running` prompt，避免后代尚未创建运行记录时漏查；复用 SessionManager 的数据库读取，不另写一套实例数据库入口 |
| 恢复 | 事务内检查已归档根会话，保留可用工作区；下一轮目录丢失时写入工作区目录或默认目录；HTTP 层重新打开隐藏工作区 | 与 D4–D7 一致 |
| 删除 | 一个写事务内递归收集会话和检查点，显式清理无外键记录，再依赖外键级联删除其余数据 | 与 D8 一致；递归使用 `UNION`，不展开 ID 参数列表 |
| 删除忙碌检查 | 删除事务内检查整棵树的 `pending/running` 运行和 `queued/starting/running` prompt，忙碌返回 409 | 有意补充：旧版本允许归档运行中的会话，不能仅靠 archived 状态证明删除安全。T4 的队列清理用 `retained` 记录验证；待执行队列另测拒绝删除 |
| 核心函数签名 | `restoreArchivedSession(sessionId, input, db = getDatabase())`、`deleteArchivedSession(sessionId, db = getDatabase())` 返回 Promise | 遵循当前 `workspace-move.ts` 和 `runWriteTransaction`；事务回调保持同步，不在事务中等待文件系统 |
| 文件清理 | `cleanupDeletedSessionFiles` 复用 `GitSnapshotEngine.dropRef` 和 `PathResolver`；每项失败单独记录，继续处理其他项 | 修复原 `deleteRef`：只传 `--git-dir`，不以已删除工作目录为 cwd；无需重复 sidecar 路径算法。结果路径保留已有安全校验 |
| 存储根 | 使用现有 snapshot、storage 默认根，读取相同的 `OHBABY_STORAGE_ROOT` / 数据根 | 与 persistent backend 一致，没有新增配置 |
| 依赖与迁移 | 无新依赖，无数据库结构变化 | 与规划一致 |
| Web 测试辅助 | 未修改 `apps/ohbaby-web` | 用户本次明确只做后端，前端 mock 与 fake daemon 留给前端实施 |

已加载实例的剩余内存资源仍按 02 §2.8，在实例卸载或 daemon 重启时释放。归档前检查与另一个进程启动任务之间的竞争窗口仍存在；本次未增加跨进程锁或新运行门禁。删除事务会再次检查当前可见的运行与队列，降低误删风险。

## 5.4 验证记录

| 验收项 | 证据 |
|---|---|
| T1 运行中不能归档 | `ui-inprocess.contract.test.ts`：本地运行、独立账本写入、孙会话运行、其他 scope 的 queued/starting 消息均拒绝；结束后可以归档 |
| T2–T5 恢复与删除 | `archive.integration.test.ts`：四种目录组合、错误不改数据、三层树逐表清理、其他会话保留、注入失败回滚、1,201 个会话删除、旧版忙碌归档记录拒绝删除 |
| T6–T7 列表与恢复接口 | `archive-server.integration.test.ts`：真实 SQLite + HTTP，隐藏工作区分页、默认 active、非法 status、鉴权、错误码、可选注册表、目录缺失回退 |
| T8 文件清理 | `archive-files.integration.test.ts`：真实 Git pre/post 引用，在 workdir 删除后清理，保留其他检查点；递归清理结果目录；路径越界拒绝；注入清理失败继续执行。HTTP 测试额外确认清理失败仍返回 200 并记日志 |
| T9 对外忙碌错误 | `create-app.unit.test.ts`：REST 与 JSON-RPC 均返回 409 和 `SESSION_RUNNING` |
| 主代理端到端 | `global-single-serve.integration.test.ts` 新增真实 daemon 进程用例：创建 → 拒绝直接删除活跃会话 → 归档 → 列表 → 隐藏工作区 → 恢复 → 再归档 → 重启并删除原目录 → 恢复到 Recents → 归档并永久删除 → 恢复返回 404。由主代理执行，使用临时目录和数据库 |
| 子代理审查 | 独立只读检查实现与 02/04，未发现可确认的 P1/P2 阻断问题 |
| T10–T14 | 本批未实施；前端完成后验收 |

命令结果：

- `pnpm test`：618 个测试文件通过、6 个跳过；7,227 条通过、17 条跳过。覆盖 unit、contract、integration 及仓库默认 smoke 用例。
- 最终受影响范围回归：25 个文件、511 条测试通过，包含全量回归后新增的“大量后代删除”和“HTTP 文件清理失败”两项测试。
- `pnpm typecheck`：通过。曾与打包测试并行运行时遇到 `dist` 被重建导致的类型输出缺失；全部打包结束后串行重跑通过。
- `pnpm lint`：0 errors，122 warnings，均为未改动位置已有的返回类型等警告。
- 所有变更 TypeScript 文件的 Prettier 检查及 `git diff --check`：通过。
- `pnpm build`：通过；有 Web bundle 大小提醒，无构建错误。
- 主代理单独执行真实 daemon 端到端用例：通过。未运行前端浏览器验收，因为前端本批未实施。

## 5.5 SWE 审视

规则留在核心会话层，HTTP 只负责鉴权、目录可用性和响应转换；删除条件与数据删除处于同一事务中，文件系统操作放在提交后。列表、事务工具、路径校验和快照引擎都复用已有实现，没有引入新框架、迁移或抽象层。新增复杂度主要来自不可逆删除所需的完整性检查与测试。

## 5.6 参考核对

- 子代理重新检查了 deepseek-harness、ZCode、kimi-code 的相关源码，03 中主要结论成立。deepseek-harness 还有归档后的模型步骤门禁，ohbaby 本次不照搬该插件机制。ZCode 在事务内重新检查归档状态，支持本次把删除前置条件放进事务的做法。
- [Claude Code Desktop 官方文档](https://code.claude.com/docs/en/desktop#archive-a-session)描述归档入口和 Unarchive；[查找归档会话](https://code.claude.com/docs/en/desktop#organize-and-find-sessions)说明可从 Archived 列表找回。这里只借鉴可恢复的会话组织方式，不推断闭源内部数据实现。
- Cursor 的旧 History 文档当前重定向到概览，查到的 Agents Window 页面没有给出足够明确的永久删除约束，因此本次不据此新增规则；以用户确认的 D1–D10 和本地参考源码为准。
