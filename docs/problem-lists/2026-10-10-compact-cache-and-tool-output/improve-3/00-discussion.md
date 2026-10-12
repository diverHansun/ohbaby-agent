# 本批结论与来源

> 更新：2026-10-12。本文件只记录第 3 批已确认的结论与来源，不复述整体方案。整体规则见 [plan/00](../plan/00-discussion.md) 与 [plan/02](../plan/02-optimization-plan-and-change-scope.md)；讨论过程见 [plan/discussion-notes.md](../plan/discussion-notes.md)。

## 本批在整体中的位置

按「错法」分批，第 3 批处理的是**请求发错**：摘要请求的 wire（材料、输出字段、缓存、重试口径）与本批接通的触发保护。用户确认保留五批，第 3 批同时接入完整摘要请求、90% 默认线和必要的容量提前保护；第 5 批贯通入口并清扫剩余旧机制，不补交本批的正确性（[discussion-notes §17.8／§17.12](../plan/discussion-notes.md)、[plan/02 §9](../plan/02-optimization-plan-and-change-scope.md)）。

## 已确认结论（本批直接依据）

1. **摘要材料同源**：摘要基于同一份将要发出的正常请求材料，保持 system、tools、既有消息顺序、原生状态、模型/端点、已解析 thinking 和适用缓存身份，只在末尾追加摘要指令。不换短 system、不删 tools、不降 thinking（[plan/00 §2](../plan/00-discussion.md)）。
2. **取消前置 prune**：本批接入完整摘要请求时，同批取消共用入口的前置 prune 和 prune-only 返回，失用代码同批清理，不留临时开关（[discussion-notes §17.12](../plan/discussion-notes.md)、[plan/02 §9.2](../plan/02-optimization-plan-and-change-scope.md)）。摘要前不改写已发送的旧工具正文，失败或提交前 Stop 不留 prune 退场。
3. **摘要输出独立**：正文 ≤ 16K；无 thinking 以 16K 申请；fixed thinking 用 `16K＋已有 B`；effort/adaptive 用 `16K 正文＋试行 thinking 预留`、合计 32K。三者都是发送时的输出上限，用 per-request override 发送，不触碰普通请求（[discussion-notes §17.7／§17.15](../plan/discussion-notes.md)）。
4. **单一重试所有者**：摘要至多首次＋一次暂时性网络重试，共两次实际请求；三个 provider 建 client 显式 `maxRetries: 0`，SDK 隐式重试收进应用层（[discussion-notes §17.15](../plan/discussion-notes.md)）。
5. **触发与容量**：自动摘要默认 90%，按完整窗口占用 `currentTokens / contextLimit` 判断，不含输出预留帽；带 50% 帽的 `usageRatio` 只服务 mask 触发，不进入容量检查（[plan/02 §4.3](../plan/02-optimization-plan-and-change-scope.md)）。
6. **容量检查全量**：摘要请求的容量检查把摘要输出额度显式传给预算解析，不取 `profile.maxOutputTokens`（普通偏好）（[plan/02 §4.1](../plan/02-optimization-plan-and-change-scope.md)）。
7. **用量归属**：成功的摘要请求记录随摘要消息的 `modelRequests` 携带；本批先把用量挂上结果/请求记录，**同事务落库与原子切换在批 4** 完成；没有摘要消息的失败只写一行日志（[discussion-notes §17.5](../plan/discussion-notes.md)、[plan/02 §6.1](../plan/02-optimization-plan-and-change-scope.md)）。

## 本批不做（边界）

- 不做模式 A 的受保护裁剪与遗漏记录、模式 B 的保留段收缩、单滚动摘要、原子提交与最终失败终止——这些是批 4。
- 不改 tools／原 tool_choice 语义；不造冷热分流、老摘要 fallback、提示词二次重做；摘要路径不接工具执行器。
- 不把「先裁后误退场」当成本批行为：本批唯一会退场的旧 parts 是成功摘要事务的一部分（批 4 落地），本批不得先 prune 再失败。

## 未决／留给后续

本批结束时是中间态：三协议字段与缓存已接通、prune 已移除、90% 与容量保护已接入；但模式 A/B、原子事务与失败终止未到位。**不能把这一状态单独发布为完整压缩策略**（[plan/02 §9](../plan/02-optimization-plan-and-change-scope.md)）。
