# 2. 优化方案与改动面

> 给后续开发会话的执行契约。本规划会话不写代码。

## 2.1 方案总览

Web 的 `message.part.delta` 记账改成与 TUI / `run-stream-adapter` 同一条规则：**只有 `parts` 最后一个元素已经是 `text`，才把新字写进去（`content` 整段替换该段，否则把 `delta` 接在后面）；否则在数组末尾新开一段 text。** 缺 `messageId`，或稳定 `messageId` 对应消息尚不存在的 delta，不再创建本地消息。工具卡的 React key 改为按 part 身份，避免定稿重排时复用错实例。

不增加事件、不抽 sdk。后端已经对；Web 抄作业并补测试。

```text
delta 到达
  → 无 messageId → 忽略（不造 streaming: 幽灵）；seq 仍前进
  → 有 messageId 但列表尚无该条 → 忽略（生产者保证先 appended；视为事件缺口）；seq 仍前进
  → 当前 producer 不发 partId，UiMessagePart 也无 id：尾部是 text ？ 写入该段 ： append 新 text 段
message.updated
  → 仍整表 upsert（现逻辑）；不再依赖它来「纠正」被写错的前言
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| 改哪一层 | Web reducer | 漂移只在 Web | 后端每次文字都发 `message.updated` | 更闪、更大 SSE |
| 与 TUI 共享代码 | 本批不抽包 | YAGNI（00） | 立刻抽 sdk reducer | 空架子、跨包评审 |
| 无 messageId | 丢弃，不造 `streaming:` | 00；现直播几乎都带 id | 缓冲到 message.appended | 状态机复杂、收益小 |
| 有 messageId 但消息尚不存在 | **丢弃，不建草稿** | producer 先写 store/发 appended，再发 delta；建草稿会掩盖事件缺口 | 保留 Web 特有容错草稿 | 畸形/旧 producer 的孤立 delta 会丢失 |
| key | 交互型 tool 用 call id；无本地 state 的 text/reasoning 暂用类型内序号 | tool 的展开态必须跟随真实调用 | 继续全用 index | text/reasoning 尚无协议级稳定身份 |
| 直播一条气泡 vs 刷新多条 | 不改 | 00 明确不做 | 按 DB 一轮一条改 adapter | 变成另一场重构 |

不可逆决策：**无。** 全是可逆前端投影。

## 2.3 分阶段实施

三笔 commit，顺序固定。每笔可独立验证、可单独 revert。

### Phase A · 尾部 text 记账（主修复）

- **目标**：工具夹层时，最终回答另起一段，不再覆盖前言；定稿不再因此跳顺序。
- **改动文件**
  - `apps/ohbaby-web/src/api/daemon/eventReducer.ts`：重写 `upsertTextPart`（或拆成与 TUI 同名的 `findTailTextPartIndex` / `upsertLastTextPart` / `appendDeltaToLastTextPart`）。`content` 有值时整段替换尾部 text；只有 `delta` 时追加。语义对齐 `packages/ohbaby-cli/src/tui/store/events.ts` 的 `applyPartDelta` 在 **无 partId** 时的分支。
- `apps/ohbaby-web/src/api/daemon/eventReducer.unit.test.ts`：至少搬 TUI 的「工具结果之后的文字另起一段」；再加无前言纯工具后出字、两轮工具（第二轮字不进第一段）。
- 用完整生产顺序写 characterization：`message.appended → message.updated(tool) → message.part.delta → message.updated(final)`；同时保留纯 `[tool, result] → delta` 负对照，防止把现场泛化成错误根因。
- **DoD**：04 场景 TO-1、TO-2、TO-3、TO-6、TO-8 单测绿。手工：先工具后字，流式过程卡片在上。

### Phase B · 停止为不可定位 delta 造消息

- **目标**：缺 id 或找不到目标消息的 delta 都不另开气泡/草稿；事件游标照常推进。
- **改动文件**
  - `eventReducer.ts`：`applyMessageDelta` 在 `messageId` 缺失，或列表里找不到对应消息时返回原 messages；不使用 `streaming:${sessionId}`，也不使用稳定 id 创建草稿。
  - seqNum 仍由 `reduceUiEvent` 前进，忽略 delta 时也不可卡住游标。
  - Web 本批选择**静默丢弃**，不新增 transcript notice：正常 producer、snapshot 与 resync 已保证消息先存在；为罕见协议缺口新造可见消息会重新引入投影实体。若真实轨迹证明缺口频繁，再单独设计 resync/notice。
  - `finalizeMessage`：可保留对 `streaming:${sessionId}` 的 filter，作为旧缓冲/重放的防御。
  - `eventReducer.unit.test.ts`：把「无 id → 造 `streaming:session_1`」改成「无 id → 不增加消息」；有 id 但消息尚不存在也不增加消息；两者都断言 seq 前进。可选：ViewState 里若已有旧占位，`message.updated` 仍清掉。
  - 同步 Web 权威文档：`data-model.md`、`dfd-interface.md`、`use-case.md` 均改为 StreamingMessage 由 snapshot / `message.appended` 建立、delta 只更新既有消息；`test.md` 写明纯文字累积的 appended 前置。
- **DoD**：04 TO-4、TO-4b、TO-7。正常 run 不再出现 `streaming:` 第二气泡或孤立稳定 id 草稿。

### Phase C · MessagePart key

- **目标**：parts 重排不把折叠状态粘到错卡。
- **改动文件**
  - `apps/ohbaby-web/src/ui/App.tsx`：`key` 不用 `` `${message.id}-${index}` ``。要求：
    - `tool-call` → `tool-call:${call.id}`
    - `tool-result` → `tool-result:${result.callId}`
    - `text` / `reasoning` → `${type}:${该类型在本消息内的序号}`（协议暂无 part id；这些节点当前无本地交互 state，只称“确定性 key”，不宣称稳定 part 身份）
  - `App.unit.test.tsx`：必测交互型工具卡：打开 call A，rerender 交换 A/B 顺序，展开态仍跟随 call A；grep 旧 index key 只作补充。
- **DoD**：04 TO-5。定稿时卡片不「闪成别的工具」。

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `apps/ohbaby-web/src/api/daemon/` | 无 | `eventReducer.ts` 及其 unit test | 无 | 核心 |
| `apps/ohbaby-web/src/ui/` | 无 | `App.tsx` key；可能 `App.unit.test.tsx` | 无 | Phase C |
| `docs/ohbaby-web/` | 无 | `data-model.md`、`dfd-interface.md`、`use-case.md`、`test.md` | 无 | 同步权威生命周期/投影流/用例/测试前置 |
| 其它包 | 无 | 无 | 无 | |

## 2.5 API / 协议 / 迁移与兼容

- **不改** `UiEvent` / SSE 字段。
- 旧 session 刷新走 snapshot，不依赖本 reducer 的历史错误 parts。
- 进行中的 run：用户硬刷新会 resync，以 snapshot 为准。
- 无数据迁移。

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 只改 Web、漏掉 `content` vs `delta` 分叉 | 单测同时覆盖有 `content` 的快照替换和纯 `delta` 追加 | revert Phase A commit |
| 丢弃不可定位 delta 导致旧 producer 丢字 | 当前 adapter 保证 appended 先于 delta；04 加完整事件序列与真实轨迹核对。若生产可重复出现缺消息，再单独设计 resync/notice | revert Phase B |
| key 在并行两个同 type text 时碰撞 | 用类型内序号；同消息内稳定 | revert Phase C |
| 跟滚在顺序修正后跳动 | 不改滚动代码；stick 仍看高度。若异常记入失败呈现之外的跟滚议题 | 与本批无关 |

## 2.7 与 00 边界对齐检查

| 00 结论 | 02 落点 |
|---------|---------|
| 只改 Web 记账 | §2.3 A/B，无 agent/cli |
| 幽灵消息/缺失消息草稿丢掉 | Phase B |
| 下标 key 一起收 | Phase C |
| 不抽 sdk | §2.2 |
| 不改后端事件 | §2.5 |
| 不修一条/多条气泡 | §2.2 放弃项 |
| 三笔 commit | Phase A/B/C |
| 分支与失败呈现顺序 | README；实施会话先完成本 02 再打开失败呈现 02 |

## 2.8 不在本批

- 工具卡配对、bash UI failed、callId 皮肤、改 `ToolPanel` 标题 → `2026-08-18-web-tool-failure-presentation`（本批最多改 MessagePart 的 **key**）
- sdk 共享 `applyPartDelta`
- 当前批为 delta 增加/消费稳定 partId（producer 当前不发，`UiMessagePart` 也无 id）
- 改 `run-stream-adapter` 在文字后补发 `message.updated`
- TUI 代码
- lifecycle 每轮一条 vs UI 合成一条
