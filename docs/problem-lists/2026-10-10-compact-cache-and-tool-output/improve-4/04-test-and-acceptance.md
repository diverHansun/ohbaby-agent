# 第 4 批测试与验收

> 依据 [00](./00-discussion.md)、[01](./01-problem-analysis-and-current-state.md)、[02](./02-optimization-plan-and-change-scope.md)。本文是**待实施**的验收目标，不是已通过的结果。
> 用仓库已有 Vitest、集成测试与协议契约测试；不新建测试框架，不以覆盖率数字代替风险验证。用例 ID 沿用 [plan 04](../plan/04-test-and-acceptance.md)，便于跨文档追踪。

## 4.1 验收分层

- 单元／契约：切点对齐、超大组保留、模式 B 收缩公式、16K 预扣、地板数值。
- 数据库／调度集成：原子切换、Stop 竞态、新输入、连续压缩、失败终止、跨入口不重试。
- 有界真实 API 探测：本批收尾动作，验证多次压缩后的连续性、旧信息继承、压缩提示与占用刷新时机。

本批**尚未测试**：以下为验收目标。

## 4.2 关键场景与用例

| ID | 批次 | 场景与断言 |
| --- | --- | --- |
| D1 | 4 | 同一 run／scope 内连续**至少三次**成功压缩可继续（占用正常增长、不靠 force 绕过）；预置多份旧摘要各有独有约束，新摘要继承仍有效内容，模型视图只留一份，原记录与旧摘要仍可查库。同批放开次数上限与抖动锁，并完成 E3／E4 终止保护。**地板行为**同批验证：成功提交后压后占用记为地板；占用没涨过地板不重复压，涨过且仍在触发线上才再压；手动与 overflow／force 不受地板限制；**窗口缩小／输出预留增大后，容量保护按完整请求重判，不被旧地板挡住** |
| D2 | 4 | 约 20K 切点对齐到最近合法边界（真实用户消息起点或助手消息起点），不拆 call/result；未闭合调用整组向前扩展；不存在“补齐用户轮到某个上限”的第二档步骤；64K／200K／1M 构造样本覆盖窗口边界，不新增小窗档位 |
| D3 | 4 | 最新不可拆组超过 20K 时**整组保留**；未闭合调用／受保护用户输入不丢；后台任务状态不被写成完成；模式 B 收缩只发生在装不下时，其余情况保留段仍是 20K 首选预算 |
| D4 | 4 | 宿主已知追加信息（文件操作、遗漏说明）在生成前占用同一正文额度，最终正文一起检查 ≤16K；计划内压后完整请求可发送且变小；除模式 B 容量不足的收缩外，不能事后缩尾段或截断摘要来过关 |
| D5 | 4 | 摘要生成途中新输入到达：既有覆盖精确，新输入**不退场、不被摘要冒充普通交付**；提交后普通请求重建并重新检查容量 |
| D6 | 4 | 数据库注入异常、待退场 parts 变更、相关工具组变化、Stop 提交前／后、进程恢复：**全部提交或全部不应用**；已提交不被事后 Stop 误报失败 |
| E3 | 4、5 | 允许的内部重试后自动摘要最终失败，或判定无收益：**结束当前运行**，保留会话、原历史及已完成工具结果；自动／overflow／force 不能在同一运行另开额度；不新增永久锁、计数器或开关。压后仍高于触发线不算失败、会话可继续；占用严格大于地板后才允许再次自动压缩。用户明确继续后进入新运行，不把完成工具当成未执行。第 5 批做各入口贯通回归 |
| E4 | 4、5 | 本批完成普通请求超窗后的 force 一次保护：标志调用前置位、失败不回滚；同一步因输入快照变化重入不重新获额，新 model step／新运行才重置。仅压缩成功、占用下降且容量通过后重发，重发不挂恢复钩子，二次 overflow 终止。最终失败／无收益不另开摘要额度；摘要自身 overflow 只走模式 A。第 5 批做全入口回归 |
| E6 | 4 | 压缩中显示 `Compacting`；完成后消息流出现压前／压后占用的单行提示；提交后调 `updateFromContextUsage` 按新投影刷新 footer 与占用面板，`summarized-conversation` 随之变化；摘要消耗不出现在占用显示，不新建统计口径 |
| E7 | 4、5 | **模式 A**：只裁请求副本的较老完整组，占两次总额度；保护全部活动旧摘要、必留近期内容、新输入及未闭合依赖，不拆工具配对。成功提交时，未进入成功摘要请求且未原样保留的精确 part IDs 和容量原因随摘要正文 part metadata 同事务落库，复用现有退场标记；未读但原样保留的不算遗漏。宿主说明与完成提示体现遗漏；原记录留库。失败／Stop／冲突不得应用裁剪，重开数据库后遗漏可查。保护内容之外无可裁材料则失败；缓存按实际共享前缀及 usage 判断，不断言必然全部 miss |
| E8 | 4、5 | **模式 B**：构造完整输入＋普通全量输出预留＋安全余量超窗，尤其覆盖“输入单独能放下，加输出才超窗”。一次按缺口算保留预算，取 min(20K, 可用空间)，固定材料包含受保护输入与协议开销，各项只计一次。对齐合法边界，不裁受保护输入／未闭合依赖，不拆 call/result；最近完整组仍放不下则失败，不能零尾段。模式 B 不改已成功摘要请求或额度，不另发摘要；更新保留集合后重新计算遗漏、最终正文、容量与收益。不能为了无收益重切；本地失败不继续撞 provider |
| A4 | 1、3、4 | 第 4 批验“摘要成功时记录随摘要消息的 `modelRequests` 同事务落库，失败／中断只在日志留一行”；usage 明细缺失与 0 区分，不新建用量表。归属口径：**自动与手动一致**，`messageId` = 预分配的 `summaryMessageId`，都挂在摘要消息上；`purpose=context-summary` 判别所有权变体，`compactionId` 复用 attemptId；**不**把摘要记录挂到普通消息上；普通请求 `runId／messageId／step` 保持必填，不加 `summaryMessageId` 外键 |
| C4 | 3、4、5 | 空正文、length、工具调用、协议错误、超长，以及“发了摘要但压后占用没下降（无收益）”**直接失败**，不执行工具、不换提示词、不自动升额、不走短 system 兜底；实际消耗仍记账。区分：**没有可压旧段**属于“无需压缩”，跳过且不算失败 |

