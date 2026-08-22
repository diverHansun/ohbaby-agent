# 2. 优化方案与改动面

> 本文是后续实施会话的执行契约。规划轮不写业务代码。约束来自 [00](./00-discussion.md)，现状证据来自 [01](./01-problem-analysis-and-current-state.md)，完成标准见 [04](./04-test-and-acceptance.md)。

---

## 2.1 方案总览

```text
工具定义解析
  ├─ toolNames ───────────────→ SystemPromptProvider.build
  └─ requestTools
       ├─→ ContextMeasurementPayload { messages, tools }
       └─→ provider send

主代理 static/manual
  → composition 解析完整 tools
  → ContextManager measurement/compact
  → contextWindow tracker

子代理 runtime only
  → Lifecycle(sessionId + contextScopeId + agentName)
  → scoped measurement
  → automatic prune/compact
  → no static API / no UI
```

核心原则：

1. measurement 对 request-shaped 数据做，但不重构 transport request。
2. schemas 与 prompt names 来自同一次路径级解析。
3. ContextManager 只接收数据，不访问 registry。
4. primary static/manual 与 subagent scoped runtime 明确分界。
5. 本批只修计量与已有 UI 数据一致性，不审查压缩策略。

---

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃项与代价 |
|--------|------|------|--------------|
| measurement 类型 | `ContextMeasurementPayload = { messages, tools }`；`tools` 属性必需，但值可为 `undefined` / `[]` | 迫使调用点显式承认 schemas；名称不与 transport request 冲突 | 不用通用 `RequestPayload`；多一个窄类型是可接受成本 |
| transport request | 保持现有 `InterfaceProviderRequest` | 4.1 无发送层重构需求 | 不追求 pi/opencode 的类型同构 |
| `AssembledContext` | 不加 tools/toolNames | 保持会话级语义 | 调用者必须在请求时组合 |
| `assemble` | 位置参数改为明确 options；`isSubagent` 与 `toolNames` 必填，scope/agentName 可选 | 防止第五/第六位置参数继续遗漏 | 内部调用点需一次性迁移 |
| system prompt | `SystemPromptProviderInput.toolNames` 必填；删除 `toolsProvider` | push 模型、依赖方向清楚 | 所有测试夹具需显式传 `[]` |
| tools 解析 | composition 负责 static/manual；Lifecycle 负责 runtime | 两处都是已有编排边界 | 不让 ContextManager 依赖 scheduler |
| final step | 先解析完整 tools/names，再令 outbound schemas = `[]` | 保持最终步禁用工具调用，同时保留当前 prompt 名称语义 | `resolveTools` 调用次数合同会翻转 |
| static 语义 | 只面向 primary；按非最终 step 的完整 tools 计量 | public 输入没有 subagent scope identity | child session 查询返回 unavailable |
| manual compact | 只面向 primary；同一 schemas 用于 before/prune/summary 后所有重测 | 与真实下一请求体积同量纲 | 不开放 child session 手动 compact |
| subagent occupancy | 仅 runtime scoped measurement/automatic compaction | 满足运行保护，不制造 UI/静态伪精度 | 无公开查询与展示 |
| calibration | 公式不变；继续按 session+scope | 实时链路已正确；4.1 只补输入 | 不引入第二个 factor |
| status | 删除 `context` 与独立 `getContextUsage`，只输出 `contextWindow` | 用户已确认；TUI 只消费 window | 内部 status payload 是有意合同变化 |
| compact 后 cache | `usageAfter` 更新 tracker，并发布已有 window event | cache-first 必须反映压缩结果 | 不新增事件类型 |
| HTTP/RPC identity | 不新增 `isSubagent`、`agentName`、scope 参数 | 防止客户端伪造身份且控制范围 | child 查询只返回 nullable unavailable |
| cache/breakdown | 不做 | 独立后续议题 | 无 |

所有决策均为进程内 TypeScript 或内部 command payload；无存储迁移。唯一有意的消费合同变化是 `/status.data.context` 删除，已获用户确认。

---

## 2.3 分阶段实施

### Phase 1 — measurement payload、prompt push 与 final-step 数据流

**目标**：同一路径中 prompt names、measurement schemas、provider schemas 来源一致；所有 measurement 显式接收 tools。

**改动**

