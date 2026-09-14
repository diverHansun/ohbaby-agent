# 0. 讨论记录与已确认要点

> 2026-09-14。根据当前用户对话整理。这里记录确认结论，不把建议伪装成已完成实施。

## 0.1 用户确认原话

> 核对并对齐供应商用量、单步估算和校准之间的数据合同；保留现有估算、统计、占用和压缩算法。

> 继续用现有结构分别表达响应结束、用量完整性和 cache 明细可用性，不新增统一状态类型。

> 校准配对以实际使用的请求准备结果为准；`usageComplete` 不承诺覆盖所有失败和重试尝试。

> 开始新建临时本地 improve-4 分支撰写文档……完成后等待我审核后可以进行实施。

## 0.2 目标、职责和数据合同

1. 保留各供应商 adapter；core 不读取供应商原始 usage 字段。归一后的 `inputTokens` 继续采用现有 inclusive 输入口径，不当作 uncached 输入或费用。
2. Run 是一次任务执行；Step 是循环计数；Turn 是本步模型交互视角。当前主路径 Step/Turn 对应，但同一步可以因上下文超限重新 prepare 和调用模型；不能只用 Step 编号解释请求配对。
3. 使用实际产生该响应的 `PreparedTurn.request` 对应的 `sentHeuristic`，与该响应归一后的输入用量校准。不重算已追加工具结果的历史，不使用 Run 累计或窗口占用作为样本。
4. 系数继续由 context-manager 按现有 session/scope 管理；不新增 run 重置、恢复训练、样本存储或标识系统。
5. 单步 usage 缺失不伪造全零对象。累计缺失按现有规则保留已知小计及 `usageComplete`，响应终态与 cache 明细状态分开表达。
6. 数据库 schema 和历史 JSON 不迁移；旧 `promptTokens/completionTokens` metadata 读取保留。没有可承载 Part 时不为 usage 伪造 Part。
7. 字段采用 KISS：不为统一名字新增全部类型。只改有实际歧义的参数/说明，已准确的接口保留；具体替换表见 02。
8. 观察事件、metadata、Run 累计、校准各司其职，不引入 TokenManager、新事件聚合层或第二份正文。

## 0.3 不做项

- 不改变 `legacy-estimation.ts` 计量材料、启发式权重、tokenizer、tokenCounting 窗口预算。
- 不改变 EMA、夹取、输入过滤、校准更新时机、scope 清理和历史占用。
- 不改变 Run 累计、`usageComplete`、`observed`、partial 的规则；不扩大为所有 HTTP 尝试的账本。
- 不改变 cache 命中公式、cache key、控制策略和默认协议。
- 不改变 currentTokens、窗口比例、七桶、压缩阈值或压缩机制。
- 不新增原生 reasoning/phase 续接、previous_response_id、Conversations、hosted tools，也不解除 Responses 当前拒绝边界。

若发现修复会改变数值或时机，先给出复现和影响，交用户单独决策；不藏在字段整理中。

## 0.4 文档、审查与实施流程

- 沿用本议题路径，在 `improve-4/` 建完整 00–04；02 必须有承重文件、符号及行号快照，不是进度清单。
- 主代理撰写和自检；文档完成后子代理核对职责一致性、代码与参考项目事实、实施可靠性及测试规范。
- 三个实施批次，每批单元、集成、相关 contract、子代理审查和 commit。最后全量检查与小量真实 LLM E2E，再独立验收；本次只批准文档。
- 用户已授权 improve-3 文档提交；其收尾验证满足要求后可本地合入 `openai-responses-migration`。improve-4 仍等待本轮文档审核与实施授权。

## 0.5 参考与后续

参考本地 `pi`、`oh-my-pi`、`opencode`、`kimi-code`、`deepseek-harness`、`Kun`，事实与不借鉴部分见 03。Run/Turn/Step 讨论参考用户指定的知识库 runtime 对比文档，实际路径以当前代码为准。

沿用 context improve-5 的 token 分工与 improve-6 的 occupancy/cache 分离；本轮结束后先独立处理 cache 命中议题，再检查已有窗口占用和压缩功能。其他延期项见 02 §2.8。
