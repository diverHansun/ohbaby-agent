# 4. 测试与验收标准

## 4.1 测试范围

| 类型 | 覆盖什么 | 放在哪里 |
| --- | --- | --- |
| 集成测试 | UI 投影、历史分页、实时视图、分叉判断、复制历史的压缩标记、思考内容的失效、模型上下文不变、加载函数的返回值 | `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.integration.test.ts`、`packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`、`packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts`、`packages/ohbaby-agent/src/services/session/copy-history.integration.test.ts`、`apps/ohbaby-web/src/api/daemon/session-recovery.integration.test.ts` |
| 单元测试 | 前端自动加载、spinner、静默重试、位置保持、空消息、编辑按钮、失效规则、子代理阅读器的返回值 | `apps/ohbaby-web/src/ui/conversation/ConversationStream.unit.test.tsx`、`MessageRow.unit.test.tsx`、`apps/ohbaby-web/src/ui/session/SubagentConversationBody.unit.test.tsx`、`apps/ohbaby-web/src/store/store.unit.test.ts`、`packages/ohbaby-sdk/src/sync/subagent-conversation-reader.unit.test.ts` |
| 浏览器验收 | 真实长会话上的滚动、显示和操作 | 内置浏览器，会话 `session_1794834837609_a4f1aq1`（`~/Downloads` 工作区） |
| TUI 验收 | 同一个会话在 TUI 里的显示 | 终端手工操作 |

重点验证用户能感觉到的问题：翻不翻得到、内容对不对、位置跳不跳、会不会反复请求、点了按钮会不会报错。另一个重点是模型上下文不能被这次改动影响。不追求覆盖率数字。

