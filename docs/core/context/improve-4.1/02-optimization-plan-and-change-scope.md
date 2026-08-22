# 2. 优化方案与改动面

> 实施契约。规划会话不写代码。开发者/实施 agent 按本文 + [04](./04-test-and-acceptance.md) 执行；完成事实写入 05。
> 基线：`84006096`。约束来自 [00](./00-discussion.md)，证据来自 [01](./01-problem-analysis-and-current-state.md)。

---

## 2.1 方案总览

给「这一次要发给模型的信封」起名为 `RequestPayload`：`messages`（已含 system + memory）+ `tools`。占用计量只对它做。`AssembledContext` 不动。

静态查询和手动 compact 在 composition 解析一次工具：名字推进 prompt，schema 推进载荷。session 记录上的 `isSubagent` / `agentName` 自动补进 `assemble`。`/status` 只读 tracker（未命中再回落同一套静态计算）。

```
composition / Lifecycle
    resolvePromptTools()                         // 一次
    assemble({ isSubagent, agentName, toolNames })
    payload = { messages: serializeForLlm(assembled), tools: toOpenAiTools(...) }
    usage = measureUsage(payload) × 共用 factor
         │
         ├─ 实时：prepareTurn 已走这条（improve-4）
         ├─ 静态：getContextUsage 改为走这条          ← 本批
         └─ 手动：compact 的 usageBefore/重测走这条    ← 本批

/status → tracker.get() → 未命中才回落 getContextUsage
```

载荷层是 **类型 + 让现有 `measureUsage` 吃它**，不是新包、不是 opencode 式两段规范化。

---

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| 载荷形态 | `RequestPayload = { messages, tools? }`，放在 `core/context/types.ts` | 01：`serializeForLlm` 已把 system 折进 messages；pi 三分法在 ohbaby 会双计 system。计量入口已在 context | 把类型放到 `llm-client`；照抄 pi 的 `systemPrompt` 字段 | 名字与 pi 不完全同构，文档里写清 |
| 载荷是不是新模块 | **不是。** 类型 + `measureUsage` 的输入 | YAGNI；03 A3 已拒两段式 | `core/context/payload.ts` 大类 / 独立包 | 若将来 llm-client 也要同一类型，再抽 |
| 谁解析 tools | composition（静态/手动）与 Lifecycle（实时），**ContextManager 不碰 registry** | 延续 improve-4 SRP | ContextManager 调 toolScheduler | composition 必须把 schema 传进 compact/getUsage |
| prompt 如何拿到工具名 | `SystemPromptProvider.build` 入参加 `toolNames`；composition 生产路径**不再设** `toolsProvider` | 01 P5；03 C3 push 模型。一步到位，调用方少 | 保留 `toolsProvider` 双通道过渡 | 单测要改为传入 `toolNames` |
| `assemble` 签名 | 后三个位置参数收成 options：`{ isSubagent, contextScopeId, agentName, toolNames }` | 01：`compact()` 漏 `agentName` 就是位置参数排到第五个被忘掉。这是在修偶然复杂度 | 再加第六个位置参数 | 内部调用点与单测要改；无外部协议 |
| `tools` vs `toolNames` | **拆开。** `tools` = 本 step 发给模型的 schema（final step 为 `[]`）；`toolNames` = prompt 用的完整名字（final step **仍非空**） | 今日 prompt 经 `toolsProvider` 拿名字，与 schema 是否清空无关。合并成一个字段会在 final step 把 prompt 工具列表一起清掉 | 从空 schema 推导 names；final step 也清空 names | Lifecycle / `prepareTurn` 必须透传 `toolNames`（计量时序仍是先 resolve 再 prepareTurn） |
| `getUsage` | 增加可选 `tools`（或直接吃 `RequestPayload`） | 扩大既有入口，不新建第二个 | 新函数 `getPayloadUsage` | 旧调用不传 tools 仍合法，实施期要保证生产路径都传 |
| 静态路径 step 语义 | 按「非最后一步」带**完整 tools** | 00 §6。静态没有 step 游标 | 模仿 final step `tools=[]` | 与实时最后一步数值不必相等 |
| 校准因子 | 继续共用，公式不动 | 01 U7：纳入 tools 后同量纲；pi 锚点增量会双计 | 静态专用 factor；条件计入 tools | 无 |
| 子代理查询 | 从 `Session.isSubagent` / `agentName` 补参；**不加守卫** | 00 §4。HTTP `getContextWindowUsage` 本就可以打到子会话 | 拒绝子代理查询 | 查询成本与主会话同级 |
| `contextScopeId` | 静态查询**默认不传**（列出该 session 全部消息） | `Session` 上没有这个字段；scope 是 run 内过滤键 | 编造 scope / 扩 HTTP | 多 scope 并存于同一 session 时，静态值是全量而非「当前 run」——可接受，第 4 批再细化 |
| `/status` 口径 | **只读** `getContextWindowUsage`（tracker 优先，未命中回落静态）。载荷里的 `context` 与 `contextWindow` 必须同源，或不再单独现算 `context` | 01 P4。TUI 已展示 `contextWindow` | 继续双取再在展示层对齐 | 若保留 `context` 字段，需从同一结果投影，避免两次数值 |
| 公开 HTTP | **不扩** `isSubagent` / `agentName` 参数 | 身份在服务端从 Session 读出 | 让客户端传身份 | 客户端传身份可被伪造口径 |
| architecture.md | Phase 1 补一句：计量对象是请求信封，D1 组装源不变 | 01 U6 | 新画一个组件框 | 小文档同步 |
| 关键改动清单 | **不写** | 本规划会话用户未要求 | — | 包/文件级改动面见 §2.3 / §2.4 |

