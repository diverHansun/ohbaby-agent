# 1. 问题基线与当前实施状态

> 时间口径：2026-08-18；本章保存实施前基线，完成状态与证据见 [`05-implementation-acceptance.md`](./05-implementation-acceptance.md)。基线以 `apps/ohbaby-web/src/api/daemon/eventReducer.ts`、`apps/ohbaby-web/src/ui/App.tsx` 与 TUI `packages/ohbaby-cli/src/tui/store/events.ts` 为准。

---

## 1.1 问题陈述

1. **流式过程中工具卡垫在最终文字下面**：在「前言 → 工具 → 结论」路径，新结论覆盖旧前言，用户看到结论在工具上方。
2. **定稿时卡片跳回上方**：`message.updated` 用后端正确的 `parts` 整表覆盖 Web 本地账，视觉上像「跳」。
3. **无 messageId 的 delta 会另造一条助手消息**（`streaming:${sessionId}`），上面打字、下面才是工具，定稿再合并。
4. **列表 key 用数组下标**：`parts` 重排后折叠状态会粘错卡，加重跳感。
5. **TUI / 后端已经按「只改尾部 text」记账**，Web reducer 未对齐，且缺少对等测试。
6. **根因边界需守住**：纯「工具 → 文字」且 parts 中没有旧 text 时，当前 Web 会把文字 append 在工具后；真实现场若仍错位，需要事件轨迹证明是另一条路径。

## 1.2 已确认的产品/技术分界

引用 `00-discussion.md`：

- 只改 Web 投影与 key；SSE 载荷不动。
- 缺 `messageId`，或有 id 但目标消息不存在：丢弃，不造幽灵消息/本地草稿。
- TUI 不动。失败呈现另立 problem-list。
- 不修「直播一条气泡 / 刷新多条气泡」。

```text
后端 / TUI：最后一行已是 text → 续写；否则另起一行
Web 现状：倒着找任意一段 text → 把新结论写进去（常写进工具前面的前言）
定稿：message.updated 整表盖上后端 parts → 卡片跳回
```

## 1.3 ohbaby-web 现状

### 1.3.1 goals-duty

[`docs/ohbaby-web/goals-duty.md`](../../ohbaby-web/goals-duty.md)：Web 是 daemon 状态的投影（G1），事件投影是职责 D2，且 G3 要求与 TUI 行为一致。

**缺口**：D2 的 `eventReducer` 对 `message.part.delta` 的 parts 记账与 TUI 不一致，直播时间线与真实顺序相反，违反 G3。

### 1.3.2 architecture

[`docs/ohbaby-web/architecture.md`](../../ohbaby-web/architecture.md)：`eventReducer` 是纯 `(event, state) → state`，被定为「最易出错逻辑（流式累积、顺序、resync）的可单测内核」。视图按 `UiMessage.parts` 数组顺序画，不自己排序。

**现状**：顺序错误发生在 reducer，不在 CSS。`ConversationStream`（`App.tsx`）只 `map` `visibleParts`。

代码锚点：

- 视图顺序：`apps/ohbaby-web/src/ui/App.tsx` `MessageRow` / `visibleParts.map`
- 投影：`apps/ohbaby-web/src/api/daemon/eventReducer.ts` `applyMessageDelta` / `upsertTextPart` / `finalizeMessage`

### 1.3.3 data-model

[`docs/ohbaby-web/data-model.md`](../../ohbaby-web/data-model.md) 定义 StreamingMessage：delta 累积，直到 `message.updated` 定稿。SDK `UiMessage.parts` 是有序数组，类型为 text / reasoning / tool-call / tool-result（`packages/ohbaby-sdk/src/snapshot.ts`）。

**gap**：模型有顺序，但 Web 把「当前轮完整 `content`」写进**任意**最后一段 text，而不是「数组尾部的 text」。`content` 在 lifecycle 里是**本步 LLM 文本快照**，不是整条消息拼接。

### 1.3.4 dfd-interface

