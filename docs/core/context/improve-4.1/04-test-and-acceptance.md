# 4. 测试与验收标准

项目无独立 `test-blueprint.md`。沿用 vitest：`*.unit.test.ts` / `*.contract.test.ts`。context 模块文档 `docs/core/context/test.md` 的 85% 阈值已过期，本批不修订该文件（与 G2 gap 同批不修）。

**合同翻转（针对 improve-4 TC-11）：** improve-4 曾要求静态/手动路径保持 messages-only。本批实施后，那条合同必须改掉，否则旧测试会把正确行为判失败。见 TC-10。

---

## 4.1 测试范围

| 层 | 覆盖什么 | 不覆盖 |
|----|----------|--------|
| 单测 | `getUsage`/`compact` 含 tools；factor 同量纲；assemble options；prompt 收 `toolNames` 且生产路径不拉 registry；composition 静态/手动传入 schema 与 session 身份 | tokenCounting 算法本身；压缩策略是否该换阈值 |
| 合同 | `/status` 占用字段同源；`getContextWindowUsage` 回落走含 tools 的静态计算 | HTTP 协议新增字段 |
| 集成 | 不强制新开 daemon e2e。Lifecycle 实时路径回归：含 tools 的 prepareTurn **不变坏** | 真实 provider；cache 命中 |
| 手工 | 冷启动 `/status` 与跑过一轮后的占用条；主会话 `/compact` 后数字下降 | 子代理占用 UI（无入口） |

发布门命令（实施时以仓库脚本为准）：

```
pnpm test -- packages/ohbaby-agent/src/core/context
pnpm test -- packages/ohbaby-agent/src/core/system-prompt
pnpm test -- packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts
pnpm test -- packages/ohbaby-agent/src/commands/service.unit.test.ts
pnpm test -- packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts
```

相关文件全绿，且 4.5 的 rg 守卫通过。

---

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 对应 02 Phase |
|----|------|------|--------|----------------|
| TC-1 | 同一 assembled messages，传入非空 tools vs 不传 | 单测 `manager.unit.test.ts` | `getUsage(..., tools)` 的 `currentTokens` **严格大于** `getUsage` 不传 tools；`compact({ tools })` 的 `usageBefore` 同样 | Phase 1 / P1 |
| TC-2 | 共用 factor 同量纲 | 单测 | 与现有单测同构：`updateCalibrationFactor(session, 300, 100)`，prev=1、α=0.5 → factor=**2**（`0.5×3 + 0.5×1`）。启发式含 tools 为 H 时，`currentTokens === round(H × factor)`；**不是** `round(H × factor) + H_tools` | Phase 1 / P2 |
| TC-3 | prompt 只消费名字 | 单测 `provider.test.ts` | `build({ toolNames: ["read","bash"] })` 使 prompt 含这些名；**不**调用 `toolsProvider`。composition 生产装配不传 `toolsProvider` | Phase 1 / P5 |
| TC-4 | 子代理会话静态查询 | 单测 `composition.unit.test.ts` | session `isSubagent: true`, `agentName: "explore"` 时，`assemble` options 含这两项；memory loader **不被**调用（沿用 assemble 既有行为） | Phase 2 / P3 |
| TC-5 | 主会话静态查询默认身份 | 单测 | 无 session 或 `isSubagent: false` 时不把主会话当子代理；`resolvePromptTools` 的 `isSubagent` 为 false | Phase 2 |
| TC-6 | `/status` 不再二次现算 | 单测 `commands/service.unit.test.ts` | `getContextWindowUsage` 被调用；`getContextUsage` **不被**独立调用，或若仍输出 `context` 字段则与 window 的 `currentTokens` 相等 | Phase 3 / P4 |
| TC-7 | tracker 命中时 `/status` 与占用条同数 | 单测或合同 | tracker 预置 `{ currentTokens: 38400, ... }` 时，status 的 `contextWindow.currentTokens === 38400`，不回落静态 | Phase 3 |
| TC-8 | 空 tools / 缺省 tools | 单测 | `tools=[]` 与不传 tools 的 heuristic 相等（与 improve-4 `estimateWireHeuristic` 既有行为一致） | Phase 1 |
| TC-9 | 手动 compact 把 tools 传入内部重测 | 单测 `manager.unit.test.ts` | **直接**断言 `compact({ tools })` 的 `usageBefore` 含 schema，且 prune/投影后的重测仍带**同一份** `tools`。禁止只靠 prepareTurn 间接覆盖 | Phase 1 / P6 |
| TC-10 | **翻转 improve-4 TC-11** | 单测 | `composition.getContextUsage` **不再**断言 `assemble(sessionId, dir)` 两参数完事；改为断言传入 tools 且 assemble 走 options。旧「不向 ContextManager 传 schema」断言删除 | Phase 1 / P7 |
| TC-11 | 实时路径未回退 | 单测 `lifecycle.unit.test.ts` | `resolveTools` 仍在 `prepareTurn` 之前；final step **schema** `tools=[]` 仍成立 | 回归 |
| TC-12 | HTTP 身份不可由客户端伪造 | 合同/代码 | `getContextWindowUsage` 请求参数仍只有 `sessionId`；rg 公开协议无 `isSubagent` | Phase 2 / U3 |
| TC-13 | final step prompt 仍含工具名 | 单测 `lifecycle.unit.test.ts` | `isFinalStep` 时 `prepareTurn` 的 `tools` 为空数组，但 `toolNames` 非空且与本轮已解析定义一致；`systemPromptProvider.build` 收到这些名字 | Phase 1 / F1-F2 |

