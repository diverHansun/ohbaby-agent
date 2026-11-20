# 1. 现状与问题分析

> 时间口径：`codex/subagent-model` 分支 `e9c6c3c8`（2026-11-20）。证据来自 2026-11-20 Codex 的只读复现，以及本次源码核查。行号是分析时的快照，定位以符号为准。标注“推断”的结论还没有测试证实，由 04 的用例确认。

## 1.1 问题陈述

1. **滚到顶不会加载更早的历史。** 只有点 `Load earlier messages` 按钮才会请求上一页。用户以为已经翻到最早，其实上面还有很多。
2. **翻到的旧消息没有正文。** 已压缩的消息在 SQLite 里原文完整，但历史接口在投影给 UI 时把它们过滤掉了：用户消息整条消失，助手消息只剩一个空壳。
3. **空消息撑出大块空白。** 空壳消息仍然各占一行，每行吃掉 26px 的行间距。真实会话里第一条正文前面有 19 个空行，正文被推到顶部往下约 602px。

第 2 条是根因，第 1、3 条是前端缺口。只修前端，翻上去也只是一页页空壳；只修后端，用户还是得点按钮，而且各种原因产生的空消息照样占位置。

## 1.2 根因：一条给模型的规则被拿来决定给人看什么

`Part.time.compacted` 的本意是“这段内容已经被摘要替代，不再发给模型”。原文没有删除，仍在 SQLite 里。判断函数是 `packages/ohbaby-agent/src/core/context/filters.ts` 的 `isActivePart`（L3）：`part.time?.compacted === undefined`。

问题在于，UI 投影也用了这个函数。于是项目里出现了两套互相矛盾的做法：

| 读取路径 | 位置 | 已压缩的原文 |
| --- | --- | --- |
| 主会话首屏与实时更新 | `source-session-projection.ts` 的 `seed`（L162，投影在 L223）和 part 更新后的重新投影（L348），都走私有方法 `project`（L248） | 过滤掉 |
| 主会话历史分页 | `source-session-projection.ts` 的 `history`（L628） → `project` | 过滤掉 |
| 子代理对话 | `subagent-conversation.ts` L77、L471 调用 `projectComplete`（`source-session-projection.ts` L152） | 显示。`projectComplete` 先把每个 part 的 `compacted` 清空，再调 `project` |
| 子代理执行历史分页 | `source-session-projection.ts` 的 `executionHistory`（L589），L605–610 先清空 `compacted` | 显示 |
| 持久化 UI 快照 | `persistent-store.ts` 的 `sessionToUiSession`（L353，L366 调 `messageToUiMessage`） | 过滤掉 |
| 旧版完整快照 | `ui-inprocess.ts` L2839 直接调 `messageToUiMessage` | 过滤掉 |
| 发给模型的上下文 | `core/context/` 下的活动投影 | 过滤掉（本来就该这样） |

子代理那两处“先清空再投影”的写法说明，之前已经有人遇到过同样的问题，只是在子代理这一侧单独绕开了，主会话没有跟着改。

文档这边的立场其实是清楚的。[context 数据流与接口](../../../core/context/dfd-interface.md) L158 写着：“已有 `time.compacted` 继续控制活动投影；旧摘要与原文仍可读取”。过滤是 [Compact UI 边界计划（2026-06-09）](../../../superpowers/plans/2026-06-09-compact-ui-boundary.md) 引入的。那份计划的目标是“UI 上不显示摘要正文”，实现时顺手把已压缩的原文也一起过滤了。

## 1.3 后端：UI 投影链路

### 1.3.1 `messageToUiMessage`

位置：`packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts` L252–327。

| 步骤 | 行号 | 行为 |
| --- | --- | --- |
| 过滤 | L255–257 | `message.parts.filter(isActivePart)`，已压缩的 part 全部丢弃 |
| 摘要消息 | L259–292 | 用 `message.parts.find(isContextSummaryPart)` 识别，不经过上面的过滤。投影成一条 `role: "system"` 的压缩分隔线，文本是 `Compacted (estimated): … tokens` 或 `Context compacted`，带 `metadata.kind: "context-compaction"`。摘要正文不投影 |
| 空消息 | L300–305 | 过滤后没有 part 时：助手消息如果有 `modelRequests`，返回一条 `parts: []` 的消息；其他情况返回 `undefined` |