jsdom 没有布局，单元测试里 `scrollTop`、`clientHeight`、`scrollHeight` 都是 0，元素位置也都是 0，需要用 `Object.defineProperty` 在滚动容器上手动定义，消息行的位置用 `getBoundingClientRect` 的替身。`requestAnimationFrame` 用假计时器推进。仓库用的是 Vitest 2，它的假计时器默认不替换 `requestAnimationFrame`，要写成 `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame"] })`。真实滚动由 T17 兜底。

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 对应 02 |
| --- | --- | --- | --- | --- |
| T1 | 一条消息的 part 已被压缩，生成持久化 UI 快照 | 集成 | 改 `persistent-store.integration.test.ts` L785–843 的已有用例：`messages` 长度是 2；第一条的 `parts` 匹配 `[{ text: "already compacted prompt", type: "text" }]`，第二条匹配 `[{ text: "still visible prompt", type: "text" }]`。另加一条：摘要消息仍投影为压缩分隔线，不含摘要正文 | Stage 1 |
| T2 | 会话发生过压缩，被压缩的消息已经在热窗口之外，调用 `getSessionHistory` 翻页 | 集成 | 页里的消息条数等于热窗口之外的记录数（用户消息不再被丢掉）；被压缩的用户消息和助手回答，文本等于写入时的原文，而且这几条都不是 `parts: []`；压缩分隔线排在被压缩的消息之后；翻到最早一页时 `hasMore` 为假。`parts: []` 的检查只针对被压缩的那几条，只调用了隐藏工具的步骤本来就投影成 `parts: []` | Stage 1 |
| T3 | 会话视图已经加载，此时发生压缩 | 集成 | 照 `ui-inprocess.contract.test.ts` 里 “exposes manual compact through the SDK client”（L3436 起，`compactSession` 在 L3493，`getSessionView` 在 L3519）的搭法：先读一次视图，压缩，再读视图。被压缩的助手回答文本等于原文，不是空壳；被压缩的用户消息也在。改动前这条应当失败在助手回答上（用户消息改动前也还留着旧副本，见 01 §1.3.2）。如果改动前就通过，说明 01 §1.3.2 的推断不成立，记录进 05 | Stage 1 |
| T4 | 压缩后再发起一轮对话 | 集成 | 已有用例 `ui-inprocess.contract.test.ts` L3354 “compacts core history before a TUI prompt and sends the compact summary in the model context”，断言不改，改动后仍然通过：请求体里有摘要，没有已压缩的原文 | Stage 1 |
| T5 | 最终回答带正文且已被压缩，从这一轮分叉；压缩时间和切点在同一毫秒 | 集成 | `findForkableMainRun` 返回这一轮；分叉成功；新会话的模型上下文是压缩前的消息。原有“最终回答只有 reasoning 时返回 `null`”的用例和 L667 的压缩标记用例不变。同一毫秒补两条，照 L667 的搭法：① 切点那一轮的最后一条消息、压缩时间、摘要消息的创建时间都是同一个值，摘要在切点之后插入（不被复制），新会话里被压缩的原文没有压缩标记，模型上下文是压缩前的消息（改动前这条应当失败）；② 摘要在切点之前插入、创建时间相同（被复制），标记保留，模型上下文里是摘要；③ 两次压缩，切点在两次之间：第一次的标记保留、第二次的标记去掉，模型上下文里有第一份摘要，没有第二份 | Stage 1 |
| T6 | 回归：子代理对话、子代理执行历史、回退到压缩点之前 | 集成 | `subagent-conversation*.integration.test.ts` 不改也全部通过；`subagent-compaction-history.integration.test.ts`、`interruption-projection.integration.test.ts` 只把 `projectComplete` 换成 `project`，断言不改也通过；`ui-persistent.integration.test.ts` L4268–4295、L4725–4760 仍然拒绝回退 | Stage 1 |
| T7 | 历史槽位在 `ready`、`loading`、`error`、失效四种状态下 | 单元 | 任何状态都没有按钮，也没有可见文字；只有 `loading` 时出现 `.ohb-spinner`；`role="status"` 节点四种状态下都在，只有 `loading` 时有文本 `Loading earlier messages`；四种状态下渲染的都是同一个固定高度的槽位元素，spinner 出现或消失不改变它的高度 | Stage 2 |
| T8 | 不贴底时滚动到距顶部一屏以内；请求未返回时又连续滚动；滚动位置距顶部超过一屏；首屏挂载时贴底、`scrollTop` 为 0、内容超过一屏 | 单元 | 第一次调用 `onLoadHistory` 一次；请求未返回期间不再调用；超过一屏时不调用；首屏挂载时不调用 | Stage 2 |
| T9 | 不贴底时一页加载完仍在顶部附近；贴底且内容不满一屏、还有更多；`onLoadHistory` 返回 `true`，promise 结束早于或晚于重新渲染两种顺序；`onLoadHistory` 返回 `false`，而且 props 没有任何变化；`historyHasMore` 变为假 | 单元 | 返回 `true` 时，前两种情况不需要滚动，推进一帧后自动再加载；promise 结束的先后顺序不同，都只再加载一次，不漏也不重复。返回 `false` 时只调用一次，推进计时器和帧以后也不再调用。没有更多以后不再调用，槽位消失 | Stage 2 |
| T10 | 加载失败，随后 2 秒内往上滑、2 秒后往上滑、不操作；停在 `scrollTop` 为 0 时往上的 wheel | 单元 | 失败后没有任何文字；不操作不会重试；2 秒内往上滑不重试；2 秒后往上滑重试一次；停在顶部时，往上的 wheel 事件也能触发重试（这时浏览器不发 `scroll` 事件） | Stage 2 |
| T11 | `historyStale` 为真，滚动到顶部附近 | 单元 | 调用 `onLoadHistory`；界面上没有 `Earlier history changed` 之类的文字 | Stage 2 |
| T12 | 不贴底时加载完成；请求途中用户又往下滚了一段；刚展开或折叠过消息（`readingPosition.messageId` 为空）后触发加载；贴底时加载完成 | 单元 | 不贴底：加载前正在看的那条消息，加载后到滚动区顶部的距离不变。请求途中滚动过：以最后一次滚动时看的那条消息为准，不被拉回请求发起时的位置。展开或折叠过：以发请求时第一条可见的消息为准，加载后它的位置不变。贴底：仍然跟随底部 | Stage 2 |
| T13 | 助手消息 `parts: []` 且没有推理（例如只调用了隐藏工具）；只有推理的流式消息；后面挂着耗时行或错误行的空消息 | 单元 | 第一种不渲染 `<article>`，外层 div 没有子节点；只有推理的消息照常显示（`App.unit.test.tsx` 里 “renders transient reasoning for a streaming assistant message” 不改也通过）；挂着耗时行或错误行的，外层 div 里这些行照常显示 | Stage 2 |
| T14 | 列表里有压缩分隔线，分隔线前后各有用户消息；另一个会话没有压缩 | 单元 | 分隔线之前的用户消息没有编辑按钮，之后的有；没有压缩的会话行为不变 | Stage 2 |
| T15 | Side Chat 加载到边界前后 | 单元 | 边界之前滚到顶部会加载；边界之后槽位消失，不再加载 | Stage 2 |
| T16 | 子代理对话详情滚到顶部；子代理翻页失败 | 单元 | 调用它自己的 `onLoadHistory`；`historyStale` 固定为假时规则照常生效；翻页失败时显示它原有的错误条，这是预期；下一次重试开始时错误条消失，再失败时重新出现 | Stage 2 |
| T17 | 浏览器验收，见 §4.3 | 手工 | §4.3 全部检查项通过 | Stage 1、2 |
| T18 | TUI 验收，见 §4.4 | 手工 | §4.4 全部检查项通过 | Stage 1 |
| T19 | 已经加载过历史后：① 收到带 `evictedMessageIds` 的失效；② 收到不带 `evictedMessageIds` 的失效；③ 同一作用域下状态从 `syncing` 变回 `ready`；④ 视图换代；⑤ 装入一页时版本不匹配或页太旧；⑥ 翻页请求在断线前发出、在重新拉基线之后才回来 | 单元 | ① `historyStale` 仍为假，已加载的消息还在，`historyBefore`、`historyHasMore` 不变，失效之前发出的请求返回的页照常装入（`invalidatedAt` 没变）。② 保持现有行为：`store.unit.test.ts` L296 的用例不改也通过。③ `historyStale` 为真，`invalidatedAt` 等于新视图的 `sessionRevision`；首次加载（还没加载过历史）时不标记。④ 现有行为不变。⑤ `installSessionHistory` 返回 `false`，装入成功返回 `true`。⑥ 这一页不装入，返回 `false`，`historyStale` 仍为真 | Stage 2 |
| T20 | 后端保存思考内容：消息在热窗口里；消息已被挤出热窗口 | 集成 | 在热窗口里时，`session.changed` 事件没有 `historyInvalidated`，视图里的这条消息照常更新；在热窗口外时，事件带 `historyInvalidated`。放在 `packages/ohbaby-agent/src/adapters/ui-state/session-run-window.integration.test.ts` | Stage 1 |
| T21 | 加载函数的返回值：`client-sync` 的 `loadEarlierHistory`、子代理阅读器的 `loadEarlier` | 集成、单元 | 装进新页且游标变了返回 `true`；装进最后一页（`hasMore` 为假）返回 `true`；没有游标、请求途中收到不带 `evictedMessageIds` 的失效导致页被丢掉、请求出错，都返回 `false`。`historyStale` 为真但视图没有 `history.before` 时：不发请求，旧页被清掉，`historyStale` 和 `historyHasMore` 都变成假，返回 `true`。`session-recovery.integration.test.ts` L892 的用例不改也通过 | Stage 2 |

