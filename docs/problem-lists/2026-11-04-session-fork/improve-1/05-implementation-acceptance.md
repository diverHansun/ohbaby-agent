# Fork 后端实施验收

本地分支 `codex/session-fork-backend` 从 Side Chat 的 `c2e46a45` 切出。本次交付进程内 SDK、HTTP 和 JSON-RPC 接口。Web 按钮、会话菜单及 TUI 的交互留待三个后端完成后验收。

## 两个入口

| 操作 | 后端结果 |
|---|---|
| 从一条 AI 回答 Fork，传入该回答的 `runId` | 新根会话保留这轮完整问答和之前的对话。选定的轮次必须已结束，且最终 AI 回答有可见正文。 |
| 从会话菜单 Fork，省略 `runId` | 从后向前找最近一次符合条件的回答。最后一轮只有用户问题、工具活动或没有消息时，复制到上一条有效回答。若最后一条 AI 消息为空，即使同一轮前面写过文字，也跳过整个轮次。 |
| 指定无法作为切点的轮次，或整个会话都没有有效回答 | 返回 HTTP 400 和 `FORK_TARGET_INVALID`。失败不产生新会话。 |

新会话拥有独立的 ID 和编号标题。复制和来源信息在一个数据库事务内写入。接口返回新会话 ID，调用客户端据此选择何时切换。

## 命令行端到端

用打包后的 CLI 启动真实 daemon，使用临时工作区、SQLite 和本机固定回答的模型服务。用 `curl` 调用接口，用 `sqlite3` 比对源会话与副本。本轮没有新增 E2E 脚本。

| 场景 | 实测结果 |
|---|---|
| 完成三轮后，指定第二轮 / 省略轮次 | 分别得到两轮 / 三轮问答，标题编号为 (1) / (2)，来源指向所选回答。 |
| 第四轮已写入用户问题，AI 尚未回答 | 运行中点菜单、通过接口中断后再点菜单，两次都复制前三轮。显式选择被中断的第四轮返回 400。 |
| 同一轮先有 AI 正文、末尾又出现空 AI 消息 | 在三轮真实问答的临时库中，给第三轮追加一条没有片段或模型记录的 AI 行。用原项目目录构建的服务验证，指定第三轮返回 400、会话数保持不变；省略轮次仅复制第一、二轮。 |
| 传用户消息 ID | 作为 `messageId` 或 `runId` 提交均返回 400，会话数不变。 |
| 打开副本、归档源会话后继续提问 | 副本正常回答，源会话只保留原来的记录。从已归档的源再次 Fork 返回 409 和 `SESSION_ARCHIVED`。 |
| 连续从菜单 Fork | 在临时库把数轮真实问答的开始时间设为相同，连续 Fork 三次。三个副本都有同样的三轮问答，末轮相同。 |

## 回归与审查

- 切点与复制复用 Side Chat 的 SQLite 测试。覆盖无 prompt 的唤醒轮、工具说明、运行中或无正文的轮次、跨目录历史、压缩时点、ID 引用及事务回滚。
- 编排测试覆盖并发编号、已归档标题、Unicode、大小写和通配符、再次 Fork、改名后的来源持久化。真实后端用例验证新会话的缓存身份及 scratch 提醒。源会话的持久写入许可不会授予副本。用预置的两份超过 51,200 字节的报告和工具输出验证历史路径及外部读取审批。
- 接口测试在同一个 SQLite 服务夹具内验证 HTTP 和 JSON-RPC 的响应、错误码、客户端绑定及移动工作区后的拒绝。格式错误和无可用切点都不能留下部分副本。
- 独立子代理复现过同毫秒开始的两轮在再次 Fork 时倒序，进而少复制一条回答。修复后，复制得到的 run ID 保留原有的排序。同一回归用例用 12 个同起始时间的轮次连续复制三次，逐轮检查顺序和引用；子代理复验通过。
- 末条 AI 消息为空的反例修复前会选中该轮，修复后两种入口都跳过该轮或报错。同一 SQLite 夹具分别走实际历史读取、Web 回答判断及后端切点查询，验证有正文后出现的压缩摘要仍允许 Fork，空 AI 步骤会阻止 Fork。子代理独立核对实时更新、刷新和历史分页的结果。
- 对恢复记录和旧数据沿用 02 的两个例外：prompt 已结束但 run 仍非终态时，后端拒绝；无 prompt 且终态 run 缺少结束时间时，有回答的轮次仍可作后端切点。