### 1.3.2 `project` 的兜底

`source-session-projection.ts` 的 `project`（L248）在 `messageToUiMessage` 返回 `undefined` 时，会给助手消息补一个 `parts: []` 的空壳（L262–274）。所以只要原文全被压缩：

- 用户消息：整条消失。
- 助手消息：变成没有内容的空壳，状态是 `completed` 或 `error`。

这和 Codex 的观察一致：第一页 44 条消息全部没有正文。主会话共 101 条记录。按最近 50 条的热窗口算，还剩 51 条；第一页取 50 条，用户消息被丢掉后剩 44 条；第二页只剩 1 条，被丢掉后返回 0 条。这个数字推算是**推断**，但方向和代码行为吻合。

实时视图也会受影响，但用户消息和助手消息的表现不一样。压缩会对被压缩的 part 发布 `PartUpdated`，`commit` 对涉及的消息重新调用 `project`（L343–350）：

- 助手消息：`project` 补出空壳，屏幕上原本有内容的回答当场变成空壳。
- 用户消息：`project` 返回 `undefined`，被 L350 的 `filter` 丢掉，视图里不会删除它，屏幕上留着压缩前的旧副本。等这条消息被挤出热窗口、再从历史分页读回来时，它才消失。

这一条是**推断**，待 04 T3 证实。

### 1.3.3 热窗口与失效

`source-session-projection.ts` 的 `trim`（L539–585）只在内存里保留最近 50 条，被挤出去的部分单独提交一次（L567–583），事件里带 `evictedMessageIds`、新的 `history` 边界和 `historyInvalidated: true`。后端这套机制本身没问题，本议题不改。问题在 Web 前端怎么处理这个标记，见 §1.5.4。

### 1.3.4 每页的大小

热窗口和每页都是 50 条，限制的是条数，不是大小。工具输出在 UI 投影里原样传（`persistent-store.ts` 的 `toolResultPart`，L86 起），单个输出在工具写入时一般截到约 8000 token（`tools/utils/output.ts` 的 `DEFAULT_OUTPUT_TOKEN_LIMIT`），但一页 50 条消息里可能有很多个。Codex 量出这个会话的第一页约 165 KiB。方案 A 之后，以前被过滤掉的正文也会回来，页还会更大。目前没有数据说明这会造成卡顿，本轮只测量（00 D16）。

## 1.4 后端：和压缩有关的两个操作

方案 A 让用户能看到压缩点之前的消息，所以要检查这些消息上的分叉和编辑按钮是否还对得上。

### 1.4.1 分叉

`packages/ohbaby-agent/src/services/session/copy-history.ts` 的 `findForkableMainRun`（L66–111）负责判断“从哪一轮的最终回答分叉”。L93 也用了 `isActivePart`：

```ts
const active = parts.filter(isActivePart);
const visible = active.filter(isTranscriptPart);
```

最终回答已被压缩时，这一轮会被当成“没有可分叉的回答”，后端返回 `FORK_TARGET_INVALID`，前端提示 `Nothing to fork yet`。现在 UI 看不到这些回答，所以没人碰到。改成显示原文以后，用户就会在旧回答上点分叉，然后看到报错。

复制历史那一层已经支持切到压缩点之前：`copySessionHistory` 在 L353–364 会撤掉切点之后才打上的 `compacted` 标记，`copy-history.integration.test.ts` L667 起的用例证明切到压缩点之前能还原压缩前的模型消息。所以分叉判断只需要放开 L93。

但撤标记的判断有一个同毫秒漏洞。现在的写法是：压缩时间（`time.compacted`）晚于最后一条被复制消息的 `created_at`（L262 的 `lastMessageAt`），就撤掉标记。切点按 `(created_at, rowid)` 取（`selectHistory`，L145–175），压缩时间却只按毫秒比。压缩提交时先取 `compactedAt = now()`（`context-manager.ts` L1105），再分配摘要消息（`core/message/manager.ts` 的 `commitCompaction`，摘要的 `created_at` 由 `createMessage` 再取一次 `now()`），所以摘要的创建时间不早于压缩时间。如果切点那一轮最后一条消息的创建时间正好等于压缩时间，摘要又排在切点之后，结果就是：摘要没被复制，标记却因为“不晚于”而留了下来，新会话的模型看不到这段原文，也没有摘要。以前压缩点之前的回答不能分叉，碰不到这种情况；放开以后就可能碰到。

