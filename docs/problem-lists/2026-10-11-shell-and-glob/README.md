# Shell 网络继承与 Shell / Glob 优化

> 规划日期：2026-10-11。规划代码基线：`24c7003448840fb4ba5acedb15d31456651e1466`。2026-10-12 从 `main@e5067039` 开始分批实施；00–04 保留规划契约，各批实际结果见 05。

本议题解决两类问题：ohbaby 主进程的系统代理适配没有传到 Shell / MCP 子进程；Shell 的轻量分析器会拒绝有效命令，Glob 的手写匹配与遍历存在语法和完成性缺口。

用户明确要求先实施网络，再实施 Shell / Glob，两批分别测试、审查和提交。两批均已实施；改动及实际证据分别见 [improve-1 实施验收](improve-1/05-implementation-acceptance.md)与 [improve-2 实施验收](improve-2/05-implementation-acceptance.md)。未验证的平台如实列出，不用单元模拟替代真机结果。

## 文档地图

| 批次      | 范围                                | 讨论                             | 现状                                                     | 实施契约                                                 | 参考                                     | 验收标准                                  |
| --------- | ----------------------------------- | -------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------- | ----------------------------------------- |
| improve-1 | 主进程与 Shell / MCP 的网络配置衔接 | [00](improve-1/00-discussion.md) | [01](improve-1/01-problem-analysis-and-current-state.md) | [02](improve-1/02-optimization-plan-and-change-scope.md) | [03](improve-1/03-reference-projects.md) | [04](improve-1/04-test-and-acceptance.md) |
| improve-2 | 原始 Shell 命令执行、平台适配、Glob | [00](improve-2/00-discussion.md) | [01](improve-2/01-problem-analysis-and-current-state.md) | [02](improve-2/02-optimization-plan-and-change-scope.md) | [03](improve-2/03-reference-projects.md) | [04](improve-2/04-test-and-acceptance.md) |

实施先读本批 00，再按 02 修改、按 04 验证。01 描述当前代码，03 说明借鉴与取舍。关键文件、符号及行号快照放在各批 02，定位以符号为准。

## 分工与依赖

- improve-1 负责代理来源、刷新快照、子进程环境变量及无法可靠应用时的启动失败；保留现有解释器选择和语法分析。
- improve-2 负责选择解释器、分析命令、生成审批依据、执行原文及 Glob 搜索；复用 improve-1 的子进程网络入口，不另算代理。
- Subagent 当前是进程内实例。其模型请求共用主进程网络设施，其 Shell 调用共用工具入口；不新增子代理代理管理器。
- TUI / Web 的审批归属不变：default 模式下，主代理和子代理均在主会话入口接受审批。
- 两批都保持现有 Read / Write / Edit 的限额、版本校验和资源锁；不扩展为全部工具重写。

## 设计与实施原则

采用 `plan-code-improvement` 的 00–04 结构，把 `plan-module-design` 的职责、模块结构、数据流、接口和测试视角纳入 01 / 02 / 04，不再复制一套内容相同的模块文档。必要的权威文档同步列入 02，由实施时更新。

复用已有网络模块、ShellJobRegistry、权限入口、资源锁与 bundled ripgrep。允许删除失去用途的旧实现，先核对全部使用者；不保留永久的新旧双轨，不新建通用进程平台、本地代理服务器、PTY 会话或额外搜索引擎。

## 与已有议题的关系

- [系统代理原规划](../2026-10-01-system-proxy/improve-1/02-optimization-plan-and-change-scope.md)：保留主进程实现；本议题扩展其 Shell / MCP 子进程边界。原规划中的 PAC 范围疑问，已由本次用户明确排除。
- [Shell 命令分析原规划](../../shell/improve-1/integration-plan.md)：承接成熟解析器方向，修正当前轻量实现的限制。
- [Shell 后台任务](../../shell/improve-3/README.md)：保留前后台任务、取消、超时、归属及清理契约。
- `docs/problem-lists/2026-10-10-compact-cache-and-tool-output/`：另一个在研议题。本轮不重写完整输出日志或压缩策略，也不修改该目录。

规划阶段只修改本目录；实施阶段按各批改动清单同步源码、测试与权威文档。参考仓库结论均注明本地版本，不将参考实现等同于安全保证；本地 `claude-code` 为第三方恢复源码，不能当作官方实现依据。

## 已确认严格失败的实际影响

本机已核对的系统 bypass 包含通配域及 `<local>`。在没有显式代理覆盖、依赖该系统配置时，improve-1 的自动桥接将明确拒绝 Shell / MCP 启动。保留这一行为是遵守用户已确认的“不能可靠应用就失败”；本方案不暗中扩大或丢弃规则。可用的显式代理 env 路径保留，主进程和本地文件工具不因此一起失效。详见 improve-1 的 02 / 04。
