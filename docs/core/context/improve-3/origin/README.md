# ADR · Origin 来源追踪：推迟 taxonomy，先做收口接缝

> 类型：架构决策记录（ADR）
> 日期：2026-06-24
> 状态：**已实施（Batch 4）**
> 关联：improve-2 Phase 5（origin 追踪规划）、improve-3/投影层、improve-3/压缩多策略、路线图 2.6（SQLite 查询接口）

---

## 背景（Context）

improve-2 Phase 5 与 2026-05-28 分析文档把"消息 origin 追踪"列为 P1 / 低垂果实，建议参照 kimi-code 的 `PromptOrigin`（10 种 kind：user / skill_activation / injection / compaction_summary / system_trigger / background_task / cron_job / cron_missed / hook_result / retry）为 ohbaby 引入来源字段。

在 improve-3 推进到本层时，对 ohbaby 实际代码做了需求核验（grep `synthetic` / `metadata.kind` / `injection` / `reminder` / `skill` / `background` / `cron`）：

**ohbaby 消息历史中唯一的"非自然"合成内容是 `context-summary`**（`context-manager.ts:574/638`），且它已带 de-facto 来源标记 `metadata.kind === "context-summary"`，被 4 处消费（`summary.ts:6`、`message/converter.ts:6`、`adapters/ui-state/persistent-store.ts:119`、`context-manager.ts`）。

**不存在**注入系统、system reminder、skill-激活-作为-消息、background 通知、cron——这些在 message/context 层一个都没有。kimi 有 10 种 kind，是因为它真有 swarm 注入 / 后台任务 / cron / hooks / steer 这些消息源；ohbaby 当前一个都没有。

---

## 决策（Decision）

**不在当前阶段构建 `PromptOrigin` taxonomy。改为只做一个收口访问器 `getMessageOrigin()`，并把完整 taxonomy 推迟到其首个真实消费方（注入/后台系统，improve-2 Phase 6）落地时共同设计。**

依据（references/00 认知陷阱 · 过早抽象；references/03 KISS/YAGNI）：

1. **消费方尚未出生**。origin 的真实用途（区分注入消息、只合并真 user 消息、跳过/标记 background 等）对应的消息源在 ohbaby 都不存在。在 improve-3 当前范围内，origin **不阻塞任何东西**：
   - 区分 summary：已用 `isSummaryMessage`（`metadata.kind`）解决。
   - 投影层 mask 豁免 write/edit/skill：按 `part.tool` 工具名判断，不需要 origin。
   - 压缩多策略排除 summary：用现有 `isSummaryMessage` 即可。
2. **"采集免得丢"论据不成立**。该论据只对"写入时来源即模糊"的内容有效；而 ohbaby 现在每条消息来源都能从现有字段无歧义推导（`role` + `metadata.kind` + part `type` + `agent`）。信息丢失从"注入 user 角色但非用户的内容"那刻起才开始——那一刻尚未到来。故"现在埋字段"买不到保险。
3. **在真空中定 taxonomy 必定定错**。kind 的形状取决于消费方如何判别它们；没有消费方就定，将来大概率返工。origin 应与首个消费方共同设计。

---

## 现在做什么：`getMessageOrigin()` 收口接缝

唯一立即落地的一步，价值是**封装"来源从哪读"**（DIP），把现在散在 4 处的 `metadata.kind === "context-summary"` 判断收口到一个函数，使将来扩展不波及消费方。

```ts
// core/message 内
export type MessageOrigin = "user" | "assistant" | "system" | "tool" | "summary";

export function getMessageOrigin(message: MessageWithParts): MessageOrigin {
  if (message.parts.some(isContextSummaryPart)) return "summary";
  if (message.parts.some((p) => p.type === "tool")) return "tool";
  return message.info.role;
}
```

- **纯派生、零存储改动、零运行时风险**：只从现有字段推导，不新增 schema、不写库。
- **单一收口点**：投影层、压缩多策略、UI 若需判别来源，统一走 `getMessageOrigin`，不再各自 `metadata?.kind === "context-summary"`。
- **可演进**：将来引入显式 origin（落 `PartMetadata.origin` 或升级为列）时，只改 `getMessageOrigin` 内部，消费方不动。

> Batch 4 实施注记：`system` 不是新增 taxonomy kind，而是现有 `message.info.role` 的无损透传；`summary` 仍是当前唯一的合成来源，由现有 `metadata.kind === "context-summary"` 派生。

> 范围红线：本轮**不**新增 `injection` / `skill_activation` / `background_task` / `cron_*` / `hook_result` / `retry` / `system_trigger` 等 kind——它们没有产生者，也没有消费者。

---

## 何时重启完整 origin 设计（Trigger）

满足**任一**条件时，回到本 ADR、与该消费方共同设计 `PromptOrigin` taxonomy：

1. **注入/后台通知系统立项**（improve-2 Phase 6）：出现第一条"user 角色但非用户发出"的消息（注入提醒、background 完成通知）——此时需要 origin 区分"真 user"与"注入"，对应 kimi `canMergeUserMessage` / `popMatchedMessage` 场景。
2. **SQLite 历史查询接口立项**（路线图 2.6）：若要按来源检索历史（"找出所有 skill 激活"），需评估把 origin 从 JSON metadata 升级为可索引列。
3. **skill 激活/子代理结果需要按来源差异化投影或压缩**，且无法用 `part.tool` / `agent` 字段满足时。

重启时的约束：taxonomy 只加"有真实产生者 + 真实消费者"的 kind，逐个长出来；优先落 `PartMetadata.origin`（向后兼容），仅在查询需求确凿时再评估升列。

---

## 后果（Consequences）

- ✅ 避免在真空中定错 taxonomy 与随之而来的返工。
- ✅ 收口 `metadata.kind` 的 4 处分散判断，降低后续扩展的改动面。
- ✅ improve-3 投影层 / 压缩多策略不被 origin 阻塞，可独立推进。
- ⚠️ 历史消息不预埋显式 origin；待 Phase 6 引入显式 origin 后，更早的历史消息只能按派生规则回退处理（与 improve-2 Phase 5 "无 origin 的历史按 legacy 处理"一致，可接受）。
