# 4. 测试与验收

> 对应 [02](02-optimization-plan-and-change-scope.md) 的 Stage 1 至 4。测试文件沿用仓库现有约定：与源码同目录，`*.unit.test.ts(x)`、`*.integration.test.ts`、`*.contract.test.ts`，分别用 `pnpm test:unit`、`pnpm test:integration`、`pnpm test:contract` 运行。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| unit | 前端 Edit 按钮的显示规则 |
| integration | 撤销编排对真实 SQLite 库的效果：各读取方的过滤、视图缓存、忙碌判断、压缩边界、子代理、todo、统计、空会话复用、并发 |
| contract | `POST /v1/sessions/:id/undo` 的请求、响应、错误码；HTTP 客户端与进程内实现一致 |
| 浏览器走查 | Stage 2 的 Edit 流程（mock 场景和真实 daemon 各走一遍） |
| 手工 | Stage 3 的 TUI `/undo` |

## 4.2 关键场景

### Stage 1：后端

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T1 | 三轮对话，撤销第二轮 | integration | 第二、三轮的用户消息、助手消息、提醒、steer 都写入同一个 `undone_at`；第一轮不受影响；第二、三轮的 prompt（含并入的 steer prompt）带 `undoneAt` 且 `updatedAt` 已更新；返回的 `restoredText` 等于第二轮 prompt 的 `text` |
| T2 | 撤销最后一轮 | integration | 只影响最后一轮；`message_count` 与可见消息数一致 |
| T3 | 撤销第一轮 | integration | 会话没有可见消息；会话本身与标题保留；之后再发一条，标题不会被重新生成 |
| T4 | 模型上下文 | integration | 撤销后下一次请求发给假 LLM 的消息里，没有任何被撤销的内容；上下文用量接口的数字随之变化 |
| T5 | 历史分页 | integration | `history` 分页跨过撤销点时不返回被撤销的消息 |
| T6 | 视图缓存 | integration | 撤销返回后**立刻**请求 `GET /v1/sessions/:id/view`，不重启、不等待，结果里没有被撤销的消息和 prompt；同时收到的 `session.changed` 带 `removedMessageIds` |
| T7 | 导出 | integration | HTML、JSONL 两种格式都不含被撤销的内容 |
| T8 | 搜索 | integration | 只在被撤销消息里出现的关键词搜不到该会话 |
| T9 | todo | integration | 第三轮改过默认作用域和某个 goal 作用域的 todo，撤销第三轮后两个作用域都回到第二轮结束时的状态 |
| T10 | 当前轮输入与恢复 | integration | 撤销后重启运行时，执行恢复和 steer 恢复不会把被撤销的输入重新排进队列；按 ID 读取的 steer 流程照常工作 |
| T11 | 读取方普查 | 评审 | 02 Stage 1 第 5 步普查表里的每一处都已按表处理；实施期间新增的直接 SQL 读取方也补进表里 |
| T12 | 排序一致 | integration | 目标用户消息与另一条消息 `created_at` 相同时，撤销范围与模型历史的切分一致 |
| T13 | 子代理 | integration | 第三轮启动的后台子代理在撤销后被停止；它已完成但未投递的结果不会触发唤醒，父会话不出现新一轮；它的实例不在列表里；第一轮就已存在的实例仍在列表里 |
| T14 | 并发：新 prompt | integration | 撤销与新 prompt 同时到达：要么撤销先完成、新 prompt 落在撤销之后，要么撤销返回 `SESSION_RUNNING`；新 prompt 永远不会被标记为已撤销 |
| T15 | 并发：goal 与唤醒 | integration | goal 为 `active` 时撤销返回 `SESSION_RUNNING`；撤销持有闸门期间触发的子代理唤醒要等撤销结束后才执行 |
| T16 | 空会话复用 | integration | 撤销到没有可见消息后，在同一目录“新建会话”得到的是新的会话 ID |
| T16b | 拒绝条件 | integration | 按下表逐条验证 |

T16b 的条件与错误码：

| 条件 | 错误码 |
|---|---|
| 运行中、有排队、恢复未就绪、goal `active`、正在压缩 | `SESSION_RUNNING` |
| 目标是 steer、未结束、已撤销、属于其他会话 | `UNDO_TARGET_INVALID` |
| 目标在最近一次压缩之前 | `UNDO_BEFORE_COMPACTION` |
| 会话不存在 | `SESSION_NOT_FOUND` |
| 子代理会话 | `SESSION_NOT_ROOT` |
| 已归档会话 | `SESSION_ARCHIVED` |

