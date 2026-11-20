# 3. 参考项目借鉴

> 2026-11-20 由子代理只读调研 `code-cli/` 下的项目，主代理抽查后整理。同一天按用户要求补充了 deepseek-harness（下称 dsh）、kimi-code、ZCode 在续页、失效、页大小和分叉上的做法（§3.1.3）。路径相对于 `code-cli/`，行号是调研时的快照。

## 3.1 借鉴来源

调研了四个问题：压缩以后界面还显示不显示原文；更早的历史怎么加载，加载后怎么保持阅读位置；什么时候停止自动续页、实时更新和重连时怎么处理已加载的页；分叉时怎么处理切点之后的压缩。

### 3.1.1 压缩后显示什么

| 项目 | 做法 | 出处 |
| --- | --- | --- |
| opencode | 显示原文，压缩处插一条 Notice 行。模型读历史时从最近一次压缩点开始读，UI 列表接口只按游标分页，不看压缩边界 | `opencode/packages/core/src/session/history.ts:202-213`（模型读取）；`opencode/packages/core/src/session/store.ts:108-140`（UI 列表）；`opencode/packages/session-ui/src/timeline/rows-current.test.ts:1490-1506` |
| codex（Rust TUI） | 显示原文，压缩完成后只追加一行 `Context compacted`，不删旧内容 | `codex/codex-rs/tui/src/chatwidget/compaction.rs:42-56` |
| pi-web | 显示原文，压缩处是一张带摘要的卡片。源码注释写明历史分页保留已压缩的消息 | `frontend/pi-web/lib/session-reader.ts:725-726` |
| pi p2 | 压缩处是一条 `Context compacted` 标记行。没有看到过滤旧内容的代码，但没有完整追踪 | `pi/apps/p2/src/web/transcript.ts:385-389` |
| claude-code | 全屏模式保留原文（上限 500 条）；默认模式把内存列表重置成只剩压缩边界，旧内容留在终端自己的滚动缓冲里 | `claude-code/src/screens/REPL.tsx:3157-3184` |
| dsh | 显示原文，压缩处是一条可以展开看摘要的标记行，标记不替换被遮住的原文 | `deepseek-harness/packages/client/ui-chat/` 下的 `CompactionItem.tsx:1-2` |
| kimi-code | 保留原来的轮次，压缩处是一个带摘要和 token 数的 `compaction` 条目 | `kimi-code/` 下的 `conversationFold.ts:619-660` |
| ZCode | 保留原文，压缩处是一条标记行，摘要消息本身不显示 | `ZCode/` 下的 `rows.ts:356-363`、`session-fork.ts:751` |

### 3.1.2 怎么加载更早的历史

| 项目 | 触发方式 | 阈值 | 位置保持 | 加载提示 |
| --- | --- | --- | --- | --- |
| opencode Web | 滚动时判断 `scrollTop`，不用 IntersectionObserver，也没有按钮。每页回来后再探测一次是否仍在顶部，是就接着加载。内容不满一屏时另有补页逻辑。请求 30 秒没回来算失败，重试前冷却 2 秒 | 200px | 虚拟列表的锚点元素 | 没有 |
| opencode TUI | 鼠标上滚或键盘移动时判断 | 一屏高度 | 固定第一个可见节点 | 没有 |
| claude-code（`claude assistant` 查看模式） | 滚动时判断，内容不满一屏时最多连续补 10 页 | 40 行 | `scrollHeight` 差值；贴底时跳过补偿 | 顶部一行文字：加载中、加载失败、会话开头 |
| ZCode | 在 `onScroll` 里判断 | max(64px, 2 屏) | 虚拟列表锚点，失败时退回总高度差 | 没有可见提示，只有 `data-loading-older` 属性 |
| pi-web | 列表顶部放一个 IntersectionObserver 哨兵 | 哨兵进入视口 | 距底部的距离 | 静态文字 `Scroll up to load earlier messages` |
| pi p2 | 滚动和布局变化时都判断，提前预取；另有一个按钮兜底 | 3 屏，贴底时 1 屏 | 浏览器原生 `overflow-anchor`，Safari 手动固定首行 | 按钮内带 spinner；顶部边缘在各个状态下高度不变 |

出处：

- opencode Web：`opencode/packages/app/src/session/timeline/history-machine.ts:1-8,158-165`，`interaction.ts:241-279`
- opencode TUI：`opencode/packages/tui/src/routes/session/index.tsx:463-476`
- claude-code：`claude-code/src/hooks/useAssistantHistory.ts:37-47,199-247`
- ZCode：`ZCode/packages/ui/src/v4/` 下的 `timelineScrollAnchor.ts:278-305`、`ConversationTimeline.tsx:1455-1486`
- pi-web：`frontend/pi-web/components/ChatWindow.tsx:677-713`
- pi p2：`pi/apps/p2/src/web/use-chat-scroll.ts:49,756-773`，`pi/apps/p2/src/web/Chat.tsx:775-792`

