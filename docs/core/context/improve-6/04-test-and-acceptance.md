# 4. 测试与验收标准

沿用仓库 `docs-test/`：`unit / contract / integration / smoke`。不新增第五种默认分类。真实 provider cache E2E 保持 opt-in，本批不把无凭据环境的命中当硬门。

## 4.1 测试范围

| 层 | 覆盖 |
|----|------|
| unit | 七类分桶、summary/runtime/subagent part-level 边界、module→builtin、skill 目录 vs SKILL.md 正文、`ResolvedStepTools` 同步、总量启发式不变、TUI 总量 formatter 不变 |
| contract | SDK `UiContextWindowUsage` 旧字段必填、composition optional；snapshot/event 仍可无 composition；有则七 key 完整；`/status` data 本批无 `promptCache` |
| integration | resolve step tools → prepareTurn → `context:prepared` → worker → stream bridge，分别覆盖 raw bridge→tracker→`context.window.updated` 与 bridge→LifecycleEvent roundtrip；自动压缩组成对齐 final request；manual compact/total-only 更新清旧 composition；primary vs subagent scope |
| smoke / 手工 | compiled Web：环、hover、click 七行、`/status` 卡片详情；TUI footer/`/status` 仍是总量 |
| （下一轮） | cache 相关测试统一见 §4.7 |

## 4.2 关键场景

| ID | 场景 | 类型 | 验证点 | 02 Phase |
|----|------|------|--------|----------|
| U1 | 仅 system + builtin tools | unit | 两类 >0，mcp/skills/summary/subagent=0 | A |
| U2 | 含 MCP schema | unit | mcp>0 且不计入 builtin-tools | A |
| U3 | skill 工具 description 含 `<available_skills>` | unit | `skill` 与 `skill_resource` 均计入 skills，不计入 builtin-tools | A |
| U4 | 已 load 的 SKILL.md tool result | unit | 计入 conversation，不计入 skills | A |
| U5 | context summary | unit | `<context_summary>` 只计入 `summarized-conversation`，不进普通 conversation | A |
| U6 | runtime environment + MCP lazy menu 附着 user part | unit | 物理 wire role 仍为 user；占用归 `system-prompt`，不进 conversation/mcp | A |
| U7 | `subagent_run` / `subagent_status` / `subagent_close`，且同一 assistant message 有普通文本 | unit | 三种父窗口 call arguments 与对应 result/status/close 回写均计入 `subagent-exchanges`；普通文本仍在 conversation；三种 schema 均在 builtin-tools | A |
| U8 | child 内部 transcript | unit/integration | 不进入父窗口 composition；只统计父窗口 exchange | A |
| U9 | `source: "module"` fixture | unit | 并入 builtin-tools | A |
| U10 | 七类之和 ≠ 校准总量 | unit | 允许；总量仍等于现有 measureUsage | A |
| U11 | final step / legacy flattened tools | unit | final step definitions/requestTools 同时为空；非空 flattened tools 无 definitions 时 composition omitted，不猜 source | A |
| U12 | resolver 快照 | unit | definitions 与 requestTools 来自同一次调用且顺序一致；每 step 重新解析，无跨 step side map | A |
| K1 | 旧 snapshot 无 composition | contract | 解析成功 | B |
| K2 | 有 composition 的 payload | contract | 七 key 齐全、非负整数；额外字段不破坏旧消费者 | B |
| I1 | 完整 prepared 推送分支 | integration | `context:prepared` 的 `usage + composition` 经 worker 写入 `run.context.prepared`；raw bridge event→run-stream-adapter/tracker→主 session usage 与 bridge→run-event-source→LifecycleEvent 两条分支分别保持字段；禁止只手造末端 adapter event | A+B |
| I2 | manual compact / total-only 更新 / static get | integration | manual compact 或任何 total-only tracker update 更新 currentTokens 并清旧 composition；cache-miss static get 只产 total-only；cached static get 保持已有快照；下一次 prepare 重建 | A+B |
| I3 | child scope | integration | 用户主占用仍是 primary；不把 child 总量标成精确主窗口 | A |
| I4 | 自动压缩后的组成 | integration | composition 来自压缩与二次 reduction 后的 final request；summary>0；已裁剪旧 conversation/subagent parts 不再计入 | A+B |
| W1 | Web 环/hover/click | unit + 手工 | 见 02-web；无 composition 不画假七行 | D |
| W2 | Web `/status` | unit + 手工 | 七行详情块；本批无 Cache 行 | D |
| T1 | TUI 底栏 | unit | 格式不变 | E |
| T2 | TUI `/status` | unit | 有/无 composition 都只显示总量；无七行/ASCII 条；本批无 Cache 行 | E |

> 命名空间：本表 U/K/I/W/T 为测试 ID，与 02 §2.9 的改动 ID（C/D/N 表）是独立命名空间，互不可检索引用。Phase F（文档同步）无功能测试行，由 §4.5 G6「审阅 D1–D3」承接。

## 4.3 集成边界

- Lifecycle resolver ↔ `ResolvedStepTools` ↔ Context：definitions 与 requestTools 必须是同一步不可变快照。
- Context `measureUsage` ↔ `PreparedTurn.composition?`：composition 是解释字段，不进入 `ContextUsage` 控制语义。
- `context:prepared` ↔ RunWorker `run.context.prepared` ↔ stream bridge 后分叉：raw bridge event ↔ tracker ↔ `context.window.updated` ↔ Web eventReducer / TUI store；另一支 stream-bridge run event source ↔ LifecycleEvent roundtrip。
- 不得：Context 解析 vendor cache 字段；UI 把 cache 段画进占用条。
- （下一轮）Lifecycle run 完成 `LifecycleTokenUsage` ↔ session cache 累加器 ↔ `handleStatus`。