摘要总是在自己的压缩时间之后创建，所以更稳的判断是看对应的摘要有没有一起复制：被复制的消息里最后一条摘要的创建时间，早于标记的压缩时间，就撤掉标记（00 D15）。L667 的用例里摘要的创建时间和压缩时间相同，在这个判断下照样通过。

`copy-history.integration.test.ts` L453–457、L495–505 有一个“最终回答已压缩时返回 `null`”的用例。那条消息只有 reasoning part，去掉过滤以后照样找不到正文，结果仍是 `null`，不受影响。

### 1.4.2 编辑重发

编辑重发底层是回退。`packages/ohbaby-agent/src/adapters/ui-inprocess/session-rewind.ts` L111–130 规定：只要目标消息之后（含同一时刻）存在摘要消息，就拒绝回退，错误码 `REWIND_BEFORE_COMPACTION`，前端提示 `This message was compacted and can't be edited`。这条规则保留不变（见 00 D4）。

前端的编辑按钮由 `ConversationStream.tsx` 的 `editablePrompt`（L303–314）决定，条件是：用户消息、不是运行时输入、不是压缩分隔线、能找到对应的 prompt。它不检查“这条消息后面有没有压缩分隔线”。

这个缺口今天就存在：压缩会保留最近一段消息不压缩（`KEEP_RECENT_TOKENS`），这些消息排在摘要之前，界面上照常显示，也带编辑按钮，点了却报 `REWIND_BEFORE_COMPACTION`。方案 A 之后，压缩点之前的用户消息全都会显示出来，这个问题会变得很常见。

## 1.5 前端：分页触发

### 1.5.1 现在的历史区块

`apps/ohbaby-web/src/ui/conversation/ConversationStream.tsx` L788–820：

- 条件：`historyHasMore`、`historyStale` 或 `historyState === "error"` 任一为真时，在消息列表最上面渲染 `.ohb-history-more`（`role="status"`）。
- 内容：历史失效时显示 `Earlier history changed. Refresh to see the latest version.`；出错时显示错误文本；再加一个按钮，文案依状态是 `Loading history…`、`Refresh earlier history` 或 `Load earlier messages`。
- 点击：先把当前 `scrollTop` 和 `scrollHeight` 存进 `anchorRef`，关掉贴底跟随，再调用 `props.onLoadHistory()`。

样式在 `messages.css` L489–520，是一个圆角胶囊按钮（`border-radius: var(--radius-pill)`）。

### 1.5.2 滚动处理里没有分页

`onScroll`（L694 起）只负责判断贴底跟随，没有任何“接近顶部就加载”的逻辑。全项目只有 `BackgroundTaskList.tsx` L174 用过 `IntersectionObserver`。

### 1.5.3 已有的位置保持

L631–638 的 `useLayoutEffect` 在历史加载完成（`historyState` 不再是 `loading`）且消息变化后执行：

```ts
element.scrollTop = anchor.top + (element.scrollHeight - anchor.height);
```

也就是把新增内容的高度补到 `scrollTop` 上。`anchorRef` 只在点按钮时记录一次（L804），记的是点击那一刻的位置。请求没回来时用户又滚动了，恢复时会被拉回点击时的位置。

另一套机制按消息 id 记录阅读位置：`onScroll` 每次都把第一条可见消息的 id 和它到顶部的距离写进 `readingPosition`（L703–714），`ResizeObserver`（L736–760）在内容高度变化、且不贴底时，把这条消息挪回原来的距离。它跟着用户最后一次滚动走，不受请求发起时间的影响。自动加载应该以这套阅读行恢复为准，不再用 `anchorRef`，见 02 §2.5。

`onScroll` 所在的监听 effect 依赖是 `[readingPosition, props.onNearEnd]`（L734），监听函数里读到的其他 props 可能是旧的。新加的加载判断要通过 ref 读最新的 props。

### 1.5.4 数据层

