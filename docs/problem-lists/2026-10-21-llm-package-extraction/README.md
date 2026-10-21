# 抽出 ohbaby-llm 包

2026-10-21 开启第一轮。规划基线为 `7bc75168`；实施前已按 `main@73e065e7` 复核，在 `codex/llm-package-extraction` 分支分阶段实施。

本议题把 `ohbaby-agent` 里调用大模型的代码（`core/llm-client/` 和 `services/interface-providers/`，约 6600 行）抽成独立的 `ohbaby-llm` 包。目标是让这部分代码有清楚的边界：它只负责“按配置调用模型、返回流式结果”，不知道会话、UI、配置文件和日志系统。

实施时间：在 [sdk 与 server 结构整理](../2026-10-21-sdk-server-boundaries/README.md) 完成之后。Web 的 workspaceless 前端规划不等本议题。开工前按当时代码重新核对 02 里的行号快照。

## 轮次与边界

| 轮次                                    | 开启日期   | 触发 | 内容                                                        |
| --------------------------------------- | ---------- | ---- | ----------------------------------------------------------- |
| [improve-1](improve-1/00-discussion.md) | 2026-10-21 | 首轮 | 先在 agent 内解开耦合，再把代码挪进新包，最后补齐构建与发布 |

本轮包括：

- 新建 `packages/ohbaby-llm`，收纳 LLM 客户端、各协议适配器，以及 `config/llm` 里的纯类型、纯校验和纯函数。
- `ohbaby-llm` 不依赖任何 workspace 包，包括 `ohbaby-sdk`。
- 读配置文件、读环境变量、写日志的部分留在 agent。agent 保留同名的 `createLLMClient`，内部改为“读配置，再交给 `ohbaby-llm`”。
- 把 UI 视图投影 `reasoningCapabilityView` 留在 agent。
- 发布的公开包从四个变成五个。

不在本轮的内容见 [02 §2.8](improve-1/02-optimization-plan-and-change-scope.md)。

## 文档地图

| 文件                                                                                           | 内容                               |
| ---------------------------------------------------------------------------------------------- | ---------------------------------- |
| [00-discussion.md](improve-1/00-discussion.md)                                                 | 已确认的决策与边界                 |
| [01-problem-analysis-and-current-state.md](improve-1/01-problem-analysis-and-current-state.md) | LLM 代码的现状与耦合点，带代码锚点 |
| [02-optimization-plan-and-change-scope.md](improve-1/02-optimization-plan-and-change-scope.md) | 方案、三个实施阶段、关键改动清单   |
| [03-reference-projects.md](improve-1/03-reference-projects.md)                                 | 参考项目的 LLM 包设计              |
| [04-test-and-acceptance.md](improve-1/04-test-and-acceptance.md)                               | 测试与验收标准                     |
| [05-implementation-acceptance.md](improve-1/05-implementation-acceptance.md)                   | 分阶段实施结果、测试和复审记录     |

02 是后续实施的依据，04 是验收依据。本轮实施后分批提交，等待用户审查，不 merge、push 或发布 npm 包。

## 相关文档

- [llm-client 模块文档](../../core/llm-client/goals-duty.md)：实施后要同步，见 02 §2.9。
- [providers 模块文档](../../services/providers/goals-duty.md)：路径已过时，实施后一并更新。
- [interface-providers 改名记录](../../services/llm-model/improve-1/04-interface-providers-boundary.md)：provider 与 interfaceProvider 的术语沿用这份文档。
- [包构建与发布](../../ohbaby-server/package-build.md)：§7 发布顺序要加入 `ohbaby-llm`。
- [LLM SDK 与 Responses 迁移](../2026-09-11-llm-sdk-and-responses-migration/README.md)：上一次大改 LLM 层的议题，其冻结的阶段边界不受本议题影响。