| T17 | 接口契约 | contract | 请求体校验、响应结构、错误码和状态码与 02 §2.5 一致，响应体带 `code`；进程内实现与 HTTP 实现对同一组输入给出相同结果 |

### Stage 2：Web

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T18 | Edit 按钮的显示 | unit | steer、没有 prompt 的消息、未结束的 prompt 不显示 Edit；会话忙、goal `active` 时置灰并有对应提示 |
| T19 | 正常撤销 | 浏览器 | 确认框写明轮数和“文件改动不会撤销”；确认后被撤销的轮次从界面消失，不用刷新；输入框里是原文，光标在输入框 |
| T20 | 有草稿、有 goal | 浏览器 | 确认框提示草稿会被替换、goal 轮数不回退；取消后草稿不变 |
| T21 | 撤销后重新发送 | 浏览器 | 改完发送，新一轮正常运行；刷新页面后历史里看不到被撤销的轮次 |
| T22 | 失败 | 浏览器 | 对压缩点之前的消息点 Edit，看到“can’t be undone”提示；`SESSION_RUNNING` 等错误同样有提示；输入框不变 |
| T23 | 多窗口 | 浏览器 | 两个标签页打开同一会话，一个撤销后另一个也移除了对应的轮次 |

### Stage 3：TUI

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T24 | `/undo` 列表 | 手工 | 只列视图里可撤销的 prompt，最新在上 |
| T25 | 确认与回填 | 手工 | 确认提示含“文件改动不会撤销”和 goal 说明；确认后消息从屏幕上移除，输入框里是原文；输入框原本有内容时先询问 |
| T26 | 失败 | 手工 | 运行中执行 `/undo` 给出“先停止”的提示；选到压缩点之前的轮次给出对应提示 |

## 4.3 集成边界

- **存储层与读取方**：过滤是否在所有路径生效，由 T4 至 T12 覆盖。
- **撤销编排与视图投影缓存**：由 T6 覆盖。
- **撤销编排与 prompt 准入、goal 续跑**：串行化由 T14、T15 覆盖。
- **撤销编排与子代理生命周期**：停止、投递作废、唤醒由 T13、T15 覆盖。
- **后端与前端事件**：`session.changed` 的 `removedMessageIds` 和 `prompts` 由 T19、T23 覆盖。

## 4.4 回归清单

- 现有的排队 prompt 编辑（`PATCH /v1/prompts/:id`、edit-lease）和 steer 重发不受影响。
- 压缩、`/compact`、自动压缩正常；撤销之后再压缩，摘要里不含被撤销的内容。
- 子代理会话的列表、对话查看不受影响。
- 会话归档、恢复、永久删除正常；永久删除时已撤销的行一起删掉。
- 没有用过撤销的会话，视图、历史、导出和改动前完全一致。

## 4.5 发布门

| 项 | 标准 | 如何验证 |
|---|---|---|
| 类型与格式 | 通过 | `pnpm typecheck`、`pnpm lint`、`pnpm format:check` |
| 自动化测试 | T1 至 T10、T12 至 T18（含 T16b）通过 | `pnpm test:unit`、`pnpm test:integration`、`pnpm test:contract` |
| 评审 | T11 完成 | 代码评审 |
| 浏览器走查 | T19 至 T23 通过，附截图 | 内置浏览器 |
| 手工 | T24 至 T26 通过 | 本机终端 |
| 文档 | Stage 4 列出的文档已同步 | 评审 |
| 发布说明 | 写明迁移 `029` 和“升级后不要降级继续使用撤销过的会话” | 评审 |

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|---|---|---|
| 新代码绕过存储层直接查 `message` 表 | 列表入口默认过滤；T11 普查 | 以后新增的直接 SQL 仍可能漏。评审时把“查 message 表是否带 `undone_at IS NULL`”列为检查项 |
| 撤销与新 prompt、goal 续跑、子代理唤醒竞争 | 在 `runControl` 里检查并占住执行闸门；goal `active` 算忙；作废未投递的结果 | 以后若有新的路径不经过闸门就开启新一轮，会绕过这层保护。评审时把“开启新一轮是否经过闸门”列为检查项 |
| 绕过提交流程直接改库 | 撤销只通过消息管理器的 `markUndone` | 以后若有人直接写 `undone_at`，视图缓存会过期；T6 能发现 |
| 撤销压缩之后、摘要引用了被撤销内容 | 只允许撤销压缩点之后的消息，摘要不会包含它们 | 无 |
| 前端规则与后端不一致 | 后端是最终裁决，前端只按忙碌状态置灰，不判断压缩边界 | 压缩点之前的消息会显示能点但会报错的按钮，有明确提示，可接受 |
