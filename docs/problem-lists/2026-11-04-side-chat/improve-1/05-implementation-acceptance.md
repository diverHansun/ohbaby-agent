# Side Chat 后端实施与验收

2026-11-10 · Stage 1 · 本地分支 `codex/side-chat-backend` · 起点 `605d3fb7`

## 可交付行为

| 操作 | 后端行为 |
|---|---|
| 打开 | 在同一 SQLite 事务中复制到最近一个有历史消息的已结束主 run，写入边界消息。如果首条 prompt 已被接收而首轮仍在排队或执行，边界会带上当前请求。空会话返回 `409 SIDE_CHAT_UNSUPPORTED`。 |
| 提问 | 新的 prompt、run、审批属于侧聊。已加载的 MCP 工具按复制的历史重建。模型请求和自动压缩沿用主会话的缓存身份，文件工具使用主会话的 scratch。侧聊创建时复制已有会话审批规则，之后各自更新。 |
| 发现与恢复 | 普通会话列表、搜索和自动继续隐藏侧聊。恢复列表按创建顺序返回当前进程的侧聊，每条包含 `sideChatId`、`title`、`createdAt`、`boundaryMessageId` 和 `workingDirectory`。 |
| 移动主会话 | 已有侧聊继续使用原工作区。新开侧聊继承主会话此前各工作区的完整历史，并在目标工作区接受新问题。恢复客户端按列表里的目录重新绑定。 |
| 关闭与归档 | 关闭时取消排队、中止运行、清理审批并删除侧聊，重复关闭返回 `204`。主会话归档前检查运行状态，再到每个侧聊的工作区完成清理。启动时回收创建进程已退出的侧聊。 |

