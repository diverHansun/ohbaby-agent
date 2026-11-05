# 4. 测试与验收

> 对应 [02](02-optimization-plan-and-change-scope.md) 的 Stage 1 至 4。测试与源码放在同一目录，`*.integration.test.ts`、`*.contract.test.ts`，分别用 `pnpm test:integration`、`pnpm test:contract` 运行。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| integration | 用真实 SQLite 库跑 `forkSessionRows` 和 adapter 的 `forkSession`：复制范围、ID 改写、压缩标记、模型上下文一致、源会话不变 |
| contract | `POST /v1/sessions/:id/fork` 的请求、响应、错误码；HTTP 与进程内实现一致 |
| 浏览器走查 | Stage 2 的两个入口（mock 场景和真实 daemon 各走一遍） |
| 手工 | Stage 3 的 TUI `/fork` |

“模型上下文一致”的比较方法：分别对新会话和切点时的源会话调用上下文构建（`contextManager.assemble`），把结果里的 ID 按映射表换算后逐条比较。

## 4.2 关键场景

### Stage 1：后端

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T1 | 三轮对话，从第二轮 fork | integration | 新会话含第一、二轮的全部消息和片段，不含第三轮；prompt、run、当前轮输入的条数与源会话前两轮一致；`message_count`、`last_message_at` 正确；`data.fork` 三个字段正确，新会话改名之后仍然在 |
| T2 | 不给 `promptId` | integration | 切在最近一个已结束的 prompt |
| T3 | 顺序 | integration | 新会话的视图和历史分页里，消息顺序与源会话完全一致，包括两条消息 `created_at` 相同的情况 |
| T4 | 不残留旧 ID | integration | 在新会话所有复制行的列值和 JSON 里，搜不到源会话任何消息、片段、run、prompt、输入的旧 ID；子代理相关 ID 除外 |
| T5 | 运行时输入与 steer | integration | 源会话有一条由排队 prompt 转成的 steer（prompt 状态 `steered`）和一条子代理结果输入：fork 成功，不违反唯一约束；新会话的模型上下文里两者都在，位置与源会话一致；打开新会话的视图，steer 恢复不报错 |
| T6 | 切点之前有压缩 | integration | 新会话的模型上下文与源会话一致：摘要在前，被压缩的片段不出现 |
| T7 | 切点之后有压缩 | integration | 源会话在第三轮之后压缩过，从第二轮 fork：新会话里第一、二轮的片段都没有压缩标记，模型上下文是完整原文 |
| T8 | 模型原生状态 | integration | `model-state` 片段原样复制，`callId` 不变，新会话下一轮请求能正常回放 |
| T9 | 标题 | integration | 源标题 `Foo` → `Foo (1)`；再 fork 一次 → `Foo (2)`；从 `Foo (1)` fork → `Foo (3)`；源标题是默认标题时也按同样规则；两个 fork 并发时标题不重复；新会话发下一条消息后标题不变 |
| T10 | 源会话在运行 | integration | 源会话第三轮正在运行时 fork 第二轮：成功；新会话不含第三轮任何内容；源会话的运行不受影响 |
| T11 | 源会话不变 | integration | fork 前后源会话的所有行逐字节相同 |
| T12 | 不继承的状态 | integration | 源会话有 active goal、排队的 prompt、子代理实例：新会话都没有；新会话的 todo 按复制的历史重建，与源会话切点时一致；源会话里未处理的 steer 在新会话里同样显示为未处理（00 P12） |
| T13 | 拒绝条件 | integration | 会话不存在返回 `SESSION_NOT_FOUND`；子代理会话返回 `SESSION_NOT_ROOT`；已归档返回 `SESSION_ARCHIVED`；prompt 不存在、属于别的会话、未结束、状态是 `steered`、会话里没有已结束的 prompt，都返回 `FORK_TARGET_INVALID`；失败时不留下任何新行 |
| T14 | 接口契约 | contract | 请求体校验、响应结构、错误码与 02 §2.5 一致，响应体带 `code`；进程内与 HTTP 实现一致 |

### Stage 2：Web

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T15 | 回答下的 fork | 浏览器 | 只有已结束轮次的最终答案有 fork 按钮；点击后切到新会话，标题是 `原标题 (1)`，内容到这一轮为止 |
| T16 | 会话行菜单 | 浏览器 | 有消息的会话可以 fork；空会话的菜单项置灰并有提示 |
| T17 | 侧栏 | 浏览器 | 新会话出现在侧栏顶部，与普通会话平级；源会话位置和内容不变 |
| T18 | 子代理卡片 | 浏览器 | 新会话里源会话子代理的卡片显示结果文字，没有可点的“打开”入口，页面不报错 |

### Stage 3：TUI

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T19 | `/fork` | 手工 | 切到新会话，提示“Forked to <标题>”，历史到最近一轮已结束的对话为止 |
| T20 | 失败 | 手工 | 在还没有任何已结束对话的会话里执行 `/fork`，给出对应提示，不切换会话 |

## 4.3 集成边界

- **复制与上下文构建**：T5 至 T8 用真实的上下文构建比较两个会话。
- **复制与视图投影**：新会话第一次打开时从数据库加载，T3、T15 覆盖。
- **adapter 与会话列表**：T17 覆盖事件发布。
- **与撤销重发议题**：两个议题中后落地的一方补一条用例：源会话有已撤销的轮次，fork 结果不含它们；指定一个已撤销的 prompt 作为切点返回 `FORK_TARGET_INVALID`。

## 4.4 回归清单

- 会话的新建、归档、恢复、删除、移动工作区不受影响。
- 子代理会话列表、全局会话列表、搜索结果里，子代理会话仍不出现。
- 没有 fork 过的会话行为与改动前完全一致。

## 4.5 发布门

| 项 | 标准 | 如何验证 |
|---|---|---|
| 类型与格式 | 通过 | `pnpm typecheck`、`pnpm lint`、`pnpm format:check` |
| 自动化测试 | T1 至 T14 通过 | `pnpm test:integration`、`pnpm test:contract` |
| 浏览器走查 | T15 至 T18 通过，附截图 | 内置浏览器 |
| 手工 | T19、T20 通过 | 本机终端 |
| 文档 | Stage 4 列出的文档已同步 | 评审 |

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|---|---|---|
| 以后有人在 JSON 里加了新的 ID 字段 | 按值替换自动覆盖；T4 会发现漏网的旧 ID | 如果新字段存的是 ID 的拼接串（不是完整的 ID），不会被替换。评审时注意 |
| 压缩时间的取法以后改了 | T7 会失败 | 改压缩逻辑的人要知道 fork 依赖“压缩时间取提交时刻” |
| fork 和源会话的写入并发 | 一个事务读写；只复制已结束的行 | 无 |
| 两个会话共用工作目录，同时改文件 | 不处理，和同一目录开两个会话一样 | 用户要自己注意，00 已说明 fork 共用同一个工作目录 |