### 3.1.3 续页、失效、页大小和分叉

kimi-code 的 VS Code webview 一次加载整段会话，没有分页（`apps/vscode/webview-ui/src/stores/chat.store.ts:284-310`），下面只列它的服务端接口和文档里的规则。

| 问题 | dsh | kimi-code | ZCode |
| --- | --- | --- | --- |
| 什么时候接着拉 | 每次内容提交、滚动结束、尺寸变化后，每帧最多查一次，顶部控件离顶部不超过 2 屏就再拉。拉回来的页是空的、或者第一条不比游标更早而 `hasMore` 还为真，就当成出错，停掉自动加载，只留手动重试。注释写明空页或被丢掉的页“必须结束循环，而不是空转” | 无前端实现 | 滚动时判断，距顶部 max(64px, 2 屏)。内容不满一屏的补页按 `firstRowId` 去重，注释写明是为了避免空范围或失败时 effect 空转。“全部加载”模式里，游标没前进就停 |
| 实时更新时已加载的页 | 日志只追加，不会原地改，已加载的页一直有效 | 撤销、清空时发 `turns.removed`；文档要求丢掉在它之前发出的翻页请求 | 针对没加载的行的更新直接忽略；真删除是单独的 `row.removed` 事件 |
| 重连 | 重连或修补缺口时整窗换成最新一页，已加载的旧页丢掉，途中的翻页请求作废 | 文档要求重连后丢掉这个会话的全部本地轮次，包括翻出来的页，原因是撤销后序号可能重复使用 | 能续上就续，续不上就换成新快照，已加载的行丢掉 |
| 每页大小 | 只按条数，至少 50 条消息，最多 500 条，没有字节上限 | 按轮次分页（默认 50，最多 200），每页再限 1 MiB，第一轮超过也照样返回 | 首屏 60 行，每次翻页最多 200 行；工具输出只传头尾各 32 KB，另给引用去取全文 |
| 分叉时的压缩 | 按事件序号复制前缀，切点之后的压缩不会被复制，原文也一直在日志里 | 按记录切片复制，摘要就存在压缩记录里，不用配对；子代理的记录按时间切 | 复制的是界面可见的历史，不是模型那份被截掉的消息；压缩和摘要按消息 id 关联；压缩进行中拒绝分叉 |

出处：

- dsh：`deepseek-harness/packages/client/ui-chat/src/client/chat/use-chat-scroll.ts:118-120,130,174`；`deepseek-harness/packages/api/session-controller/src/client/sessions/session.ts:461-462,553-558,769-772`；`deepseek-harness/packages/core/session/src/fork.ts`
- kimi-code：`kimi-code/packages/kap-server/src/services/conversation/conversationFeed.ts:114-115,181-199`；`kimi-code/docs/en/reference/server-api-conversation.md:227,241,438`；`kimi-code/packages/agent-core-v2/src/workspace/sessionLifecycle/internal/forkTurnSlice.ts:133-185`
- ZCode：`ZCode/packages/ui/src/v4/timelineScrollAnchor.ts:282-306`；`ZCode/packages/shared/src/zcode-protocol-v4/apply.ts:93`；`ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/projection-rows.ts:186-205`；`ZCode/apps/zcode-cli/packages/core/src/runtime/methods/session-fork.ts:193-197,735-754`

## 3.2 可借鉴点

| 借鉴点 | 来源 | 用在哪里 |
| --- | --- | --- |
| 给模型的内容和给人看的内容分开读：模型从压缩点开始读，界面照常分页读原文 | opencode；codex、pi-web、dsh、kimi-code、ZCode 的做法一致 | 00 D1、D2：UI 投影不再过滤 `compacted` |
| 在滚动处理里判断 `scrollTop`，不加额外的观察器 | opencode、ZCode、claude-code、pi p2 | 02 §2.5 |
| 每页装好后再判断一次，覆盖“内容不满一屏”和“一页里没什么可见内容” | opencode 的顶部探测与补页，claude-code 的连续补页，pi p2 的布局变化触发，dsh 每帧最多查一次 | 02 §2.5 的调用点 ③ ④，④ 等一帧再查 |
| 没有进展就停，不空转 | dsh 把空页、游标没前进当成出错；ZCode 按游标去重 | 00 D14：加载函数返回是否前进，返回 `false` 就停。我们不把它算成出错，下一次滚动或新消息到达还会再判断 |
| 只是移出实时窗口的消息不算改动；真删除、真修改单独处理 | ZCode 忽略针对未加载行的更新、删除单独发事件；kimi-code 单独发 `turns.removed` | 00 D8：带 `evictedMessageIds` 的失效不清页 |
| 重连时要么续上，要么重来，不在中间修补 | dsh、kimi-code、ZCode | 00 D8：重新拉基线时标记失效，下次接近顶部时清页重拉 |
| 分叉复制前缀，压缩标记跟着自己的摘要走 | dsh 按序号、ZCode 按消息 id、kimi-code 摘要和压缩存在同一条记录里 | 00 D15：标记按被复制的最后一条摘要去留，不再拿压缩时间和最后一条消息的时间比 |
| 出错后冷却 2 秒再重试 | opencode | 00 D7，02 §2.5 |
| 贴底跟随时不做位置补偿，只在内容不满一屏时补页 | claude-code（跳过补偿）；opencode（跟随底部时只做补页） | 02 §2.5 |
| 位置保持以用户正在看的那条消息为准 | opencode TUI 固定第一个可见节点；opencode Web、ZCode 用锚点元素 | 复用 `ConversationStream.tsx` 里 `ResizeObserver` 的阅读行恢复，见 02 §2.5 |
| 加载提示所在的顶部边缘高度固定，状态变化时内容不跳 | pi p2 | 02 Stage 2 第 1 项的槽位 |

