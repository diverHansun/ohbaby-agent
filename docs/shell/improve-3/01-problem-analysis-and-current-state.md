# 1. 问题基线与当前实施状态

> 时间口径：2026-08-09。范围：`bash` / shell 执行支撑 / subagent 后台对照；不含 MCP BM25。

---

## 1.1 问题陈述

1. **长命令堵对话**：`bash.execute` 同步 await 进程结束；无 background / job id。
2. **双超时**：ToolScheduler 默认 120s 墙钟 + bash 工具内 timeout（可至 600s），bash **未**设 `timeoutOwner: "tool"` → 用户加大 `timeout` 仍可能被 scheduler 先 abort；新增 `task_output.wait_ms` 最高也可为 600s，必须同样由工具自身管理，不能被默认墙钟抢先中断。
3. **后台语义缺口**：真正后台只有 `subagent_run(mode: background)`；用 subagent 跑 `npm run dev` 过重。
4. **无 task 观测/停止工具面**：无 `task_output` / kill；模型无法跨 turn 等结束或收尾。
5. **文档漂移**：`docs/tools/*` 仍写 `description`/`workdir`、旧 Permission.ask 位置；`docs/shell/goals-duty.md` N6 写「不做后台」。
6. **后台 job 无生命周期上限**（本次补充发现）：旧草案把 `timeout` 误写成「仅前台等待上限」，未定义 `run_in_background: true` 时的含义。若模型不主动 `task_kill`、session 又长期不 dispose（交互式长会话常见），bg 子进程可**无限期存活**——等同于变相拥有无监督后台进程，与「不做独立 daemon、只用受控进程内表」的既定边界相冲突。

---

## 1.2 已确认分界

```text
前台 bash ──await──► 输出（timeout 内 = job 生命周期到点即杀）
后台 bash ──spawn+登记──► 立即返回 job_id（timeout 仍是该 job 的生命周期上限）
                │
                ├─ task_output(block, wait_ms) ──工具自管等待上限──► output 尾部快照 + metadata.status
                ├─ task_kill（running）──killTree──► 终态 cancelled（模型主动）
                ├─ task_kill（已终态）──不杀进程──► 原样返回既有终态（幂等）
                └─ 生命周期 timeout 到点 ──registry 自动 killTree──► 终态 timed_out

permission/sandbox：与前台同一路径（启动前已评估）
subagent_*：Agent-as-job，本批不动工具面
```

---

## 1.3 bash / shell 现状

### 1.3.1 goals-duty

| 文档说 | 代码做 | Gap |
|--------|--------|-----|
| `docs/shell/goals-duty.md` N6：不做后台进程管理 | 确实无 bash job 表 | 产品要后台 → 本批修订职责：job 表在 tools 侧，shell 提供 spawn/killTree |
| N2：超时归 bash tool | 工具内有 timeout，但 scheduler 仍可能先砍 | 双超时未闭环 |
| improve-1：permission 在 scheduler | 与代码一致 | 根 `docs/tools/architecture.md` 仍说 bash 内 ask → 漂移 |

### 1.3.2 architecture

锚点：

- `packages/ohbaby-agent/src/tools/bash.ts` — 参数 `command` + `timeout`；前台 spawn；超时/abort → `killTree`
- `packages/ohbaby-agent/src/shell/process.ts` — `killTree`（进程组）
- `packages/ohbaby-agent/src/shell/preflight.ts` — execute 内二次 preflight
- `packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts` — permission 链；`timeoutOwner !== "tool"` 时挂墙钟；新增的可 block `task_output` 亦须声明 owner
- `packages/ohbaby-agent/src/tools/subagent.ts` — `timeoutOwner: "tool"`；bg 立即返 id
- `packages/ohbaby-agent/src/agents/subagent-host.ts` — 进程内 `active` Map + store

`detached: true`（非 Windows）服务于进程组清理，**不是**产品后台 job。

### 1.3.3 data-model

| 实体 | 现状 |
|------|------|
| Bash 工具参数 | `command`, `timeout?`（1…600000 ms）；无 bg 字段；bg 下 `timeout` 语义**未定义**（本节问题 6） |
| Shell job | **不存在** |
| Subagent job | `ActiveSubagentState` + `SubagentInstanceRecord`（不宜直接复用）；已有 `timed_out` 状态可作命名参照 |
| Shell job 终态集 | **不存在**；需新增 `running / completed / failed / cancelled / timed_out`；主动终止用 `cancelled`，生命周期超时用 `timed_out` |
| Shell job 结果 | **不存在**；新工具应沿用 `ToolExecutionResult = { output?, metadata? }`：output 为尾部文本，metadata 为 job/status/truncated 与终态退出信息 |

### 1.3.4 dfd-interface

前台路径（简化）：

```text
ToolScheduler.prepareCall
  → sandbox/lease.preflight(command)   # analyzeShellCommand
  → external_directory / sensitive_path
  → evaluatePermissionOnly(bash)
  → bash.execute
       → resolveCommandContext
       → preflightShellCommand（再次）
       → spawn → await exit / timeout / abort
```

