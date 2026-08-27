# 3. 优秀项目借鉴

> 口径与 00 §5 一致。下列外部项目路径均相对于 `/Users/hansunwork26/workspace/projects/code-cli/`；只把当前机器可读取的源码作为本轮实现证据。

## 3.1 借鉴来源

| 项目 | 可验证路径 | 调研范围 |
|------|------------|----------|
| deepseek-harness | `deepseek-harness/packages/llm/token-meter/src/usage-projection.ts`、`packages/llm/token-meter/README.md`、`packages/client/ui-conversation/src/client/chat/StatsLine.tsx` | 整份 durable log 的 token 累计、Cache-Read Share 公式、usage 与 context pressure 分离 |
| claude-code-best | `claude-code-best/src/cost-tracker.ts`、`src/components/ContextVisualization.tsx` | cache read/write 累计；在 context 可视化中显示 hit rate |
| kimi-code | `kimi-code/apps/vis/web/src/lib/analysis.ts`、`components/analysis/TimelineTab.tsx`、`components/context/ContextTab.tsx` | 累计 share 公式、未知态；cache token 条形可视化 |
| ohbaby improve-6 | `docs/core/context/improve-6/02-web-ui.md`、`02-tui.md` | 已冻结的 `/status` 行位置、文案与“cache 不属于 context occupancy”边界 |

### 参考完整性说明

improve-6 的历史讨论曾引用两份仓库外知识库笔记，但它们在当前工作区不可读取。因此，本轮不把其路径或结论当成可追溯的实现依据；关键公式、未知态和累计边界均在本目录内重新写全，并由上表中的源码交叉验证。这样即使脱离个人知识库，实施者也不会缺失前提。

## 3.2 可借鉴点

| 项目 | 可观察做法 | 为何相关 | ohbaby 取舍 |
|------|------------|----------|-------------|
| deepseek-harness | `tokenUsage` 累加整份日志中的 uncached input、cache read、cache write；UI 以 `cacheRead / (uncached + cacheRead + cacheWrite)` 得到全局 share；context pressure 另算 | 同时证明“token 数”和“share”是两个量，也证明 cache 命中率不等于 context occupancy | **Adopt** 累加原始 token 后再求比率，以及 usage/occupancy 分家。**Adapt** 为进程内 session tracker，不引入 durable-log projection |
| kimi-code analysis | 先累计 `inputOther / inputCacheRead / inputCacheCreation`，分母为三者之和；无 input 时返回 `null`；时间线显示 `—` | 与本轮 `accountedInputTokens`、`cacheReadTokens`、`cacheReadShare` 三字段直接对应 | **Adopt** `null` 与 `0` 分离。**Reject** 将 cache 段放进 Context TokenBar |
| claude-code-best | cost tracker 累计 cache read/write token；ContextVisualization 可显示 cache hit rate | 证明累计 token 是稳定原材料，也提醒 UI 位置会改变用户心智 | **Adopt** 累计原始计数。**Reject** 与七类占用图混排及阈值告警 |
| improve-6 UI 契约 | Web `/status` 占用块后独立 Cache 行；TUI 在 Context 与 Tools 之间 | 用户已确认本轮 UI 状态与位置，不再重开交互设计 | **Adopt** `Cache hit {n}%`、`Cache hit —` 和缺字段/子代理不显示 |

## 3.3 明确不借鉴

- 不把单个 step、turn 或 run 的百分比当作产品数字，也不对各轮百分比做算术平均；只累计可信原始 token，再计算 session share。
- 不把 cache read/write 画成七类 context occupancy 的组成段；命中不会释放上下文窗口。
- 不把 Cache hit 放进 Web 顶栏占用环、hover/click 详情或 TUI 底栏；本轮只进入 `/status`。
- 不引入 deepseek-harness 的 durable-log replay、替换投影或持久化；Ohbaby 本轮采用进程内 session 累计，进程重启后归零。
- 不复制 deepseek-harness 为接近 100% 场景设计的精细十进制格式；Ohbaby 保持已确认的整数 `Math.round` 文案。
- 不引入 claude-code-best 的阈值告警，也不引入 cache 成本、节省金额和 write/read 分栏。

## 3.4 对 02 的影响

- Phase A 必须保存 `accountedInputTokens` 与 `cacheReadTokens` 两个累计量，`cacheReadShare` 由二者派生；这一点来自 deepseek-harness 与 kimi-code 的共同证据。
- Tracker 只接收可信主代理模型请求的 provider usage；session 内 compact 和换模型都不清零，进程重启才归零。
- Cache usage 与 Context occupancy 数据模型、事件和 UI 分离；这一点来自 deepseek-harness 的 usage/pressure 分家和 improve-6 的冻结契约。
- `/status` 之外不新增常驻面板、持久化或诊断视图；这是本轮 YAGNI 边界，不妨碍后续单独扩展 cache 诊断。
