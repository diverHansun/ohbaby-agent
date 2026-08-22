# 4. 测试与验收标准

> 本文是 improve-4.1 的发布门。项目没有独立 `test-blueprint.md`，沿用现有 Vitest 分类：co-located `*.unit.test.ts` / `*.contract.test.ts`，跨模块测试放 `tests/integration/`。测试围绕真实数据流与回归风险，不以覆盖率数字代替验收。

---

## 4.1 测试范围

| 层 | 覆盖内容 | 不覆盖 |
|----|----------|--------|
| 单元 | measurement payload、factor、compact 重测、prompt names、Lifecycle final step、composition primary 边界、status 单源、tracker 更新 | tokenizer 算法替换、压缩策略优劣 |
| 合同 | status data shape、context-window nullable 行为、compact 后 event/snapshot | 新 HTTP/SDK 字段 |
| 集成 | tools resolve → prompt/measure/send；primary static/manual；subagent scoped auto compact；`/compact → /status` | 真实 provider、cache 命中 |
| 手工 smoke | 主代理冷启动 status、对话后占用、手动 compact 后下降 | 子代理 UI（明确不存在） |
| 对抗性审查 | 重复计量、scope 丢失、隐藏双源、范围膨胀 | improve-5 与后续压缩策略评审 |

---

## 4.2 关键场景

| ID | 场景 | 类型 | 验证点 | 对应 Phase |
|----|------|------|--------|------------|
| TC-1 | 同一 messages，非空 schemas vs 空 schemas | unit · context manager | 非空 tools 的 `currentTokens` 严格更大；`ContextMeasurementPayload.tools` 必须显式存在 | 1 |
| TC-2 | factor 与 tools 同量纲 | unit | `currentTokens = round(estimate(messages+tools) × factor)`；不得再加一次 tool estimate | 1 |
| TC-3 | system prompt 只消费 names | unit · system prompt | `build({ toolNames })` 生成既有工具列表；代码中不存在 `toolsProvider` 回落 | 1 |
| TC-4 | 非最终 step | unit · lifecycle | resolved tools 同时派生 prompt names、measurement schemas、provider schemas；三者集合一致 | 1 |
| TC-5 | 最终 step | unit · lifecycle | `resolveTools` 仍调用；`toolNames` 非空；measurement/provider `tools=[]`；不执行工具调用 | 1 |
| TC-6 | subagent scope calibration 隔离 | unit · context manager | 同 child session 的 scope A/B 使用各自 factor，不回退为 session-only | 回归 |
| TC-7 | subagent 自动压缩 | integration | 同 child session 两个 scope 的 history 不串；超阈值 scope 只压自己的上下文，另一个 scope 不受影响 | 回归 |
| TC-8 | manual compact 全程含 schemas | unit | `usageBefore`、prune 后投影、summary 后重测使用同一 tools；不是只在入口算一次 | 1 |
| TC-9 | primary static 自定义 agent | unit · composition | 从 primary Session 取得 agentName；同一次 `resolvePromptTools` 的 names 给 assemble、schemas 给 getUsage | 2 |
| TC-10 | child session 静态查询不可用 | unit/contract | 在读取 tracker 前识别 `isSubagent`，返回 `null`；即使 child tracker 有值也不得泄漏 sibling-last-writer 数字 | 2 |
| TC-11 | 公开协议不接收 subagent identity | contract/rg | context-window 参数仍只有 sessionId；无 client-supplied agentName/scope/isSubagent | 2 |
| TC-12 | status 只输出 window | unit · commands | 只调用 `getContextWindowUsage`；data 无 `context`；`CommandServiceOptions` 无 `getContextUsage` | 3 |
| TC-13 | tracker hit 不回落 static | unit/contract | 预置 primary tracker 时 status 返回相同值，runtime.getContextUsage 不调用 | 3 |
| TC-14 | manual compact 更新 tracker | unit/contract · ui-inprocess | compact 成功后 tracker 的 currentTokens/model/limit 来自 `usageAfter` | 3 |
| TC-15 | manual compact 发布 window event | contract/integration | 发布一次 `context.window.updated`，payload 与 tracker 相同；随后 `/status` 读取该值 | 3 |
| TC-16 | 范围守卫 | rg/review | 无 cache/breakdown/scope UI 字段；threshold、prune、summary 策略无改动 | 全部 |

