# 5. 实施与验收

## 5.1 范围与结论

- 日期：2026-10-25。
- 实施分支：`codex/archived-sessions-backend`，基于 `71f97f3d`。
- 本次范围：02 的 Stage 1、2，核心会话规则、全局 HTTP 路由、SDK 契约、OpenAPI 与后端测试。
- 分工以本次用户请求为准：agent 完成后端并提交；用户验收并实施前端；前端完成后再做原生浏览器端到端验证，最后才合并到 main 并 push。00、02 保留原规划，不回写历史分工。
- 后端提交时 Stage 3、4（Web 界面、mock、浏览器走查、设计文档同步）尚未实施；之后在同一分支完成，记录见 5.7。

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
| T10–T14 | 见 5.7 |

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

## 5.7 前端实施与验收（Stage 3、4）

- 日期：2026-10-25，同一分支，提交 `a296befb`、`072cb05c`、`da1d7061`、`14f6b875`，文档同步单独提交。
- 后端验收：重新跑了 6 个相关测试文件（核心恢复与删除、文件清理、HTTP 路由、REST 与 JSON-RPC 忙碌错误、归档前检查、真实 daemon 端到端），325 条全部通过；读代码确认删除条件和删除操作在同一个写事务里，和 02、04 一致。

### 实现与 02 的差异

| 项 | 实际实现 | 原因 |
|---|---|---|
| 接口层 | `GlobalSessionsClient.listSessions` 加 `status` 参数，新增 `unarchiveSession`、`deleteSession`；`GlobalLayer` 和运行时门面各加 3 个方法 | 照 02 Stage 3 第 2 步；`ArchivedSection` 只拿到运行时的这 3 个方法 |
| 行的样式 | 用 `SettingsRow`，整组放在一张圆角卡片里；删除是垃圾桶图标（悬停变红），恢复是浅底文字按钮 | 参照 Codex 和 ZCode：设置页里两个按钮常显，不靠悬停出现 |
| 时间 | `Archived 3d ago`，悬停显示完整日期 | 列表里相对时间好扫，完整日期按需看 |
| 分页 | 一页 50 条 | 设置页一次看不了 100 条，50 条够用，翻页也快 |
| 已在别处恢复或删除 | 收到 `404` 或 `SESSION_NOT_ARCHIVED` 时直接移除这一行，不报错 | 用户想要的结果已经成立 |
| 屏幕阅读器 | 恢复或删除后在隐藏的 `role="status"` 里读出结果 | 界面不弹通知（D10），读屏用户仍要知道结果 |
| 忙碌提示 | 侧栏菜单项后加 `Running`；服务端 `SESSION_RUNNING` 统一显示 `Stop the chat before archiving.` | 原始错误文案带会话 ID 和运行 ID，用户看不懂 |
| mock | 新增 `archived`、`archived-many`（120 条，测分页）、`archived-error`（首次读取和每次删除失败）3 个场景 | 02 只要求 `archived`；另两个用来走查分页和失败状态 |

没有做的仍按 D10：搜索、按工作区分组、一键删除全部、Undo。

### 验证记录

| 验收项 | 证据 |
|---|---|
| T10 分区 | `ArchivedSection.unit.test.tsx`：行说明文字、空状态、300 ms 后才显示 Loading、失败重试、Show more |
| T11 恢复与删除 | 同上：恢复后行消失、焦点到下一行或分区本身；删除先确认、焦点在 Cancel、失败时确认框保留；已在别处恢复时静默移除。`SettingsDialog.integration.test.tsx`：6 个分区顺序，恢复后会话以无工作区状态进入全局列表，删除后不再出现。`session-runtime.operations.integration.test.ts`：经 fake daemon 走完列表、恢复、删除，删除未归档会话得到 409 |
| T12 侧栏禁用归档 | `Sidebar.unit.test.tsx`：`running`、`awaiting` 时悬停按钮和菜单项禁用并有提示，快捷键 `a` 不触发；`idle` 可用。运行时测试覆盖 409 时显示提示并把行放回 |
| T13 浏览器走查（mock） | `archived` 场景：恢复后进入 Recents 顶部、焦点移到下一行；删除确认后行消失；`archived-many` 翻页 50 → 100；`archived-error` 失败后 Retry 成功；`running` 场景归档按钮和菜单项置灰；`fresh` 空状态；手机宽度 375 px 无横向滚动 |
| T13 浏览器走查（真实 daemon） | 用临时 `HOME`、`OHBABY_HOME` 和数据库启动编译后的 daemon，建 6 个会话、归档 4 个、删掉其中一个工作区文件夹。界面上：恢复后回到原工作区顶部；文件夹已删的会话进入 Recents，接口显示下一轮目录为默认目录；删除后搜索没有结果，再恢复返回 404 |
| T14 文档同步 | `rg` 检查无命中；README D12、00、01（新增 UC-SETTINGS-06）、04、05、06 已同步 |