1. 在 `core/context/types.ts` 定义 `ContextMeasurementPayload`，`tools` 属性不允许省略。
2. `measureUsage` 改为接收 payload；model/session/scope calibration metadata 与 payload 分离，避免把完整 Session stamp 进计量类型。
3. `measureContext` serialize 后构造 payload；`getUsage` 改为对象参数并要求显式 tools。
4. `CompactOptions.tools` 改为必填属性（值可为空），同一份 schemas 贯穿 `usageBefore`、prune/投影和 summary 后重测。
5. `assemble` 改为 options 签名；`SystemPromptProviderInput.toolNames` 必填。
6. 删除 `SystemPromptProviderOptions.toolsProvider` 及 composition 生产接线。
7. Lifecycle 每个 step 都先取得完整 resolved tools；从它派生 `toolNames`。若为 final step，再把实际 `requestTools` 置为 `[]`。
8. `PrepareTurnInput` 显式携带 `toolNames` 与 `tools`；prepare/assemble/measure/send 的 schemas 必须一致。
9. MCP selectable menu 的独立 `resolveMcpToolNames` 暂时保持，不把“同一次 schemas/name 解析”夸大为整个 prompt 构建只访问 scheduler 一次。

**完成定义**

- 04 TC-1 至 TC-5、TC-8、TC-9 通过。
- `AssembledContext` 无 tools 字段。
- ContextManager 无 scheduler/MCP import。

### Phase 2 — primary static/manual 与 subagent runtime 边界

**目标**：主代理冷启动查询和手动 compact 正确计入 schemas；child session 不暴露错误静态数值；subagent 自动压缩保持 scoped。

**改动**

1. `composition.getContextUsage`：
   - 读取 Session 以确定 primary agentName；
   - 若为 subagent session，抛出明确的 internal unsupported 错误；
   - 对 primary 调用 `resolvePromptTools({ isSubagent: false, agentName })`；
   - names 传 assemble，schemas 传 getUsage。
2. `composition.compactSession`：
   - 删除公开/内部 `isSubagent?` 输入；
   - 防御性确认 Session 不是 subagent；
   - 解析 primary agent tools/names；
   - names 与 schemas 一并传 ContextManager。
3. `getContextWindowUsageInternal` 在读取 tracker **之前**检查 session：
   - primary：cache-first，miss 时 static fallback；
   - subagent：返回 `null`，不能把已被 sibling scope 覆盖的 child tracker 值泄漏出去。
4. 保留 `assertCanUseAsPrimarySession` 对用户 prompt/manual compact 的限制；可抽出更诚实的 primary-session helper，错误文案不得继续写成仅“submit prompt”。
5. 不向 Session 添加 `contextScopeId`，不扩 HTTP/RPC，不查询 SubagentStore 来拼一个半公开静态 API。
6. 保持实时 Lifecycle 的 `sessionId + contextScopeId + agentName + tools` 数据流；补充/强化自动压缩 scope 回归测试。

**完成定义**

- 04 TC-6、TC-7、TC-10、TC-11 通过。
- public window query 对 child session 为 nullable unavailable。
- primary 自定义 agentName 的静态/手动工具解析正确。

### Phase 3 — status 单源与 compact 后一致性

**目标**：当前占用只有一个面向 UI 的来源；手动 compact 立即改变该来源。

**改动**

1. `handleStatus` 不再调用 `CommandServiceOptions.getContextUsage`，status data 删除 `context`，只保留 `contextWindow`。
2. 从 `CommandServiceOptions` 与 ui-inprocess command 装配删除 `getContextUsage`；若搜索发现其它真实消费者，先回到规划审查，不保留隐藏双源。
3. `compactSessionInternal` 成功获得 `result.usageAfter` 后：
   - `contextWindowUsage.updateFromContextUsage(sessionId, result.usageAfter)`；
   - 有有效 projection 时 `publish({ type: "context.window.updated", usage })`；
   - 再返回 compact result。
4. 更新 command、ui-inprocess contract、TUI event/store 相关回归测试；不新增 SDK 字段或新事件。

**完成定义**

- 04 TC-12 至 TC-15 通过。
- `/compact → /status` 集成用例看到 `usageAfter`，且不触发第二次 static calculation。

---

## 2.4 按包/目录的改动面