## 首次交付验证

在原项目目录的本地分支 `codex/session-fork-backend` 上完成验证。代码提交依次为 `a647ddb9`（切点与同时间排序）、`df286f58`（独立会话及接口）、`8a4a16d1`（末条 AI 消息为空的修复及 Web 对照）。

| 检查 | 结果 |
|---|---|
| `pnpm exec vitest run --maxWorkers=4 --minWorkers=1` | 675 个文件通过、6 个跳过；7,873 项通过、17 项跳过、0 项失败。包含 Side Chat 回归。 |
| `pnpm build`、`pnpm typecheck`、`pnpm format:check` | 通过。 |
| `pnpm lint` | 0 个错误，119 个警告。 |

## 验收意见（2026-11-10）

验收范围是 `c2e46a45..0aca4af3`，共 4 个提交。验收按两条线并行审查：一条看代码质量，一条逐条对照 02 和 04。验收会话在本地复跑了以下检查：

- `pnpm typecheck`、`pnpm format:check` 通过。
- `pnpm lint` 报告 0 个错误、119 个警告。
- 全量 `pnpm test`：7873 项通过，17 项跳过，0 项失败。

结论：**主干完成，没有发现数据错乱或越权的问题。补完 F1、F2 后可以切撤销分支。** 以下几处核实过，没有问题：

- 事务用的是 `BEGIN IMMEDIATE`，计算标题编号和复制历史在同一个事务里。
- HTTP、JSON-RPC 和进程内三条路径的错误映射一致。
- `core/message/database-store.ts`、`origin.ts`、`persistent-store.ts`、`side-chat.ts`、`title-fallback.ts` 的改动都是纯重构。

### 切撤销分支前要补

| 编号 | 问题 | 要做的事 |
|---|---|---|
| F1 | 04 完成定义里有 7 条只测了一部分 | 都在 fork 入口补断言：<br>- **T1**：新会话的 `message_count`、`last_message_at`，以及 prompt、run、当前轮输入的条数，和源会话前两轮一致。<br>- **T2b**：通过 `forkSession` 指定唤醒轮，新会话含这一轮的全部消息。<br>- **T10**：通过 fork 入口验证，不能只测函数。<br>- **T12b**：新会话真正调用工具 A，不被 `accessGuard` 拒绝；源会话的已加载工具不变。<br>- **T12d**：新会话的 `data` 里没有 `sideChat`。<br>- **T13**：显式指定未结束的 run、子代理上下文里的 run，都返回 `FORK_TARGET_INVALID`；`HistoryCutInvalidError` 映射为 `FORK_TARGET_INVALID`（`session-fork.ts:72-75`）。<br>- **T14b**：新会话自己的 `scratch/` 不受影响。 |
| F2 | 超出 02 的改动，05 和 02 都没交代 | 以下改动都保留，在 05 和 02 里如实记下：<br>- `isDefaultSessionTitle` 现在对所有会话生效：以 ` (n)` 结尾的旧式默认标题不再算默认标题（`prompt-sanitizer.ts:45-47`）。<br>- 复制出的 run ID 改为有序的 `run_-copy_…`，`selectHistory` 加了 `ORDER BY run_id`。side chat 复制也受影响，side chat 的 C1 至 C9 要在 05 里注明仍然通过。<br>- 请求体格式错误、带未知字段、`runId: null`，都返回 400 `FORK_TARGET_INVALID`。这样就不用为参数错误另加错误码，写进 02 §2.5。<br>- 源会话检查先判已归档，再判 side chat。已归档的 side chat 返回 `SESSION_ARCHIVED`，写进 02 第 2.1 步。<br>- JSON-RPC 客户端开始透传 `targetDirectory`，并补了 openapi 文档。<br>同时删掉 05 第 31 行“核对切点时的 MCP 工具”这句话，等 T12b 补上真实调用后再写。 |

### 建议（不阻塞撤销）

