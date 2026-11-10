# 4. 测试与验收

> 对应 [02](02-optimization-plan-and-change-scope.md) 的 Stage 1 至 4。测试文件沿用仓库现有约定：与源码同目录，`*.unit.test.ts(x)`、`*.integration.test.ts`、`*.contract.test.ts`，分别用 `pnpm test:unit`、`pnpm test:integration`、`pnpm test:contract` 运行。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| unit | 前端 Edit 按钮的显示规则 |
| integration | 撤销编排对真实 SQLite 库的效果：各读取方的过滤、视图缓存、忙碌判断、压缩边界、子代理、todo、统计、空会话复用、并发 |
| contract | `POST /v1/sessions/:id/rewind` 的请求、响应、错误码；HTTP 客户端与进程内实现一致 |
| 浏览器走查 | Stage 2 的 Edit 流程（mock 场景和真实 daemon 各走一遍） |
| 手工 | Stage 3 的 TUI `/rewind` |

## 4.2 关键场景

### Stage 1：后端

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T1 | 三轮对话，撤销第二轮 | integration | 第二、三轮的用户消息、助手消息、提醒、steer 都写入同一个 `rewound_at`；第一轮不受影响；第二、三轮的 prompt（含并入的 steer prompt）带 `rewoundAt` 且 `updatedAt` 已更新；返回的 `restoredText` 等于第二轮 prompt 的 `text` |
| T1b | 撤销并发送 | integration | 三轮对话，带 `text` 撤销第二轮：第二、三轮被撤销；返回 `prompt`；新 prompt 不带 `rewoundAt`，模型和 reasoning 等于第二轮 prompt 记录的值（第二轮没记模型时等于会话当前模型）；假 LLM 收到的是第一轮加新文字；新 prompt 在闸门释放后才开始执行 |
| T1c | 预检与接收失败 | integration | 目标 prompt 的模型配置已删除：预检直接返回错误，什么都不停、不标记。再用测试替身让预检之后的接收抛错：返回 200，带 `sendError`，不带 `prompt`；撤销已生效；会话没有排队的 prompt；闸门已释放 |
| T2 | 撤销最后一轮 | integration | 只影响最后一轮；`message_count` 与可见消息数一致 |
| T3 | 撤销第一轮 | integration | 会话没有可见消息；会话本身与标题保留；之后再发一条，标题不会被重新生成 |
| T4 | 模型上下文 | integration | 撤销后下一次请求发给假 LLM 的消息里，没有任何被撤销的内容；上下文用量接口的数字随之变化 |
| T5 | 历史分页 | integration | `history` 分页跨过撤销点时不返回被撤销的消息 |
| T6 | 视图缓存 | integration | 撤销返回后**立刻**请求 `GET /v1/sessions/:id/view`，不重启、不等待，结果里没有被撤销的消息和 prompt；同时收到的 `session.changed` 带 `removedMessageIds`，也带上了带 `rewoundAt` 的 prompt（来自补发的 `prompt.updated`）。再重启运行时、重新打开会话：视图初始化取最近一轮时，被撤销的助手消息和轮次也不出现（覆盖 `listPageByRun`） |
| T7 | 导出 | integration | HTML、JSONL 两种格式都不含被撤销的内容 |
| T8 | 搜索 | integration | 只在被撤销消息里出现的关键词搜不到该会话 |
| T9 | todo | integration | 第三轮改过默认作用域和某个 goal 作用域的 todo，撤销第三轮后两个作用域都回到第二轮结束时的状态 |
| T9b | 已加载的 MCP 工具 | integration | 前提：[已加载 MCP 工具从历史重建议题](../../2026-11-09-mcp-loaded-tools-from-history/README.md)已落地。第二轮加载 A，第三轮加载 B；撤销第三轮后下一次请求的工具列表有 A、没有 B，调用 B 被 `accessGuard` 拒绝 |
| T10 | 当前轮输入与恢复 | integration | 撤销后重启运行时，执行恢复和 steer 恢复不会把被撤销的输入重新排进队列；按 ID 读取的 steer 流程照常工作 |
| T11 | 读取方普查 | 评审 | 02 Stage 1 第 5 步普查表里的每一处都已按表处理；实施期间新增的直接 SQL 读取方也补进表里 |
| T12 | 排序一致 | integration | 目标用户消息与另一条消息 `created_at` 相同时，撤销范围与模型历史的切分一致 |
| T12b | 非用户发起的轮次 | integration | 第二轮之后依次有 goal 续跑、子代理唤醒、提醒，撤销第二轮后它们全部隐藏，视图的 run 列表里也没有这些轮次；goal 续跑和子代理唤醒的消息没有对应 prompt，不能作为撤销目标（返回 `REWIND_TARGET_INVALID`） |
| T13 | 子代理与后台任务 | integration | 撤销第二轮：第三轮启动、仍在运行的后台子代理被停止，之后它才跑完也不会送回结果；第二轮里已完成但未送达的结果不触发空闲唤醒，下一轮也不会插入这条结果；第三轮启动的后台 shell 任务被取消；这些调用不在子代理列表和调用列表里；第一轮创建、第三轮又被调用过的子代理仍在列表里，显示的是第一轮那次调用；只在被撤销轮次里出现过的子代理不在列表里 |
| T13b | 停止失败 | integration | 让 `interruptByRootRun` 抛错：撤销返回错误；消息、prompt、子代理调用都没有被标记；闸门已释放 |
| T14 | 并发：新 prompt | integration | 撤销与新 prompt 同时到达：要么撤销先完成、新 prompt 落在撤销之后，要么撤销返回 `SESSION_RUNNING`；新 prompt 永远不会被标记为已撤销 |
| T15 | 并发：goal 与唤醒 | integration | goal 为 `active`（两轮之间空闲）时撤销：goal 变为 `paused`，撤销成功，之后没有自动开出 goal 轮次；goal 在撤销点之前、要保留的轮次里启动的后台子代理仍在运行；撤销持有闸门期间触发的子代理唤醒要等撤销结束后才执行 |
| T15b | 运行中先停再撤 | integration | 当前这一轮正在跑、后面排着两条 prompt：带 `text` 撤销正在跑的这一轮的用户消息，当前这一轮被中断，两条排队的 prompt 被取消并标记为已撤销、没有开跑，新 prompt 正常执行；撤销更早的一轮时结果相同。正在跑的分别是 goal 轮次、子代理唤醒轮次时，结果也相同；撤销中途子代理唤醒抢先开出的一轮也被中断并隐藏 |
| T15c | 停下来超时、预检失败 | integration | 让当前这一轮迟迟不结束：超过 10 秒返回 `SESSION_RUNNING`，没有任何消息和 prompt 被标记，闸门未被占住。目标在压缩点之前或是 steer 时，直接返回对应错误，当前这一轮照常运行、排队不受影响 |
| T16 | 空会话复用 | integration | 撤销到没有可见消息后，在同一目录“新建会话”得到的是新的会话 ID |
| T16b | 拒绝条件 | integration | 按下表逐条验证。会话检查的顺序与 02 Stage 1 第 6.1 步一致（跟随已落地的 `readActiveMainSession`、`assertSessionInWorkspace`）：`SESSION_NOT_FOUND` → `SESSION_NOT_ROOT` → `SESSION_ARCHIVED` → `SIDE_CHAT_UNSUPPORTED` → `SESSION_MOVED` |
| T16c | 与 fork、side chat 的衔接 | integration | 撤销后 fork 和新建 side chat 复制的历史里没有被撤销的消息和 prompt；fork 默认切点不会落在只剩被撤销消息的轮次上；新建 side chat 的切点同样跳过它们；fork 04 §4.3 的撤销相关用例通过 |