| 位置 | 作用 |
| --- | --- |
| `apps/ohbaby-web/src/api/daemon/client-sync.ts` L629–671 的 `loadEarlierHistory` | 历史失效时用 `view.history.before` 作为游标重新拉，否则用上次的 `historyBefore`。调 `getSessionHistory`，再 `installSessionHistory`、`setHistoryState("ready")`。返回 `Promise<void>`，调用方分不出有没有进展：没有游标时（L632、L637）直接返回，状态不变；页因为过期被 store 丢弃时，状态同样回到 `ready`。失效了而视图又没有 `history.before` 时，会一直停在失效状态 |
| `apps/ohbaby-web/src/store/store.ts` L400–470 的 `setSessionSync` | 热视图里的每条消息都会复制进 `loaded`，被挤出热窗口的消息仍然留在前端。视图换代（`viewGeneration` 变化）且已经加载过历史时，标记 `historyStale`（L462–464） |
| 同上 L544–571 的 `invalidateSessionHistory` | 收到 `historyInvalidated`、且已经加载过历史时，把 `historyStale` 置真，并用 `view.history.before` 覆盖 `historyBefore`（L563–570） |
| 同上 L484–541 的 `installSessionHistory` | `historyStale` 为真时，先从 `loaded` 里删掉版本不新于这一页的条目，也就是把已经翻出来的旧页清掉，再装入这一页 |

后端在这些情况下会发 `historyInvalidated`（`source-session-projection.ts`）：删除消息（L313–316）、热窗口外的消息信息更新（L319–322）、热窗口外的 part 更新（L330–333）、推理保存或缺失（L426）、`trim` 把消息挤出热窗口（L583）。会话运行时，每条新消息都可能把一条旧消息挤出热窗口，所以这个标记很频繁。

这五种情况其实分两类。`trim` 的那一种只是把消息从实时视图挪进历史，内容没变，事件里带 `evictedMessageIds`；其余几种是旧消息真的变了，不带 `evictedMessageIds`。另外，`commitReasoning`（L385–432）不管这条消息在不在当前视图里，只要推理保存或缺失就发失效（L426）。消息在视图里时，改动已经随视图推给了前端，历史页里也没有这条消息，这次失效是多余的。用推理模型运行时，几乎每一步都会触发。

现在要点按钮才刷新，这个问题不明显。改成自动加载以后，运行中用户每次滑到顶部附近都会触发刷新：已经翻出来的旧页被清掉，只剩新拉的一页，视图会跳。

其实挤出窗口不需要清页：被挤出的消息已经在 `loaded` 里，之前翻出来的页也仍然有效。旧消息真被改了，清页重拉才是对的；视图换代时清页重拉也是对的，保留。所以这一层要小改，见 02 Stage 2 第 9 项。

断线重连还有一个缺口。重连、事件序号出现缺口、或者视图无法应用某个事件时，`session-sync.ts` 会把状态切到 `syncing`，重新拉一份视图（`resync`，L232 起）。断线期间漏掉的失效事件不会补发，`setSessionSync` 只在视图换代时才标记失效，所以已加载的页可能是旧内容。今天这个缺口被频繁的失效掩盖了；挤出窗口不再清页以后，就要在重新拉基线时补一个失效标记。

TUI 的 `packages/ohbaby-cli/src/tui/session-recovery.ts` L552–556 在失效时同样会清掉已加载的历史。TUI 不在本轮改动范围（00 D11）。

### 1.5.5 三个调用方

| 调用方 | 位置 | 说明 |
| --- | --- | --- |
| 主会话 | `ui/session/SessionConversation.tsx` L140–143 | 完整传入历史状态 |
| Side Chat | `ui/side-chat/SideChatPage.tsx` L198–201 | `historyHasMore={!boundaryLoaded && …}`，加载到边界后不再显示 |
| 子代理对话 | `ui/session/SubagentConversationBody.tsx` L122–125 | `historyStale` 固定为 `false` |

三处共用 `ConversationStream`，改一处就三处生效。

## 1.6 前端：空消息占位置

| 位置 | 现状 |
| --- | --- |
| `messages.css` L18–25 | `.ohb-stream-inner` 是 `display: flex; flex-direction: column; gap: 26px` |
| `ConversationStream.tsx` L824–829 | 每条消息都包一层 `<div data-message-id … hidden={…}>`，不管里面有没有东西 |
| `MessageRow.tsx` L40–46 | 只在 `reasoning === undefined && parts.length > 0 && visibleParts.length === 0` 时返回 `null`。`parts` 本身为空时，不返回 `null`，渲染一个空的 `<article>` |