## 4.3 浏览器验收（T17）

在 `~/Downloads` 工作区打开会话 `session_1794834837609_a4f1aq1`，按顺序检查：

1. 一直往上滚，更早的消息自动出现，直到会话的第一条用户消息。全程没有按钮，也没有文字。
2. 加载时顶部中间出现一个小 spinner，加载完消失，下面的内容不跳。
3. 压缩之前的用户消息和助手回答显示原文，压缩处是一条分隔线。
4. 没有大块空白。在控制台检查：所有高度为 0 的 `[data-message-id]` 元素，计算样式都是 `display: none`。
5. 往上翻的过程中，正在看的那条消息不会被推走。
6. 翻到最早以后，网络面板里不再有新的历史请求。
7. 压缩分隔线之前的用户消息没有编辑按钮，之后的有。
8. 在压缩点之前的一条回答上点分叉，新会话创建成功，内容正确。
9. 断网后往上滚：spinner 出现后消失，没有任何提示文字。恢复网络，等 2 秒以上再往上滚，能继续加载。
10. Side Chat 和子代理对话详情各往上滚一次，行为和主会话一致。子代理详情翻页失败时显示它原有的错误条，这是预期。
11. 让会话运行起来，先往上翻几页，等它再输出几条消息，然后继续往上翻：已经翻出来的内容还在，视图不跳，网络面板里没有反复重拉同一页的请求。
12. 测量并记录：第一页、第二页历史响应的大小（网络面板的传输大小和解压后大小）；连续往上翻时，性能面板里有没有超过 50ms 的长任务。只记录，不设硬门槛，数据用来决定下一轮要不要按大小分页。

结果写入 05，附截图。

## 4.4 TUI 验收（T18）

用 TUI 打开同一个会话，按 TUI 现有的方式加载历史：

1. 压缩之前的消息显示原文，压缩处有分隔线。
2. 没有乱码、空行堆积或报错。
3. 显示的消息内容和 Web 一致。

TUI 代码不改。发现问题时只记录进 05，不在本轮修。

## 4.5 回归清单

