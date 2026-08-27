# context improve-6 · seven-bucket occupancy breakdown（+ cache 通道移交）

> 状态：improve-6 占用分类已完成；后继 cache 累计与 `/status` 显示由 [session-cache-hit](../../../problem-lists/2026-08-27-session-cache-hit/README.md) 独立实施。
> 日期：2026-08-26
> 规划基线：`d82d213`
> 落点：`docs/core/context/improve-6/`
>
> 前序：[improve-4.1](../improve-4.1/README.md) 路线图第 5 项「context 占用监测与 UI」；[improve-5](../improve-5/README.md) 已冻结 cache usage 语义但未投影到 UI；[联合回归](../improve-4-to-5-regression/README.md) 已证明粗略占用条可见，不能当作 breakdown / cache 证据。

---

## 1. 一句话目标

让主代理窗口占用可解释：后端产出七类 composition，Web 用小环 + hover 粗信息 + click/`/status` 分类详情；TUI 的 Context 表达继续只显示现有总占用。Cache 命中率已移交独立 `promptCacheUsage` 通道，不改变本批 occupancy 语义。

## 2. 范围

### In scope（本批）

1. 主代理占用七类启发式 breakdown（见 [00](./00-discussion.md) 的 key / 英文显示名），单列 Summarized conversation 与 Subagent exchanges。
2. Web：状态栏小环 → hover 粗信息 → click 彩条详情（详情不含 cache；无 `7.1k / 1m` 常驻文本）。
3. Web `/status`：详细占用（本批不含 Cache 行）；TUI 底栏与 `/status` 均保持现有总量展示。
4. 后端测量从 step-local `ResolvedStepTools`（definitions + 实际 request tools）与可识别来源的 history 分桶；总量仍与现有校准占用对齐。
5. 02 写入关键改动清单（承重锚点，非全量文件表；cache 批次承重项单列 N1–N6）。

### 后继 cache 批次（独立实施）

- Cache：session aggregate 唯一显示口径（Cache-Read Share，分母含 cacheWrite）；run aggregate 只作原料；不完整轮跳过；Web/TUI `/status` 独立显示 `Cache hit {n}% / Cache hit —`；正式字段为 `promptCacheUsage`。实现与验收以 [session-cache-hit](../../../problem-lists/2026-08-27-session-cache-hit/README.md) 为准。

### Out of scope

- 子代理占用进入用户主 UI（子代理继续按 scope 内部计量/压缩）。
- 把 cache 画进占用彩条，或把命中理解成「不占窗口」。
- 精确 tokenizer、计费/价格。
- 改压缩阈值、cache 请求策略、Rules 独立层、Memory 独立占用行。
- 对话内再拆 user / assistant / 普通 tool result。
- TUI 状态栏 hover/click 展开。
- TUI 七类明细、ASCII 堆叠条或新 `/context` 命令；先由 Web 验证 composition 的可读性。

## 3. 文档地图

前后端分离；Web / TUI 分别设计。阅读顺序：README → 00 → 01 三篇现状 → 02 后端契约 → 02-web / 02-tui → 03 → 04。

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 已确认决策与边界 |
| [01-backend-current-state.md](./01-backend-current-state.md) | 计量、类型、事件现状 |
| [01b-web-current-state.md](./01b-web-current-state.md) | Web 顶栏与 `/status` 卡片现状 |
| [01c-tui-current-state.md](./01c-tui-current-state.md) | TUI dock 与 `/status` 面板现状 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 后端数据/协议契约与关键改动清单 |
| [02-web-ui.md](./02-web-ui.md) | Web 小环 / hover / click / `/status` 卡片 |
| [02-tui.md](./02-tui.md) | TUI 本轮保持总占用的明确延期契约 |
| [03-reference-projects.md](./03-reference-projects.md) | Cursor / dsh / claude-code-best / Codex / kimi-code |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 测试与验收 |
| `05-implementation-acceptance.md` | 实施完成后由验收模式写入 |

## 4. 与既有文档关系

| 文档 | 关系 |
|------|------|
| [improve-4](../improve-4/README.md) | 曾把占用三类 UI 推迟；本批在后端/Web 落地，分类扩为七类英文 key |
| [improve-4.1](../improve-4.1/README.md) | 本批是其路线图第 5 项；静态/手动 tools-aware 计量已还清 |
| [improve-5](../improve-5/README.md) | cache 语义与 `observed` 不变量由后继 session-cache-hit 批次投影到 `/status`；公式不改 |
| [goals-duty.md](../goals-duty.md) | cached input 仍占窗口；子代理自身窗口/child transcript 不进主占用 UI，父窗口 exchanges 仍按七类规则计入 |
| [architecture.md](../architecture.md) | occupancy composition 与独立 cache 通道保持分家 |

## 5. 实施入口

improve-6 occupancy 已按 02 + 02-web + 02-tui + 04 完成。后续不要在本目录继续扩展 cache；session 累计、生命周期和 Web/TUI `/status` 验收统一进入 [session-cache-hit](../../../problem-lists/2026-08-27-session-cache-hit/README.md)。
