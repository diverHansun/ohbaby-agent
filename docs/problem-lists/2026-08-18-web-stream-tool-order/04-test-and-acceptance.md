# 4. 测试与验收标准

> 项目测试规则：`docs-test/`（unit colocated，`*.unit.test.ts`，root Vitest）。Web 场景约定见 [`docs/ohbaby-web/test.md`](../../ohbaby-web/test.md)。本议题**不要求 e2e / Playwright**；风险在纯 reducer。

## 4.1 测试范围

| 类型 | 覆盖 | 不覆盖 |
|------|------|--------|
| unit | `eventReducer` 的 delta 记账、无 id 行为；可选 App key 不崩溃 | 真 daemon、真 LLM |
| 手工 | 一次真实「先工具后回答」的浏览器对话 | 像素级视觉 |

定向命令（实施会话在仓库根执行）：

```bash
pnpm exec vitest run apps/ohbaby-web/src/api/daemon/eventReducer.unit.test.ts
pnpm exec vitest run apps/ohbaby-web/src/ui/App.unit.test.tsx
```

完整发布门另跑 `pnpm test:unit`。仓库的 `test:unit` 包装脚本会枚举全部 unit 文件，不支持在 `--` 后用路径缩小范围。

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 对应 02 Phase |
|----|------|------|--------|----------------|
| TO-1 | 前言 + 工具 + 结论 | unit | parts 为 `[text 前言, tool-call, tool-result, text 结论]`；结论 `content` **不**覆盖前言 | A |
| TO-2 | 无前言，先工具后字（负对照） | unit | 先 `message.updated` 带工具，再 delta；文字在工具之后；证明该形状当前/修后都不是旧 text 覆盖根因 | A |
| TO-3 | 两轮工具 | unit | 第二轮 `content` 是新的尾部 text，第一段前言仍在 | A |
| TO-4 | delta 无 `messageId` | unit | messages 条数不变，不出现 `streaming:${sessionId}`；`lastAppliedSeqNum` 仍前进 | B |
| TO-4b | delta **有** `messageId` 但列表尚无该消息 | unit | messages 不变、不建稳定 id 草稿；`lastAppliedSeqNum` 仍前进 | B |
| TO-5 | 工具 key 保持交互身份 | unit + 代码审查 | 打开 call A，rerender 交换 A/B 顺序后展开态仍跟随 A；tool key 使用 callId，不是数组 index；text/reasoning 只要求确定性 key | C |
| TO-6 | 纯文字多 delta | unit | 先 `message.appended` 建空 assistant，再发 `hel` / `lo` delta；回归连续 delta 拼成一段 `hello` | A |
| TO-7 | `message.updated` 定稿 | unit | 现有「稳定 id 替换」仍成立；若仍保留幽灵 filter，旧占位会被清 | B 防御 |
| TO-8 | 完整 producer 顺序 | unit | `appended → updated(tool) → delta → updated(final)` 全程顺序稳定，定稿前后 parts 语义一致 | A/B |
| TO-9 | 真实异常 run 事件轨迹 | 现场归因证据（非 merge blocker） | 能复现时在 DevTools Network 选 `/v1/events` 流，摘录相关 `seqNum/type/messageId/partId/parts 类型摘要`，不得保存 Authorization/用户正文；可写入本目录 `artifacts/<date>-event-trace.md`。若轨迹不支持旧 text 覆盖，只能说明本批不得宣称覆盖该现场形状，不否定 TO-1–TO-8 已证明的 reducer 修复 | 发布说明 |

TO-1 应对齐 TUI `events.unit.test.ts` 中「appends direct text deltas after a tool result instead of replacing earlier text」的断言形状。

## 4.3 集成边界

本批不跨进程。唯一边界是 **SSE 已变成 `UiEvent` 之后** 的 Web 投影。`run-stream-adapter` 本批不改；04 不要求重跑 adapter 测试，但手工路径依赖它继续发带 `messageId` 的 delta。

## 4.4 回归清单

- 无工具的纯流式回答：文字仍递增，无空白新气泡。
- `message.updated` 定稿后 markdown 替换 `pre`（现 `MessagePart` 行为）仍发生。
- 跟滚（`.ohb-stream` stick）：不作为本批开发项，但手工时应仍贴底。
- todo 工具过滤（`filterTodoToolParts`）不受 key / 记账影响。
- 无 id 事件仍推进 `lastAppliedSeqNum`（不可因 return 早而卡住游标——实现必须在 `reduceUiEvent` 层照常写 seq）。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| 定向单测 | TO-1–TO-8 全绿 | 上节命令 |
| 全量单测 | `pnpm test:unit` 通过 | 仓库根执行 |
| 现场归因 | TO-9 有则写入发布说明；抓不到轨迹不阻塞合并，轨迹不支持当前根因时不得宣称覆盖该现场 | 可选 `artifacts/<date>-event-trace.md` |
| 肉眼 A | 先调 `list`/`bash` 再出结论：流式过程卡片在字上，结束不跳 | 浏览器 `ohbaby serve` |
| 肉眼 B | 有前言时三截顺序稳定 | 同上 |
| 幽灵 | 正常 run 不应出现 id 为 `streaming:` 的气泡 | React 调试或 DOM |
| key | 代码无 `` `${message.id}-${String(index)}` `` 作为 MessagePart key | grep |
| 范围 | git diff 不含 `ohbaby-cli` / `run-stream-adapter` / sdk 事件类型 | `git diff --stat` |

## 4.6 对抗性审查要点

1. **`content` 是本轮快照不是全文**：若实现做成「始终 append delta、忽略 content」，会和 adapter 的整段替换打架。防御：有 `content` 时替换尾部 text 整段。残余：后端若某次只发 delta 不发 content，走追加分支。
2. **找不到 messageId / 目标消息**：两者都丢，且 seq 继续前进。依据是 producer 已保证 appended 先于 delta；残余风险是旧 producer 的孤立 delta 会丢字，优于静默造出错误实体。若真实轨迹证明该事件合法出现，应先设计 resync/缓冲协议再改口径。
3. **seq 卡住**：忽略 delta 时若忘记让 `lastAppliedSeqNum` 前进会永久丢后续事件。防御：忽略发生在 apply 内部，`reduceUiEvent` 仍写 seq。测试 TO-4 应断言 seq 已前进。
4. **并行两个 text 段**：规则只认数组尾部。若错误地把 text 插到中间，后续 delta 会写错段。防御：本批只 append 到末尾或改尾部，不插入中间。
5. **失败呈现尚未做**：验收时仍可能看到 `result ${callId}` 双卡——那是下一议题，**不得**当成本批失败。
6. **把负对照误当成主根因**：TO-2 必须保留；真实「纯工具先发生却仍错位」若无法由旧 text/缺消息解释，不得宣称本批已覆盖。
