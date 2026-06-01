# Permission 重构文档集（已决策版）

本目录是 `permission` 与 `policy` 双模块合并重构的实施基线。目标是删除 `packages/ohbaby-agent/src/policy/`，把工具调用判定、用户审批、会话级规则与 UI 状态收敛到 `permission` 领域内。

- 日期：2026-05-27
- 阶段：设计已确认，待实施
- 适用版本：ohbaby-agent MVP
- 编码：UTF-8

---

## 一句话结论

重构后只有一个权限领域模型：

```ts
interface PermissionState {
  mode: "plan" | "auto";          // 全局 UI 状态
  level: "default" | "full-access"; // 全局 UI 状态
  sessionRules: Map<string, readonly PermissionRule[]>; // sessionId -> rules
}
```

`tool-scheduler` 每次工具调用先走 `permission.evaluate(call, state)`。`allow` / `deny` 直接处理；`ask` 才进入 `PermissionManager.requestApproval()` 走 UI。`PermissionManager` 不再持有批准状态，所有 `always` 真相都在 `state.sessionRules`。

---

## 文档构成

| 文档 | 职责 | 重点 |
|------|------|------|
| [problem-analysis.md](./problem-analysis.md) | 问题分析 | 为什么必须删除 policy 模块，当前真实代码的耦合点在哪里 |
| [design-goals.md](./design-goals.md) | 最终设计 | 10 条决策、数据模型、判定矩阵、模块职责 |
| [implementation-plan.md](./implementation-plan.md) | 实施计划 | 文件改动、Phase 0-6、分支与测试/e2e/审查流程 |
| [acceptance.md](./acceptance.md) | 验收标准 | 单测、集成、e2e、真实数据流、残留检查 |

阅读顺序：`problem-analysis` -> `design-goals` -> `implementation-plan` -> `acceptance`。

---

## 已确认的 10 条决策

1. `mode` / `level` 是全局 UI 状态；`sessionRules` 按 `sessionId` 隔离。
2. evaluator 是唯一判定入口；manager 只负责 UI 队列、用户响应、always 写 rule 与 drain queue。
3. Pattern DSL 内部 canonical 全小写，匹配真实注册工具名。
4. `plan` 与 `auto` 使用同一套 `default/full-access` permission 矩阵；`plan` 不再通过独立 gate 改写 allow/ask/deny。
5. `memory` 在 classifier 内拆成 `memory-read` / `memory-write`，不扩展顶层 enum。
6. `skill` default ask，full-access allow。
7. plan 模式不按 mode 过滤工具列表；LLM 在 plan / auto 下看到完全相同工具。
8. `/mode` 不存在；TUI 的 `Shift+Tab` 只切 `plan <-> auto`，`/permission` 只切 `default/full-access`。headless/SDK/启动参数只支持初始值。
9. `full-access` 不绕过 scheduler 安全闸：external workspace write 与 untrusted MCP 仍强制 ask；external write 审批可记住。
10. Bash 由 `shell/command-classifier.classifyShellCommand(parsed)` 分类为 `readonly | mutating | dangerous`，复合命令按最危险子命令计，未知命令保守走 mutating/ask；运行前路径、安全闸检查继续由 `shell/preflight.ts` 承担。

---

## 与现有文档的关系

本目录覆盖并替换旧 `docs/permission/` 中的 policy+permission 双模块描述。代码实施完成后，需要同步更新：

| 文档 | 更新方向 |
|------|----------|
| [../goals-duty.md](../goals-duty.md) | permission 从“Policy 执行层”升级为“判定 + 审批一体的权限控制层” |
| [../architecture.md](../architecture.md) | 移除 policy 节点，加入 state/evaluator/classifier/rule |
| [../data-model.md](../data-model.md) | 替换为 Mode/Level/PermissionRule/PermissionState |
| [../dfd-interface.md](../dfd-interface.md) | 数据流改为 scheduler -> evaluator -> manager(UI) |
| [../test.md](../test.md) | 增加 evaluator/state/classifier/真实数据流测试 |
| [../../ohbaby-cli/tui-productization/policy-mode.md](../../ohbaby-cli/tui-productization/policy-mode.md) | 废弃或替换为 permission-mode 文档 |

---

## 与参考项目的关系

| 项目 | 采用点 | 不采用点 |
|------|--------|----------|
| DeepSeek-TUI / codex | capability 与 approval 分层 | 真实 OS 沙箱不在本轮范围 |
| kimi-code | 规则类型化、Pattern DSL、selector UI | 完整 permission policy 插件链暂不做 |
| opencode | per-tool pattern 规则、always 会话规则 | 持久化配置与 agent permission merge 暂不做 |
| pi | tool-call 前拦截思想 | 不把权限完全外置为扩展 |
| claude-code | mode 与 permission 用户面收敛 | 不采用单一 permissionMode preset |

---

## 实施边界

本轮覆盖：

- 删除 `packages/ohbaby-agent/src/policy/`。
- `permission/` 新增 `state.ts`、`rule.ts`、`matcher.ts` 扩展、`classifier.ts`、`evaluator.ts`。
- `PermissionManager` 删除内部 approval 状态和 `AutoEditRequested`。
- `tool-scheduler` 改调 evaluator，并保留 externalWrite / untrustedMcp 安全闸。
- 工具列表不再按 permission mode 过滤。
- SDK snapshot 从 `policy` 改为 `permission`。
- TUI 状态栏、`Shift+Tab`、`/permission`、PermissionSelector 更新。
- 启动参数支持初始 `--mode plan|auto`、`--permission default|full-access`。
- 单测、集成测试、e2e、真实数据流观察、子代理审查。

本轮不做：

- 权限规则持久化。
- `/mode` 命令或 headless 中途切 mode。
- 多 agent profile permission merge。
- 真实 OS sandbox。
- deny 规则的用户创建 UI。

---

## 实施前置

实施必须新建临时分支，建议：

```bash
git switch -c codex/permission-policy-refactor
```

真实 e2e 使用根目录 [ohbaby-e2e-test.md](../../../ohbaby-e2e-test.md) 中的本地凭据说明。执行记录不得提交真实 API key；日志和总结只描述 provider/model/结果，不输出密钥。