```text
lifecycle llm:delta
  → stream-bridge message.part.delta { content, delta }
  → run-stream-adapter：upsertTextPart（只改尾部 text）+ 发布 delta（不发 message.updated）
  → SSE ui.event
  → Web applyMessageDelta → upsertTextPart（倒着找任意 text）  ✗
  → store → ConversationStream 按 parts 下标渲染

工具路径：
  run.tool.start / result → adapter appendToolCall/Result → message.updated（整表 parts）
  → Web finalizeMessage 整表替换（此时顺序对）
  → 随后最终回答只有 delta → 又被 Web 写进旧 text
  → run 结束 completeAssistantMessage 再发 message.updated → 跳回
```

代码锚点：

- 后端尾部规则：`packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts` `upsertTextPart`（约 116–134 行，只看 `parts.at(-1)`）
- 直播 delta 不发整表：同文件 `handleMessageDelta`（`publishUpdate: false`）
- Web 任意 text：`eventReducer.ts` `upsertTextPart`（约 544–568 行，从尾向前找 `type === "text"`）
- 无 id 造幽灵、有稳定 id 但缺消息时造草稿：`applyMessageDelta` 使用 `event.messageId ?? \`streaming:${sessionId}\``，随后无条件构造 `current`
- 定稿删幽灵：`finalizeMessage` 在新 id 不是 streaming 占位时 filter 掉 `streaming:${sessionId}`
- 已有测试只覆盖「无 id 的 delta 造占位、定稿用稳定 id 删掉」：`eventReducer.unit.test.ts`（`removes the anonymous streaming placeholder…`），**没有**「工具之后另起文字」或「纯工具开头负对照」用例

生产者顺序证据：`run-stream-adapter.ts` `ensureAssistantMessage` 先写 state store 并发布 `message.appended`（约 271–307 行），`handleMessageDelta` 在 `updateAssistant` 完成后才发布 `message.part.delta`（约 374–390 行）。正常 producer path 不存在“稳定 id 的 delta 合法早于 appended”的首包竞态。

### 1.3.5 use-case

主路径：用户发 prompt → assistant 可能前言 → 并行/串行工具 → 最终回答。Web 在「工具已在 parts 中、最终回答开始流，且前面已有 text」这一段撒谎。多轮工具时，后一轮 `content` 会覆盖第一段前言，时间线更乱。

负对照：若 parts 只有 `[tool-call, tool-result]`，现 `upsertTextPart` 找不到任何 text，会 append 新 text，得到 `[tool-call, tool-result, text]`。这条路径本身不支持“所有先工具后文字都会错位”的泛化结论。

### 1.3.6 non-functional

不引入新网络或存储。错误记账会让用户误判模型是否先规划再动手（正确性 / 可信度）。`MessagePart` key 位于 `apps/ohbaby-web/src/ui/App.tsx` 的 `MessageRow` parts 映射（当前主干约 1856 行；以符号与表达式为准），现为 `` `${message.id}-${String(index)}` ``：parts 重排时 React 复用错误实例，折叠态错位。

### 1.3.7 test

[`docs/ohbaby-web/test.md`](../../ohbaby-web/test.md) 关键场景写了「多个 `message.part.delta` 顺序累积、`message.updated` 定稿不错位」，但现单测只有纯文字累积和幽灵占位，**没有工具夹在中间**。

TUI 已有对等测试：`packages/ohbaby-cli/src/tui/store/events.unit.test.ts`「appends direct text deltas after a tool result instead of replacing earlier text」。Web `eventReducer.unit.test.ts` 无对应项。其现有纯文字累积测试从空 snapshot 直接发送稳定 messageId delta，并依赖 reducer 建草稿；Phase B 后必须先发 `message.appended`，不能只新增 missing-message 测试而漏改旧用例。

项目测试规则见 `docs-test/`（unit colocated）。本议题以 unit 钉死 reducer 即可，不上 e2e。

## 1.4 ohbaby-cli（对照，非改动模块）

TUI `applyPartDelta`（`packages/ohbaby-cli/src/tui/store/events.ts`）：

- 有 `partId` 且命中则改该 part。
- 否则：有 `content` → `upsertLastTextPart`；只有 `delta` → `appendDeltaToLastTextPart`。
- `findTailTextPartIndex`：**仅当最后一个 part 的 type 是 text** 才返回该下标，否则 `-1`（另起一段）。
- 当前 session 缺 messageId 对应消息：丢 delta 并 warning notice，不造消息。

