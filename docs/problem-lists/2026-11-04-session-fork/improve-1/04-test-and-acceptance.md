# 4. 测试与验收

> 对应 [02](02-optimization-plan-and-change-scope.md) 的 Stage 1 至 4。测试与源码放在同一目录，`*.integration.test.ts`、`*.contract.test.ts`，分别用 `pnpm test:integration`、`pnpm test:contract` 运行。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| integration | 用真实 SQLite 库跑 adapter 的 `forkSession`：切点、标题、来源信息、拒绝条件。复制函数本身（范围、ID 改写、压缩标记、模型上下文一致、源会话不变）由 side chat 议题 04 的 C1 至 C9 测，这里不重复 |
| contract | `POST /v1/sessions/:id/fork` 的请求、响应、错误码；HTTP 与进程内实现一致 |
| 浏览器走查 | Stage 2 的两个入口（mock 场景和真实 daemon 各走一遍） |
| 手工 | Stage 3 的 TUI `/fork` |

“模型上下文一致”由 side chat 议题 C5 至 C7 验证，本议题不重复。

## 4.2 关键场景

### Stage 1：后端

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T1 | 三轮对话，从第二轮 fork | integration | 新会话含第一、二轮的全部消息和片段，不含第三轮；prompt、run、当前轮输入的条数与源会话前两轮一致；`message_count`、`last_message_at` 正确；`data.fork` 的 `sourceSessionId`、`sourceRunId` 正确，新会话改名之后仍然在 |
| T2 | 不给 `runId` | integration | 切在最近一个已结束的主 run；最后一轮是子代理唤醒轮（没有 prompt 记录）时切在它的末尾 |
| T2c | 默认切点与 Web 一致 | integration | 同一个夹具里混着用户轮、唤醒轮、失败轮、两个 run 开始时间相同：服务端不带 `runId` 选出的切点，等于 Web 按 `listEndedTurns` 算出的最后一轮的 `runId` |
| T2b | 从唤醒轮 fork | integration | 指定一个子代理唤醒触发、没有 prompt 记录的 run：成功，新会话含这一轮的全部消息 |
| T3 | 复制核心 | integration | 不在本议题重复测，以 side chat 议题 04 的 C1 至 C9 为准（顺序、旧 ID、运行时输入与 steer、压缩、模型原生状态、源会话在运行且不变、不继承的状态）。fork 落地时这九条必须仍然通过 |
| T9 | 标题 | integration | 源标题 `Foo` → `Foo (1)`；再 fork 一次 → `Foo (2)`；从 `Foo (1)` fork → `Foo (3)`；源标题是默认标题时，基础标题取显示标题，新标题显示时带着 `(1)`；标题里有 `%`、`_` 或大小写不同的同名会话时不误算；已归档的同名会话也参与编号；两个 fork 并发时标题不重复；新会话发下一条消息后标题不变 |
| T10 | 源会话在运行 | integration | 源会话第三轮正在运行时不带 `runId` fork：切在第二轮，新会话不含第三轮任何内容 |
| T12b | 已加载的 MCP 工具 | integration | 前提：[已加载 MCP 工具从历史重建议题](../../2026-11-09-mcp-loaded-tools-from-history/README.md)已落地。源会话在切点前加载 A、B 并调用过，切点后又加载 C：fork 后新会话第一次请求的工具列表里有 A、B，没有 C，顺序与源会话切点时一致；新会话调用 A 不被 `accessGuard` 拒绝；源会话的已加载工具不变 |
| T12d | 缓存身份 | integration | 新会话的 `data` 里没有 `sideChat`；它在 OpenAI 官方兼容接口上的第一次请求，`prompt_cache_key` 由新会话自己的 ID 算出，不等于源会话的 |
| T12c | “总是允许”规则不继承 | integration | 源会话对写操作选过“总是允许”：fork 后新会话做同样的写操作仍然弹审批；源会话的规则不变 |
| T13 | 拒绝条件 | integration | 会话不存在返回 `SESSION_NOT_FOUND`；子代理会话返回 `SESSION_NOT_ROOT`；side chat 会话返回 `SIDE_CHAT_UNSUPPORTED`；已归档返回 `SESSION_ARCHIVED`；run 不存在、属于别的会话、在子代理上下文里、未结束、会话里没有已结束的 run，都返回 `FORK_TARGET_INVALID`；失败时不留下任何新行 |
| T14 | 接口契约 | contract | 请求体校验、响应结构、错误码与 02 §2.5 一致，响应体带 `code`；进程内与 HTTP 实现一致 |
| T14b | 源会话存储区里的文件 | integration | 源会话有一份超过 51,200 字节、已导出到 `subagents/` 的子代理报告，和一份存到 `tool-results/` 的工具长输出；从之后的一轮 fork。新会话的历史里这两个路径原样保留，没有被改写；默认权限档位下，新会话用 `read` 读它们时弹外部读取确认，拒绝后读不到；新会话自己的 `scratch/` 不受影响 |
| T14c | 环境提醒里的 scratch 路径 | integration | 复制过来的历史里有源会话的环境提醒（带源会话的 scratch 路径）。新会话第一轮运行时，模型请求里出现一条新的环境提醒，带新会话自己的 scratch 绝对路径，排在复制来的历史之后 |