对应关系：D1～D6 对应 plan P3／P4／P8；E3／E4／E6～E8 对应 plan P2／P7／P8。编号仅用于追踪风险，不要求每行各建一个测试文件。

## 4.3 集成边界

- Context ↔ MessageStore：`commitCompaction` 事务内写摘要＋`modelRequests`＋遗漏 metadata＋parts 退场，全提交或全不应用。
- Context ↔ 调度器：新输入走现有投递，提交只作用计划内精确 IDs；提交后重新准备下一份普通请求。
- Context ↔ LLM 层：消费 prepared 请求，返回有效正文、成功 requestId、预分配 summaryMessageId 和成功 record；模式 A 与网络重试共享第 3 批两次实际请求总预算。
- Context ↔ CLI／Web：`updateFromContextUsage` 提交后按新投影刷新；`composition.summarized-conversation` 已存在。

## 4.4 优先复用的测试位置与命令

现有文件均在 `packages/ohbaby-agent/src/`，后续按实际改动补用例：

| 领域 | 已有位置 |
| --- | --- |
| 切点／计数／预算 | `core/context/token-estimation.unit.test.ts`、`core/context/native-context.unit.test.ts` |
| 原子与恢复 | `core/context/compaction-atomic.integration.test.ts`、`core/context/compaction-hard-crash.integration.test.ts`、`core/message/database-store.integration.test.ts` |
| 摘要序列化／提示 | `core/context/summary-serialization.unit.test.ts`、`core/context/compression-prompt.test.ts` |
| 占用刷新／入口 | `core/context/context-window-usage.unit.test.ts`、`core/context/context-window-policy.integration.test.ts`、`core/context/manager.unit.test.ts` |

示例定向命令，在仓库根执行：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/core/context/compaction-atomic.integration.test.ts \
  packages/ohbaby-agent/src/core/context/compaction-hard-crash.integration.test.ts \
  packages/ohbaby-agent/src/core/message/database-store.integration.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/core/context/token-estimation.unit.test.ts \
  packages/ohbaby-agent/src/core/context/summary-serialization.unit.test.ts \
  packages/ohbaby-agent/src/core/context/context-window-usage.unit.test.ts
```

每个 improve 按代码变更记录实际命令、通过／失败、尚未覆盖范围和证据；只改文档不重跑业务测试；改行为后必须执行对应风险用例与必要静态检查。

## 4.5 真实 API 与上下文探测（本批收尾，非交付物）

- 用 [tests/models-4-tests.md](../../../../tests/models-4-tests.md) 的模型与真实 api-key，在独立 ohbaby 服务、独立测试数据目录、端口与会话中发真实请求；不停止或占用用户现有服务；key 在进程内加载，不写进文档、参数或日志。
- 本批样本：用包含**已知约束、文件引用、错误、未完成任务与后续修正**的历史做多次压缩，检查可继续性与旧信息继承；核对压缩提示、压前／压后占用与刷新时机。
- 失败终止、跨入口不另开额度、用户继续的边界用**可控故障**验证，不靠反复真实调用制造失败；缓存证据分别报告客户端共享前缀与服务端 cache read／create，不要求固定命中率；64K／200K／1M 离线边界通过**不能**写成这些规模都做过实网测试。

## 4.6 摘要内容验收

用可核对的事实清单做样本：早期限制仍有效；用户明确修正被继承；助手建议未变成批准；已完成、未验证、未知结果正确区分；真实命令／文件／任务 ID 保留；后台任务未冒称完成；不因摘要含疑问就机械停止无关工作。自动检查覆盖有效正文、协议、长度、调用关系、提交范围与遗漏记录；语义连续性由人工样本检查，不新增线上审核模型。

## 4.7 对抗性审查要点

- 模式 A 裁剪点与提交范围不一致 → 未读 part 静默退场。防御：精确 IDs＋metadata＋E7。
- 提交前 Stop 与事务竞态留下半次替换。防御：单事务＋D6。
- 删除次数帽后自动／overflow／force 互相补额度死循环。防御：失败终止＋一次性标志＋E3／E4。
- 地板误挡“容量条件变化后的合理再压”。防御：地板只抑制相同容量条件下的重复触发。
- 残余风险：摘要语义完整性不能靠标题存在证明；真实缓存收益待实网。

## 4.8 交付记录

本批验收记录后续写入本目录（`05-implementation-acceptance.md`），包含实际变更、测试、实网结果、兼容与回退限制、未解决问题。本规划**不**提前生成验收结论，也不新建文档自检报告文件。