后端 adapter 的 `upsertTextPart` 与 TUI 尾部规则同构。Web 是唯一漂移消费者。

## 1.5 跨模块一致性

| 点 | 后端 adapter | TUI | Web |
|----|--------------|-----|-----|
| 尾部才续写 text | 是 | 是 | **否**（任意最后一段 text） |
| 无 messageId | 直播路径总会带 id | 丢弃 + 警告 | **造 `streaming:` 消息** |
| 有 messageId 但消息尚不存在 | 先 appended 再 delta | 丢弃 + 警告 | **用该 id 建草稿，掩盖事件缺口** |
| 工具事件 | `message.updated` 整表 | 整表替换 | 整表替换（短暂正确） |
| 最终文字 | 只发 delta | 尾部 append | 写进旧 text |

协议（`ohbaby-sdk` `UiMessagePartDeltaEvent`）允许缺 `messageId` / `partId`。Web 把缺 id 当成「匿名流」，TUI 当成「不可用」。00 要求 Web 去掉匿名流，并且不再为缺失的稳定消息造草稿；事件游标仍前进，避免畸形事件卡住后续正常事件。

**已知不做**：lifecycle 每轮 `createMessage`，UI adapter 整 run 合成一条 `assistantMessageId`。刷新后 snapshot 可能多条 assistant。与乱跳不同，00 明确本批不碰。

## 1.6 改动影响面（现状视角）

| 区域 | 会动？ | 说明 |
|------|--------|------|
| `apps/ohbaby-web/src/api/daemon/eventReducer.ts` | 是 | 核心 |
| `apps/ohbaby-web/src/api/daemon/eventReducer.unit.test.ts` | 是 | 补场景 |
| `apps/ohbaby-web/src/ui/App.tsx` | 是 | MessagePart key |
| `apps/ohbaby-web/src/ui/App.unit.test.tsx` | 可能 | 若有依赖幽灵 id / 下标 key 的断言 |
| `ohbaby-agent` / `ohbaby-cli` / `ohbaby-sdk` | 否 | 本批不改 |

## 1.7 SWE 原则审视摘要

- **偶然复杂度**（00 哲学）：问题本质是「两种事件（delta 补丁 vs 整表更新）合进有序 parts」。Web 自造第三套记账规则，是偶然复杂度。
- **重复且漂移**（03 DRY 护栏）：TUI 与 Web 各写 reducer。本批**不抽共享包**（YAGNI，00 已确认）；用测试把 Web 钉在 TUI 语义上，避免错误抽象。
- **错误处理可见**（06）：缺 id 的 delta 不应默默另开气泡；丢弃比造幽灵更可预测。
- **可逆**：纯前端投影，可按 commit 回滚。
- **可观测性残余**：本批不新建一套前端诊断状态；真实异常 run 用事件轨迹核对。若缺消息事件在生产中可重复出现，再单独设计 resync/notice，而不是 reducer 静默造实体。

## 1.8 与既有文档关系

| 文档 | 关系 |
|------|------|
| ohbaby-web architecture / data-model / test | architecture 仍有效；data-model 的“首个 delta 创建 StreamingMessage”与已确认策略冲突，实施时改为 appended/snapshot 创建；test 补「工具夹层」与 appended 前置 |
| 2026-07-13 web-stream-scroll | 跟滚；parts 顺序变了高度仍变，不改滚动契约 |
| 2026-08-18 web-tool-failure-presentation | 姊妹；本批不处理失败皮肤 |

### 文档 vs 实现

| 文档说 | 代码做 | gap |
|--------|--------|-----|
| test.md：delta 累积 + updated 定稿不错位 | 纯文字路径大致对；工具夹层会把结论写进前言 | 缺夹层测试，实现错 |
| data-model：StreamingMessage 按顺序拼接 | 无 id 时用 `streaming:sessionId` 另开实体 | 与 TUI 不一致；00 要求改为丢弃 |
| G3 与 TUI 一致 | 同协议两套记账 | 本批对齐 Web |