| 编号 | 位置 | 建议 |
|---|---|---|
| F3 | `ui-inprocess.ts:5407` | fork 从 `options.sideChatStorage?.db` 拿数据库，这个选项缺失时抛普通 `Error`，最后变成 500。可以把这个选项改成不带 side chat 的中性名字，缺失时返回明确的错误。 |
| F4 | `session-fork.ts` 的 `nextForkTitle` | 用户自己写的 `Report (2024)` 会被当成编号去掉，得到 `Report (1)`。这和 00 P9 的规则一致，本轮接受。 |
| F5 | 后端 `findForkableMainRun` 和 Web `run-process.ts:58-67` | “最终回答”的判断写了两份，以后容易各改各的。Web 阶段可以考虑由后端在 `UiRun` 上带一个可 fork 标记，Web 直接用。到时在 Web 阶段决定。 |
| F6 | `session-fork.ts` | 计算标题编号的 SQL 属于业务规则，可以挪到 `services/session` 里。 |

### 交给撤销阶段

撤销 02 和 04 引用的代码位置，在 fork 之后整体漂移了，包括 `listBySession` 的 SQL 搬到了 `readSessionMessages`，以及 `ui-inprocess.ts`、prompt store、路由的行号。F1、F2 补完、切撤销分支之前，由验收会话按当时的代码更新撤销文档。撤销第 6.1 步的会话检查可以复用 `readActiveMainSession` 和 `assertSessionInWorkspace`，检查顺序跟着 fork：先判已归档，再判 side chat。迁移的最新编号仍是 `028`，`029_message_rewind` 可以用。

## F1、F2 补验记录（2026-11-10）

### F1 的入口回归

| 04 场景 | 本次验证 |
|---|---|
| T1、T2b、T10 | 在真实 SQLite 中记录前两轮的内容和统计，第二轮由子代理唤醒，没有对应的 prompt。第三轮运行时从菜单 Fork；等第三轮结束后再显式选第二轮 Fork。两个副本都指向唤醒轮，逐条比对消息角色、片段正文和时间，并核对 4 条消息、最后消息时间、1 条 prompt、2 条 run 和 1 条当前轮输入。 |
| T13 | 显式选中仍在运行的主轮次或子代理上下文里的已结束轮次均被拒绝。另一次测试让切点查询返回失效的 run ID，由真实复制函数复核并抛出 `HistoryCutInvalidError`。Fork 统一返回 `FORK_TARGET_INVALID`，源会话和历史各表没有新增行。 |
| T12b、T12d | Fork 的第一次模型请求按切点时的顺序带上工具 A、B，排除后来加载的 C。通过正常工具执行路径调用本地 MCP 工具 A，回调收到副本 ID 和本次参数，下一次模型请求收到对应的新结果。随后在源会话再次提问，工具列表和顺序与 Fork 前一致。直接读取副本的 `session.data`，确认没有 `sideChat` 字段。 |
| T14b | 先在源会话用 `write`、`read` 写读 scratch 文件。创建副本并拒绝它读取源文件后，再通过相同工具写读副本 scratch 下的同名文件。两份文件各自保留写入的内容。两边的写入均触发现有的工具级确认；读取自己的 scratch 无额外审批，读取源报告及工具长输出则触发 `external_directory_read`。 |

### F2 的契约补记

已核对实现并同步到 [02 的后端方案和接口约定](02-optimization-plan-and-change-scope.md)。

| 行为 | 对现有调用方的影响 |
|---|---|
| 标题回退 | 所有会话共用 `isDefaultSessionTitle`。形如 `New session - 2026-11-10 (1)` 的旧格式标题会保留编号。 |
| 复制的 run ID | Fork 和 Side Chat 均按源 `run_id` 排序，生成 `run_-copy_<定宽序号>_<UUID>`，保持同开始时间的轮次顺序。重跑共享历史复制与 Side Chat 编排的两个集成测试文件，12 项通过，覆盖 04 的 C1 至 C9。 |
| HTTP 请求体 | 无效 JSON、非对象、未知字段和 `runId: null` 等参数错误返回 400 和 `FORK_TARGET_INVALID`。空请求体按 `{}` 处理；超出大小限制返回 413。 |
| 已归档的 Side Chat | 先验证根会话状态，再判断 Side Chat 标记。已归档的 Side Chat 返回 `SESSION_ARCHIVED`，活跃的 Side Chat 返回 `SIDE_CHAT_UNSUPPORTED`。 |
| 远端错误 | JSON-RPC 客户端保留服务端错误的 `targetDirectory`，工作区移动后调用方可读取新目录。OpenAPI 已登记 Fork 的请求头、请求体和响应状态。 |