- 发给模型的上下文不变（T4）。
- 回退到压缩点之前仍然被拒绝，错误文案不变（T6）。
- 复制历史切到压缩点之前，仍然能还原压缩前的模型消息（`copy-history.integration.test.ts` L667 起的用例）。
- 已有的失效用例不改也能通过：`store.unit.test.ts` L296、`session-recovery.integration.test.ts` L892。
- 热窗口 50 条和每页 50 条不变。
- 助手消息还没有内容时，`Thinking` 一行照常显示（由 `ExecutionProgress.tsx` 渲染，不受 `MessageRow` 返回 `null` 影响）。
- 发送新消息后视图回到底部跟随，行为不变。
- 已有的 `ConversationStream`、`MessageRow`、`App` 单元测试，除了针对旧历史按钮的断言以外，不改也能通过。

## 4.6 验收标准（发布门）

| 项 | 标准 | 如何验证 |
| --- | --- | --- |
| 自动化测试 | T1–T16、T19–T21 和回归清单里的已有测试全部通过 | `pnpm test` 和相关的集成测试 |
| 类型与静态检查 | 没有新增错误 | 项目现有的 typecheck 和 lint 命令 |
| 浏览器 | §4.3 第 1–11 项通过，第 12 项有记录 | 05 记录每一项的结果和截图 |
| TUI | §4.4 全部通过 | 05 记录结果 |
| 文档 | 02 §2.9 K10 已更新 | 对照检查 |

## 4.7 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
| --- | --- | --- |
| **请求停不下来**：加载失败，或者加载函数什么都没做就返回（没有游标、页被丢掉），请求后的复查又立刻触发加载，形成死循环 | 只有加载函数返回 `true`（游标前进或已没有更多）才续拉；遇到 `error` 也不续拉，重试只能由用户操作触发，而且要等 2 秒冷却。③ 的依赖里不放 `historyState`。T9、T10、T21 固定这一点 | 无 |
| **复查漏掉**：装进新页后，重新渲染和请求回调的先后不固定，两处复查都跳过，内容不满一屏却停住 | 两处复查都调用同一个函数，从 `latestProps` 读状态；④ 等一帧再查，总有后执行的那一处能查到。T9 固定这一点 | 无 |
| **运行中翻历史被重置**：每条新消息把旧消息挤出热窗口，都会发一次失效；每保存一次思考内容也发一次失效。自动加载跟着清掉翻出来的页 | 带 `evictedMessageIds` 的失效不标记 `historyStale`、不改游标；后端只在消息不在热窗口里时才为思考内容发失效。T19、T20、T17 第 11 项 | 热窗口外的旧消息真被改时，下次接近顶部会清页重拉，阅读位置可能跳一下，这种情况很少 |
| **显示过期内容**：旧消息真被改了，或者断线期间漏掉了失效事件，已加载的页还是旧内容 | 不带 `evictedMessageIds` 的失效照旧标记失效；重新拉基线时也标记失效。T19 | 无 |
| **分叉丢上下文**：压缩时间和切点在同一毫秒，标记留下了，摘要没复制过去 | 标记按被复制的最后一条摘要去留，不再比较压缩时间和最后一条消息的时间。T5 | 历史数据里不带摘要的标记，分叉后会被去掉，上下文变大但不丢内容 |
| **打开会话就多拉页**：首屏挂载时 `scrollTop` 还是 0，被当成在顶部 | 贴底时只看内容满不满一屏，不看 `scrollTop`。T8 固定这一点 | 无 |
| **重复请求**：一次滚动会连续触发很多个 `scroll` 事件，在请求返回之前重复调用 | `requestPendingRef` 保证同一时刻只有一个请求，T8、T9 固定这一点 | 无 |
| **请求挂住**：请求一直不返回，spinner 一直转 | 本轮不加超时（见 03 §3.3） | 网络异常时可能一直转，验收时留意 |
| **位置跳动**：加载完内容往下跳，请求途中滚动过被拉回去，或者贴底时被拉走 | 不贴底时按用户最后一次滚动记下的阅读行恢复，在绘制前完成；贴底时只补页，不做位置恢复。T12、T17 第 5 项 | 消息里的图片或代码块加载完才撑开高度时，可能有小幅跳动，现在也存在 |
| **已压缩内容进入模型上下文** | 只改 UI 投影入口，模型上下文走 `core/context` 的另一条路径。T4 固定这一点 | 无 |
| **编辑按钮的规则和后端不一致** | 前端按后端同样的规则判断，后端拒绝保留作为兜底。T14 | 后端规则以后变化时，前端需要跟着改，见 02 §2.6 |
| **空消息误伤**：有意义的内容被当成空消息隐藏 | 只在没有推理、也没有可见 part 时返回 `null`；外层 div 只有在完全没有子节点时才隐藏。T13 | 无 |
| **首屏变慢**：显示原文后每页内容变多 | 每页 50 条限制的是条数，工具输出原样传。T17 第 12 项测量响应大小和长任务 | 一页可能有几百 KiB，单条消息特别长时渲染会慢一些，本轮只测量 |
