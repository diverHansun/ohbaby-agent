# 5. 实施验收

## 5.1 范围与当前结论

| 项目 | 内容 |
|---|---|
| 议题 | 无项目会话、项目归属与设置，improve-1 |
| 首次审查、修复复审及提交前审查日期 | 2026-10-21 |
| 规划基线 | `241f930c`，加工作区内 00/02/04 已确认的 goal 暂停规则；工作区先、设置后，每批包含必要的后端、SDK 和 Web |
| 分支 | `codex/workspaceless-settings`，本轮分四批本地提交，不 merge、不 push |
| 本次复审范围 | F2 目标历史显示、F3 隐藏项目列表、F4 内部通知搜索、T4 默认目录旧数据升级；提交前再核对工作区后端与提交依赖 |
| 审查方式 | 主代理执行测试并重跑独立复现；修复复审由三个子代理分工检查；提交前另由三个子代理核对 API、运行时和提交分组 |
| 后端审查结论 | **工作区后端主体具备提交条件**：F2、F3、F4 和 T4 已关闭；提交前发现的 F5 默认目录复用 daemon 问题也已修复并通过回归。完整验收仍有待验证项，见 §5.5 |
| 完整第一批状态 | **部分完成，尚未完整验收**：G1 的 SDK 全局客户端方法和 Web 接入仍待完成，不属于本次修复范围 |
| 第二批状态 | 设置尚未进入本次验收 |

修复复审阶段未改变实现，已用文件哈希核对。随后提交前审查补了一处默认目录复用入口和对应回归测试。SDK 全局客户端方法与 Web 接入按用户确认，等 Web 规划完成后再做；设置仍是第二批，尚未实施。产品范围以 [00](00-discussion.md)、[02](02-optimization-plan-and-change-scope.md) §2.6 和 [04](04-test-and-acceptance.md) 为准。

## 5.2 第一批落地情况

| 规划内容 | 状态 | 实际情况 |
|---|---|---|
| 默认工作目录 | 已有核心自动化证据 | 默认目录创建、权限、父级 Git 边界、普通项目列表过滤，以及真实进程首次启动与复用均有测试 |
| 归属与执行目录分开 | 已有核心自动化证据 | `project_directory`、`pending_project_root` 与执行目录 `project_root` 分开；旧默认目录归属已补清理 |
| 移入、换项目、移出 | 已实现后端主要路径 | 保留 ID 和历史、队列交接、旧目录拒绝及目标视图刷新已有验证；goal 按确认规则暂停后手动继续 |
| 全局列表与搜索 | 本次已知缺陷已关闭 | 隐藏项目在普通列表中排除；内部通知不再参与搜索；分页、字面匹配和排序回归通过 |
| SDK | 部分完成 | 有 DTO、目录 helper 和内部路由检查，尚无全局列表、搜索、归属操作的客户端方法 |
| Web | 未完成 | 尚无草稿首发、全局侧栏与搜索、Project 菜单和移动后订阅切换 |
| 架构文档同步 | 待完整交付时补齐 | 多项目运行时、Web 架构和旧侧栏议题仍需同步 |

## 5.3 发现项的复审结果

### F1 · 已撤回：按确认规则暂停 goal

最初按自动续跑要求发现 A→B 后 goal 不再继续。随后 00/02/04 已将行为改为“目标保留并暂停，由用户在 B 手动继续”，因此不再将停止自动续跑视为缺陷。

本次再次运行独立用例：B 读回 paused 状态，目标和已用轮数保留；执行 `/goal resume` 后在 B 开始下一轮，模型 cwd 和数据库执行目录均为 B。验证通过，保持现有行为，无需增加跨实例 goal 交接。

### F2 · 已修复：目标实例重新读取原目录的完整回复

原问题是 B 在 A 尚未结束时缓存了不完整历史，后续忙重试没有刷新缓存。

[ui-inprocess.ts](../../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts) 第 3414–3437 行现在只在跨目录切换时执行补偿：先检查旧轮是否结束，有活动运行就沿用忙重试；确认旧轮结束后，调用现有 `sourceProjection.owner.rebuild()` 重新读取持久化消息和运行记录，再发布刷新后的会话。

[正式回归测试](../../../../packages/ohbaby-agent/src/adapters/session-project-move.integration.test.ts) 第 210–245 行在 A 结束前初始化 B，之后检查两条助手回复都有内容，且不残留 running 请求。本次还重跑了上一轮失败的独立用例：两轮正文均包含完整的 `ok` 回复，输出中的请求状态均为 success 并带结束时间。原缺陷不再复现，可以关闭。

### F3 · 已修复：普通列表排除隐藏项目，移出的会话仍可见

[global-query.ts](../../../../packages/ohbaby-agent/src/services/session/global-query.ts) 第 111–113、129–133 行按 `project_directory` 排除隐藏项目，明确保留空归属，并在分页前过滤。搜索没有使用这个隐藏条件，所以仍能找到隐藏项目的会话。