**不可逆性**：全部是进程内 TypeScript 与文档。无存储迁移、无对外协议版本。可逆。

---

## 2.3 分阶段实施

三个纵切，顺序固定。每一刀结束后应能编译、单测绿、行为可说明。

### Phase 1 — 信封计量闭环（回应 P1、P2、P5、P6 的 tools 部分）

**目标**：凡是算占用的地方，算的都是 `{ messages, tools }`。静态主会话路径含 schema。prompt 不再自己拉 registry。

**改动**

1. 在 `core/context/types.ts` 增加 `RequestPayload`。`measureUsage` / `measureContext` 继续是唯一入口，输入视为载荷（messages 必有，tools 可选）。
2. `getUsage(context, modelId, tools?)`：内部 `measureContext({ tools })`。
3. `CompactOptions` 增加可选 `tools`。`compact()` 把同一份 tools 传给 `usageBefore` 和 `runCompaction`（与 `prepareTurn` 已做的透传同构）。
4. `assemble` 改为 `(sessionId, directory, options?)`。`systemPromptProvider.build` 增加 `toolNames`：**生产路径必填**（由上层传入；缺省不得静默当 `[]`）。有 `toolNames` 则不再调用 `toolsProvider`。测试夹具可保留 `toolsProvider` 回落。
5. `createSystemPromptProvider` 的生产装配（`composition.ts`）去掉 `toolsProvider`。
   - 静态/手动：`resolvePromptTools` 一次 → `toolNames` 给 `assemble`，schema 给 `getUsage`/`compact`。
   - **实时：Lifecycle 必须同时传 `tools`（schema）和 `toolNames`（名字）。** `PrepareTurnInput` / `prepareTurn` → `assemble({ toolNames })`。final step：`tools=[]`，`toolNames` 仍为本轮完整名字（可再 resolve 一次，或复用本 turn 已解析的定义）。**禁止**从空 schema 推导 names。
6. `composition.getContextUsage`：`toOpenAiTools(await resolvePromptTools(...))` 后 `getUsage(assembled, model, tools)`。本阶段身份参数仍可默认主会话（Phase 2 补）。
7. `composition.compactSession`：解析 tools 传入 `compact()`。
8. 同步 `docs/core/context/architecture.md`：计量对象 = 请求信封；tools 不进 `AssembledContext`。
9. **禁止**：改校准公式、加 breakdown、改阈值、碰 cache、ContextManager 依赖 toolScheduler。**计量时序不改**（仍先 resolve 再 prepareTurn）；Lifecycle **只增加 `toolNames` 透传**。