命令结果：

- Web 全量：67 个测试文件、788 条通过。
- `pnpm typecheck`：通过。
- ESLint（提交钩子）：0 errors；本次新增代码没有新警告。
- Prettier：本次改动的文件通过。

## 5.8 独立视觉验收与并发修复（2026-10-25）

主代理使用 Codex 原生浏览器控制完成本轮操作。独立子代理只读审查前端提交 `b99a4202..1ee2c3fe`，随后复审修复；未委托子代理执行端到端测试。

### 审查发现与修复

1. P2：重新打开分区触发的旧刷新响应，或尚未完成的下一页响应，可以把刚恢复的行重新加入列表。增加修改版本检查；读取期间发生成功恢复、删除或已在别处移除时，丢弃旧结果并重新读取。无新依赖或状态管理层。
2. P2：恢复 A 尚未完成时打开删除 B 的确认框，A 完成后会聚焦背景行，Escape 随后关闭 Settings 并留下确认框。原生浏览器已复现；分区隐藏或确认框打开时丢弃焦点移交。修复后重测，焦点保持 Cancel，Escape 只关闭确认框。

新增 3 个回归用例，修复前均失败、修复后通过。子代理复审确认两项 P2 已关闭，未发现新增阻断问题。

### 本轮验证证据

| 场景 | 结果 |
|---|---|
| 真实 daemon 归档 | 从侧栏归档测试会话后，工作区和 Recents 均不再显示；Settings 列表立即读到它 |
| 恢复到原位置 | 恢复隐藏工作区中的会话，工作区重新显示，原会话回到该工作区 |
| 目录丢失 | 恢复已删除目录中的会话后进入 Recents；数据库核对 `workspace_directory = NULL`，下一轮目录为隔离环境默认目录 |
| 重载持久化 | 浏览器刷新后恢复结果保持，归档会话仍在归档列表 |
| 真实游标分页 | 真实服务 54 条归档：首批 50，Show more 后 54，ID 无重复且按钮消失 |
| mock 分页 | 120 条归档：50 → 100 → 120，无重复 |
| 加载失败与空态 | 首次读取失败出现说明和 Retry，重试后显示列表；fresh 场景显示 No archived chats |
| 运行中限制 | running 场景的行归档按钮禁用；操作菜单显示禁用的 Archive / Running |
| 删除确认键盘 | 默认焦点为 Cancel，Tab 在 Cancel/Delete 间循环；Escape 取消且 Settings 保持打开，焦点回到原删除按钮 |
| 视觉 | 桌面布局和 375 px 窄屏均检查；标题截断保留操作按钮，页面宽度等于视口，无按钮横向越界；确认框窄屏文字正常换行 |
| 控制台 | 真实服务页面无 error/warn |
| 真实浏览器永久删除 | 已到最终 Delete 确认框，目标为隔离测试服务内的 `E2E Delete disposable fixture`；原生浏览器永久删除规则要求操作时确认，等待用户回复后执行与核对。未以其他工具代替该点击 |

隔离环境使用单独的数据库、`OHBABY_HOME`、存储目录和 daemon 状态文件，不修改真实会话，也不改进程的 `HOME`。截图保存在当前 Codex 会话的 visualizations 目录：`archived-desktop.jpg`、`archived-mobile.jpg`、`archived-delete-confirm.jpg`。

本轮命令结果：Web 全量 67 个文件、791 条测试通过；Web 构建（含 TypeScript）通过；受影响文件 ESLint / Prettier 通过；真实 daemon 生命周期集成用例通过（创建、归档、恢复、重启、目录失效、删除及 404）。浏览器永久删除的最后一步仍单独待确认，因此暂未进行 main 合并与 push。