缺口：无「登记 job → 立即返回 → 另工具读输出/杀」分支。

### 1.3.5 use-case

| 用例 | 现状 |
|------|------|
| 短命令 | OK |
| 长安装/构建（要等结束） | 堵 turn；且 timeout 双层不可靠 |
| dev server 长驻 | 无法 bg + 偶尔读日志 + kill |
| Agent 长任务 | subagent bg 可用 | 域不同 |

### 1.3.6 non-functional

- 输出截断：`OUTPUT_CAPTURE_CHAR_LIMIT`；bg 后需明确缓冲/落盘策略。
- 进程泄漏：无 registry 则 abort/session 结束难统一收尸；**若 bg 无生命周期上限，泄漏风险从「session 异常退出」扩大到「正常运行也可能永久挂着」**。
- 可靠性：双超时导致「我说等 5 分钟却 2 分钟死」。
- 可观测性：若超时自动杀与手动杀共用一个终态，用户/模型无法区分「进程正常被我杀掉」和「默默超时被系统杀掉」，排障困难。

### 1.3.7 test

- `bash.unit.test.ts`：spawn/timeout/abort/killTree 较全。
- scheduler 对 bash permission 顺序有覆盖。
- **缺**：bash `timeout > 120s`、task_output `wait_ms > 120s` 与 scheduler 的交互；bg/job/task_*（尚未实现）。
- subagent 的 `timeoutOwner` / bg 单测可作样板。

---

## 1.4 跨模块一致性

| 模块 | 问题 |
|------|------|
| tool-scheduler | bash 缺 `timeoutOwner`；未来可 block 的 task_output 也须避免默认墙钟；subagent 已有 |
| permission/sandbox | 路径正确，bg 必须复用，不可另开信任通道 |
| docs/tools | 参数与 Permission 位置漂移 |
| docs/shell 根文档 | architecture 未反映 analysis/preflight 全貌 |

---

## 1.5 改动影响面（现状视角）

- `tools/bash.ts`、builtin 注册
- 新：`ShellJobRegistry`（建议 `tools/` 或 `shell/jobs/`）
- 新：`task_output` / `task_kill` 工具
- `composition` / `createBuiltinTools` 注册
- runtime dispose 钩子（`composition.dispose` 层，与 `toolScheduler.cancelAll` 同层；session manager 无独立 dispose）：清理未结束 job
- 文档：`docs/tools/*`、`docs/shell/goals-duty.md` N6

---

## 1.6 SWE 原则审视摘要

- 后台要解决的是 **控制流不阻塞**，不是分布式任务系统 → 进程内表足够（YAGNI）。
- Subagent 与 shell job **域不同**；硬合并工具面是偶复杂度 → 本批分工具、可共用薄 registry 接口。
- bash 与可 block task_output 分别自管各自的等待边界，才能消除 scheduler 默认墙钟带来的偶然复杂度。

---

## 1.7 与既有文档关系

| 文档 | 关系 |
|------|------|
| `docs/mcp/improve-1/` | 先实施 |
| `docs/shell/improve-1|2` | 分析链保留；permission 流可引用 |
| `docs/shell/goals-duty.md` | 本批修订 N6 |
| 笔记 tools-upgrade | 双超时、无 bg 债并入本批 |

---

## 1.8 承重问题 → 02

| ID | 问题 | 02 入口 |
|----|------|---------|
| S1 | 无 bg，堵对话 | `run_in_background` + job 表 |
| S2 | bash 与未来 task_output 的双超时 | 两者声明 `timeoutOwner: "tool"`，分别落实 lifecycle timeout / `wait_ms` |
| S3 | 无观测/停止 | `task_output` + `task_kill` |
| S4 | 与 subagent 边界 | 分工具面；薄 registry |
| S5 | 文档漂移 | Phase 文档同步 |
| S6 | session 结束泄漏 | dispose 杀未结束 job |
| S7 | bg 无生命周期上限 | `timeout` 统一语义为 job 最大生命周期；到点 registry 自动 kill |
| S8 | 超时终态与手动终态混淆 | 新增 `timed_out`；主动 kill → `cancelled`；已终态幂等不覆盖 |
| S9 | 「增量输出」若无 cursor 则名不副实 | v1 改为有上限尾部快照；不引入 cursor/隐藏消费位置 |
| S10 | 输出路径契约会把 v1 带入文件生命周期与持久化设计 | 本批删除 `outputPath`；只保留有上限的内存尾部，日志文件另开议题 |
| S11 | bash 与 task_output 同名 `timeout` 实际含义不同 | bash 保留兼容字段；新 task_output 使用 `wait_ms` |
| S12 | 结果字段只有描述没有落点 | 固定 `output + metadata`；不把 JSON 塞入 output，也不提前定义全局响应信封 |
| S13 | 先写逻辑终态会拿不到稳定退出信息 | 先认领终止原因，wait for child close 后一次性写 status/exitCode/signal |