**DoD**：04 TC-1、TC-2、TC-3、TC-8、TC-9、TC-11、TC-13。

### Phase 2 — 任何 agent 正确传参（回应 P3、P6 的身份部分）

**目标**：静态/手动路径从 `Session` 读取 `isSubagent`、`agentName`，传进 `assemble` / `resolvePromptTools`。不加守卫。

**改动**

1. `composition.getContextUsage` / `compactSession`：`sessionManager.get(sessionId)` → 补参。session 缺失时保持主会话默认并打已有 warning 通道，不抛成 500。
2. `ui-inprocess.getContextWindowUsageInternal` 的回落走同一 `runtime.getContextUsage`（已走 composition）。确认 `compactSessionInternal` 在 `assertCanUseAsPrimarySession` 之外，若将来允许子会话 compact，composition 已能正确计量——本批不拆除该守卫（它管的是「主会话命令」，不是计量）。
3. 不把身份字段加到 HTTP / JSON-RPC 参数表。

**DoD**：04 TC-4、TC-5、TC-12。

### Phase 3 — `/status` 单一权威（回应 P4、P7）

**目标**：同一时刻占用条与 `/status` Context 行、以及 status 载荷内的占用字段，不再出现两套算法。

**改动**

1. `handleStatus` 以 `getContextWindowUsage` 为占用权威（其内部已是 tracker 优先 + 静态回落）。
2. 若仍输出 `context: ContextUsage`：从同一结果投影，**禁止**再调一次 `getContextUsage`。推荐：TUI 只用 `contextWindow`，`context` 可保留为同源投影以免破坏合同形状，但数值必须一致。
3. 更新 `commands/service.unit.test.ts`：不再把「两次独立取值」当合同；改为「同源」或「只调 window」。

**DoD**：04 TC-6、TC-7、TC-10。

---

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `packages/ohbaby-agent/src/core/context/` | `RequestPayload` 类型 | `types.ts`、`context-manager.ts`、`manager.unit.test.ts` | 无 | 计量入口扩输入；assemble 改 options |
| `packages/ohbaby-agent/src/core/system-prompt/` | 无 | `assembler.ts`、`__tests__/provider.test.ts` | 生产路径的 `toolsProvider` 接线 | `build` 收 `toolNames` |
| `packages/ohbaby-agent/src/adapters/ui-runtime/` | 无 | `composition.ts`、`types.ts`、`composition.unit.test.ts` | 无 | 静态/手动解析 tools + 补 session 身份 |
| `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` | 无 | 仅当回落/status 接线需要 | 无 | 尽量把逻辑收在 composition |
| `packages/ohbaby-agent/src/commands/` | 无 | `builtin.ts`、`service.unit.test.ts` | 无 | `/status` 单源 |
| `docs/core/context/architecture.md` | 无 | 计量对象说明 | 无 | 与 D1 对齐 |
| `docs/core/context/goals-duty.md` | 无 | 可选：D2 补一句「计量对象含即将发出的 tool schema」 | 无 | 不把 tools 写入 D1 组装源 |
| `packages/ohbaby-agent/src/core/lifecycle/` | 无 | `lifecycle.ts`、`lifecycle.unit.test.ts` | 无 | **计量时序不改**（仍先 resolve 再 prepareTurn）。**必须**向 `prepareTurn` 透传 `toolNames`；final step schema 为空、names 非空 |
| `services/llm-model/tokenCounting.ts` | 无 | 不改 | 无 | 00 硬约束 |

---

## 2.5 API / 协议 / 迁移与兼容

