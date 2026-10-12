# improve-1：计数与预算同源、能力与偏好分离、危险恢复分支移除

> 性质：修 bug ＋ 计量，可最快单独合入，不受其他批次进度阻塞。
> 本批规划日期：2026-10-12。代码基线 git HEAD：`c5cfda2689fd48dec5c8002bffe626bfca354caf`（整体 plan 的调查基线是 `24c70034`，此后只有 TUI／CLI 测试等提交，本批涉及的文件已按当前 HEAD 复核）。
> 状态：**尚未实施**。本目录只写规划与验收目标，不含已通过结论，也没有 `05-implementation-acceptance.md`（实施完成后由验收模式创建）。

## 本批要解决什么

一句话：**让“算的账”和“发的请求”用同一份数字，让模型真实能力不再被普通输出偏好和一张过期的内置档位表顶替，顺手拿掉一条会静默把没读到的历史当成已压缩的恢复分支。**

对应整体议题的四类故障面里的两类：**计量算错**（本批）和一处独立的**错误退场 bug**。请求发错（第 3 批）、本地切错（第 4 批）、投影不稳（第 2 批）都不在本批。

## 批次边界

**本批做（in scope）**

- 输出预算解析：发送额度与容量预留来自同一个已解析结果；模型真实能力、普通 `/connect` 输出偏好、摘要内部额度三者分开。
- 计数同源：尾段估算与完整请求估算用同一份可回传表示，兼容内存 reasoning 路径不漏计，显示用 reasoning 不重复算。
- 删除 `services/llm-model/modelProfiles.ts` 的内置档位表 `BUILTIN_PROFILE_RULES` 及只为其服务的代码（详见 [02 Stage 1.2](./02-optimization-plan-and-change-scope.md)）。
- 普通输出缺省统一为 8192（现在 writer 是 4096、modelProfiles 是 8192，不一致）。
- `ModelRequestRecord` 增加**可选** `usage` 字段，标准用量补可选 reasoning 子项；只补结构，不新建用量表，缺失不等于 0。
- 移除“摘要请求超窗时缩小输入、却仍按原集合标记退场”的危险恢复分支。

**本批不做（out of scope）**

- 摘要改走同源 prepared 请求、per-request 输出 override、缓存策略、重试合并（第 3 批）。
- 模式 A／B 两种容量失败分流、遗漏记录、单份滚动摘要、固定 20K 尾段、原子切换、压缩提示（第 4 批）。
- 删除前置 prune／prune-only 及失用代码（第 3 批）；删除 mask、每次运行压缩次数上限、无收益抖动锁（第 4／5 批）。
- 工具结果稳定投影（第 2 批）、手动／自动入口贯通与全量清扫（第 5 批）。

## 前后批依赖

- **本批无前置依赖**：不读批 2～5 的成果，可先合入。
- **本批是第 3／4 批的地基**：第 3 批的“发送与预留同一结果”、第 4 批的“模式 B 容量检查取全量 `config.maxTokens`”，都依赖本批先把预算解析层分清、把 `requestedOutputTokens` 作为显式输入。本批没有把 `requestedOutputTokens` 显式传进容量检查（那是第 3 批的接线），只保证解析层能给出唯一的已解析额度。
- **本批移除的恢复分支**由第 4 批的模式 A 以“显式遗漏记录 ＋ 原子提交精确范围”重新实现；本批只做“没接入模式 A 之前，未读历史绝不退场”的保守处理。

## 文档地图

| 文件 | 内容 | 说明 |
| --- | --- | --- |
| [00-discussion.md](./00-discussion.md) | 本批已确认要点与来源 | 只归纳已确认结论，不代写对话 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 本批现状、问题与代码锚点 | 现状诊断，不含目标 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 本批改动面与实施契约 | 最详，给后续开发会话 |
| [03-reference-projects.md](./03-reference-projects.md) | 外部参考（模型能力来源） | 只借思路，不照搬 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 测试与验收目标 | 映射整体 plan 的 A1～A5 |
| `05-implementation-acceptance.md` | 实施完成后由验收模式写入 | 规划期不存在 |

## 与其他批的接口约定

后续各批使用以下接口与口径：

1. `ModelRequestRecord`（`core/llm-client/types.ts:257`）新增**可选** `usage` 字段。它是普通请求和将来摘要请求共用的记录类型；本批只加字段与“缺失≠0”的语义，**不填充**摘要用量（第 3／4 批填）。同时锁定一条不变量：`runId`／`messageId`／`step` 对普通请求仍必填、不造假 run；空闲手动压缩的摘要记录按 `purpose` 区分所有权（建议用预分配 `summaryMessageId` ＋ `compactionId`／`attempt` 替代 `runId`／`step`），具体字段与预分配时机由第 4 批落地，需主代理统一。
2. 标准用量补可选 reasoning 子项：provider 层早已读到 `reasoningTokens`（`interface-providers/types.ts:161`），本批让它在标准用量／metadata 链路里可选传递，且**不再次计入 total**。
3. 普通输出缺省统一 **8192**（`config/llm/writer.ts` 与 `services/llm-model/modelProfiles.ts`）。这是行为改变：`/connect` 未配 maxOutput 时不再继承内置档位表的上限。
4. 模型能力三层：用户显式配置（`models[]` 窗口必填）> provider 探测（`probeContextWindow`）> 默认值兜底。`maxOutputTokens` 只来自 `llmParams.maxTokens`。
5. `estimateHistoryForCompaction`（`core/context/compaction-policy.ts:26`）的入参需要补 `activeReasoningByMessageId`，让尾段估算与完整请求估算同源；第 4 批的尾段选择会消费它。

## 阅读顺序

先看 [00](./00-discussion.md) 确认边界，再看 [01](./01-problem-analysis-and-current-state.md) 的现状锚点，[02](./02-optimization-plan-and-change-scope.md) 是实施契约，[04](./04-test-and-acceptance.md) 是自测与收尾。整体规则、跨批数据流和系统级验收仍在 `../plan/`，本目录不重复。
