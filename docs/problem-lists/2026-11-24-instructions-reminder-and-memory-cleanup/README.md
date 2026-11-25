# 指令提醒化（AGENTS.md / CLAUDE.md）与长期记忆残留清理

本议题解决 `ohbaby-agent` 后端中“用户/项目指令文件误拼入静态 System Prompt 导致 KV Cache 失效”以及“`OHBABY.md` 与历史长期记忆残留未清干净”两类问题，通过复用现有 `system-reminder` 管道引入独立的 `services/instructions` 模块完成改造。

---

## 范围说明

- **In Scope（本轮包含）**：
  1. 将用户/项目指令从 `SystemPrompt.assemble()` 中彻底移除，恢复静态 system prompt 的 KV Cache 稳定性。
  2. 新增 `services/instructions` 模块，接入 `services/reminder` 管道，统一面向主代理与子代理注入低优先级 `user` 侧 `<system-reminder>`。
  3. 仅支持行业标准文件名 `AGENTS.md`（复数）与 `CLAUDE.md`，两者共存时全部读取并按内容哈希去重；作用域覆盖用户全局（`~/.ohbaby/`）与会话项目根；彻底移除 `OHBABY.md`，不兼容单数 `AGENT.md`。
  4. 彻底清除长期记忆残留（A 类：旧全局记忆路径与迁移逻辑由前置专题先移除，本轮清理 `docs/core/memory/` 空壳目录与幽灵 `memory_*` 工具测试；B 类：`ToolCategory` / `PermissionToolCategory` / `PermissionCallKind` / `goals/tools.ts` 中沿用的 `"memory"` / `"memory-write"` 命名正名为 `"internal-state"`）。
  5. 同步更新受影响模块的设计文档与仓库根目录入口文件（删除 `OHBABY.md`，保留并规范 `AGENTS.md` / `CLAUDE.md`）。

- **Out of Scope（本轮不做）**：
  1. 长期记忆新能力的设计与实现（将由独立仓库单独设计，与 `ohbaby-agent` 代码解耦）。
  2. 项目子目录递归扫描、工具触达动态发现（`read`/`write`/`edit` touch）与后台 `fs.watch` 热监听。
  3. Claude Code `@path` 导入语法、`.claude/rules/*.md` 与 `AGENTS.local.md` / `CLAUDE.local.md` overlay。
  4. 按子代理角色差异化关闭指令注入（如 `Explore` 跳过）。
  5. 与长期记忆无关的 RAM 内存存储命名（如 `InMemoryShellJobStore`、`:memory:`、`adapters/ui-state/memory-store.ts`）。

---

## 轮次地图

| 轮次 | 开启日期 | 状态 | 触发事件 | 说明 |
| --- | --- | --- | --- | --- |
| `improve-1/` | 2026-11-24 | 规划中（待审查） | 首轮立项 | 一次性完成指令提醒化迁移、`OHBABY.md` 移除与长期记忆 A/B 类残留清理（轮内拆分为 4 个 Stage） |

---

## `improve-1/` 文档地图

| 编号 | 文档 | 作用 |
| --- | --- | --- |
| 00 | [00-discussion.md](./improve-1/00-discussion.md) | 与用户已确认的 8 项结论与边界冻结 |
| 01 | [01-problem-analysis-and-current-state.md](./improve-1/01-problem-analysis-and-current-state.md) | 代码基线（`e7ecdc52`）现状诊断、问题链与 SWE 原则审视 |
| 02 | [02-optimization-plan-and-change-scope.md](./improve-1/02-optimization-plan-and-change-scope.md) | 面向实施会话的执行契约：分 Stage 方案、改动面、迁移与风险 |
| 03 | [03-reference-projects.md](./improve-1/03-reference-projects.md) | `deepseek-harness`、`kimi-code`、`ZCode`、`Codex`、`Claude Code` 借鉴与取舍 |
| 04 | [04-test-and-acceptance.md](./improve-1/04-test-and-acceptance.md) | 测试策略、关键场景、发布门验收标准与红队审查要点 |
| 05 | `05-implementation-acceptance.md`（预留） | 本轮实施完成后由验收模式写入，规划期不存在 |

---

## 关联新增模块设计文档（`plan-module-design`）

本轮新增的 `services/instructions` 模块完整设计位于 [docs/services/instructions/](../../services/instructions/goals-duty.md)：

- [goals-duty.md](../../services/instructions/goals-duty.md)
- [architecture.md](../../services/instructions/architecture.md)
- [data-model.md](../../services/instructions/data-model.md)
- [dfd-interface.md](../../services/instructions/dfd-interface.md)
- [non-functional.md](../../services/instructions/non-functional.md)
- [test.md](../../services/instructions/test.md)

---

## 实施契约声明

本目录（`00`–`04`）及 `docs/services/instructions/` 均为**规划阶段产出**，用于后续独立实施会话按 `02` + `04` 执行改造，本规划会话不修改业务源码。实施完成后另开验收会话产出 `improve-1/05-implementation-acceptance.md`。
