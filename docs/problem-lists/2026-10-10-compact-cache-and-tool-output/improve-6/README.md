# improve-6：子代理接入补完与整轮收口

> 状态：**已实施，测试、真实 API／Web／CLI 与独立审查完成，待用户审查**。编写日期：2026-10-13。代码基线：`16737a72`（improve-1～5 全部实施完毕）。
> 上游规划是 [plan/](../plan/README.md)。本目录不重开已确认的压缩策略，只收口前五批留下的**跨实例接入缺口**与**跨模块小尾巴**。
> 2026-10-13 已确认：保持收尾性质，子代理独立选模型与跨 provider 另开议题；本批修 S1 标记回放、补 S3 关键测试、保留 S5 通用失败处理并清理 X1 四个 agent 级模型字段。S4 子代理占用视图及缓存扩展、X2 归档资源回收均不在本批。

第 6 批 / 共 6 批。主、子代理已经共用 Context 核心，本批补齐子代理历史回放与测试边界，清理静态 agent 模型配置，完成文档收尾。

## 本批交付（一句话）

| 交付 | 一句话 |
| --- | --- |
| 子代理标记回放（已确认） | Web 会话与 CLI 执行详情一起修；多轮、多次压缩后重开和翻页不漏标记、不重复、不串 scope，保留每次压缩记录 |
| 子代理测试兜底（已确认） | 补恢复、隔离、持续压缩与保留内容测试；关键行为定向注入，真实缺陷最小修复 |
| 通用失败处理（已确认） | 沿用既有失败状态、详情与错误结果交付，回归验证，不加压缩专用通知 |
| agent 配置清理（已确认） | 删除静态 `model`／`maxTokens`／`temperature`／`topP`，文件配置和自定义接入使用旧字段时明确报错；保留 LLM 层配置及运行时 `modelId`、reasoning |
| 记录收口 | 模块记录入口与议题目录同步，历史章节的现在时表述澄清 |

## 依赖与顺序

- 前五批全部完成是本批的前提。本批**不重写**压缩算法、不新增数据库 schema、不引入新的执行状态框架。
- S1／S3／S5／X1 的范围已确认；S2 独立选模型与跨 provider 另开议题，S4／X2 保留现有行为。按 [02](./02-optimization-plan-and-change-scope.md) 的契约实施，按 [04](./04-test-and-acceptance.md) 验收。
- 本批是全议题的收尾批次。做完后由用户决定是否合并、推送，以及是否需要在模块侧留长期记录。

## 文档地图

| 文档 | 职责 |
| --- | --- |
| [00-discussion.md](./00-discussion.md) | 本批逐项决定、保留边界与来源 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 子代理接入现状、缺口与代码锚点 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 改动契约：阶段、改动面、边界、风险 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 测试与验收，含“故意改坏要变红”的故障注入项 |
| [05-implementation-acceptance.md](./05-implementation-acceptance.md) | 实施取舍、测试／故障注入、真实 API 与 Web／CLI 证据、审查和本地提交 |

**03 跳过**：本批是收尾性质，没有引入新的外部做法。前五批的参考项目调查见 [plan/03](../plan/03-reference-projects.md) 与各批 `03-reference-projects.md`，本批不重复。

## 明确不在本批

- 不新增子代理独立选模型或跨 provider 路由，不以“修预算”为由注册全部模型档案或切换客户端。X1 清理静态 agent 模型字段及旧 `model` 覆盖入口，不新增替代配置结构。
- 不扩展 `contextWindowUsage` 或新增子代理占用视图。当前 UI 显示主会话的上下文窗口占用；将来做子代理占用视图时，再把查询、缓存和显示一起接通。
- 不处理归档后的 Context 状态回收，保留现有归档、删除与清理行为；后续处理会话资源回收时再统一考虑释放时机。
- 不重做子代理的会话模型。多个子代理共用一个 child session 是现状，本批修复读取，并验证既有 scope 隔离，不改这个结构。
- 不给摘要消息伪造 `runId`，不新增尝试表，不引入第二套压缩流程。
- 不新增数据库 schema、不新建用量表、不做跨进程分布式锁。
- 不做子代理视图的完整重设计；在既有读取通路上补齐标记回放，失败继续沿用通用处理，不加压缩专用通知。
- 不复活 mask、prune、次数帽、thrash lock 或比例尾段。

## 与 plan 的关系

本目录沿用 plan 已确认的压缩策略；本批范围与配置清理以 [00](./00-discussion.md) 记录的最新用户决定为准。旧 raw 讨论里已撤回的表述**不复活**。

[返回议题入口](../README.md) · [整体规划](../plan/README.md) · [Context 模块记录](../../../core/context/improve-7/README.md)
