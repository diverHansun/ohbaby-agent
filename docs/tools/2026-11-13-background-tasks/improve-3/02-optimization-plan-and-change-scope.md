# 改造方案与改动范围

状态：后端已完成实施与验证；本文保留改造契约，实际改动与验证结果见 [05](05-implementation-acceptance.md)。产品依据 [00](00-discussion.md)，接口依据 [design](design/dfd-interface.md)。

## 目标和边界

把模型可见的 ShellJob 管理入口收拢为 task(list/output/stop)。保留 Bash 唯一启动入口与 agent 独立运行时。本轮不实现自动转换，不重新设计持久化/回收，不改 Web/TUI。

## 依赖与基线

improve-1 提供权威任务记录、list 查询、准确快照、统一停止、结果就绪、通知及回收；其实际验证范围见 [improve-1 验收](../improve-1/05-implementation-acceptance.md)。improve-2 提供自动转换后的同一 jobId，实际验证范围见 [improve-2 验收](../improve-2/05-implementation-acceptance.md)；本轮工具不依赖其是否已开启。

若三轮一起实施，直接交付最终 task 工具即可，不必先发布 task_list 再删除。若分开实施，先验证 improve-1 的管理语义再换入口；不能只完成改名便宣布准确状态和可靠回收已交付。前轮的持久化、恢复、通知契约以其 design 为准，不在这里复制第二套解决方案。

## 改造阶段

| 阶段 | 契约 | 完成条件 |
| --- | --- | --- |
| A：适配与授权 | 三动作 schema、运行时字段白名单、可信 owner、动态 category、control admission；按动作分类及最小旧 deny 兼容 | 非法或越权调用无副作用；owner 与显式 deny 不被绕过；等待可取消且不杀任务。 |
| B：注册与消费者 | builtin/内置角色/提示词改为 task；上下文投影保留准确 metadata | 模型声明只有一个管理入口，子代理仍禁 agent；旧历史可读，新历史能投影。 |
| C：迁移与集成 | rewind、配置迁移诊断、真实 Bash 管理和通知交互 | 旧 deny 不绕过，单停不误停别的任务，回滚不接受 list 汇总为清理证据，前轮生命周期回归通过。 |

## 简要关键改动清单

沿用前轮用户要求的简要清单；文件位置已按本轮工作区同步，完成情况见 05。

| 文件/区域（packages/ohbaby-agent/src 下） | 改动 |
| --- | --- |
| tools/task.ts、shell-job-registry.ts、builtin.ts | 薄适配和统一注册；删除旧模型入口，复用服务方法。 |
| agents/builtin、agents/manager.ts、工具使用说明 | 内置角色允许 task；自定义旧配置迁移诊断并拒绝激活不完整角色；不解除禁止孙代理规则。 |
| 相关分类路径、permission/evaluator.ts | 按 action 分类；仅对可信 task 保留旧 deny 检查，复用原 matcher，不增加动作 pattern DSL 或 allow 迁移。 |
| core/tool-scheduler/scheduler.ts 的工具不存在分支 | 对已退役旧名返回迁移诊断，不注册或执行别名；正常未知工具错误保持原义。 |
| core/context/tool-metadata-projection.ts | task 三分支投影；新旧 metadata 兼容，有界摘要。 |
| services/session/rewind-shell.ts | improve-1 权威记录优先；旧记录 fallback 同时识别旧回执和新 task(output/stop)，验证 job/owner/cleanup。 |
| 相关 unit / integration 测试 | 更新真实工具调用与信任边界测试，保留旧历史夹具。 |

## 迁移与回滚

不改写已保存 tool part。历史中的 task_output/task_kill 保持原样，读取、导出、摘要仍支持。新模型只收到 task schema；旧对话诱导模型再调用旧名时给出明确的“已替换，请使用 task 对应动作”错误，不自动重放或改写有副作用调用。

会话恢复时以当前工具声明运行；未完成旧调用按现有运行恢复协议处理，不因新别名重复停止。自定义角色旧配置拒绝激活并提示迁移，防止能启动后台却没有管理入口，细则见接口文档。旧名称仍可出现在历史读取和迁移测试中，不能用“全文没有旧名”作为验收。

回滚应先停止当前服务并完成现有资源回收，再回到兼容版本；本轮不新增数据格式迁移。若连同 improve-1 一起上线，数据库降级能力由 improve-1 的迁移策略决定，不能声称本轮让整体版本可任意回退。

## 风险和范围外

主要风险是权限按名字失效、角色缺管理工具、六状态未贯穿筛选/返回/投影、metadata 被白名单过滤、回滚读不到清理事实。以动作/owner/旧历史集成测试覆盖，避免增加通用任务平台。

前端现有工具专用展示可能仍只识别旧名。本轮保证通用可读正文与后端结构化结果，不承诺新 task 专用卡片或后台面板已经完成；交接时明确提供 action 和快照契约。没有新增 improve-4 候选。