[正式测试](../../../../packages/ohbaby-agent/src/services/session/global-query.integration.test.ts) 第 149 行覆盖隐藏、移出后仍可见及隐藏项目仍可搜索。上一轮独立 SQLite 夹具中，普通列表现在不再返回隐藏项目会话，验证通过，可以关闭。

### F4 · 已修复：搜索排除内部通知，保留用户引导消息

[global-query.ts](../../../../packages/ohbaby-agent/src/services/session/global-query.ts) 第 116–117、239–243 行在原角色、scope、synthetic 条件上，增加 `runtimeInput.kind` 筛选：没有 runtimeInput 的普通正文继续参与搜索，带 runtimeInput 时仅保留 `user-steer`。这与现有会话显示规则一致。

[正式测试](../../../../packages/ohbaby-agent/src/services/session/global-query.integration.test.ts) 第 265 行验证内部通知搜不到、用户引导消息能搜到；普通 user/assistant 正文由既有用例覆盖。上一轮独立夹具中的内部标记也不再命中，验证通过，可以关闭。

### T4 · 已补齐：默认目录旧数据升级

迁移 025 仍负责一次性补齐旧归属。持久化后端在 `initDatabase()` 之后、会话读取之前调用 `clearDefaultWorkspaceProjectBindings()`，清理归属等于默认目录配置路径或真实路径的记录。

- 启动调用：[ui-persistent.ts](../../../../packages/ohbaby-agent/src/adapters/ui-persistent.ts)，第 670–672 行。
- 清理逻辑：[database-store.ts](../../../../packages/ohbaby-agent/src/services/session/database-store.ts)，第 126 行。
- 升级测试：[session-project-move.integration.test.ts](../../../../packages/ohbaby-agent/src/adapters/session-project-move.integration.test.ts)，第 256–280 行。

新测试创建缺少迁移 025 的真实旧库，插入默认目录和普通项目会话，再通过持久化后端启动完成升级。结果为默认归属清空、普通归属保留，测试通过。清理只修改匹配记录的归属，不改实际目录、待生效目录、时间和历史；重复执行不会重新绑定会话。普通会话移出后重启不重绑的既有测试也通过。

该静态差异已经关闭。无需为这条幂等清理增加额外迁移框架。

### F5 · 提交前发现并修复：默认目录复用已有 daemon

首次启动已经跳过默认目录的项目登记，但复用已有 daemon 时仍调用 `/v1/scopes/open`，被默认目录不能作为项目的规则拒绝，返回 HTTP 400。

[main.ts](../../../../packages/ohbaby-server/src/runtime/daemon/main.ts) 的 `restoreWorkspaceInRunningDaemon()` 现在对默认目录直接返回，两条复用分支共用这个判断。进程、健康状态、版本及端口检查仍保留，普通项目仍按原逻辑恢复到项目列表。

[真实进程回归](../../../../packages/ohbaby-server/src/runtime/daemon/global-single-serve.integration.test.ts) 新增 `reuses the default workspace without registering it as a project`：在隔离目录中先启动服务，再用第二个进程从同一默认目录启动，检查复用同一服务且项目列表为空。修复前实际报 HTTP 400，修复后通过；相关三文件 41 项测试全部通过，子代理再次只读复核通过。

### G1 · 仍待完成：SDK 与 Web 接入

G1 属于完整批次的交付范围，不是这次修复遗留的缺陷，本次不扩展实现。

[SDK 全局类型](../../../../packages/ohbaby-sdk/src/global-sessions.ts) 已存在，但客户端方法尚未加入。Web 的 [App.tsx](../../../../apps/ohbaby-web/src/ui/App.tsx) 仍要求先打开项目，[runtime.ts](../../../../apps/ohbaby-web/src/runtime.ts) 仍立即创建新会话；全局侧栏、搜索和 [Project 菜单](../../../../apps/ohbaby-web/src/ui/session/SessionActionsMenu.tsx) 尚未接入。

后续结合前端规划完成 SDK 方法和工作区 Web，再按 04 完整验收第一批；设置仍属于第二批。

## 5.4 SWE 与 KISS 评价

这次修复集中在原有职责内：F2 复用运行记录的忙重试和会话视图重建；F3/F4 在现有 SQL 中补齐筛选；T4 在已有启动入口清理无效归属；F5 在原有恢复入口跳过默认目录。没有新增依赖、搜索服务、第二套存储或任务迁移框架，复杂度与实际问题相称。

提交前审查发现的 F5 已修复并经子代理复核，未再发现必须阻塞本地提交的问题。配置、权限和重启组合属于尚未完成的专项验证，不能据此宣称完整验收，也不要求为本次提交增加新机制。

## 5.5 测试证据

### 本次修复复审：2026-10-21

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | 通过，退出码 0 |
| `pnpm lint` | 通过，0 错误、122 条警告；没有执行自动修复 |
| 正式相关测试 | **11 个文件、301 项全部通过**，命令为 `pnpm exec vitest run --no-file-parallelism` 加下列文件 |
| 上轮独立运行时用例 | **3 项通过**：空闲移动后的 cwd、排队移动后的完整回复、goal 暂停后手动继续。按旧规则要求 goal 自动续跑的 1 项被名称过滤排除，不用于当前验收 |
| 上轮独立 SQLite 夹具 | **2 项检查通过**：隐藏项目不出现在普通列表、内部通知不命中正文搜索 |
| 稳定性核对 | 复审期间实现和测试文件哈希未变化，避免把不同版本的结果混在一起 |

