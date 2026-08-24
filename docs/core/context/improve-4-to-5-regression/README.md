# improve-4～5 Context 联合回归

> 状态：规划草案，等待用户与独立审查者确认。
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
- 用测试证实后暴露的生产缺陷，以及与事实不一致的 Context 权威文档修订。

### Out of scope

- 新增长期记忆 CRUD、向量检索、自动提取、主动召回或 `memory_*` 工具。
- 全量事件溯源重写、数据库整体迁移或无失败证据的“大重构”。
- improve-4～5 之外的产品功能回归；仅在其破坏 Context 承重链路时纳入。
- 用真实 Provider E2E 替代确定性测试，或将外部网络波动当作架构正确性的唯一证据。
- 在规划阶段写生产代码、提交或推送。

## 四、文档地图

| 文档 | 作用 |
|---|---|
| [00-discussion.md](./00-discussion.md) | 冻结已确认目标、边界、术语和待确认决策 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 说明现有实现、测试可信度、风险证据和文档漂移 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 定义测试优先的分批实施契约、设计岔路、风险与回滚 |
| [03-reference-projects.md](./03-reference-projects.md) | 记录六个参考项目中 adopt/adapt/reject 的具体取舍 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 定义状态机、不变量、故障矩阵、CI/外部门禁与验收标准 |
| `05-implementation-acceptance.md` | 实施完成后由独立验收会话创建；规划期不存在 |

## 五、权威关系

- improve-4、4.1、5 的 `00`～`05` 保留为各阶段历史契约和验收记录，不回写实施进度。
- 本目录是三阶段**联合回归**的规划契约，不反向声称旧阶段验收无效。
- `docs/core/context/{goals-duty,architecture,data-model,dfd-interface,test}.md` 仍是模块级权威文档，但当前存在阈值、接口和文件布局漂移；本轮先记录差异，待 R0 决策后统一修订。
- 如果本目录与上述模块级文档冲突，在用户确认前视为“待决策差异”，不能默默选择一方。

## 六、规划闸门

正式实施前需要用户与独立审查者确认：

1. Design Goals 的优先级是否正确。
2. P0 测试点是否确实对准 Context 的最大风险。
3. 压缩阈值采用“输入预算占用率 + 剩余输入安全余量”公式，并以当前 95% 作为不改变行为的回归基线，是否接受。
4. 是否接受引入 `fast-check` 作为测试期 dev dependency；若不接受，则使用自研确定性生成器，但缺少自动 shrinking。
5. 故障测试证实缺陷后，是优先增加窄的原子提交端口，还是采用可恢复的持久化操作标记；不得在证据出现前拍板。
6. Summary 语义评测是 nightly/release 门，而不是每次提交的硬门，是否接受。
7. 是否接受 manual compact 与同 scope prompt 的“接纳与执行分离”契约：UI 可先接纳 prompt，Context durable mutation 必须在 per-scope exclusive lane 中串行。
