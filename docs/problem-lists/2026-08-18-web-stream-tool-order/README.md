# Web 工具卡片流式时序（parts 顺序乱跳）

> 状态：**代码实施与自动化验收完成，待肉眼验收。** 详见 [`05-implementation-acceptance.md`](./05-implementation-acceptance.md)。  
> 实施 git 分支（与失败呈现共用）：`codex/web-tool-transcript`。  
> **本分支上先做本议题的全部 commit，再做** [`../2026-08-18-web-tool-failure-presentation/`](../2026-08-18-web-tool-failure-presentation/README.md)。

## 1. 议题

Web 对话在「前言 → 工具 → 结论」时，流式过程中工具卡片会垫在最终文字下面；等 run 定稿，卡片才跳回文字上方。根因是 Web `eventReducer` 把新文字写进了工具前面的旧 text part，和后端 / TUI 的「只改小票最后一行」规则不一致。纯「工具 → 文字」且没有旧 text 的负对照当前不会错位；若真实现场仍出现该形状，必须用事件轨迹核对是否存在极短前言、缺失消息实体或匿名 delta。同批收掉两条亲戚：缺少可定位消息时造本地草稿/`streaming:${sessionId}` 幽灵消息、以及用数组下标当 React key。

本批只改 **ohbaby-web 对 `message.part.delta` 的投影与列表 key**。不改 SSE 事件形状、不改 TUI、不改工具失败皮肤（那是下一份 problem-list）。

## 2. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 冻结已确认的产品行为与边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 以当前代码为基线的问题与根因 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 实施契约：方案、改动面、分阶段 DoD |
| [03-reference-projects.md](./03-reference-projects.md) | OpenCode / Kimi 的稳定 part 身份与增量收敛做法 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 单测、手工验收与发布门 |
| [05-implementation-acceptance.md](./05-implementation-acceptance.md) | 实施结果、自动化证据与剩余手工验收 |

推荐阅读顺序：`00 → 01 → 02 → 03 → 04`。实施以 `02 + 04` 为准；与 `00` 冲突时先改文档再改代码。

实施结果与验收证据统一写入 `05-implementation-acceptance.md`。

## 3. In scope

- Web `upsertTextPart` 与 TUI / `run-stream-adapter` 使用同一条「只改尾部 text」规则。
- 缺少 `messageId`，或稳定 `messageId` 对应消息尚不存在的 delta，均不创建本地草稿；事件游标仍前进。
- 实施时同步 Web 权威文档：StreamingMessage 由 snapshot / `message.appended` 建立，delta 只更新既有消息。
- `MessagePart` 列表 key 不用全局数组下标。
- 针对性 unit 测试（把 TUI 已有场景搬到 Web reducer）。
- 一次真实异常 run 的事件轨迹核对；不把所有「工具先发生」现象都未经证据归因到旧 text 覆盖。
- 三个逻辑阶段均在共用临时分支 `codex/web-tool-transcript` 上先于失败呈现实施。

## 4. Out of scope

- 工具调用/结果配对、失败红卡、bash `failed` 投影 → [失败呈现](../2026-08-18-web-tool-failure-presentation/README.md)。
- 抽取 sdk 共享 reducer / 共享 UI 包。
- 改 `message.part.delta` / `message.updated` 的后端载荷。
- 改 TUI（本批只当标准答案）。
- 修「直播合成一条 assistant 气泡、刷新后按 DB 一轮一条」的结构差。
- 虚拟列表、markdown 性能、跟滚（已有独立 problem-list）。

## 5. 与现有文档的关系

| 文档 | 关系 |
|------|------|
| [ohbaby-web](../../ohbaby-web/README.md) | Web 仍是 daemon 投影；本批修投影正确性，不改连接模型 |
| [ohbaby-web architecture](../../ohbaby-web/architecture.md) | `eventReducer` 仍是纯函数内核；本批修正其对 delta 的 parts 记账 |
| [ohbaby-web test](../../ohbaby-web/test.md) | 已要求「delta 累积 + `message.updated` 定稿不错位」；现状未覆盖「工具夹在文字中间」 |
| [web-stream-scroll](../2026-07-13-web-stream-scroll-and-composer-placeholder/README.md) | 跟滚议题；本批改 parts 顺序后跟滚仍应贴底，不重做滚动 |
| [失败呈现](../2026-08-18-web-tool-failure-presentation/README.md) | 姊妹议题；同一 git 分支、本批 commit 全部完成后再做 |

## 6. 开发闸门

1. [x] 用户审阅并确认本目录 00–04。
2. [x] 按 02 完成 Phase A（记账规则）、B（幽灵消息）、C（key）。
3. [ ] 按 04 完成验收：自动化已通过，真实浏览器肉眼项待执行。
4. [ ] 独立验收会话对照 02/04 出具结论（可选）；写入 `05-implementation-acceptance.md`。
