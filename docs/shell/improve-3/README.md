# shell improve-3 · bash 后台 + `task_output` / `task_kill`

> 状态：**已实施（第 2 批）**
> 日期：2026-08-09
> 落点：`docs/shell/improve-3/`
> 前置：`docs/mcp/improve-1/`（三批次中的第 1 批）
> 后续：`docs/core/memory/improve-1/`（三批次中的第 3 批；与 shell 域分离）
> 承接：`docs/shell/improve-1|2`（命令分析 / 脚本路径）；本批补 **进程级后台执行与观测**

## 1. 议题

当前 `bash` 仅前台同步执行：长命令（安装、dev server、构建）会堵死当前 tool call / 对话轮次。Subagent 已有进程内后台，但不适合拿来跑普通 shell 长进程。

本批目标：

1. `bash` 增加 `run_in_background`，立即返回 job id；v1 只保留有上限的内存尾部，不落盘
2. 新增 **`task_output`**（`block` + `wait_ms`）：有上限**尾部快照** + status（无 cursor）
3. 新增 **`task_kill`**（≡stop）：running → `cancelled`；已终态幂等返回
4. **进程内 job 表**；permission/sandbox **沿用前台 bash** 路径
5. 修复 bash 与 ToolScheduler 的 **双超时** 归属（bash 与可 block 的 `task_output` 均为 `timeoutOwner: "tool"`）；`timeout` 为 job 生命周期，到点 → `timed_out`
6. bash-enabled subagent 同时获得 `task_output/task_kill`；阻塞读取响应 turn abort
7. 终止等待 child close 最多 1 秒；Registry 最多保留 100 个 job
8. 主 session 删除与 subagent scope 关闭时先停稳 producer，再分别按 session/context scope 回收 job（含 inactive child scopes）；bash preflight 后复查取消；`task_output` 不占文件读取并发槽

## 2. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 已确认决策与边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 现状与问题 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 实施契约 |
| [03-reference-projects.md](./03-reference-projects.md) | Claude / Kimi / Gemini / oh-my-pi 等 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 测试与验收 |

推荐阅读：`00 → 01 → 02 → 03 → 04`。实施以 `02 + 04` 为准。

## 3. In scope

- `bash`：`run_in_background`；前台路径保留；`timeout` 为 fg/bg 通用的 job 最大生命周期
- 进程内 `ShellJobRegistry`：id / status / pid / 有上限的内存输出 / abort；到点自动 `killTree`；终态保留有界
- Registry 生命周期接入主 session 删除、subagent scope 关闭与 runtime 全局 dispose；scope 清理不影响共享 child session 的兄弟 subagent
- builtin：`task_output`（`wait_ms` 等待、尾部快照）、`task_kill`（kill≡stop；主动终态 `cancelled`）；结果沿用 `output + metadata`，不引入全局响应信封
- `task_output` 保持只读副作用语义，但使用控制类调度豁免，不占 `read/glob/grep` 的并发槽
- bash 与可 block 的 `task_output` 使用 `timeoutOwner: "tool"`，消除与 scheduler 默认 120s 冲突；bg 到点自动 `timed_out`
- 沿用现有 bash permission / sandbox / preflight / `killTree`
- 同步漂移的 `docs/tools/*`、`docs/shell/*` 中与本批冲突的表述

## 4. Out of scope

| 项 | 说明 |
|----|------|
| 独立 background daemon / 跨重启复活进程 | YAGNI |
| 把 subagent 改成 bash 参数 | 域不同 |
| 本批统一收编 `subagent_status/close` 为 Task 门面 | 可留 improve-4；本批只服务 shell job |
| Codex 式持久 PTY 会话 | 暂缓 |
| MCP BM25 | `docs/mcp/improve-1/` |
| 虚假 `memory_*` LLM 工具契约清理 | `docs/core/memory/improve-1/`（第 3 批）；保留 MemoryLoader 的被动加载/注入能力 |
| 完成通知注入对话（Claude 风格） | 可选后续；本批以 task_output 为主 |

## 5. 实施契约声明

实现已按 `02` 落地，并按 `04` 的自动化门槛验证。
