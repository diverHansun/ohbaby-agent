# 7. token 职责收口实施验收

> 实施日期：2026-08-25
>
> 基线：`89659af8`（`main`）
>
> 结论：**通过**。H1/H2 已按 [06](./06-token-responsibility-review-and-follow-up.md) 的克制边界完成；没有新增 schema、service、manager、配置项或 provider 方言依赖。

---

## 7.1 实际提交

| commit | 批次 | 内容 |
|--------|------|------|
| `f67bc63b` | 文档基线 | 对齐 token 文件职责、两批实施边界与验收门槛 |
| `cbe9e62f` | H1 · metadata storage adapter | creator/reader 收归 message storage boundary；收紧新写类型；修复 hybrid usage 重复持久化；补 lifecycle、legacy reopen 与边界测试 |
| `081949dc` | H2 · estimation envelope | estimator 直接消费 `PreparedModelRequest`；删除无差异 `ContextMeasurementPayload`；迁移独立单测并保持公式不变 |

这些提交均直接落在本地 `main`。本验收记录写入时尚未 push；是否推送由用户复核后决定。

## 7.2 最终职责与数据流

### 7.2.1 请求前估算

```text
ContextManager assembleModelRequest
  → deep-frozen PreparedModelRequest { messages, tools }
  ├─ estimatePreparedRequestHeuristic(request)
  │    → sentHeuristic
  │    → scoped calibration
  │    → ContextUsage / compaction decision / UI occupancy
  └─ PreparedTurn.request
       → Lifecycle provider request
```

估算公式没有变化：仍逐条 `JSON.stringify(message)`，只在 tools 非空时追加 `JSON.stringify(tools)`，用换行拼接后交给 `TokenCounter`。变化只在接口所有权：计量不再接受可被调用者拆散或漏传的 messages/tools 平行参数。

主代理和子代理共用该入口；校准状态仍按 `sessionId + contextScopeId` 隔离。tail directives 在组装时进入相同 request，MCP tools 也从相同快照计量和发送。

### 7.2.2 请求后 usage 与持久化

```text
provider raw usage
  → interface-provider normalizer
  → canonical inclusive TokenUsage
  ├─ Lifecycle aggregate / llm:complete transport
  ├─ ContextManager scoped calibration
  └─ createTokenUsageMetadata
       → at most one durable part per model step
       → database JSON round-trip
       → readTokenUsageMetadata(unknown)
```

`createTokenUsageMetadata` 与 `readTokenUsageMetadata` 现在同属 message storage boundary：

- writer 只接受 canonical `TokenUsage`，复制 breakdown/observed，并重算 total；
- reader 把数据库 JSON 当作 `unknown`，优先读取 canonical shape，再兼容最小 legacy `promptTokens/completionTokens`；
- 数值必须是非负安全整数，重算的 total 也必须安全；损坏 breakdown 不污染合法 inclusive totals；
- legacy shape 不再出现在新写入类型或 message 导出中；
- 有非空 text 时 usage 写在 text part；tool-only 时只写在第一个 tool part；reasoning-only 不伪造 synthetic part；
- hybrid text + tool-call 响应不再把同一份 usage 持久化两次。

子代理走同一 creator/reader，并由 part 的 `contextScopeId` 保持 durable 隔离；auxiliary request 不因此获得新的 assistant metadata 旁路。

## 7.3 测试证据

### 7.3.1 TDD 与定向测试

H1 的新增测试先暴露两个真实失败：metadata creator 尚不存在，以及 hybrid 响应产生两个 usage parts。实现后，metadata/lifecycle/database/provider/transport 相关定向集合为 **6 files / 84 passed**。

H2 的独立 estimator 测试先因新入口不存在产生 **3 个预期红灯**；实现后，estimator、ContextManager、improve-4.1 与 subagent scope 定向集合为 **4 files / 82 passed**。

覆盖内容包括：

- canonical/legacy metadata、损坏 JSON、breakdown 降级、安全整数与 total 重算；
- text-only、tool-only 多工具、hybrid、reasoning-only 的 durable placement；
- database raw legacy fixture 经 close/reopen 后由 production reader 解析；
- 子代理 usage part 的 `contextScopeId`；
- messages-only、undefined/empty/non-empty tools、多工具顺序、`content: null` tool calls；
- frozen `PreparedModelRequest` 不被 estimator 修改；
- measurement、send、tail directives、主/子代理 request 深等价。

### 7.3.2 最终仓库门禁

| 门禁 | 结果 |
|------|------|
| `pnpm run lint` | 通过 |
| `pnpm run typecheck` | 通过 |
| `pnpm run test:unit` | **225 files；2053 passed / 2 skipped** |
| `pnpm run test:contract` | **14 files；245 passed** |
| `pnpm run test:integration` | **49 files；321 passed**，包含 npm packed CLI packaging smoke |
| `git diff --check` | 通过 |

本批没有修改 provider wire、cache capability、cache key、MCP epoch 或 cache breakdown normalizer，因此没有把真实 provider cache smoke 设为重复硬门，也没有复用 improve-5 的旧外部凭据证据冒充本次执行结果。

## 7.4 独立审查闭环

H1 审查发现一个 important：reader 使用普通整数校验会接受超出 JavaScript 安全整数范围的值。实现已改为 `Number.isSafeInteger`，并对重算 total 再校验。审查提出的 tool-only 多工具、reasoning-only 与子代理 metadata scope 用例也已补齐。最终没有遗留 critical/blocker。

H2 只读审查结论为可提交，Critical / Important / Minor 均为 0。审查逐项确认：

- 新旧估算公式逐字节等价，没有 calibration 漂移；
- production/test 中不再存在旧 estimator 或 measurement alias；
- 组装、计量、callback、发送使用同一 `PreparedModelRequest`；
- 主/子代理、tail directives 与 tools 数据流未分叉；
- 独立 helper 测试从大型 manager test 中移出，没有增加生产抽象。

## 7.5 验收门槛对照

| [06 §6.9](./06-token-responsibility-review-and-follow-up.md#69-验收门槛) | 结果 |
|------|------|
| 删除三个旧生产/测试入口 | 通过：`toPartTokenUsageMetadata`、`estimateWireHeuristic`、`ContextMeasurementPayload` 均无 production/test 引用 |
| 不增加不必要结构 | 通过：净结果是一个共享 creator、一个完整 request 参数和一个无差异别名删除 |
| storage codec fail closed | 通过：unknown/array/null/unsafe number/invalid breakdown/legacy 均有测试 |
| 每 step 最多一个 durable usage part | 通过：text/tool-only/hybrid/reasoning-only 均有测试 |
| estimator 公式不变 | 通过：characterization unit + improve-4.1 integration |
| 主/子代理共享实现且 scope 隔离 | 通过：lifecycle 与 context-subagent-scope tests |
| 门禁与只读审查 | 通过：见 §7.3、§7.4 |

## 7.6 明确未做与后续边界

本批没有引入精确 tokenizer、usage pricing、跨 session cache analytics、per-message cache hit UI、provider-measured anchor state machine，也没有移动 canonical `TokenUsage` 的模块所有权。它们都需要独立问题和收益证据，不能继续塞进这次小型职责收口。

`ContextManager` 的体量问题也没有借本批机械拆类。此次只删除同义类型并收紧现有接缝，避免重新触碰 improve-4～5 已经完成的并发、压缩和恢复架构。
