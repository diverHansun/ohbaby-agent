# improve-5.5 · 推理配置与三协议原生续接

> 开启日期：2026-09-15。状态：本地分支已实施，测试与独立审查已完成，等待用户审查；未合并、未推送。
> 代码基线：`codex/improve-5-cache-accounting@8b546e3b8ea8870d4cca79a0c030ad60eecacb2d`。
> 本轮由 improve-5 真实 E2E 暴露的上游协议缺口触发，用户明确命名为 improve-5.5。A–F 是本轮内的实施批次，不是六个新轮次。

目标：后端默认开启推理、默认请求 `medium`，允许用户调整或关闭；Chat Completions、Responses、Anthropic 能正确发送配置、保留续接必需状态，并保持文本、工具、用量和 cache 统计可靠。本轮不开发前端推理开关或思考文字展示。

## 文档地图

| 文档                                                        | 职责                                           |
| ----------------------------------------------------------- | ---------------------------------------------- |
| [00 讨论记录](./00-discussion.md)                           | 最新用户决策，覆盖之前的默认关闭提议           |
| [01 现状与问题](./01-problem-analysis-and-current-state.md) | 代码证据、已做诊断、问题归因及历史边界         |
| [02 方案与批次](./02-optimization-plan-and-change-scope.md) | 数据所有权、配置优先级、A–F 目标/方案/完成定义 |
| [03 参考项目](./03-reference-projects.md)                   | 六个指定项目的事实、差异及本项目取舍           |
| [04 测试与验收](./04-test-and-acceptance.md)                | 固定样本、真实组件集成、回归与真实请求验收门   |

实际实施与验证见 [05 实施验收](./05-implementation-acceptance.md)；真实请求、失败记录、用量及缓存对账见 [06 真实验证报告](./06-real-native-reasoning-validation.md)。

00 是已确认需求；02 是实施合同；04 是实施后的验收依据。01 中的现状不是目标态，03 中的参考实现不是本项目指令。子代理开关/强度继承、压缩沿用所属代理当前配置均已确认；标题关闭也已确认；模型能力边界属于 00 K13 记录的工程取舍，不冒充用户逐项确认。

## 与前序轮次的关系

- improve-1：保持 SDK 升级成果；本轮不以继续升级 SDK 代替适配代码。
- improve-2：扩展此前明确拒绝的 reasoning / assistant phase 能力；保留独立协议 kind、完整流验证和工具授权边界。
- improve-3：扩展自有请求/结果类型，接入必要原生状态；不把 SDK 类型重新泄漏到 core。
- improve-4：扩展新增状态的估算材料和持久化承载；保留真实 usage、同请求校准与输出预留不重复计算的原则。
- improve-5：保留可信 Step 的 session 累计 hit%、未知与零区分、主子隔离。原生消息可跨重启恢复，不代表 cache 累计开始跨重启恢复。

前序 00–05 保留历史；本轮只显式替代上述受限能力范围，不追溯改写旧验收。已有真实复验结果见 [improve-5/06](../improve-5/06-real-cache-revalidation.md)。

## 实施边界

当前实现位于 `codex/improve-5.5-reasoning`。实施按 A → B → C → D → E → F 推进；默认开启的产品行为必须与原生续接完整能力一起交付，不能在 B 完成时单独发布。每批有单元与集成验收，最后再执行三协议真实请求矩阵。

不改变 system prompt 组装、cache_control、缓存 key/TTL、工具权限和调度算法；不接入 hosted tools、服务端 Conversations、previous_response_id、后台异步 Responses 或完整计费账本。按用户授权在本地分批提交，等待用户审查；本次不 merge/push。
