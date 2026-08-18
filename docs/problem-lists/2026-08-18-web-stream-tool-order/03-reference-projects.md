# 3. 参考项目借鉴

> 参考只用于校验方向，不扩大本批改动面。当前实施仍以 `02 + 04` 为准。

## 3.1 OpenCode：part 有稳定身份，delta 精确命中

OpenCode 的 `message.part.updated` / `message.part.delta` 都携带 `part.id` / `partID`；客户端按 `messageID + partID` 查找并更新目标 part，渲染 key 也来自稳定 `part.id`，不需要猜“最后一个 text 是谁”。

代码锚点：

- `../opencode/packages/app/src/context/global-sync/event-reducer.ts`：`message.part.updated` / `message.part.delta`
- `../opencode/packages/session-ui/src/components/message-part.tsx`：`groupParts` 的 `part:${messageID}:${part.id}`

**本批借鉴**：React key 必须表达 part 身份；delta 不能倒序寻找任意旧 text。

**本批不照搬**：不给 `ohbaby-sdk` 的所有 `UiMessagePart` 加 id。该改动会同时触及 producer、snapshot、TUI、Web 与兼容策略，当前证据只需要局部可逆修复。

## 3.2 Kimi：单一收敛路径 + frameId/offset

Kimi transcript 把 text/tool 作为带 `frameId` 的稳定 frame；增量 append 明确携带目标 `frameId` 与 `offset`。offset 超过本地长度、重复片段不一致时返回 gap，由调用方决定重新 snapshot，而不是在客户端创建一个猜测实体。

代码锚点：

- `../kimi-code/packages/transcript/src/model/frame.ts`：`TextFrame` / `ToolCallFrame`
- `../kimi-code/packages/transcript/src/ops/operation.ts`：`FrameUpsertOp` / `AppendOp`
- `../kimi-code/packages/transcript/src/ops/apply.ts`：`applyFrameUpsert` / `applyAppend`

**本批借鉴**：缺目标消息属于收敛 gap，不应被 Web 草稿静默掩盖；live 与 snapshot 应走同一种可解释的投影语义。

**后续演进触发条件**：若事件轨迹证明“同一 message 内多 text 并行增量”或缺消息/缺 part 事件在生产中合法且频繁，再单独规划稳定 partId + gap/resync 协议。没有该证据前不升级协议。

## 3.3 内部标准答案：ohbaby-cli

TUI `packages/ohbaby-cli/src/tui/store/events.ts` 已执行两条目标语义：只续写尾部 text；稳定 id 找不到消息时丢弃并给 warning。本批 Web 对齐其结果语义，不抽共享 reducer。
