# 2. 方案与改动面

> 本文是给实施会话的执行契约。决策来源见 [00](00-discussion.md)，现状证据见 [01](01-problem-analysis-and-current-state.md)，验收见 [04](04-test-and-acceptance.md)。路径缩写：`A/` = `packages/ohbaby-agent/src/`，`W/` = `apps/ohbaby-web/src/`，`T/` = `packages/ohbaby-cli/src/tui/`。

## 2.1 方案总览

fork 只做数据复制，在一个数据库事务里完成：新建一个根会话，把源会话主上下文里到切点为止的五类记录（消息、片段、prompt 记录、当前轮输入记录、run 记录）复制过去，全部换新 ID，再用“按值替换”的规则改写 JSON 里的引用。源会话不会被修改，也不需要空闲。

```
Web 回答下的 fork / 会话行菜单 / TUI /fork
        │
        ▼
POST /v1/sessions/:id/fork { promptId? }
        │
adapter 层：校验根会话、未归档 → 打开 runWriteTransaction
        │
services/session/fork.ts 的同步函数（在上面的事务回调里执行）
        ├─ 定切点（给定 prompt 或最近一个已结束的 prompt）、算标题
        ├─ 选出要复制的行：message、part、prompt_submission、current_run_input、run_ledger
        ├─ 建 ID 映射：会话、消息、片段、run、prompt、输入、client_request_id
        ├─ 改写：JSON 里值完全等于旧 ID 的字符串 → 新 ID；清掉“超前”的压缩标记
        └─ 写入新会话行（统计、来源信息一次写好）和全部复制行
        │
adapter 层：发布会话创建事件 → 返回 { sessionId, title }
        │
前端切换到新会话
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 复制方式 | 复制行，换新 ID | 本项目是 SQLite 行存储，复制后两个会话完全独立，所有读取方不用改 | codex 那样引用父会话的前缀（每个读取方都要会拼接历史） | 存储翻倍，可接受 |
| 复制哪些表 | `message`、`part`、`prompt_submission`、`current_run_input`、`run_ledger` | 每张都有不复制就出错的理由（见 01 §1.4.1） | 只复制消息（显示和模型上下文都不对） | 五张表的复制代码 |
| ID 改写 | 按值替换：复制行的文本列和 JSON 字符串，值完全等于某个旧 ID 就换成新 ID | 一条规则覆盖所有字段，以后新增字段也不会漏 | 逐个字段改写（ZCode 的映射表做法，字段多、易漏） | 工具参数或输出里恰好整段等于某个 ID（例如会话 ID）时也会被替换，可接受；子代理元数据里的会话 ID 也会变成新会话的，子代理卡片因此打不开，与 P11 一致 |
| 工具 `callId` | 不改 | 模型原生状态回放依赖它 | 一起换新 | 两个会话里有相同的 `callId`，它本来就只在会话内使用 |
| 压缩标记 | 片段的压缩时间晚于最后一条被复制消息的时间，就清掉 | 切点之后的压缩，摘要不在复制范围里 | 原样复制（新会话丢上下文） | 依赖“压缩时间取提交时刻”这一现状，04 的 T7 守住 |
| 事务 | 调用方开一个 `runWriteTransaction`，复制函数在回调里同步执行，SQL 直接写 | 现有会话创建接口设不了模型与统计；消息存储没有批量写入 | 先 `SessionManager.create` 再逐条插入（不是一个事务，失败会留下半个会话） | 会话行的写法和 `SessionManager` 重复一小段 |
| 源会话状态 | 不要求空闲 | fork 只读已提交的行 | 要求空闲（用户得先停止才能 fork） | 无 |
| 切点定位 | 可选的 `promptId`；不给就用最近一个已结束的 prompt | Web 回答按钮知道 prompt；菜单和 TUI 不需要知道 | 按消息 ID 定位（要再推一次属于哪一轮） | 无 |
| 来源信息 | `session.data.fork = { sourceSessionId, sourcePromptId, inheritedMessageCount }` | 00 已确认；排查问题时有据可查 | 不记（dsh）；用 `parent_id`（会被当成子代理） | 目前没有读取方 |
| 标题 | 服务端计算 `基础标题 (n)` | 一次请求拿到最终结果 | dsh 那样前端再发一次改名请求 | 一次按标题前缀的查询 |
| 子代理引用 | 不处理，卡片保留结果文字但打不开 | 不复制子代理实例和执行记录 | 复制子代理会话（牵出整套子代理生命周期） | 00 P11 已说明 |

## 2.3 分阶段实施

全部 Stage 都属于 improve-1。每个 Stage 结束时 `pnpm typecheck`、`pnpm lint` 和相关测试保持通过。

### Stage 1：后端

**目标**：`POST /v1/sessions/:sessionId/fork` 能用；新会话的视图、历史和模型上下文与源会话在切点处一致；源会话不受影响。

**改动**：

1. **复制函数**：新建 `A/services/session/fork.ts`，导出同步函数 `forkSessionRows(tx, input)`，入参见 §2.5。`runWriteTransaction`（`A/services/database/index.ts:323-330`）是异步的、要求回调同步执行，所以这个函数自己不开事务，只能在调用方已经打开的事务回调里执行：fork 的 adapter（第 2 步）和 side chat 议题的 `openSideChat` 各自开事务再调用它。函数内依次完成以下步骤。
   1. **定切点**：`cutPromptId` 为 `null` 时跳过第 1 至 4 步，只写会话行（side chat 在主会话没有已结束的 prompt 时这样用）。否则目标 prompt 必须属于源会话、状态为 `succeeded`、`failed`、`cancelled` 或 `interrupted`、有 `run_id`、未被撤销（`steered` 不能作为切点，它是并入别的轮次的输入）。切点消息是主上下文里 `data.runId` 等于这个 run 的最后一条消息，排序同 `listBySession`（`created_at, rowid`）。找不到返回 `FORK_TARGET_INVALID`。
   2. **选行**：
      - 消息：主上下文（`context_scope_id IS NULL`）、按 `created_at, rowid` 排序、到切点消息为止（含）、`undone_at IS NULL`。
      - 片段：属于上面这些消息的全部片段，按消息顺序和 `order_index`。
      - prompt：`scope_key` 等于后端的 prompt 作用域、`session_id` 为源会话、`user_message_id` 或 `run_id` 落在复制范围内、状态为上面四种已结束状态之一或 `steered`、`undone_at IS NULL`。
      - 关于 `undone_at`：这一列由撤销议题的迁移 `029` 加入。两个议题谁后落地，谁负责在这里（以及第 1 步、第 2 步取“最近一个已结束的 prompt”时）加上这个条件，并补 04 §4.3 的用例。
      - 当前轮输入：`message_id` 落在复制的消息里的行。
      - run：上面这些行引用到的主上下文 run，各列原样复制（包括 `inputs_closed_at`，`filterModelHistory` 靠它判断输入是否有效，`current-run-inputs.ts:195-206`）。
   3. **建 ID 映射**：给新会话、每条消息、每个片段、每个 run、每个 prompt、每个输入生成新值。
      - 消息 ID 不能用现有生成器：它的随机后缀无序（`A/core/message/id-generator.ts:14-18`），而且用户消息用的是另一种 UUID 格式。做法是把复制的消息按源会话的 `(created_at, id)` 排名，新 ID 写成 `message_<fork 时刻毫秒>_<补零的名次>`。这样视图分页（按 `created_at, id`，`A/core/message/database-store.ts:236-242`）和源会话顺序一致；插入时再按源 `(created_at, rowid)` 顺序写入，模型历史的顺序也一致。
      - 其他 ID 用项目现有的生成器。
      - 两个客户端请求 ID 不进映射表，直接生成：`client_request_id` 写成 `fork:<新 prompt ID>`；`steer_receipt.clientRequestId` 写成 `fork:<新 prompt ID>:steer`。它们在同一个 `scope_key` 内有唯一约束（`migrations.ts:536-537`），源会话和新会话共用这个 `scope_key`，不改就会插入失败。
   4. **改写**：
      - 一条规则：所有被复制行的每个文本列、以及 JSON 列里的每个字符串值，凡是**完全等于**映射表里某个旧值的，换成对应的新值。这条规则同时覆盖 `id`、`session_id`、`message_id`、`run_id`、`prompt_id`、`user_message_id`、`input_id`、`source_id`（steer 的 `source_id` 存的是 promptId，`current-run-inputs.ts:461`）、`resend_of_prompt_id`，以及 `data`、`steer_receipt` 里的所有引用。不单独列字段。
      - 片段的 `time.compacted` 晚于切点消息的时间时，去掉这个标记。
   5. **写会话行**：
      - 复制 `project_id`、`working_directory`、`workspace_directory`、`pending_working_directory`、`agent`。
      - `parent_id` 为空，`status` 为 `active`，`created_at`、`updated_at` 为当前时间。
      - `title`：调用方传了就直接用（side chat 传“Side chat”）；没传时在本事务里计算：去掉源标题末尾的 ` (数字)` 得到基础标题，在非子代理会话里找标题为“基础标题”或“基础标题 (n)”的最大 n，新标题为“基础标题 (n+1)”。放在事务里算，两个并发 fork 不会都拿到 `(1)`。
      - `message_count` 为复制的消息数，`last_message_at` 为复制消息中最晚的时间。
      - `data` 为 `{ reasoning, modelEntryId, childrenIds: [], isSubagent: false, ...input.data }`，其中 `reasoning`、`modelEntryId` 取自源会话；`input.data` 由调用方给：fork 传 `{ fork: { sourceSessionId, sourcePromptId, inheritedMessageCount } }`，side chat 传它自己的字段。
   6. **写复制行**：
      - 消息与片段保留原来的 `created_at`、`updated_at`，按源顺序插入。
      - run 记录的 `owner_*` 置空。
      - prompt 的 `admission_order` 原样复制（这一列没有唯一约束）；`edit_lease_*`、`owner_*`、`title_expected` 置空；`resend_of_prompt_id` 不在映射表里时置空。
2. **adapter 层**：新建 `A/adapters/ui-inprocess/session-fork.ts`，由 `ui-inprocess.ts` 注入依赖后暴露 `forkSession({ sessionId, promptId? })`：
   - 源会话不存在返回 `SESSION_NOT_FOUND`，不是根会话返回 `SESSION_NOT_ROOT`，不是 `active` 返回 `SESSION_ARCHIVED`。
   - 没给 `promptId` 时取源会话最近一个已结束的 prompt；一个都没有返回 `FORK_TARGET_INVALID`。
   - 打开 `runWriteTransaction`，在回调里调用 `forkSessionRows`，传入后端的 prompt 作用域（`ui-inprocess.ts:1230` 的 `promptScopeKey`）和 `data.fork`，不传 `title`。
   - 成功后先在总线上发布 `SessionEvent.Created`（带新会话的 `Session` 对象，`SessionManager.create` 在 `manager.ts:145` 也是这样做的，adapter 靠它填充会话元数据缓存，`ui-inprocess.ts:702`），再调用 `publishSessionIndexInvalidation()`（`ui-inprocess.ts:2255`）刷新侧栏。
   - 返回 `{ sessionId, title }`。
3. **路由与 SDK**：
   - `packages/ohbaby-server/src/protocols/web/routes/sessions.ts` 在归档路由旁边新增 `POST /v1/sessions/:sessionId/fork`。状态码沿用现有映射 `globalSessionErrorStatus`（`packages/ohbaby-server/src/protocols/global-sessions.ts:94-120`：`SESSION_NOT_FOUND` 404，`SESSION_NOT_ROOT`、`SESSION_ARCHIVED` 409）。这个函数遇到不认识的错误码会返回 500，所以要在里面加上 `FORK_TARGET_INVALID` → 400。响应体带 `code`。路由的错误处理如果撤销议题已经改好，直接复用。
   - `packages/ohbaby-sdk/src/contract/client.ts` 加 `forkSession({ sessionId, promptId? })`，HTTP 客户端和进程内实现行为一致；`FORK_TARGET_INVALID` 和现有错误码一起放在 `packages/ohbaby-sdk/src/contract/global-sessions.ts`。

**完成定义**：04 的 T1 至 T14（含 T14b、T14c）通过。

### Stage 2：Web

**前置**：回答下面的 fork 按钮依赖[消息复制议题](../../2026-11-04-message-copy/improve-1/02-optimization-plan-and-change-scope.md)的 Stage 1（`MessageActions`）。会话行菜单不依赖它。

**改动**：

1. 每轮最终答案（`RunProcess.answerId` 指向的消息）的 `MessageActions` 加 fork 按钮，图标加提示“Fork from here”，调用时带上这一轮的 `promptId`。最终答案只在一轮结束后才会出现，所以按钮不需要额外的可用性判断。
2. `W/ui/sidebar/SessionMenu.tsx` 加“Fork”菜单项，调用时不带 `promptId`。会话没有消息时置灰，提示“Nothing to fork yet”。
3. 成功后调用 `runtime.openSession(newSessionId)`（`W/runtime/index.ts:89`）切换到新会话。失败时按错误码提示。
4. side chat 会话里不显示这两个入口：side chat 议题会给 `ConversationStream` 加一个开关，side chat 面板里只挂复制按钮。后端的 `SIDE_CHAT_UNSUPPORTED` 检查由 side chat 议题加在本议题的 fork 入口上。

**完成定义**：04 的 T15 至 T18 通过（浏览器走查）。

### Stage 3：TUI `/fork`

**改动**：

1. `A/commands/catalog.ts` 加 `fork` 命令，`surfaces` 只含 `tui`，在 `T/app.tsx` 本地拦截（参照 `export`，:231）。
2. 执行时调用 `forkSession({ sessionId })`，成功后用现有的切换会话逻辑（`T/store/events.ts:432` 的 `selectSession`，恢复流程见 `T/session-recovery.ts:323`）切到新会话，并提示“Forked to <标题>”。失败时显示错误码对应的提示。

**完成定义**：04 的 T19、T20 通过（手工走查）。

### Stage 4：权威文档同步

| 文档 | 改什么 |
|---|---|
| `docs/services/session/`（数据模型与生命周期相关文档） | 补充 fork 操作、`session.data.fork` 字段、复制范围 |
| `docs/core/message/data-model.md` | 说明 fork 复制消息时的 ID 改写规则和压缩标记处理 |
| `docs/cli/commands/` 或 `docs/ohbaby-cli/tui-productization/slash-menu.md` | 补 `/fork` |

## 2.4 按包的改动面

| 包 / 目录 | 新增 | 修改 |
|---|---|---|
| `packages/ohbaby-agent` | `services/session/fork.ts`、`adapters/ui-inprocess/session-fork.ts` | `adapters/ui-inprocess.ts`（接入）；`services/session/types.ts`、`database-store.ts`、`events.ts`（`Session` 类型、`SessionData`、`rowToSession`、`encodeData`（`database-store.ts:176-184、191-217`）和事件的 zod 定义都加可选的 `fork` 字段。缺任何一处，会话下次更新或经过事件缓存时 `fork` 就会丢）；`commands/catalog.ts` |
| `packages/ohbaby-server` | fork 路由 | `protocols/web/routes/sessions.ts`、`protocols/global-sessions.ts`（`FORK_TARGET_INVALID` → 400） |
| `packages/ohbaby-sdk` | `forkSession`、`FORK_TARGET_INVALID` | `contract/client.ts`、`contract/global-sessions.ts`、HTTP 客户端 |
| `apps/ohbaby-web` | 无新文件 | `ui/conversation/{ConversationStream,MessageRow}.tsx`、`ui/sidebar/SessionMenu.tsx`、`runtime/index.ts`、`dev/mock-runtime.ts`（`forkSession`） |
| `packages/ohbaby-cli` | 无新文件 | `tui/app.tsx` |

不需要数据库迁移：`session.data` 是 JSON 列，新增的 `fork` 字段是可选的。

## 2.5 接口

```
POST /v1/sessions/:sessionId/fork
请求体：{ "promptId": "prompt_..." }   // 可省略