## 3.3 明确不借鉴

| 做法 | 来源 | 不借鉴的原因 |
| --- | --- | --- |
| 虚拟列表 | opencode、ZCode | 我们没有虚拟列表，现有的阅读行恢复够用。虚拟列表不在本轮范围（00 §3） |
| 请求发起时记下 `scrollHeight`，回来后补高度差 | claude-code；我们现有的 `anchorRef` 也是这个做法 | 请求途中用户滚动过，会被拉回请求发起时的位置。改用阅读行恢复，`anchorRef` 删掉 |
| IntersectionObserver 哨兵 | pi-web | 哨兵在加载完以后如果还在视口里，观察器不会再回调，需要另写一段复查。`scrollTop` 方案的滚动判断和加载后复查是同一个函数。本议题讨论初期推荐过哨兵，比较后改成了 `scrollTop` |
| 任何文字提示，包括加载中、失败、会话开头 | claude-code、pi-web、pi p2 | 用户要求界面上没有文字，只有 spinner（00 D6、D7） |
| 按钮兜底 | pi p2 | 用户要求去掉按钮 |
| 连续补页的页数上限 | claude-code（10 页） | 只有游标前进了才续拉，每页都要等网络返回，拉到没有更多就停，不会空转。见 02 §2.6 |
| 没有进展时进入出错状态，只留手动重试 | dsh | 我们没有手动按钮（00 D5、D6）。返回 `false` 时停下，等下一次滚动或新消息再判断，效果一样，也不用多一种状态 |
| 重连时立刻丢掉已加载的页 | dsh、kimi-code、ZCode | 我们已有“标记失效、下次接近顶部清页重拉”的机制，复用它就够了，不再另写一条清页路径。代价是重连后到用户下次接近顶部之前，旧页可能是旧内容 |
| 压缩和摘要按 id 或序号关联 | dsh、ZCode | 要给 part 加字段，改存储格式，超出本议题“不改数据结构”的边界（00 §3）。现在的判断依赖“摘要在自己的压缩时间之后创建”这一顺序，已经能避开同一毫秒的问题，残余风险见 02 §2.6 |
| 每页限 1 MiB、工具输出只传头尾 | kimi-code、ZCode | 要改分页游标或投影格式。本轮先测量（00 D16），如果 T17 测出问题，下一轮优先考虑这两种做法 |
| 30 秒请求超时 | opencode | 本轮不加。实施或验收时如果发现请求会挂住、spinner 一直转，再补 |
| 压缩时重置界面列表 | claude-code 默认模式 | 那是终端特有的做法，旧内容留在终端缓冲里。Web 没有这个缓冲 |

## 3.4 对 02 方案的影响

- 后端方案 A 有六个项目的先例（opencode、codex、pi-web、dsh、kimi-code、ZCode），不是我们自创的规则。
- 前端加载从最初设想的 IntersectionObserver 改成了 `scrollTop` 阈值加装页后复查，阈值取一屏，介于 opencode（200px）和 ZCode、dsh（2 屏）之间。贴底时只补页，和 opencode 一致。
- 自动续页只在游标前进时继续，和 dsh、ZCode 防空转的思路一致。
- 失效分成“移出窗口”和“真改动”，重连按“重来”处理，和 ZCode、kimi-code 一致。
- 分叉时压缩标记跟着摘要走，方向和 dsh、ZCode 一致；它们按 id 关联，我们因为不改数据结构，用摘要的创建时间判断。
- 页大小本轮只测量；kimi-code 的 1 MiB 上限和 ZCode 的工具输出截断留作下一轮的候选做法。
- 位置保持从高度差补偿改成按阅读行恢复，原因是请求途中用户可能还在滚动。
- 静默重试的 2 秒冷却来自 opencode。
- spinner 槽位高度固定，来自 pi p2。