| 包/目录 | 预计修改 | 不允许顺带修改 |
|---------|----------|----------------|
| `packages/ohbaby-agent/src/core/context/` | types、manager、unit tests | tokenCounting、threshold、strategy |
| `packages/ohbaby-agent/src/core/system-prompt/` | assembler/provider input、tests | prompt 文案重写 |
| `packages/ohbaby-agent/src/core/lifecycle/` | resolved tools/final-step names、tests | maxSteps 语义、tool execution |
| `packages/ohbaby-agent/src/adapters/ui-runtime/` | composition/types/tests | provider transport |
| `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` | primary-only window query、compact tracker/event | 新 UI、scope tracker |
| `packages/ohbaby-agent/src/commands/` | status payload/options/tests | 其它 slash commands |
| `packages/ohbaby-sdk/` | 只做现有事件/compact contract 回归；预期无 shape 修改 | breakdown/cache/scope 字段 |
| `tests/integration/` | lifecycle tools 与 compact→status 集成 | 真实 provider/cache e2e |
| `docs/core/context/architecture.md` | measurement/transport 与 primary/scoped 分界 | 压缩策略设计 |
| `docs/core/context/goals-duty.md` | D2 可补 tools-aware measurement；D1 不变 | 85% 阈值修订 |

---

## 2.5 API、迁移与兼容

| 面 | 契约 |
|----|------|
| HTTP/RPC context-window | 参数/响应 shape 不变；child session 返回 `null`/unavailable |
| HTTP/RPC compact | shape 不变；仍只允许 primary session |
| `/status` internal data | 删除 `context`；保留 `contextWindow` |
| ContextManager | 内部破坏性签名调整；全仓一次迁移 |
| SystemPromptProvider | 内部破坏性签名调整；调用者显式传 names |
| Lifecycle resolveTools | final step 调用行为改变；outbound schemas 仍为空 |
| storage | 无 schema/migration |
| cache usage | 无字段、无行为变化 |

回滚按 Phase 反向 revert。Phase 3 可独立回滚；Phase 2 依赖 Phase 1 的 tools-aware API，但不改变其计量公式。

---

## 2.6 风险、缓解与回滚

| 风险 | 影响 | 缓解 | 回滚 |
|------|------|------|------|
| final step 因解析 tools 产生额外 scheduler 工作 | 延迟小幅变化 | 与当前 prompt `toolsProvider` 的隐式解析等价；单测确认只做路径级一次 schema/name 解析 | 恢复侧通道，不推荐 |
| static 数字修正后跳高 | 用户观感 | 这是修正漏计；本批不新增 UI 解释 | static 不传 schemas |
| child window query 从错误数字变为 null | 行为变化 | 明确产品边界；无 UI 消费者 | 不能回滚成伪精度；若未来需要必须设计 scoped API |
| compact 后 event 重复 | UI 重复刷新 | 只在 manual compact adapter 发布；run path 仍由 stream adapter 发布 | 仅保留 tracker 更新 |
| assemble/options 迁移漏调用点 | 编译/行为回归 | TypeScript + 全仓 `assemble(` 搜索 + tests | 原子 revert Phase 1 |
| status `context` 有未知消费者 | 内部展示缺字段 | 实施前全仓搜索；已知 TUI 只读 `contextWindow` | 单独恢复字段会重开双源，需重新规划 |

---

## 2.7 与用户边界对齐

| 用户确认 | 方案落点 |
|----------|----------|
| 方案 A | Phase 2：primary static/manual；subagent runtime only |
| 子代理需自动 compression 占用监控 | Phase 2 第 6 步 + TC-6/7 |
| 子代理不需要 UI | Out-of-scope + child query unavailable |
| 删除 status `context` | Phase 3 第 1–2 步 |
| improve-5 暂不做 | §2.8 |
| 4.1 后先审查压缩 | README/00 路线；不混入本实现 |
| cache 后再复核压缩 | README/00 路线 |

---

## 2.8 不在本批

- prompt cache 语义、命中率、费用与 usage 字段
- 手动/自动压缩策略、threshold、档位、summary prompt、剪裁和 prune 算法审查
- 主代理占用 breakdown 与新 UI
- 子代理静态 API、UI、scope-aware tracker
- memory tool/hooks
- tokenizer 替换、factor persistence、mask 开启
- provider transport request 重构
- MCP menu 两条查询的全面合并
- 新的外部协议字段或数据库 migration

---

## 2.9 实施提交批次

用户已要求分批 commit。建议保持以下原子边界，测试随对应代码提交，不单独堆成“补测试”提交：

1. `docs(context): finalize improve-4.1 contracts`
2. `refactor(context): unify measurement and prompt tool flow`（Phase 1 + 单测）
3. `fix(context): close primary static and manual usage paths`（Phase 2 + 单测/集成）
4. `fix(context): unify status and compacted window usage`（Phase 3 + 合同/集成）
5. 验收发现 gap 时按问题单独提交；不把不相关修复揉进上述批次。

实施完成后先跑 04 发布门，再启动独立子代理审查；审查修复完成后重跑发布门，最后进入验收模式产出 05。
