# Logging 与 Diagnostics 改造文档集

> 状态：设计阶段，等待人工审查；尚未开始实现。
>
> 分支：`codex/logging-diagnostics-docs`
>
> 日期：2026-08-29

## 1. 这批文档解决什么问题

ohbaby 目前已经有用户提示、异常、调试输出、迁移告警、daemon 生命周期输出和命令观测记录，但它们没有一套共同的边界与生命周期约束。此前 `{ "record": ... }` 污染 TUI 的问题已经证明：只要底层模块可以直接写 `stdout` / `stderr`，内部观测数据就可能穿透到用户界面。

本改造的目标不是“多打印一些日志”，而是建立三条清晰边界：

1. **用户界面**只显示用户需要理解或处理的信息；
2. **本地诊断日志**默认记录安全元数据，不接管终端；
3. **开发者调试信息**可以更细，但 `trace` 也不能隐式记录正文或秘密。

## 2. 已确认的核心决策

- 自研一个小而明确的 TypeScript logger，不引入 Pino、Winston 等通用日志框架；
- TUI in-process 与 `ohbaby serve` 默认日志级别均为 `info`；
- 本地日志采用 JSONL，一行一个完整事件；
- 日志默认写文件，logger 本身永不写 `stdout` / `stderr`；
- CLI 的 TUI/fresh serve 默认启用；公开 agent/server library factory 未注入 diagnostics capability 时默认 no-op；
- logger 使用静态 event definition 与受限字段 encoder，不开放任意 string record；
- `trace` 只增加事件粒度和安全元数据，不放宽正文边界；
- prompt、模型回复、推理内容、工具参数/结果、命令正文、MCP/HTTP body 和凭据在普通日志体系中始终禁止；
- 内置 MCP/agent/skill 名称可以直记，用户定义名称使用稳定短 hash；
- 路径中的 `<home>`、`<workspace>`、`<ohbaby-home>`、`<tmp>` 是运行时解析得到的语义占位符，不是固定目录或要求用户填写的配置；
- 当前主运行形态只有 TUI in-process 与 `ohbaby serve`；现有 one-shot CLI 行为只作为回归契约，不作为本方案的主要设计中心；
- 日志基础设施和“面向用户的错误产品化”分阶段实施，但都归在本 `improve-1/` 文档集内，`improve-1/2` 不代表实施批次；
- 实施阶段按阶段 commit，不在该阶段 merge 或 push；本轮只提交文档。

更严格、可直接用于实现审查的规则以 [logging-policy.md](./logging-policy.md) 为唯一规范来源。

## 3. 文档导航

| 文档 | 作用 |
| --- | --- |
| [00-discussion.md](./00-discussion.md) | 讨论背景、术语、已确认决策和范围边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 结合当前代码说明问题、根因、影响和约束 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 目标架构、分阶段实施方案、变更面和回滚边界 |
| [03-reference-projects.md](./03-reference-projects.md) | 六个优秀项目分别借鉴什么、不照搬什么 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 单元、契约、集成、真实进程、TUI 与 Web E2E 验收 |
| [logging-policy.md](./logging-policy.md) | 日志等级、字段、敏感信息、终端所有权、文件生命周期的规范合同 |

## 4. 实施顺序

本方案按可独立验证、可独立提交的阶段推进：

1. 日志合同、编码器、脱敏/标准化与文件写入器；
2. TUI in-process 组合与现有调试/迁移旁路迁移；
3. `ohbaby serve` 组合、supervisor 与 server 诊断旁路迁移；
4. 进程退出、崩溃恢复、限时 flush 与真实 PTY/子进程验证；
5. 先补首批高频错误清单并经用户确认，再实现用户错误展示标准化；动态重试策略不写死到静态错误码表；
6. 全量测试、真实 TUI/Web E2E、文档验收与最终收尾。

这些是一个改造主题内的实施阶段，不是 `improve-1`、`improve-2` 目录的对应关系。

## 5. 本轮不做什么

- 不实现代码；
- 不建设远程遥测、日志上传、指标平台或 trace backend；
- 不记录会话正文；
- 不为每个包建立一套 logger；
- 不新增庞大 error-code registry；
- 不让 domain event bus 兼任 logger；
- 不把普通产品输出改造成日志；
- 不 merge、不 push。

## 6. 开发准入门槛

只有在以下条件满足后才进入实现：

- 用户确认本套文档的范围与敏感信息边界；
- 文档内容审查和可实施性审查均无阻断项；
- 对 logger 的公开 API 面积、默认目录和失败退化行为没有悬而未决的重大分歧；
- 测试计划能在真实子进程、真实构建产物和 PTY/终端环境中复现用户可见行为。

本套文档经确认后，Phase A–D/F 具备实施依据；Phase E 只有方向边界，必须先补 2–3 个真实高频错误的清单与验收并再次确认，不能直接编码。

实现完成后的事实验收应单独新增 `05-implementation-acceptance.md`；在真正实现前不预写“已通过”。