---

## 4.3 集成测试设计

### I-1 Lifecycle 工具数据流

扩展 `tests/integration/core/lifecycle-tool-scheduler.integration.test.ts`：

1. scheduler 返回确定的两个工具。
2. 非最终 step 断言 prompt names、prepared measurement schemas、provider request schemas 一致。
3. 最终 step 断言 scheduler 仍解析 names，但 provider schemas 为空。
4. provider fake 返回 prompt token usage，断言 calibration 分母来自同一 prepared payload。

### I-2 primary static/manual 闭环

新增或扩展 context integration 用例：

1. 创建 primary Session 和若干 history。
2. scheduler 返回固定 schemas。
3. tracker 为空时查询 context window，断言静态值包含 schemas。
4. 执行 manual compact，fake summary client 返回更短 summary。
5. 断言 `usageAfter < usageBefore`。
6. 再执行 status，断言读取 `usageAfter`，且不再调用 static calculator。

### I-3 subagent scoped automatic compaction

使用同一个 child session 建立两个 `contextScopeId`：

1. scope A 写入足以触发自动压缩的 history，scope B 写入可辨识的小 history。
2. 以不同 role/agentName 调用实时 `prepareTurn`。
3. 断言 A 的 measurement/compaction 只读取 A。
4. 断言 B history、factor、compact state 未被 A 污染。
5. 不调用任何 UI/static context-window API；该测试验证的是内部运行保护。

---

## 4.4 回归清单

- improve-4 非最终 step 仍把 tools 算入 measurement 和实际请求。
- final step 仍不向 provider 暴露 callable tools，也不执行 tool calls。
- `measureUsage` 仍是唯一 occupancy 算法入口。
- EMA α、clamp、session+scope key 与进程内生命周期不变。
- `AssembledContext` 仍无 tools。
- primary 仍加载 memory；subagent 仍不加载 memory。
- subagent history 仍按 `contextScopeId` 隔离。
- manual compact 仍受 primary-session guard。
- threshold 仍为 0.95；不改 prune/summary/mask 策略。
- status panel 与现有占用条继续消费 `contextWindow`。
- SDK `UiContextWindowUsage` 与 `UiCompactSessionResult` shape 不变。
- SQLite schema 无 migration。

---

## 4.5 发布门

### 快速反馈（每个 commit）

```bash
pnpm test -- packages/ohbaby-agent/src/core/context/manager.unit.test.ts
pnpm test -- packages/ohbaby-agent/src/core/system-prompt/__tests__/assembler.test.ts
pnpm test -- packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts
pnpm test -- packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts
pnpm test -- packages/ohbaby-agent/src/commands/service.unit.test.ts
pnpm test -- packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
pnpm run typecheck
```

测试文件名若在实施中发现与当前仓库实际命名不同，以现有文件为准修正文档/命令，不创建重复测试套件。

### 集成门

```bash
pnpm run test:integration
```

必须包含 I-1、I-2、I-3；不允许只跑 unit 后宣称完成集成验收。

### 最终门

```bash
pnpm run preflight
```

若全量 preflight 暴露与本批无关的既有失败，必须记录：命令、失败测试、是否能在未改代码的 main 基线复现；不得静默忽略。

---

## 4.6 手工 smoke

只验证主代理：

1. 新建/打开一个 tracker 无值的主 session，执行 `/status`，确认返回 contextWindow 且无旧 `context` 字段。
2. 运行一轮含工具的对话，确认 status 与占用条相同。
3. 制造足够 history，执行 `/compact`。
4. compact 成功后不再运行 LLM，直接执行 `/status`；数值应等于 compact result 的 `usageAfter`，且小于 `usageBefore`。
5. 不要求、也不新增子代理占用展示。

