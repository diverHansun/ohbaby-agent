# improve-4～5 Context 联合回归

> 状态：已实施，条件验收；确定性本地门禁通过，外部 Provider 与部分扩展矩阵仍待后续门禁。
> 规划基线：`301de2da7996703e2c4254b330f981bf51507e1f`（2026-08-24）。
> 本目录只定义回归、诊断与后续修复契约；规划阶段不修改生产代码。

## 一、为什么需要单独的联合回归

improve-4、improve-4.1 和 improve-5 已分别完成定向实施与验收，但三阶段文档都没有声称完成一轮跨阶段、长序列、故障恢复式回归。阶段内测试擅长回答“本次接口有没有按计划改变”，联合回归需要回答更承重的问题：

> 一次真实请求经过历史读取、Memory/System 快照、动态工具解析、请求测量、Provider 发送、工具循环、压缩、重试、子代理隔离和进程恢复之后，Context 是否仍然只有一个合法、可解释的模型视图？

这轮工作把测试当作设计探针：先用可重复的测试证明风险，再决定是否修改生产结构。不得为了“架构看起来更漂亮”先重写 `ContextManager`。

## 二、Design Goals 优先级

本轮质量属性按以下顺序取舍：

1. **正确性**：模型实际看到的请求必须与测量、缓存策略和工具权限一致。
2. **可靠性与鲁棒性**：部分写入、并发、中断、重试和恢复后不能产生双份历史或非法工具序列。
3. **隔离性**：主代理与子代理、同一 child session 的不同 `contextScopeId` 互不污染。
4. **可测试性与可观测性**：失败必须能以 seed、动作轨迹、scope 和状态差异复现并解释。
5. **可维护性**：状态所有权、模块边界和权威文档与实现一致。
6. **简单性**：优先测试硬化与窄边界修复；复杂度必须由失败证据挣得。
7. **缓存效率**：在前六项成立的前提下稳定 Provider-relevant prefix；不以缓存命中率换取错误上下文。

这里有意不把“最大灵活性”和“全面长期记忆”列为本轮目标，避免用联合回归之名扩大产品能力。

## 三、范围

### In scope

- improve-4：Context usage、压缩梯级、UI/runtime projection 的回归。
- improve-4.1：tools-aware measurement、主/子代理 scope、manual/static/runtime 路径的回归。
- improve-5：`PreparedModelRequest`、TokenUsage/cache 语义、稳定 runtime prefix、tool epoch、MCP 动态加载、cache key、主/子代理统一请求链的回归。
- Context 与 Lifecycle、Message、Memory、SystemPrompt、ToolScheduler、MCP、Provider adapter、RunManager、Web projection 的承重集成边界。
- 属性/状态机、故障注入、并发、重建/恢复、长序列 soak、真实 Provider 和 compiled Web 分层验证。
- 摘要请求自身 context overflow 的有界收缩与恢复，以及 compaction 事件的 scope/terminal 契约。
- 用测试证实后暴露的生产缺陷，以及与事实不一致的 Context 权威文档修订。

### Out of scope

- 新增长期记忆 CRUD、向量检索、自动提取、主动召回或 `memory_*` 工具。
- 全量事件溯源重写、数据库整体迁移或无失败证据的“大重构”。
- improve-4～5 之外的产品功能回归；仅在其破坏 Context 承重链路时纳入。
- 根据一次 Provider overflow 持久化“观测窗口上限”并自适应调参；本轮仅记录为 P2 已知限制。
- 用真实 Provider E2E 替代确定性测试，或将外部网络波动当作架构正确性的唯一证据。
- 在规划阶段写生产代码、提交或推送。

## 四、文档地图

| 文档 | 作用 |
|---|---|
| [00-discussion.md](./00-discussion.md) | 冻结已确认目标、边界、术语和工程取舍 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 说明现有实现、测试可信度、风险证据和文档漂移 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 定义测试优先的分批实施契约、设计岔路、风险与回滚 |
| [03-reference-projects.md](./03-reference-projects.md) | 记录六个参考项目中 adopt/adapt/reject 的具体取舍 |
| [context-references/README.md](./context-references/README.md) | 六个项目的逐项目源码调研索引；作为 03 的补充证据，不单独定义方案 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 定义状态机、不变量、故障矩阵、CI/外部门禁与验收标准 |
| [05-implementation-acceptance.md](./05-implementation-acceptance.md) | 记录实际改动、测试证据、规划偏差、独立审查与剩余门禁 |

## 五、权威关系

- improve-4、4.1、5 的 `00`～`05` 保留为各阶段历史契约和验收记录，不回写实施进度。
- 本目录是三阶段**联合回归**的规划契约，不反向声称旧阶段验收无效。
- `docs/core/context/{goals-duty,architecture,data-model,dfd-interface,test}.md` 仍是模块级权威文档，但当前存在阈值、接口和文件布局漂移；本目录已经冻结联合回归的目标契约，R0 必须把模块级文档同步到该契约。
- R0 落地前，冲突项按 01 的“现状事实/文档漂移”处理：现有行为以代码证据为准，后续目标与验收以本目录 00～04 为准；不得把旧文档当成重新打开已关闭决策的依据。

## 六、已关闭的规划闸门

2026-08-25 已确认以下实施契约；修订后复核只检查文档是否准确表达这些结论，不重新打开已关闭决策：

1. Design Goals 以正确性、可靠性、隔离性优先，测试对准 durable truth、请求身份和恢复，而非覆盖率数量。
2. 压缩阈值采用“输入预算占用率 + 剩余输入安全余量”，以当前 95% + 4096 作为不调参的回归基线。
3. 属性测试优先采用 `fast-check`；Reference Model 先覆盖核心动作，MCP/permission/memory/scope lifecycle 在后续专门 suite 扩展。
4. Summary 语义评测属于 nightly/release 门；确定性结构、隐私和恢复不变量属于 commit/PR 硬门。
5. Compaction 部分写失败若被证实，优先增加窄的原子提交端口；durable marker 仅在存储事务不足时使用，并必须区分 active/busy 与 stale/orphan lifecycle。
6. 同 `sessionId + contextScopeId` 的 auto/manual compaction 与 prompt Context 写入共用 exclusive mutation lane；提交前还要复核快照/版本，不同 scope 保持并发。
7. Summary 请求自身 overflow 是 P0：按完整 turn/tool pairing 有界缩小后重试，必须保证每轮有进展并有终止上限。
8. 所有 Context 事件必须携带正确 scope；compaction progress/terminal 另带 attempt identity 和唯一 terminal outcome。durable store 是事实源，事件发布失败不得反向改写已提交历史。
9. Provider observed-window 自适应作为 P2 已知限制记录，不在本轮顺带实现。
