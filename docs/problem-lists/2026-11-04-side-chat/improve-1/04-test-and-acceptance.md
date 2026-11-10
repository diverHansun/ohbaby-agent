# 4. 测试与验收

> 对应 [02](02-optimization-plan-and-change-scope.md) 的 Stage 1 至 4。测试与源码放在同一目录，`*.unit.test.ts(x)`、`*.integration.test.ts`、`*.contract.test.ts`，分别用 `pnpm test:unit`、`pnpm test:integration`、`pnpm test:contract` 运行。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| integration | 打开与边界消息、模型上下文、列表过滤、操作拦截、子代理拦截、当前会话规则、关闭与启动清理、两个客户端互不影响、存储区归属 |
| contract | 三个 side chat 路由、新错误码；HTTP 与进程内实现一致 |
| unit | Web 的边界过滤、选中文字判断与引用格式 |
| 浏览器走查 | 右侧面板、选中文字入口、审批、关闭（mock 场景和真实 daemon 各走一遍） |
| 手工 | TUI `/btw` |

## 4.2 关键场景

### Stage 1：核心与服务端

复制函数 `copySessionHistory`（02 Stage 1 第 0 步）。“模型上下文一致”的比较方法：分别对新会话和切点时的源会话调用上下文构建（`contextManager.assemble`），把结果里的 ID 按映射表换算后逐条比较。

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| C1 | 复制范围 | integration | 源会话三个已结束的主 run，切在第二个：新会话含前两个 run 的全部消息和片段，不含第三个；prompt、run、当前轮输入的条数与源会话一致；`message_count`、`last_message_at` 正确；`data` 里有调用方传入的字段，会话更新后仍在 |
| C2 | 切在没有 prompt 的 run | integration | 第二个 run 是子代理唤醒开的（没有 prompt 记录）：切在它上面能复制到它为止的全部内容 |
| C3 | 顺序 | integration | 新会话的视图和历史分页里，消息顺序与源会话一致，包括两条消息 `created_at` 相同的情况 |
| C4 | 不残留旧 ID | integration | 新会话所有复制行的列值和 JSON 里，搜不到源会话任何消息、片段、run、prompt、输入的旧 ID；子代理相关 ID 除外 |
| C5 | 运行时输入与 steer | integration | 源会话有一条由排队 prompt 转成的 steer 和一条子代理结果输入：复制成功，不违反唯一约束；新会话的模型上下文里两者都在，位置与源会话一致 |
| C6 | 压缩 | integration | 切点之前有压缩：新会话的模型上下文与源会话一致（摘要在前，被压缩的片段不出现）。切点之后才有压缩：新会话里切点前的片段没有压缩标记，模型上下文是完整原文 |
| C7 | 模型原生状态 | integration | `model-state` 片段原样复制，`callId` 不变，新会话下一次请求能正常回放 |
| C8 | 源会话在运行、不变 | integration | 源会话第三个 run 正在运行时复制第二个：成功，新会话不含第三个 run 的任何内容，源会话的运行不受影响；复制前后源会话的所有行逐字节相同 |
| C9 | 不继承的状态 | integration | 源会话有 active goal、排队的 prompt、子代理实例：新会话都没有；新会话的 todo 按复制的历史重建 |


| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T1 | 打开 | integration | 主会话有三轮已结束的对话：side chat 是根会话，含这三轮的历史和一条边界消息；`data.sideChat` 中的主会话 ID、边界消息 ID、PID 和进程实例 ID 正确，更新会话后仍在；`data` 里没有 `fork`；标题是 `Side chat 1`；主会话的行不变 |
| T2 | 模型上下文与系统提示词 | integration | side chat 第一次提问时发给假 LLM 的请求：主会话三轮历史、边界消息、用户问题依次排列；系统提示词与主会话下一轮逐字相同 |
| T3 | 切点、运行中、快照 | integration | 主会话第三轮之后有一个子代理唤醒的 run 已结束：side chat 的历史包含这个唤醒 run。主会话第四轮（用户触发）正在运行时打开：历史只到前一个已结束的 run，边界消息里有第四轮的用户输入原文，主会话的运行不受影响；正在运行的是 goal 续跑或子代理唤醒时，边界消息写对应的说明。打开后主会话又结束一轮，side chat 的历史不变。主会话第一轮还在跑、没有已结束的 run 时，side chat 只有边界消息，边界消息里有这一轮的用户输入 |
| T4 | 列表过滤 | integration | 打开 side chat 后：全局列表（活跃、归档）、搜索、TUI 的 `/sessions` 与 `/resume`、TUI 与 daemon 的“继续上次会话”、归档后的替补会话、Web 备用侧栏都没有它；它仍在会话索引和会话快照里，能被绑定 |
| T5 | 多开与归档 | integration | 同一主会话连续两次和并发两次调用 `openSideChat`，得到四个不同的 side chat，标题依次为 `Side chat 1` 至 `Side chat 4`；关掉 `Side chat 2` 后再开一个，标题为 `Side chat 2`。归档主会话后，它的全部 side chat 被中止并删除，别的主会话的 side chat 不受影响 |
| T6 | 操作拦截 | integration | 对 side chat：手动压缩、goal、切换模型、切换 reasoning、归档、移动工作区、导出都返回 `SIDE_CHAT_UNSUPPORTED`；以 side chat 为主会话再打开 side chat，也返回 `SIDE_CHAT_UNSUPPORTED`；主会话一个主 run、一个已接收的 prompt 都没有时打开，返回 `SIDE_CHAT_UNSUPPORTED`，说明为 “Send a message first”；第一条消息刚被接收、还在排队时可以打开；prompt 提交和中止成功；自动压缩照常触发。fork 和撤销的拦截用例由这两个议题落地时各自补上 |
| T7 | 子代理 | integration | side chat 里模型调用 `agent` 工具，得到“Subagents are not available in side chat.”，没有创建子代理记录；其他工具照常执行并走审批 |
| T8 | 不改当前会话 | integration | 进程内后端：向 side chat 提交后，后端的当前会话仍是主会话；之后的会话索引失效通知里 `selectedSessionId` 仍是主会话 |
| T9 | 关闭 | integration | side chat 正在运行时关闭：排队的 prompt 被取消，运行被中止并等到结束；会话、消息、片段、prompt、run 行都被删除；内存里的视图、todo、权限规则被清掉；主会话不受影响；再次关闭返回 204。运行 5 秒内没结束时返回 `SESSION_RUNNING`，数据不删 |
| T10 | 启动清理 | integration | daemon 启动和进程内 TUI 启动都会调用 `deleteOrphanSideChats(db, isPidAlive)`：`ownerPid` 已不在的两个 side chat（其中一个有标着运行中的 run 记录）被删除；当前 PID 与旧实例 ID 不匹配时同样回收；其他活进程的记录以及本进程自己的侧聊保留；主会话不受影响 |
| T11 | 两个客户端 | integration | 客户端 A 绑定主会话，客户端 B 绑定 side chat：A 只收到主会话的事件和审批，B 只收到 side chat 的；B 提交后 A 的绑定不变 |
| T12 | 存储区归属 | integration | side chat 的可信路径和环境提醒里是主会话的 `sessions/<mainId>`，不会建出 `sessions/<sideChatId>`；能免确认读取主会话 scratch 里的文件；side chat 往 scratch 写的文件也落在主会话的目录里；关闭 side chat（以及启动清理）后，主会话的目录和这些文件都还在 |
| T9b | 审批规则与关闭 | integration | 主会话对某条命令点过“总是允许”后打开 side chat：side chat 执行同一命令不再请求审批；side chat 新加的规则不出现在主会话里。side chat 正在等审批时关闭它、或归档主会话：审批请求被取消，side chat 被删除，没有残留的待处理审批 |
| T13b | 缓存一致 | integration | 前提：[已加载 MCP 工具从历史重建议题](../../2026-11-09-mcp-loaded-tools-from-history/README.md)已落地。主会话加载过一个 MCP 工具、处于空闲状态时打开 side chat（主会话正在运行的一轮里切点之后才加载的工具，side chat 不会有）：side chat 第一次模型请求的工具定义、系统提示词与主会话下一次请求逐字节一致，历史前缀与主会话相同、边界消息在末尾；OpenAI 兼容接口（官方端点）下两者的 `prompt_cache_key` 相同，side chat 触发自动压缩时摘要请求的 key 也相同；消息、run 仍记在 side chat 名下 |
| T13 | 接口契约 | contract | 状态码与错误码同 02 §2.5，响应体带 `code`；HTTP 与进程内实现一致 |