200：{ "sessionId": "session_...", "title": "原标题 (1)" }
404 SESSION_NOT_FOUND     源会话不存在
409 SESSION_NOT_ROOT      源会话是子代理会话
409 SIDE_CHAT_UNSUPPORTED 源会话是 side chat 会话（由 side chat 议题加入）
409 SESSION_ARCHIVED      源会话已归档
400 FORK_TARGET_INVALID   prompt 不存在、不属于该会话、未结束或是 steered，或会话里还没有已结束的 prompt
```

SDK：`forkSession(input: { sessionId: string; promptId?: string }): Promise<{ sessionId: string; title: string }>`。

复制函数（side chat 议题也会用）：

```ts
// A/services/session/fork.ts
forkSessionRows(tx, input: {
  sourceSessionId: string;
  cutPromptId: string | null;   // null：不复制历史，只写会话行
  promptScopeKey: string;
  title?: string;               // 省略时按 (n) 规则计算
  data?: Partial<SessionData>;  // 合并进新会话的 data：fork 传 { fork }，side chat 传 { sideChat }
}): { sessionId: string; title: string; copiedMessageCount: number }
```

## 2.6 风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| 漏掉某种 ID 引用 | 新会话里某条消息指向源会话的数据 | 按值替换覆盖全部 JSON；04 的 T4 在复制结果里搜索源会话的全部旧 ID |
| 压缩标记处理错 | 新会话的模型上下文缺一块或多一块 | 04 的 T6、T7 比较两个会话的模型上下文 |
| 运行时输入被过滤 | steer、子代理结果从新会话的上下文里消失 | 复制当前轮输入记录；04 的 T5 |
| 同一毫秒内的消息乱序 | 视图里顺序和源会话不同 | 新 ID 保持源顺序；04 的 T3 |
| 源会话正在写入 | 复制到一半的状态 | 只复制已结束的 prompt 及之前的行，读写在一个事务里；04 的 T10 |

回滚：fork 只新增会话，删掉入口即可；已经 fork 出来的会话是普通会话，可以照常归档和删除。

## 2.7 与 00 边界对齐

| 00 结论 | 02 落点 |
|---|---|
| 复制切点之前的历史成新会话 | Stage 1 第 1 步 |
| 切点在一轮已结束对话的末尾 | Stage 1 第 1.1 步 |
| 来源信息放 `session.data`，不用 `parent_id` | Stage 1 第 1.5 步 |
| 侧栏平级 | Stage 1 第 1.5 步（`parent_id` 为空）、第 2 步（发布事件） |
| Web 两处入口、TUI `/fork` | Stage 2、Stage 3 |
| 标题 `(n)` | Stage 1 第 2 步 |
| 不带 goal、排队、运行中的一轮、子代理实例 | Stage 1 第 1.2 步（只选这五张表中已结束的行） |
| 继承工作区、目录、agent、模型、reasoning | Stage 1 第 1.5 步 |
| P1 至 P13 | 决策表与 Stage 1 至 3 |

## 2.8 不在本轮

| 项 | 去向 |
|---|---|
| 从一轮中间或从用户消息 fork | 不做 |
| 侧栏显示 fork 关系、跳回源会话 | 不做 |
| 让 fork 出来的会话能打开源会话的子代理、免确认读取源会话存储区里的文件 | 不做。[子代理结果搬迁议题](../../2026-11-05-subagent-results-location/README.md)和会话存储区第二期 a 已把子代理报告（`subagents/`）和工具长输出（`tool-results/`）都放进源会话的存储区。复制过来的历史里的这类路径不改写，fork 出来的会话读取时按外部路径弹确认即可，不另开授权（04 T14b） |