### 命令行与回归结果

用构建后的 CLI、本机固定回答的模型服务、`curl` 和临时 SQLite 运行。第三轮停在模型响应前，从菜单 Fork 得到前两轮（5 条含环境提醒的消息、2 条 prompt、2 个 run）；最后消息时间与实际复制的最后一条一致，源第三轮仍在运行。显式选择该轮及四种错误请求均返回 400，拒绝后会话数不变。对同一个 Side Chat，在活跃状态和临时库中构造的归档状态下分别调用 HTTP Fork，均返回 409，错误码分别为 `SIDE_CHAT_UNSUPPORTED` 和 `SESSION_ARCHIVED`。

测试提交为 `9e8aa3d1`。本次新增一个集成用例，其余验证扩展已有用例。独立子代理复核了七组断言和五项契约，并复跑了 Fork 编排、共享复制及持久后端三个测试文件，20 项全部通过。

| 检查 | 结果 |
|---|---|
| 全仓 `pnpm exec vitest run --maxWorkers=4 --minWorkers=1` | 7,874 项通过，17 项跳过，0 项失败。 |
| 最终断言的定向复跑（上述三个文件加 Side Chat 编排） | 4 个文件共 24 项通过，包含 Side Chat C1 至 C9。 |
| 构建、类型检查、格式检查 | 均通过。 |
| ESLint | 0 个错误，119 个警告。 |

F1 和 F2 已补齐，等待用户复核。

## 复审结论（2026-11-10）

复审范围是 `0aca4af3..61e563d5`，这一轮只补了测试和文档，没有改业务代码。验收会话复跑了以下检查：

- `pnpm typecheck` 通过。
- `pnpm lint` 报告 0 个错误。
- 全量 `pnpm test`：7874 项通过，17 项跳过，0 项失败。

F1 的 7 条测试都已在 fork 入口补上断言。F2 的 5 处改动都已如实写进 02 和本文档。

结论：**通过，可以从 `61e563d5` 切撤销分支。** F3 到 F6 留待以后处理。撤销议题的 01、02、04 已按当前代码更新了代码引用，决定不变。

## 前端实施记录（2026-11-11）

代码在 `codex/session-actions-frontend`：Web 是 `48144fc1`，TUI 是 `015e1a98`。走查环境同 side chat 05 的前端记录（隔离数据库、本机假模型）。

| ID | 结果 | 说明 |
|---|---|---|
| T15 | 通过 | fork 按钮紧挨复制按钮，只出现在主会话有复制按钮的回答上；side chat 面板里没有；点击后切到 “原标题 (1)”，内容到这一轮为止。单元测试 `message-edit-fork.unit.test.tsx` 覆盖显示规则 |
| T16 | 部分 | 会话行菜单有 Fork；对一个只有失败轮次的会话点击，提示 “Nothing to fork yet”、不切换。“从另一个工作区的会话行 fork”没有走查 |
| T17 | 部分 | 新会话出现在侧栏顶部，和普通会话平级，源会话不变。归档互不影响没有走查 |
| T18 | 未走查 | 没有搭子代理场景 |
| T19 | 通过 | `/fork` 切到新会话，提示 “Forked to Fake model chat (1)”；之后发的消息落在新会话里；被拒绝审批、没有回答的那一轮没有复制过去 |
| T20 | 部分 | 错误文案由 SDK 的 `sessionActionErrorText` 统一给出，有单元测试；TUI 里没有在真实环境触发 `FORK_TARGET_INVALID` |

错误文案表从 Web 挪到了 `packages/ohbaby-sdk/src/util/session-action-errors.ts`，Web 和 TUI 共用。

### 回归

在 `015e1a98` 上，`pnpm typecheck` 通过，`pnpm lint` 0 个错误，全量 `pnpm test` 7928 项通过、17 项跳过、0 项失败。