| 面 | 策略 |
|----|------|
| HTTP `GET /v1/sessions/:id/context-window` | 路径与响应形状不变。服务端回落计算变准 |
| JSON-RPC `getContextWindowUsage` / `compactSession` | 同上 |
| `/status` 载荷 | `contextWindow` 必在。`context` 若保留必须与 window 同源；允许删除仅当 04 合同同步修改且确认无展示依赖（TUI 已不读 `context`） |
| `ContextManager.assemble` / `PrepareTurnInput` | **内部破坏性**。`prepareTurn` 增加 `toolNames`。无包外 SemVer |
| `SystemPromptProvider.build` | 内部接口。测试夹具补 `toolNames` |
| 存储 / 校准 Map | 不迁。重启仍从 1.0 开始 |
| SDK `UiContextWindowUsage` | 不加字段 |

回滚：按 Phase 反向 revert。Phase 3 独立；Phase 2 独立于 Phase 1 的计量正确性（只影响子代理身份）。没有双写期。

---

## 2.6 风险与回滚

| 风险 | 可能性 | 影响 | 缓解 | 回滚 |
|------|--------|------|------|------|
| 静态含 tools 后占用条跳变（用户以为「突然多用了」） | 中 | 观感 | 这是修正少算，不是回归。04 用前后对比单测钉住「含 tools ≥ 不含」。不在 UI 文案解释（第 4 批的事） | 去掉 composition 传入的 tools 即可回到 messages-only |
| `getAvailableTools` 在冷启动 `/status` 变慢 | 低 | 延迟 | 01 U4：assemble 本就会经 prompt 解析一次；本批是同一次两用 | 回退 prompt 到 `toolsProvider` |
| assemble 改 options 漏改调用点 | 中 | 编译失败 | TypeScript 会抓住；全量搜 `assemble(` | 提交粒度：签名与调用点同一 commit |
| `/status` 去掉二次现算导致某消费者缺 `context` | 低 | 展示空 | 先做同源投影，确认 TUI/Web 不读该字段后再考虑删除 | 恢复双取（不推荐） |
| 手动 compact 因含 tools 更频繁触发 prune | 低 | 行为变化 | 这是按真实发出去的体积决策，是正确方向 | compact 不传 tools |

---

## 2.7 与 00 边界对齐检查

| 00 结论 | 02 落点 |
|---------|---------|
| 路子三，AssembledContext 不变 | §2.1 / 决策表「载荷形态」 |
| 工具解析上浮 | Phase 1 第 4–5 步 |
| 正确传参、不加守卫 | Phase 2 |
| UI 口径 tracker 权威 | Phase 3 |
| 静态按非最后一步完整 tools | 决策表 |
| 共用 factor、不新建入口 | 决策表；`measureUsage` |
| 不做 cache / breakdown / 压缩策略 / tokenizer | §2.8 |
| U1 放置与命名 | `core/context/types.ts` · `RequestPayload` |
| U2 prompt 接口 | `toolNames` 入参，生产去掉 `toolsProvider` |
| U3 公开签名 | 不扩 HTTP，服务端读 Session |
| U4 副作用 | 01 已关闭：一次解析两用 |
| U5 缺参调用点 | Phase 1–2：`getUsage`/`compact`/`composition`/`assemble` options |
| U6 architecture | Phase 1 第 8 步 |
| U7 factor 量纲 | 01 关闭；04 TC-2 钉住 |

---

## 2.8 不在本批

与 00 §7 一致，再钉一遍：

- Prompt cache 字段、policy、命中率与成本（improve-5）
- `system / tools / messages` breakdown 与占用条 UI 改造（第 4 批）
- 子代理占用的新展示入口（第 4 批）
- 压缩阈值 / 档位 / prune / summary 策略（第 3 批）
- 长期记忆工具、hooks
- 精确 tokenizer、校准因子持久化、打开 `maskEnabled`
- G2 85% vs 0.95
- 拆除 `assertCanUseAsPrimarySession`（那是提交/compact 命令的产品规则，不是计量规则）
- ContextManager 内解析 MCP/工具注册表
- 把 `RequestPayload` 做成独立包或 llm-client 门面