T16b 的条件与错误码：

| 条件 | 错误码 |
|---|---|
| 正在压缩、恢复未就绪、排队区有 retained 的 prompt 或被别的窗口锁住编辑的 prompt（此时什么都不停）、停下来时 10 秒内没占到闸门 | `SESSION_RUNNING` |
| 目标是 steer、还在排队或没开始、没有用户消息（例如从排队区取消过的 prompt）、已撤销、属于其他会话；`text` 为空白（此时不做任何改动） | `REWIND_TARGET_INVALID` |
| 目标在最近一次压缩之前 | `REWIND_BEFORE_COMPACTION` |
| 会话不存在 | `SESSION_NOT_FOUND` |
| 子代理会话 | `SESSION_NOT_ROOT` |
| 已归档会话（包括已归档的 side chat） | `SESSION_ARCHIVED` |
| 未归档的 side chat 会话 | `SIDE_CHAT_UNSUPPORTED` |
| 会话已移到别的目录 | `SESSION_MOVED` |

| T17 | 接口契约 | contract | 请求体校验、响应结构、错误码和状态码与 02 §2.5 一致，响应体带 `code`；进程内实现与 HTTP 实现对同一组输入给出相同结果 |

### Stage 2：Web

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T18 | Edit 按钮的显示 | unit | steer、没有 prompt 的消息不显示 Edit；正在跑的这一轮的用户消息显示 Edit；side chat 面板和子代理对话里没有 Edit；运行中、有排队、goal 在跑时按钮可点，正在压缩时置灰 |
| T19 | 气泡编辑 | 浏览器 | 点 Edit 后气泡原地变成编辑框，预填原文，光标在编辑框；下方有 Cancel、Send 和“文件改动不会撤销”，之后还有轮次时写明 N 轮；Esc 和 Cancel 恢复原样；同时只有一个气泡在编辑；文字为空时 Send 置灰 |
| T20 | 主输入框草稿、goal、运行中 | 浏览器 | 主输入框有草稿时编辑并 Send，草稿原样保留；有 goal 时编辑框写明 goal 轮数不回退；运行中编辑框写明“当前任务会先停止”，有排队时写明会移除的条数，goal 在跑时写明“goal 会暂停”；点 Send 后当前任务停止、排队区清空、新一轮开始 |
| T21 | Send | 浏览器 | 改完点 Send：被撤销的轮次从界面消失，不用刷新；新一轮正常运行；刷新页面后历史里看不到被撤销的轮次 |
| T22 | 失败 | 浏览器 | 压缩点之前的消息改完点 Send，看到“can’t be edited”提示，编辑框和改过的文字保留；其他错误码同样有提示；请求进行中 Send 显示加载、不能重复点；返回 `sendError`（mock 场景）时编辑框关闭，主输入框为空时改过的文字直接填入，有草稿时接在草稿后面，草稿不丢 |
| T23 | 多窗口 | 浏览器 | 两个标签页打开同一会话，一个撤销后另一个也移除了对应的轮次 |