## 4.4 回归清单

- inclusive `currentTokens` 仍含 cache read；压缩阈值仍 0.95 + 4096。
- `toOpenAiTools` 仍输出无 source 的 OpenAI tools（发送契约不变）。
- 子代理自身窗口/child transcript 不进主占用 UI；已经进入父请求的三种 `subagent_*` call 与对应回写仍计入 `subagent-exchanges`。
- runtime model-context 仍不进 live conversation UI 文本（improve-5），物理上继续附着 initiating user message；只在占用归因中进 System prompt。
- `/status` 仍输出 model/permission/mcp 汇总；Tools **个数**行仍在。
- SDK 无 composition 的客户端不崩溃。
- TUI 不因 composition 新字段增加任何分类行或改变总量格式。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| G1 分桶与 step 快照 | U1–U12 全绿 | `vitest` 对应 unit/integration |
| G2 SDK | K1/K2 全绿；事件可选 composition | contract |
| G3 组成链路 | I1–I4 全绿；尤其 worker/bridge 不丢字段、自动/手动 compact 后无 stale composition | integration |
| G4 Web | 环可见；hover 粗信息；click 七英文行；面板无 cache；`/status` 有详情（无 Cache 行） | App.unit + 手工 compiled serve |
| G5 TUI | 底栏与 `/status` 旧总量格式；即使 payload 有 composition 也不出现七行 | status-panel.unit + usage.unit + 手工抽查 |
| G6 文档 | architecture/data-model 已提 composition；status-bar.md 不再指向幽灵类型 | 审阅 D1–D3 |
| G7 回归 | 现有 context-window-usage 分母仍是 context window | 旧 unit 不得改语义 |

Cache 验收整体移入 §4.7，随下一轮执行，不占用本批发布门。

实施完成后的必跑命令矩阵（真实 provider cache smoke 不在本批执行，也不作为门）：

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run test:contract
pnpm run test:integration
pnpm run build
pnpm run test:e2e:compiled-web
```

无 API key 时 G4 手工可用本地假 usage；真实 cache 命中不是本批硬门（沿用 improve-5 skip 记账）。

## 4.6 对抗性审查

| 攻击面 | 防御 | 残余风险 |
|--------|------|----------|
| （下一轮）把「没有可信数据」渲染成 0% 命中 | helper 要求 observed；`cacheReadShare === null` → `Cache hit —`；§4.7 N-U1 | 某前端漏接 null |
| definitions 与 requestTools 来自不同解析时刻 | `ResolvedStepTools` 单快照 + U11/U12 | 新 resolver 未来绕过 contract |
| 用 flattened tools 猜 source，导致 MCP/skill 全进 builtin | 缺 definitions 时 composition omitted；U2/U3/U11 | 某静态路径只有总量、无明细 |
| SKILL.md 很大却显示在 Skills | U4 | 工具改名未同步常量 |
| runtime 因 role:user 被误算 Conversation | provenance 优先于 wire role + U6 | runtime 内部暂不细拆 environment/MCP menu |
| summary 或同消息普通文本被 subagent 桶吞掉 | part-level 分类 + U5/U7（三种 `subagent_*`） | serializer 形状将来变化需更新投影测试 |
| 自动压缩后 composition 仍来自 unreduced history | 仅从 final request 生成 + I4 | 新增 reduction 阶段时需继续锁 final 快照 |
| compact 后总量已降、明细仍是旧值 | total-only 更新清 composition + I2 | prepare 前暂时没有分类，UI 正确降级 |
| 子代理全量 transcript 被算进主窗口 | 现有 scope 过滤 + U7/U8 | 若将来把 child 历史 mirror 进 parent 需重开议题 |
| 七类加总当断言失败 | 测试禁止强制相等 | 用户观感依赖 `~` |
| TUI 被顺手扩成七行，扩大本轮 | T2/G5 锁 total-only | 后续有需求需重新规划 |

最可能失败的集成点：resolver 返回的 definitions 与实际 request tools 漂移，或调用方只传 flattened tools。Phase A 应用窄快照；来源不足时 composition omitted、Web 不画假七行，fail-visible 而不是猜 source。

## 4.7 下一轮（cache 批次）测试清单

> 随 02 Phase C 执行；口径与设计见 00 §2.4。本批不跑。

| ID | 场景 | 类型 | 验证点 |
|----|------|------|--------|
| N-U1 | Cache-Read Share helper：无 observed / 无任何可信数据 | unit | `cacheReadShare === null` → `Cache hit —`，禁止 0% |
| N-U2 | 分母含 cacheWrite | unit | read=0、write>0 时 share=0% 且分母为总输入 |
| N-U3 | session 累加跨 run | unit | 两轮 read/total 各自累加后比率正确 |
| N-U4 | 不完整轮尽力而为 | unit | `usageComplete=false` 或无 breakdown 的轮跳过累加；`incompleteRuns` +1；session 桶仍显示 |
| N-U5 | 辅助 title/summary usage | unit/integration | 不进入 session 累加器 |
| N-C1 | `/status` 无 `promptCache` 字段的旧消费者 | contract | contextWindow 总量仍在，解析成功 |
| N-I1 | run 完成 → 累加器 → `/status` | integration | `Cache hit {n}%` 与累加器一致 |
| N-W1 / N-T1 | Web 卡片 / TUI 面板 Cache 行 | unit + 手工 | `Cache hit 61%` / `Cache hit —` 单行文案 |