未编号、**本批不做故无验收项**：breakdown 字段、cache usage、压缩阈值、子代理占用 UI、`ContextUsage.tokens = null`。

---

## 4.3 集成边界

- **composition ↔ ContextManager**：tools 由 composition 解析，ContextManager 只计量。测试里 ContextManager 用传入的 tools JSON，不 mock registry。
- **composition ↔ SessionManager**：身份只从 `sessionManager.get` 读。测试用 in-memory session。
- **composition ↔ SystemPromptProvider**：`toolNames` 与 schema 来自同一次 `resolvePromptTools`。禁止 prompt 再调 `getAvailableTools`。
- **commands ↔ tracker**：`/status` 占用权威 = `getContextWindowUsage` = tracker 优先。
- **Lifecycle ↔ ContextManager**：计量时序不改（仍先 resolve 再 prepareTurn）；须透传 `toolNames`。TC-11 守 schema 为空；TC-13 守 prompt 名字非空。

---

## 4.4 回归清单

- improve-4 实时：非 final step 含 tools，final step 空 tools，prune/投影重测透传 tools。
- improve-3：`measureUsage` 仍是唯一占用入口；校准 EMA α=0.5、clamp `[0.5, 3.0]`、不写库。
- mask 默认仍关闭。
- 压缩阈值仍 0.95（不「顺便」改成文档里的 85%）。
- 成功 compact 默认不发 notice。
- `AssembledContext` 仍无 tools 字段。
- Memory：子代理仍不 load；主会话仍只读注入。
- SQLite schema 无 migration。
- SDK `UiContextWindowUsage` 无 breakdown / cache 字段。
- `assertCanUseAsPrimarySession` 仍阻止对子代理会话提交主 prompt / 手动 compact 命令（计量允许查询，命令规则不动）。

---

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| 静态含 tools | 有 schema 时静态 `currentTokens` > 仅 messages | TC-1、TC-10 |
| 不双计 | 无「heuristic 后再加一遍 tools」的实现 | TC-2 + 读 `measureUsage` |
| prompt 依赖方向 | 生产 `createSystemPromptProvider` 无 `toolsProvider` | TC-3 + `rg toolsProvider composition.ts` |
| 子代理测得对 | 静态查询把 `isSubagent`/`agentName` 传入 assemble | TC-4 |
| `/status` 单源 | 不并行调两套算法 | TC-6、TC-7 |
| 实时未回退 | Lifecycle 合同仍绿；final step schema 空、prompt 名非空 | TC-11、TC-13 |
| 协议未膨胀 | 公开 API 无身份字段、无 breakdown | TC-12 + rg |
| 文档同步 | `architecture.md` 写明计量对象是信封 | 读 diff |

rg 守卫（实施验收时跑）：

```
rg "breakdown" packages/ohbaby-sdk/src/context-window.ts
rg "prompt_tokens_cached|cache_read" packages/ohbaby-agent/src/core/context
rg "toolsProvider" packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts
```

前两项应无新增；第三项生产装配应为零命中（测试夹具除外）。

---

## 4.6 对抗性审查要点

1. **旧 TC-11 把本批正确行为判失败。** 防御：Phase 1 同一 PR 改 `composition.unit.test.ts`（TC-10）。残余：其它包若复制了「messages-only」注释，搜 `messages-only` 清掉。
2. **照抄 pi 的 `systemPrompt` 字段导致 system 计两遍。** 防御：`RequestPayload` 只有 `messages`+`tools`；TC-1 的 messages 已含 system 角色。残余：有人把 `systemPrompt` 字符串再 `estimateTokens` 一次——code review 拦。
3. **final step 从空 schema 推导 toolNames，prompt 丢掉工具列表。** 防御：`tools` 与 `toolNames` 拆开（02 决策表）；TC-13。
4. **ContextManager 为了「方便」自己去 resolve tools。** 防御：SRP 与 rg `toolScheduler` inside `core/context/`。禁止。
5. **静态路径用 final step 空 tools，占用条比对话中突然变小。** 防御：00/02 已锁「非最后一步完整 tools」。测试用非空 tools。
6. **把 `isSubagent` 加到 HTTP 让客户端说了算。** 防御：TC-12。身份只信 Session。
7. **`/status` 只删了 `getContextUsage` 调用，tracker 未命中时回落仍 messages-only。** 防御：Phase 1 必须先于 Phase 3；TC-7 之外要有「tracker 空 → 回落值已含 tools」的单测（可附在 TC-1 的 composition 级）。
8. **assemble 改 options 漏改 `prepareTurn` 内部调用，实时路径静默丢 `agentName`。** 防御：TypeScript + TC-11 + 搜 `assemble(`。
9. **为对齐口径顺手加 breakdown 或 cache 字段。** 禁止。无验收项。
10. **拆除 `assertCanUseAsPrimarySession` 以便「测子代理 compact」。** 禁止。那是产品规则；计量测试走 `contextManager.compact` 单测即可。
