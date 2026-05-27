# Sandbox Improvement — Round 1

本目录是 `packages/ohbaby-agent/src/sandbox/` 模块第一轮（improve-1）的设计文档。
配套实现尚未开工；这里只回答"做什么 / 为什么 / 怎么接 / 借鉴谁"。
与 shell 模块配套的设计见 [Shell Improvement — Round 1](../../shell/improve-1/README.md)。

## 背景一句话

当前仓库里有两套 `SandboxManager`：[src/sandbox/](../../../packages/ohbaby-agent/src/sandbox/)
里的 rich 版本（adapter / context / lease / capabilities 全套）是死代码；
[adapters/ui-runtime/host-local-environment.ts](../../../packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.ts)
里的简版只做路径越界校验，名为"sandbox"但实际只是 workspace path resolver。
improve-1 的任务是把这种"两份同名抽象、一份死、一份名不副实"的状态收敛掉，
让 rich `SandboxLease` 成为统一的 `ToolExecutionEnvironment`，并与 shell、permission 接通。
这里不是让 sandbox "接管 runtime"；runtime / run-manager 的底层架构保持不变，
只是删除 runtime 下的简版 sandbox 二次实现，改用 rich sandbox 提供同一个执行环境抽象。

## 关键决策摘要

| 维度 | 决策 | 影响 |
|---|---|---|
| 隔离层级 | 纯应用层（不做 OS 级 seatbelt/landlock） | 跨平台一致，工作量小，Windows 端不跛脚 |
| 命令解析 | 由 shell/improve-1 负责 tree-sitter 全量分析，sandbox 消费其结构化结果 | 命令语法属于 shell 领域，sandbox 不再二次实现 parser |
| workspace 边界 | 单一边界 + 内置敏感路径黑名单；外部路径是事实，不是错误 | 对绝对路径和 `../` 解析出的外部路径统一触发 `external_directory` |
| 与 permission 协作 | external path 优先：先问 `external_directory`，通过后再按 bash 原规则判断是否还要问 | 对齐 opencode，同时保留现有 bash 权限模型 |
| arity 字典 | 直接拷 opencode 100+ 条，但归 shell analysis 维护 | 高质量 always-allow 粒度，不让 sandbox 理解 bash 语义 |
| 简版去留 | 删除 runtime 下的简版 sandbox 二次实现，rich `SandboxLease` 成为统一 execution environment | `RunContext.sandboxLease` 仍然由 run-manager 挂载，架构不翻新 |
| OS 级隔离 | 留接口不实现 | 未来可加 SeatbeltAdapter 不破坏架构 |

详细每一项的论证见各分项文档。

## 文档导航

1. [goal-and-duty.md](goal-and-duty.md) — sandbox 模块的职责定位、设计原则、非目标声明
2. [data-flow.md](data-flow.md) — 端到端运行时数据流、lease 生命周期、PreflightResult schema
3. [integration-plan.md](integration-plan.md) — 文件增/改/删清单、迁移顺序、依赖变更、测试调整
4. [reference-takeaways.md](reference-takeaways.md) — opencode / kimi-code / DeepSeek-TUI / pi 的具体借鉴点

阅读顺序建议：`goal-and-duty` → `reference-takeaways`（理解参考来源）→ `data-flow`（理解形态）→ `integration-plan`（理解落地路径）。

## 范围（scope）

improve-1 覆盖以下条目（编号沿用 brainstorm 阶段的清单）：

- ① 删除 runtime 下的简版 SandboxManager / SandboxLease 二次实现，rich `SandboxLease` 成为统一 execution environment
- ② 新增 `lease.preflight(command, shellKind)` 方法（内部调用 shell analysis，再补充路径抽取 + 黑名单 + workspace 边界）
- ③ bash 权限链路改为"外部路径事实 → `external_directory` ask → 原 bash 权限规则"模式
- ④ fs tools（read/write/edit/glob/grep）走 `lease.resolvePath*`
- ⑤ `external_directory` permission 问话链路真正走通
- ⑥ 默认 permission level 接入 sandbox preflight 事实

**不在 scope**：

- OS 级隔离（seatbelt/landlock/bubblewrap/Job Object）—— 留接口，不实现
- snapshot 模块的 `workspaceSource` 解耦 —— 留给 improve-2
- 配置化的 allow/deny 列表（pi 风格的 `.pi/sandbox.json`）—— 留给后续
- 后台任务（background process manager）—— 已是 kimi-code 风格，与 sandbox 正交

## 不在做的事

**OS 级隔离不是本轮目标。** 详见 [reference-takeaways.md](reference-takeaways.md) 对
DeepSeek-TUI 的分析：seatbelt/landlock 是真正的内核拦截，但跨平台破碎、
策略难写、调试地狱，且 Windows 端 Job Object 只能做进程包容、不做 FS/网络隔离。
我们对齐的 opencode 和 kimi-code 都明确选择不做 OS 级，理由相同。

未来如需，rich 版的 `SandboxAdapter` 接口足以承载 `SeatbeltAdapter`、
`BubblewrapAdapter` 等扩展，按 adapter 注册即可，不需要重构。

## 与 improve-2 / 其他改进轮次的关系

- **permission/improve-1** 已经把 policy 收敛进 permission 领域，本轮 sandbox
  借力它已有的 `PermissionType = "external_directory"` 类型和 `bash-readonly` /
  `bash-mutating` / `bash-dangerous` 三档分类，不做 permission 接口大改。
- **shell/improve-1** 负责 bash / powershell 的语法分析、动态表达式标记、命令 arity
  pattern 计算和 bash 进程硬化；sandbox 只消费这些事实并补充 workspace 边界事实。
- **context/improve-2** 在做记忆系统的工程深度，与本轮正交，无依赖。
- **未来 sandbox/improve-2** 候选议题：snapshot 解耦、OS adapter 落地、
  配置化策略、容器/远程 adapter。