### Stage 2：Web

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T15 | 回答下的 fork | 浏览器 | fork 按钮紧挨复制按钮，出现在且只出现在主会话视图里有复制按钮的最终答案上（含子代理唤醒轮）；side chat 面板和子代理对话里没有 fork 按钮；点击后切到新会话，标题是 `原标题 (1)`，内容到这一轮为止 |
| T16 | 会话行菜单 | 浏览器 | 菜单里有 Fork；第一轮还在跑时点击，提示“Nothing to fork yet”、不切换；从另一个工作区的会话行 fork，新会话在源会话的目录下打开，轮次分组正常 |
| T17 | 侧栏 | 浏览器 | 新会话出现在侧栏顶部，与普通会话平级；源会话位置和内容不变；归档源会话不影响 fork，归档 fork 不影响源会话 |
| T18 | 子代理卡片 | 浏览器 | 新会话里源会话子代理的卡片显示结果文字，没有可点的“打开”入口，页面不报错 |

### Stage 3：TUI

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T19 | `/fork` | 手工 | 切到新会话，提示“Forked to <标题>”，历史到最近一轮已结束的对话为止 |
| T20 | 失败 | 手工 | 在还没有任何已结束对话的会话里执行 `/fork`，给出对应提示，不切换会话 |

## 4.3 集成边界

- **复制与上下文构建**：由 side chat 议题 C5 至 C7 覆盖。
- **复制与视图投影**：新会话第一次打开时从数据库加载，T1、T15 覆盖。
- **adapter 与会话列表**：T17 覆盖事件发布。
- **与撤销重发议题**：撤销在 fork 之后落地，由撤销议题在 `copy-history.ts` 的选行和 `findEndedMainRun` 里加 `rewound_at IS NULL`，并补一条用例：源会话有已撤销的轮次，fork 结果不含它们；传一个已撤销 run 的 `runId` 返回 `FORK_TARGET_INVALID`；不带 `runId` 时跳过已撤销的 run。

## 4.4 回归清单

- 会话的新建、归档、恢复、删除、移动工作区不受影响。
- 子代理会话列表、全局会话列表、搜索结果里，子代理会话仍不出现。
- 没有 fork 过的会话行为与改动前完全一致。

## 4.5 发布门

| 项 | 标准 | 如何验证 |
|---|---|---|
| 类型与格式 | 通过 | `pnpm typecheck`、`pnpm lint`、`pnpm format:check` |
| 自动化测试 | T1、T2、T2b、T2c、T3、T9、T10、T12b、T12c、T12d、T13、T14、T14b、T14c 通过；side chat 议题的 C1 至 C9 仍然通过 | `pnpm test:integration`、`pnpm test:contract` |
| 浏览器走查 | T15 至 T18 通过，附截图 | 内置浏览器 |
| 手工 | T19、T20 通过 | 本机终端 |
| 文档 | Stage 4 列出的文档已同步 | 评审 |

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|---|---|---|
| 以后有人在 JSON 里加了新的 ID 字段 | 按值替换自动覆盖；side chat 议题的 C4 会发现漏网的旧 ID | 如果新字段存的是 ID 的拼接串（不是完整的 ID），不会被替换。评审时注意 |
| 压缩时间的取法以后改了 | side chat 议题的 C6 会失败 | 改压缩逻辑的人要知道 fork 依赖“压缩时间取提交时刻” |
| fork 和源会话的写入并发 | 一个事务读写；只复制已结束的行 | 无 |
| 两个会话共用工作目录，同时改文件 | 不处理，和同一目录开两个会话一样 | 用户要自己注意，00 已说明 fork 共用同一个工作目录 |