### Stage 2：Web

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T14 | 边界过滤 | unit | 面板只拿到 `boundaryMessageId` 之后的消息和对应的 prompt；继承来的轮次不出现 |
| T15 | 主客户端不受影响 | 浏览器 | 打开 side chat 并提问，主会话的消息、运行状态、审批照常更新；关闭面板后主会话不受影响 |
| T16 | 选中文字 | unit + 浏览器 | 在主会话消息正文里选中文字出现“Ask in side chat”；选区为空、落在输入框或 side chat 面板里时不出现；点击后：右侧正显示某个 side chat 时，引用填进它的输入框；否则新建一个 side chat 再填进去；输入框里是 `> ` 引用加一个空行，不自动发送 |
| T17 | 面板与入口 | 浏览器 | 顶栏菜单、快捷键、入口页、标签排 + 都能新建 side chat，标签名依次为 `Side chat 1`、`Side chat 2`；主会话还没发消息时这些入口置灰并提示 “Send a message first”；空状态只有 “No messages yet” 和一行快照说明；输入框占位文字为 “Ask a quick question”；只显示 side chat 自己的对话；消息有复制按钮，没有 Edit、fork；没有模型、权限、goal 控件和斜杠命令面板 |
| T18 | 审批 | 浏览器 | side chat 里触发需要审批的工具调用，审批出现在 side chat 面板里，主会话界面不出现；批准后 side chat 继续。开两个 side chat，在看第一个时第二个请求审批，第二个的标签出现“等待审批”标记，处理完后标记消失 |
| T19 | 多开与关闭 | 浏览器 | 连开两个 side chat，各自提问互不影响；点关闭直接关掉，不弹确认，再打开得到一个空的新 side chat。切换到另一个主会话：原来的 side chat 标签不显示，但没有被删除；这时其中一个请求审批，切回来后审批还在，可以处理；切回来时标签和内容都在 |
| T19b | 刷新与重连 | 浏览器 | 开两个 side chat 并各问一句后刷新页面：两个 side chat 都恢复，对话内容还在；断开网络十几秒再恢复，side chat 不被删除，事件继续推送；关掉其中一个再刷新，只恢复剩下那个 |

### Stage 3：TUI

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T20 | `/btw` | 手工 | 新会话还没发消息时 `/btw` 给出 “Send a message first” 的提示，不打开面板；主会话正在运行时能打开；打开面板，标题栏写“Side chat · Esc to close”；输入框可用，输入 `/compact` 会作为普通文字发给 side chat；`/btw <问题>` 打开后立即提问；连接远程 daemon 时给出不可用的提示 |
| T21 | 不被拉走 | 手工 | 在 side chat 里提问并等回答结束后关闭面板，TUI 回到主会话，主会话的消息和状态正确 |
| T22 | 审批 | 手工 | side chat 的审批弹出现有的权限对话框，批准后继续；面板打开期间主会话请求审批时，标题栏出现主会话需要审批的提示，按 Esc 回到主会话后审批照常弹出 |
| T23 | 关闭 | 手工 | 输入框为空时按 Esc 关闭面板并删除 side chat；输入框有内容时 Esc 不关闭 |

## 4.3 集成边界

- **side chat 与列表、操作**：T4、T6 逐项覆盖 01 §1.4.3、§1.4.4 的清单。
- **两个客户端**：T11、T15。
- **TUI 与后端当前会话**：T8、T21。
- **与 fork 议题**：复制函数由本议题写并用 C1 至 C9 守住；fork 以后复用它，在 fork 议题里补标题、`data.fork` 和入口的用例。
- **与撤销、存储区议题**：撤销议题落地时补上“side chat 里不能撤销”的用例。存储区已经落地，T12 由本议题补齐。

## 4.4 回归清单

- 子代理的创建、列表、对话查看、审批不受影响。
- 主会话的提交、中止、压缩、goal、归档、删除不受影响。
- 从不打开 side chat 的用户，会话列表、搜索、事件与改动前完全一致。
- 右侧面板的子代理页和终端页不受影响。
- 往普通会话提交时，后端当前会话照旧更新。

## 4.5 发布门

| 项 | 标准 | 如何验证 |
|---|---|---|
| 类型与格式 | 通过 | `pnpm typecheck`、`pnpm lint`、`pnpm format:check` |
| 自动化测试 | C1 至 C9、T1 至 T14（含 T9b、T13b）、T16 的单元部分通过 | `pnpm test:unit`、`pnpm test:integration`、`pnpm test:contract` |
| 浏览器走查 | T15 至 T19、T19b 通过，附截图 | 内置浏览器 |
| 手工 | T20 至 T23 通过 | 本机终端 |
| 文档 | Stage 4 的文档已同步 | 评审 |

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|---|---|---|
| 以后新增的列表不调用 `isUserFacingSession` | 一处定义；T4 | 新列表仍可能漏。评审时把“列表是否用 `isUserFacingSession`”列为检查项 |
| 以后新增的会话级操作没有拦截 | T6 | 同上，评审时检查 |
| side chat 修改文件 | 只有软提醒，工具照常走审批 | 用户批准了就会改。这是用户确认的行为 |
| 第二个客户端泄漏 | 关闭时销毁；面板卸载时也销毁 | 浏览器直接关闭时，客户端由服务端按现有的过期规则回收 |
| daemon 重启丢掉正在用的 side chat | 只删进程已不在的 | daemon 自己重启时，它名下的 side chat 会被删掉，Web 面板随之失效。和“关闭即删”的约定一致 |