flex 的 `gap` 对零高度的子元素同样生效，只有 `display: none` 的子元素不占间距。外层 div 带 `hidden` 时不占，但空壳消息不在 `hiddenIds` 里，所以每个空壳都多出 26px。

后端修好以后，压缩造成的空壳会消失，但空消息还有别的来源：只调用了隐藏工具的步骤（投影成 `parts: []`）、刚开始流式输出还没有内容的助手消息。所以前端这一层也要修。只有 todo 调用的消息不在其列，`ConversationStream` L147 的 `filterTodoToolMessages` 已经在列表层把它们去掉了。

外层 div 里除了 `MessageRow`，还挂着这条消息之后的耗时行、错误行和 prompt 错误（L872–874）。这些东西挂在消息 id 上，所以不能直接把空消息从数据里删掉，只能让“真正什么都没有”的那一层不占位置。

“Thinking”这一行由 `ExecutionProgress.tsx` 单独渲染，不在 `MessageRow` 里。空的流式助手消息返回 `null` 不会让它消失。

## 1.7 文档与实现对照

| 文档 | 位置 | 和本议题的关系 |
| --- | --- | --- |
| [Web 布局与样式](../../../ohbaby-web/redesign-2026-10/03-ui-layout-and-style.md) | L197 | 写的是“消息区顶部一个居中的细描边小胶囊 `Load earlier messages`，聊天和子代理详情里一样”。实施后要改 |
| [context 数据流与接口](../../../core/context/dfd-interface.md) | L158 | `time.compacted` 只控制活动投影，原文仍可读取。和方案 A 一致，不用改 |
| [Compact UI 边界计划](../../../superpowers/plans/2026-06-09-compact-ui-boundary.md) | 全文 | 历史计划，引入了这个过滤。不回改，由本议题说明推翻了哪一半 |
| [会话操作前端设计](../../2026-11-10-session-actions-frontend.md) | 第七节 | `REWIND_BEFORE_COMPACTION`、`FORK_TARGET_INVALID` 的文案。文案保留，不用改 |

## 1.8 测试现状与缺口

| 测试 | 位置 | 现状 | 方案 A 之后 |
| --- | --- | --- | --- |
| “投影时省略已压缩的 part” | `persistent-store.integration.test.ts` L785–843，L842 断言 `not.toContain("already compacted prompt")` | 固定了旧行为 | 断言要反过来 |
| 最终回答已压缩时不能分叉 | `copy-history.integration.test.ts` L453–457、L495–505 | 预期 `null` | 不变（只有 reasoning part） |
| 切到压缩点之前还原模型消息 | `copy-history.integration.test.ts` L667 起 | 通过 | 不变，是放开分叉的依据 |
| 压缩时间和切点在同一毫秒 | 无 | 无 | 要补，见 04 T5 |
| 回退到压缩点之前被拒绝 | `ui-persistent.integration.test.ts` L4268–4295、L4725–4760 | 通过 | 不变 |
| Web 历史加载 | `ConversationStream.unit.test.tsx` | 只传了 `onLoadHistory`，没有测按钮或加载 | 要补 |
| 失效时标记 `historyStale` | `store.unit.test.ts` L296 “marks history stale on invalidation …”、`session-recovery.integration.test.ts` L892 “restarts an invalidated history cache …” | 发的都是不带 `evictedMessageIds` 的失效，期望标记失效 | 不变。挤出窗口、重新拉基线的用例要补 |
| 推理保存时的失效 | 无 | 无 | 要补，见 04 T20 |
| 加载函数有没有进展 | 无 | 无 | 要补，见 04 T21 |
| 空消息不占位置 | 无 | 无 | 要补 |
| 主会话历史分页带已压缩原文 | 无 | 无 | 要补 |
| 压缩前用户消息不显示编辑 | 无 | 无 | 要补 |

## 1.9 SWE 视角

- **规则泄漏**：给模型的过滤规则被 UI 投影复用，两个关注点混在一个函数里。正确的做法是只在发给模型的那条路径上用 `isActivePart`。
- **补丁叠补丁**：子代理那两处“先清空 `compacted` 再投影”是在下游绕开上游的错误。把上游改对以后，这两处补丁就可以删掉，整体代码会变少。
- **改动可逆**：没有数据结构、接口或存储格式的变化，回滚就是把过滤加回去。