### Stage 3：TUI

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T24 | `/rewind` 列表 | 手工 | 只列视图里可撤销的 prompt，最新在上 |
| T25 | 确认与回填 | 手工 | 确认提示含“文件改动不会撤销”和 goal 说明；确认后消息和被撤销轮次的完成提示都从屏幕上移除，输入框里是原文；输入框原本有内容时先询问 |
| T26 | 运行中与失败 | 手工 | 运行中执行 `/rewind`，确认提示写明会先停止，确认后当前任务停止、原文填回；选到压缩点之前的轮次给出对应提示 |

## 4.3 集成边界

- **存储层与读取方**：过滤是否在所有路径生效，由 T4 至 T12 覆盖。
- **撤销编排与视图投影缓存**：由 T6 覆盖。
- **撤销编排与 prompt 准入、goal 续跑**：先停再撤与串行化由 T14、T15、T15b、T15c 覆盖。
- **撤销编排与子代理生命周期**：停止、投递作废、唤醒、停止失败由 T13、T13b、T15 覆盖。
- **后端与前端事件**：`session.changed` 的 `removedMessageIds` 和 `prompts` 由 T6、T21、T23 覆盖。

## 4.4 回归清单

- 现有的排队 prompt 编辑（`PATCH /v1/prompts/:id`、edit-lease）和 steer 重发不受影响。
- 普通的 Stop、goal 的暂停与恢复不受影响；被撤销暂停的 goal 可以照常恢复。
- 压缩、`/compact`、自动压缩正常；撤销之后再压缩，摘要里不含被撤销的内容。
- 子代理会话的列表、对话查看不受影响。
- 会话归档、恢复、永久删除正常；永久删除时已撤销的行一起删掉。
- 没有用过撤销的会话，视图、历史、导出和改动前完全一致。

## 4.5 发布门

| 项 | 标准 | 如何验证 |
|---|---|---|
| 类型与格式 | 通过 | `pnpm typecheck`、`pnpm lint`、`pnpm format:check` |
| 自动化测试 | T1 至 T10（含 T1b、T1c）、T12 至 T18（含 T12b、T13b、T15b、T15c、T16b、T16c）通过 | `pnpm test:unit`、`pnpm test:integration`、`pnpm test:contract` |
| 评审 | T11 完成 | 代码评审 |
| 浏览器走查 | T19 至 T23 通过，附截图 | 内置浏览器 |
| 手工 | T24 至 T26 通过 | 本机终端 |
| 文档 | Stage 4 列出的文档已同步 | 评审 |
| 发布说明 | 写明迁移 `029` 和“升级后不要降级继续使用撤销过的会话” | 评审 |

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|---|---|---|
| 新代码绕过存储层直接查 `message` 表 | 列表入口默认过滤；T11 普查 | 以后新增的直接 SQL 仍可能漏。评审时把“查 message 表是否带 `rewound_at IS NULL`”列为检查项 |
| 撤销与新 prompt、goal 续跑、子代理唤醒竞争 | 先取消排队、暂停 goal、中断并等空闲，再在 `runControl` 里检查并占住执行闸门；作废未投递的结果 | 以后若有新的路径不经过闸门就开启新一轮，会绕过这层保护。评审时把“开启新一轮是否经过闸门”列为检查项 |
| 绕过提交流程直接改库 | 撤销只通过消息管理器的 `markRewound` | 以后若有人直接写 `rewound_at`，视图缓存会过期；T6 能发现 |
| 撤销压缩之后、摘要引用了被撤销内容 | 只允许撤销压缩点之后的消息，摘要不会包含它们 | 无 |
| 前端规则与后端不一致 | 后端是最终裁决，前端只在正在压缩时置灰，不判断压缩边界 | 压缩点之前的消息会显示能点但会报错的按钮，有明确提示，可接受 |
