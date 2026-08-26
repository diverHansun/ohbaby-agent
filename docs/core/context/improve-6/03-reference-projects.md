# 3. 参考项目借鉴

> 调研路径均在 `/Users/hansunwork26/workspace/projects/code-cli/`。Cursor 占用面板来自用户截图，无本地源码。

## 3.1 借鉴来源

| 项目 | 路径 | 调研范围 |
|------|------|----------|
| Cursor | 用户截图 | hover 粗信息、click 分类彩条 |
| deepseek-harness | `deepseek-harness/packages/client/ui-conversation/.../ContextMeter.tsx`；`StatsLine.tsx`；`packages/llm/token-meter/` | Web 环、三类组成条、`~`、cache 隔离（不是 TUI 参考） |
| claude-code-best | `src/components/BuiltinStatusLine.tsx`；`src/commands/context/`；`src/utils/analyzeContext.ts`；`src/components/ContextVisualization.tsx` | 常驻状态栏总量 + 独立 `/context` 分类；Skills 从 builtin 扣除 |
| Codex | `codex/codex-rs/tui/src/status/card.rs`；`bottom_pane/footer.rs` | `/status` 总窗口；footer 紧凑 % 与宽度降级 |
| kimi-code | `apps/kimi-code/src/tui/components/chrome/footer.ts`；`messages/usage-panel.ts` | footer 与 `/usage` 都只显示总窗口 |

## 3.2 可借鉴点

| 项目 | 做法 | 为何相关 | ohbaby 取舍 |
|------|------|----------|-------------|
| Cursor | 小环/触发器 + hover 粗 % + click 彩条与行 | 用户明确对标 | **Adopt** Web 交互；**Reject** Rules；Subagent 用父窗口 exchanges 不是 definitions |
| deepseek-harness | 组成不强制等于 projectedTokens；条长=provider %；段=相对比例；cache 在 StatsLine（整会话 `tokenUsage` 投影的 Cache-Read Share：`缓存命中 {percent}%`）不在占用条；单次请求只留 raw token 数（Trajectory），不做 last-step 百分比 | 与 ohbaby 启发式+校准同构；「one home per fact」 | **Adopt** `~` 与条/段分工；Web **Adopt** 小环（00 覆盖调研里一度 REJECT ring）；**Adopt（下一轮）** session aggregate 口径与 `Cache hit {n}%` 极简文案，落点在 `/status` 而非 dock 状态条 |
| claude-code-best | 常驻 StatusLine 只给 Context %/tokens；显式 `/context` 才展示 System tools / MCP / Skills / Messages 等大量诊断 | 证明分类不必常驻 TUI | **Adapt** 后端/Web 分类与 Skills 扣除；**Defer** TUI 详情；**Reject** Memory files、Autocompact buffer、deferred 虚占、Custom agents definitions、方格网格、同面板 cache hit |
| Codex | footer/status line 与 `/status` 都优先显示 total/remaining；空间不足时先丢次要 context 指示 | TUI 信息预算直接证据 | **Adopt** 本轮 TUI total-only；**Reject** 用其无组成模型限制后端/Web |
| kimi-code | footer 固定 `context: N% (used/max)`；`/usage` 仍是一根总量进度条；子 agent 独立计量 | 与 Ohbaby 现 TUI 最接近 | **Adopt** total-only 与主/子隔离；**Reject** cache/input/output 计费条当 occupancy |

## 3.3 明确不借鉴

- 把 cache read/write/create 画成占用组成（kimi TokenBar、claude `/context` 同面板 hit rate）。
- Claude 的 Autocompact buffer / Free space 填网格。
- Cursor「Subagent definitions」与 Ohbaby 父窗口「Subagent exchanges」混名。
- 精确 API countTokens 作为本批门禁（claude 混合估法；ohbaby 继续启发式）。
- TUI 占用环、hover、七行或 ASCII 条（dsh 是 Web 环；Claude 详情是独立命令，不是常驻区）。
- 按 runtime XML/tag 拆 environment 与 MCP menu；当前缺 typed provenance，不为细分制造解析耦合。

## 3.4 对 02 的影响

- Web 环 + hover + click：来自 Cursor/dsh，写入 `02-web-ui.md`。
- TUI total-only：来自 Claude/Codex/Kimi 的紧凑常驻设计 + 用户最终确认，写入 `02-tui.md`。
- 七类、summary/runtime/Subagent exchanges 边界与 Skills 扣除 builtin：来自 claude `/context`、Ohbaby provenance 与用户确认，写入 00 与 02 §2.2。
- 组成不求和：来自 dsh，写入 02 §2.2 与 04。
- cache 独立通道与 session aggregate 口径：来自用户 + dsh StatsLine 投影 + 知识库公式，写入 00 §2.4 与 02 Phase C（**下一轮实施**）。
