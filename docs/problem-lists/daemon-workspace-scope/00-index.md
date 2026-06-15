# Daemon Workspace Scope 文档索引

> **归档状态**：该思路已放弃，由 `docs/problem-lists/server` 方案替代。本目录仅作为 daemon workspace scope 方案的历史参考，不再作为 v0.1.4 或后续版本的实施计划。

## 目标

本目录原本记录 v0.1.4 计划处理的 daemon 多路径启动、偶发 `fetch failed`、以及本地 npm 真实使用场景下 daemon 生命周期不稳定的问题。

在完成 `gemini-cli`、`kimi-code`、`claude-code`、`opencode` 的架构复核后，当前主线已调整为：默认 CLI 走 in-process runtime，server/daemon 类能力改为显式入口。因此，本目录不再用于指导实现，只保留为“为什么不继续修 hidden daemon workspace scope”的参考材料。

本轮文档只做分析和方案设计，不直接修改代码。核心边界如下：

- v0.1.3 已发布，本轮修复目标版本应为 v0.1.4。
- 当前 session view reset 的修复已作为 v0.1.4 的前置 commit 存在。
- 多路径启动是 CLI 的基本能力，不能靠要求用户只在某个目录启动来规避。
- “同一 workspace”必须有明确的 scope 规则；同一 scope 并发启动只能产生一个 daemon。
- “repo root 与 repo 子目录是否共享 daemon”是产品决策点，不能在文档中偷换成默认结论。

## 文档职责

1. `01-current-problems-and-code-analysis.md`
   - 描述当前可见问题、根因、现有代码路径、`packages/ohbaby-agent/src/project` 的可用性，以及 root/subdir scope 的决策边界。
2. `02-design-and-implementation-plan.md`
   - 给出 v0.1.4 短期稳定方案、可选 scope 策略、daemon 启动锁、state ownership、reconnect 方案和实施顺序。
3. `03-related-files-code-blocks-and-packages.md`
   - 列出涉及文件、关键代码块、测试文件、文档关联和包发布影响。
4. `04-testing-acceptance-review.md`
   - 定义自动测试、手工验收、npm 本机 smoke、回归范围和审查标准。
5. `05-doc-self-review.md`
   - 记录文档自审、未决策点和实施前需要用户确认的问题。

## 当前推荐阅读顺序

优先阅读 `docs/problem-lists/server/`。只有在回看旧 daemon 方案的来龙去脉时，才需要阅读本目录：先看 `01` 确认根因和产品边界，再看 `02` 了解当时的 scope 策略讨论。`03` 和 `04` 仅作为历史实现/测试参考。