正式测试文件及数量：

| 测试文件 | 项数 |
|---|---:|
| `adapters/ui-inprocess.contract.test.ts` | 172 |
| `adapters/ui-persistent.integration.test.ts` | 39 |
| `adapters/ui-state/persistent-store.integration.test.ts` | 17 |
| `services/database/database.integration.test.ts` | 24 |
| `services/session/global-query.integration.test.ts` | 14 |
| `adapters/session-project-move.integration.test.ts` | 3 |
| `services/session/project-binding.integration.test.ts` | 8 |
| `paths/default-workspace.unit.test.ts` | 6 |
| `runtime/daemon/global-server.integration.test.ts`（server） | 8 |
| `coordination/session-project-move.unit.test.ts`（server） | 6 |
| `protocols/global-sessions.unit.test.ts`（server） | 4 |

未标 server 的测试均位于 `packages/ohbaby-agent/src/`，server 测试位于 `packages/ohbaby-server/src/`。独立用例是复审时运行的临时夹具，不属于仓库中的永久测试；正式回归以表内测试文件为准。

本次按修复范围运行相关测试，没有重新运行全仓套件、浏览器走查或真实付费模型。截图中的全量测试数字属于实施方提供的结果，不计入本次独立复跑统计。

### 首次审查的历史证据

首次审查曾运行全仓测试：576 个文件通过、6 个跳过，6,818 项通过、17 项跳过。期间源码有更新，因此又补跑了 250 项相关测试。独立复现当时发现 F2/F3/F4，说明全仓通过并不等于这些行为已经覆盖。本次正式回归和独立复现已经验证相应修复，旧失败记录不再代表当前状态。

### 提交前补充验证：2026-10-21

F5 的真实进程回归先失败、后通过；随后运行以下命令，**3 个文件、41 项全部通过**，包括普通项目复用、进程重启和全局 HTTP 接口。这里包含前述 301 项中的 8 项全局接口测试，不重复累加为独立用例数。

```sh
pnpm exec vitest run --no-file-parallelism \
  packages/ohbaby-server/src/runtime/daemon/global-single-serve.integration.test.ts \
  packages/ohbaby-server/src/runtime/daemon/main.unit.test.ts \
  packages/ohbaby-server/src/runtime/daemon/global-server.integration.test.ts
```

### 对照完整批次验收项

| 验收项 | 当前状态 | 证据或剩余范围 |
|---|---|---|
| T1–T2 | 已有核心自动化证据 | 默认目录权限、Git 边界、scopes 过滤通过；真实双进程验证默认目录首次启动与复用，普通项目复用回归通过 |
| T3 | 部分验证 | 缺目录头、全局鉴权已有断言；默认目录下完整工具与权限流程未单独走查 |
| T4 | 默认路径升级缺口已关闭 | 真实旧库升级、新建及子代理归属、普通移出后重启不重绑的用例通过 |
| T5 | 部分验证 | 同 ID/历史和空闲移动后目标 cwd 通过；目标配置/权限未完整验证 |
| T6 | 已知缺陷已关闭，完整验收待补 | 队列交接、busy 重试、旧头拒绝、两轮完整回复、goal 手动继续有证据；目标权限与重启组合仍沿用原完整批次验收要求 |
| T7 | 部分验证 | 取消 pending、保留目录、队列回交计划有断言；运行中移出的完整交互尚待整批走查 |
| T8 | 已有核心自动化证据 | 隐藏过滤修复通过；超过 500 条分页、根会话/归档过滤回归通过 |
| T9–T10 | 已有核心自动化证据 | 旧历史、长正文、同消息多文本块、禁止跨字段拼接的测试通过 |
| T11 | 已有核心自动化证据 | 内部通知过滤修复通过；字面匹配、大小写、用户引导正文等回归通过 |
| T12 | 部分验证 | 排序、去重、片段和分页通过；完整 SDK 客户端契约仍待接入 |
| T18–T22、T24 | 未完成，G1 | Web 草稿、侧栏、搜索、Project 菜单和状态同步尚未实施 |
| T13–T17、T23 | 本次不验收 | 第二批设置 |

HTTP 路由测试的 catalog/backend 使用 mock，不能替代真实数据库、daemon、Web 的整条用户流程。完整第一批仍应按 04 §4.5 走查。

## 5.6 后续工作

后端按依赖顺序分四批本地提交：默认目录边界；会话归属、持久化与全局查询；移动后的运行衔接及 goal 暂停规则；服务接口、默认目录复用修复及本验收记录。每批包含相关测试，不包含 Web 或设置实现。

后续先完成 Web 规划，再补 G1 的 SDK 方法与 Web 接入，同步架构文档并完成第一批端到端验收；第一批完成后再推进设置。本轮不 merge、不 push。