---

## 4.7 rg/静态守卫

```bash
rg "toolsProvider" packages/ohbaby-agent/src
rg "RequestPayload" packages/ohbaby-agent/src/core/context
rg "prompt_tokens_cached|cache_read|cache_write" packages/ohbaby-agent/src/core/context
rg "breakdown" packages/ohbaby-sdk/src
rg "contextScopeId|isSubagent|agentName" packages/ohbaby-sdk/src/context-window.ts
rg "getContextUsage" packages/ohbaby-agent/src/commands
```

期望：

- production 与测试中均不再存在 system prompt `toolsProvider` API。
- context 模块不新增通用 `RequestPayload`；使用窄语义名称。
- 无新增 cache/breakdown/public subagent identity。
- commands 不保留 status 专用的 `getContextUsage` 双源。

---

## 4.8 子代理审查门

代码、unit、contract、integration 和 typecheck 全绿后，再启动独立只读子代理审查；正式文档仍由主代理维护。

### Reviewer A — correctness / data flow

重点核对：

- names、measurement schemas、provider schemas 是否来自同一 resolved set
- final-step 顺序是否保持 prompt names 与 outbound-empty
- manual compact 是否所有重测都带 schemas
- child session 是否可能从 cache/static 泄漏错误占用
- subagent auto compact 是否确实 scope-aware

### Reviewer B — SWE / scope / tests

重点核对：

- 是否出现新的 transport/measurement 双抽象
- ContextManager 是否反向依赖 registry
- 是否混入 cache、breakdown、阈值或压缩策略
- status 双数据源是否彻底删除
- 测试是否测行为而非只锁实现细节

审查 finding 按 critical/major/minor 分类，必须带文件/符号证据。critical/major 修复后重跑相关测试与最终门；minor 若不修，需在验收说明中记录理由。

---

## 4.9 对抗性审查

| 攻击面 | 防御 | 残余风险 |
|--------|------|----------|
| messages 已含 system，却又单独估 system | measurement payload 只有 messages/tools；TC-1/2 | review 需检查无额外 `estimateTokens(systemPrompt)` |
| final step 从空 schemas 推导 names | 先 resolve，再清 outbound；TC-5 | scheduler 解析延迟需观察但非架构 blocker |
| child tracker 命中绕过 primary 检查 | 检查必须发生在 `tracker.get` 前；TC-10 | 内存仍可能存 child last-writer，但不对外展示 |
| manual compact 只在 usageBefore 带 tools | TC-8 检查所有投影/summary 重测 | 新增重测路径时需延续 payload |
| compact 返回正确但 tracker/event 旧 | TC-14/15 + I-2 | 工具菜单变化仍等下一次 prepare/static refresh |
| 删除 status 字段但隐藏消费者存在 | 全仓搜索 + command contract tests | 外部非仓库消费者无法静态发现；该变化已获用户批准 |
| 借 4.1 顺便“优化”压缩策略 | TC-16、diff review、双 reviewer | 下一批必须重新从数据结构/数据流规划 |
| unit 全绿但真实模块接线错误 | I-1/I-2/I-3 + preflight | 不使用真实 provider，provider-specific 误差留给后续 telemetry |

---

## 4.10 验收结论标准

只有同时满足以下条件才可宣称 improve-4.1 完成：

1. TC-1 至 TC-16 全部有自动化或明确 smoke 证据。
2. unit、contract、integration、typecheck、lint/format/build 对应的 `preflight` 通过。
3. 两名子代理 reviewer 无未处理 critical/major finding。
4. commit 按 02 §2.9 分批且每批可解释、可回退。
5. diff 不包含 cache、压缩策略、breakdown/UI、memory 或存储迁移。
6. 验收模式对照 02/04 产出 `05-implementation-acceptance.md`。