手动压缩、模型或 reasoning 切换、goal、归档、移动、导出及嵌套侧聊走禁用检查。模型在侧聊里调用子代理工具会收到说明，其余工具继续按既有权限运行。共享复制函数及切点查询可供下一轮 Fork 使用。接口见 [02 §2.5](02-optimization-plan-and-change-scope.md#25-接口)。

## 后端验证

端到端验收直接启动构建后的 CLI，用 `curl` 调用 daemon，并用 `sqlite3` 核对落库结果。工作区、数据库和本地 OpenAI 兼容模型端点均为临时实例。

| 实际操作 | 观察结果 |
|---|---|
| 在空主会话开侧聊，然后提交第一轮再打开 | 首次返回 409 和 “Send a message first”。第一轮成功后，打开和恢复接口返回同一个侧聊及边界 ID。 |
| 分别绑定主客户端和侧聊客户端并提问，随后手动压缩并连续关闭侧聊两次 | 两边各自的 prompt 均成功且记录在各自会话下。手动压缩返回 409，两次关闭均返回 204，SQLite 中该侧聊的会话行已删除。 |
| 从工作区 A 打开侧聊，将主会话移动到 B，再在 B 打开第二个侧聊 | 从 B 查询恢复列表得到 A、B 两个目录。主会话已有的两条 prompt 保留在 A，新侧聊的两条历史副本位于 B。 |
| 按恢复列表的目录重新绑定 A 的侧聊并提问，随后从 B 归档主会话 | 提问在原侧聊成功完成。主会话状态变为 `archived`，两处侧聊均已删除。 |

首轮回归用例按 [04 的 Stage 1 场景](04-test-and-acceptance.md) 验证历史切点、同毫秒消息排序、steer、压缩、模型原生状态、缓存与工具、归档竞态和孤儿清理函数。其中跨目录归档用例让旧侧聊同时有一个待审批的工具调用和一条排队消息，归档后分别得到 `interrupted` 和 `cancelled`，待审批列表为空。模型请求的前缀和缓存键在请求边界比对，供应商的线上缓存命中率未实测。

聚焦检查可直接运行：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/services/session/copy-history.integration.test.ts \
  packages/ohbaby-agent/src/adapters/ui-inprocess/side-chat.integration.test.ts \
  packages/ohbaby-agent/src/adapters/side-chat-runtime.integration.test.ts \
  packages/ohbaby-server/src/runtime/daemon/main.unit.test.ts
```

首轮上述 4 个文件共 38 项通过，其中 15 项为 Side Chat 相关用例，另外 23 项为 daemon 启动文件原有用例。首轮的两个客户端命令行走查覆盖了提交和绑定；事件隔离与真实启动清理的自动化覆盖见下方复修记录。`pnpm build`、`pnpm typecheck` 和 `pnpm format:check` 通过，`pnpm lint` 报告 0 个错误、119 个警告。

在代码提交 `a0bc0695` 上运行 `pnpm exec vitest run --maxWorkers=3 --minWorkers=1`，7,860 项通过、17 项跳过、0 项失败。先前一次四 worker 运行中，已有的 SQLite 写入预算用例得到另一条 busy 错误文案。该文件独立复测三次，每次 4 项均通过，随后也通过了上述全量回归。本轮没有修改数据库写入预算和重试逻辑。

## 审查确定的边界

- 当前进程持有侧聊才能关闭它。侧聊由另一活进程持有，或本地运行在 5 秒内无法停止时，返回 `409 SESSION_RUNNING` 并保留该侧聊。归档前会检查是否存在其他进程持有的侧聊。多个侧聊逐个关闭，若其中一个超时，主会话保持活跃，此次已成功关闭的侧聊保持关闭。可重试归档以完成剩余清理。
- 如果切点消息的时间晚于当前系统时间，打开操作回滚并给出可重试时间，避免后续问题落在边界之前。
- 此轮交付持久化进程内后端、daemon 和 SDK。Web 面板、TUI `/btw` 及其界面验收留到三个后端阶段之后。Fork 和 Rewind 分别在后续阶段加入自身入口的侧聊禁用检查。

## 验收意见（2026-11-10）

验收范围是 `main...codex/side-chat-backend` 的 3 个提交（`ab7fcf66`、`5b8b7914`、`a0bc0695`）。验收按两条线并行审查：一条看代码质量，一条逐条对照 02 和 04。验收会话在本地复跑了以下检查：

- `pnpm typecheck` 通过。
- 上面 4 个聚焦测试文件的 38 项通过。
- 全量 `pnpm test` 通过：7860 项通过，17 项跳过，0 项失败。

结论：**暂不切 fork 分支。** 先在本分支修完 V1 到 V9、补齐 V10 到 V12 的测试、同步 V13 到 V15 的文档，再由验收会话复审修改部分。复审通过后，从本分支最新 commit 切 fork 分支。V16 到 V21 可以顺手修，不阻塞 fork。

### 必须修复

| 编号 | 位置 | 问题 | 修法 |
|---|---|---|---|
| V1 | `services/session/types.ts` 的 `SideChatMetadata`、`orphan-side-chats.ts`、`ui-inprocess.ts` 和 `ui-persistent.ts` 中所有比较 `ownerPid` 的地方 | 只用 PID 判断归属。新进程拿到旧进程的 PID 时（daemon 在容器里固定是 PID 1），会把旧进程留下的 side chat 当成自己的：启动清理删不掉，启动时还会恢复它，归档主会话时一直报忙。这是 02 第 1 步的设计漏洞，不是实现偏差。 | 照 prompt 调度的做法（`runtime/prompt-scheduler/in-memory-store.ts:82`、`:699`），`data.sideChat` 再记一个进程实例 ID `ownerId`（每个进程启动时随机生成一次，同一进程内所有 side chat 共用）。判断“属于本进程”看 `ownerId` 相等。判断孤儿的条件是 PID 已不存在，或 PID 等于本进程而 `ownerId` 不同。恢复列表和 `GET` 只返回 `ownerId` 等于本进程的条目。 |
| V2 | `ohbaby-server/src/coordination/client-view.ts:214` `projectSnapshotForClient` | 没绑定会话的调用方能看到什么，取决于库里有没有 side chat。只要有一个，`activeSessionId` 就变成 `null`，其他会话的消息也被清空。不用 side chat 的旧调用方也会受影响，违反 04 §4.4。 | 未绑定时只把 side chat 从 `sessions` 中去掉（连同它们的 todo、goal），其余字段和改动前一致。补一条单元测试：库里有 side chat 时，未绑定快照的 `activeSessionId` 和普通会话消息不变。 |
| V3 | `services/session/copy-history.ts:91` | 切点无效时抛普通 `Error`，fork 无法转成 `FORK_TARGET_INVALID`。 | 改为带类型的错误，例如 `HistoryCutInvalidError`，放在 `services/session/errors.ts`。side chat 的打开流程保持现有行为。 |
| V4 | `adapters/ui-inprocess/side-chat.ts:156-158` | “主会话是否已移到别的工作区”的检查只写在打开 side chat 里，fork 也需要同样的检查。 | 抽成共用函数，例如 `assertSessionInWorkspace(tx, sessionId, promptScopeKey)`，放在 `copy-history.ts` 旁边，side chat 调用它。fork 在下一阶段直接复用。不要把它塞进 `copySessionHistory` 本身，复制函数只管复制。 |
| V5 | `runtime/prompt-scheduler/database-store.ts:1`、`runtime/run-ledger/database.ts:1` | runtime 层新增了对 `services/session/archive.ts` 的依赖。原来 runtime 只依赖 `services/database`。 | 把 `assertActiveSessionForWork` 移到 session 层的纯查询模块（只依赖数据库类型），runtime 从那里引用。行为不变。 |

### 超出 02 的改动：保留，并补进 02

| 编号 | 位置 | 处理 |
|---|---|---|
| V6 | `adapters/ui-runtime/composition.ts:426-441` 在 side chat 里拦截 goal 工具 | 符合 00 “side chat 不能用 goal”的本意，保留。02 第 5 步补上“goal 工具同样拦截”。工具名改为引用 goals 模块里的常量，不再写字符串（同时解决 V19）。 |
| V7 | `ui-inprocess.ts:5498` 在 side chat 上拒绝所有 `executeCommand` | 比 02 只拦手动压缩的要求宽，先保留，02 第 4 步如实记录。TUI `/btw` 阶段再评估是否放开部分命令。 |
| V8 | `assertActiveSessionForWork` 和 `archiveIdleRoot`：已归档会话树不能再排 prompt、建 run | 对所有会话生效，用来防归档和新工作之间的竞态。保留，按 V5 调整位置。02 的风险表补一行，说明这是对所有会话生效的行为变化。 |
| V9 | `client-view.ts`、`sse-hub.ts:567-571`、`permission-router.ts`：todo、goal、notice 事件和审批按会话分发 | 对所有客户端生效，属于 04 §4.4 的回归面。保留，前提是 V10 的 T11 测试补上。02 的改动面补上这三个文件。 |

### 测试缺口

| 编号 | 04 场景 | 缺什么 |
|---|---|---|
| V10 | T11 两个客户端 | 没有测试。客户端 A 绑定主会话、B 绑定 side chat：A 只收到主会话的事件、todo、goal、notice 和审批，B 只收到 side chat 的；B 提交后 A 的绑定不变。 |
| V11 | T13 接口契约 | 没有测试。三个路由（`routes/sessions.ts:113,195,208`）的状态码和响应体 `code`，包括 `SESSION_NOT_FOUND`、`SIDE_CHAT_UNSUPPORTED`、`SESSION_RUNNING`、`SESSION_MOVED`、重复关闭返回 204；JSON-RPC 的映射（`rpc-route.ts`）与 HTTP 一致。 |
| V12 | T9、T10、T5、T6 | 以下几项只测了一部分，按 04 补齐：<br>- **T9**：对运行中的 side chat 直接调用关闭，断言内存里的视图、todo、权限规则被清掉。<br>- **T10**：断言启动时确实调用了 `deleteOrphanSideChats`（`ui-persistent.ts:846`），并覆盖 V1 的 PID 复用情形。<br>- **T5**：关掉 2 号后再开，得到 2 号；别的主会话的 side chat 不受影响。<br>- **T6**：模型、reasoning、goal 入口，归档 side chat 本身，在 side chat 里再开 side chat。 |

### 文档同步

| 编号 | 文档 | 改什么 |
|---|---|---|
| V13 | 02 第 0 步和 §2.5 | 按实际代码改写：消息 ID 格式；prompt 不按作用域筛选，而是复制所有作用域再改写到目标作用域；新增参数 `destinationSessionId`；切点无效时的错误类型（V3）；共用的工作区检查（V4）。§2.5 错误表加 `SESSION_MOVED`。第 1 步加 `ownerId`（V1）。fork 02 写的是“以这一步为准”，所以这一项必须在切 fork 分支前完成。 |
| V14 | 00 第 6 节 | 补一条决定：归档主会话时，到每个 side chat 所在的工作区分别关闭它。 |
| V15 | 本文档上面的“后端验证”一节 | 改正三处说重了的地方：<br>- 38 项测试里有 23 项来自 `main.unit.test.ts`，那个文件只加了测试桩，没有 side chat 用例，要如实写明；<br>- “客户端隔离、启动清理已验证”，要等 V10、V12 补齐后才成立；<br>- 删掉“改名走禁用检查”，代码里没有改名入口。<br>同时更新 `docs/services/session/data-model.md` 里 `sideChat` 一行的字段说明（加 `ownerId`）。 |

### 建议顺手修（不阻塞 fork）

| 编号 | 位置 | 问题 | 修法 |
|---|---|---|---|
| V16 | `copy-history.ts:211` | 复制消息的 ID 是 `message_-copy_…`，靠 `-` 排在数字前面来保证排在原消息之前。ID 格式一改顺序就会乱。 | 在函数注释里写明这个约束，并补一条排序断言测试。如果有不依赖字符顺序的写法更好。 |
| V17 | `adapters/ui-inprocess/side-chat.ts:252-257` `stopSideChatWork` | `deadline` 和 `setTimeout` 写了两套 5 秒超时。 | 只留一套。 |
| V18 | `ui-inprocess.ts` 关闭 side chat（约 3343-3356）和归档（约 3428-3434） | 两处各写了一份逐个删除内存状态的代码。 | 抽成一个函数，例如 `forgetSessionState(sessionId)`。 |
| V19 | `composition.ts:426` | goal 工具名写死成字符串，和 goals 模块的定义重复。 | 见 V6。 |
| V20 | `ohbaby-server/src/runtime/daemon/server.ts:935-938` `closeSideChatInWorkspace` | 加载不到工作区时，悄悄退回用根 backend，会把配置错误藏起来。 | 加载不到时直接报 `SESSION_MOVED`。 |
| V21 | `adapters/ui-inprocess/side-chat.ts:211,222` | 在适配层直接 `INSERT INTO message`/`part` 写边界消息，绕过了 message store。 | 边界消息改走 message store（传入事务），或把这段移到 `services/session` 里，和复制函数放在一起。 |

### 留给 fork 阶段

- `findEndedMainRun`（`copy-history.ts:11-48`）和 SDK `listEndedTurns`（`packages/ohbaby-sdk/src/util/turn.ts:51`）判断“已结束轮次”的规则不完全一样。SDK 会列出 prompt 已结束但没有任何消息的轮次，后端要求至少有一条消息。这样界面上会出现后端拒绝的 fork 按钮。验收会话在 fork 开工前，在 fork 02 里定下按哪一边对齐。side chat 只取最近一个可用切点，不受影响，本分支不用改。（2026-11-10 已定：fork 新增 `findForkableMainRun`，只认最终 AI 回答有正文的轮次，和 Web 复制按钮的规则一致，见 fork 00 第 6 节。）
- `validatePermissionRoot`（`ui-inprocess.ts` 约 2538 行）把 side chat 当作根会话放行。side chat 的审批属于它自己，这是预期行为，不用改。

## 复修记录（待用户复审）

| 验收项 | 修改与验证 |
|---|---|
| V1、T5、T10 | 每次进程启动生成一个共享的 `ownerId`。持久化后端与 daemon 启动用例验证同 PID 不同实例的遗留侧聊会被回收。另一个存活 PID 的旧格式记录保留。并发打开、复用已关闭的 2 号、归档时保留另一主会话的侧聊均有回归断言。 |
| V2、V9、T11 | 旧 RPC 调用方保留普通会话的选择和消息。双客户端集成用例连接真实 daemon，以测试后端产生可控的消息、todo、goal、notice 及审批事件，检查每个客户端实际接收的内容，并检查侧聊提交后的主客户端绑定。两个 prompt 重叠时按会话和已知 run 分发运行状态。旧事件缺少会话标识时，只在归属明确时投递；重连时按原投递的会话过滤，避免切换绑定后回放上一会话的状态。 |
| V3、V4、V13、V16、V21 | 无效切点抛出带会话与 run ID 的 `HistoryCutInvalidError`。工作区检查由编排层在事务内调用。边界消息复用消息存储的写入函数。同毫秒排序沿用现有分页规则，测试通过真实分页接口验证历史、边界、新消息的顺序。复制接口与目标 scope 见 02 §2.5。 |
| V5–V8、T6、V19 | 写入 prompt 与 run 的归档检查已抽出为独立查询。goal 工具定义和拦截使用同一组名称。T6 在持久化后端验证显式命令、模型与 reasoning 设置、侧聊自身归档以及嵌套打开都返回禁用错误。改名没有后端入口。 |
| V11、T13 | 在 SQLite 后端上对 REST 和 JSON-RPC 核对错误状态和响应体，覆盖主会话不存在、非根会话、已归档、操作禁用、运行繁忙和目录变更。REST 重复关闭返回 204，RPC 重复关闭返回成功。 |
| T9、V14、V15、V17、V18、V20 | 正在等审批的侧聊直接关闭后，run 被中止，快照中的视图、todo、待审批请求和会话权限规则被移除。关闭过程共用一个 5 秒时限。跨目录归档按原目录查找持有侧聊的运行实例，缺失时返回 `SESSION_MOVED`。00、02、04 和数据模型已同步。 |

命令行实测使用临时 SQLite 数据库和构建后的 CLI。启动前写入一条与即将启动的 daemon 同 PID、实例 ID 不同的侧聊记录，启动后确认已删除。通过 `curl` 比较打开侧聊前后的未注册 RPC 客户端快照，普通会话选择和完整消息 ID 序列相同。新侧聊的进程实例 UUID 和 PID 正确，两次 DELETE 均返回 204。主会话移动后，从目标工作区归档成功，原工作区的侧聊行已删除。

复修代码提交为 `cdaa91b6` 和 `f9f1bf1d`。在后者上运行 9 个相关文件的全部测试，178 项通过。全库运行 `pnpm exec vitest run --maxWorkers=3 --minWorkers=1`，7,865 项通过，17 项跳过，0 项失败。相较首轮全库净增 5 个用例；其余断言扩展在已有用例中。构建、类型和格式检查通过，Lint 报告 0 个错误、119 个警告。交叉复核重跑了主会话和侧聊同时运行、重绑后重连两种情况，均通过。

## 复审结论（2026-11-10）

复审范围是 `a0bc0695..c2e46a45`，涉及 3 个提交：`cdaa91b6`、`f9f1bf1d`、`c2e46a45`。验收会话逐条核对了 V1 到 V21，并在本地复跑了以下检查：

- `pnpm typecheck` 通过。
- `pnpm format:check` 通过。
- `pnpm lint` 报告 0 个错误、119 个警告，和首轮一样。
- 全量 `pnpm test`：7865 项通过，17 项跳过，0 项失败。

结论：**通过，可以从 `c2e46a45` 切 fork 分支。**

- **V1 到 V15 都已按修法落地。** 判断 side chat 属于哪个进程，已全部改为比较 `ownerId`。没有 `ownerId` 的旧记录：PID 和本进程相同时被回收，PID 属于另一个存活进程时保留，这样处理是安全的。T5、T6、T9、T10、T11、T13 都有断言到位的测试。
- **V2、V9 的回归面复核过。** 单个普通客户端绑定会话时，事件投递和改动前一致。有一处行为变了：后端没有选中会话时，`runtime.updated` 不再投给提交 prompt 的客户端。原来那样投其实是错投，这次属于修正。
- **V16 只修了一部分，可以接受。** 复制消息的排序仍然依赖 ID 里 `-` 排在数字前面，但已经补了注释，并用真实分页接口加了顺序断言。
- **V21 的修法和建议不同，可以接受。** 没有走 message store 的接口，而是从 `core/message/database-store.ts` 导出行级写入函数。普通消息写入的列、顺序、时间戳和事务都没变，属于纯重构。边界消息现在会写入 `context_scope_id`。

以下几点低风险，不阻塞 fork，记下来留待以后处理：

- 未绑定的快照沿用后端的 `activeSessionId`。后端当前选中的是 side chat 时，这个 ID 会指向一个已被过滤掉的会话（`client-view.ts:210-212`）。只有没绑定会话的旧 RPC 调用方会遇到。
- 两个 prompt 同时运行时，不带 `sessionId` 的旧格式 `runtime.updated` 不会投给任何客户端。目前所有产生这个事件的地方都已带上 `sessionId`。
- `runSessionIdsByRunId` 只在重置时清空，会一直增长。这在复修之前就存在，复修没有引入。
