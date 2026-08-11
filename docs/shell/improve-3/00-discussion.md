# 讨论记录与已确认要点

> 2026-08-09 定稿。讨论来源：[Ohbaby agent optimization](656ac25a-1867-4e78-86e5-94d4a9680088) 与本规划会话。正式方案见 01–04。

### timeout 的适用对象

这里的 10 分钟硬上限约束的是通过 bash 启动的 shell job，前台和后台相同：

- bash 执行的命令，包括 dev server、构建、安装等，最长按该 job 的 timeout 运行；未显式传值时使用默认 120s，最大值 600s。
- 宿主进程本身的 ohbaby serve 生命周期不由这个 bash job timeout 管理。
- subagent_run 的模型/agent 运行时间不计入 shell job 生命周期；subagent 保持自己的工具、超时和状态语义。
- 如果 bash 命令内部再启动了其它进程，它们属于该 shell job 的进程树，timeout 到点由 ShellJobRegistry 按既定 killTree 语义收尾。

---

## 1. 背景与动机

- 长命令堵死对话是明确痛点；subagent 后台是「Agent-as-job」，不适合替代 `npm run dev` 类 shell 长进程。
- 对照调研：**业界无独立 background execution daemon**；主流是 spawn + **进程内 job 表** + output/stop。
- 排期（本会话确认）：**先** `docs/mcp/improve-1/`，**后**本批。
- 补充讨论（2026-08-09 第二轮）：读 `Hansun-database` 笔记 [[2026-08-07-coding-agent-builtin-tools-survey]] / [[2026-08-07-ohbaby-agent-tools-upgrade]] 后发现，首版草案只定义了「前台等待」与「读输出等待」两个 timeout，未定义**后台 job 自身的最大生命周期**——若模型不主动 `task_kill`、session 又长期不 dispose，bg 进程可无限期存活，等同于变相拥有无监督后台进程。本节补齐该缺口。

---

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| 文档落点 | `docs/shell/improve-3/`（与 MCP 文档拆成两套） |
| 成功标准 | 长命令可不阻塞对话；可 block/timeout 等待或读输出；可 kill/stop；权限与前台 bash 一致 |
| 启动 | `bash` 增加 `run_in_background`（布尔参数）；立即返回 job id |
| 观测 | **1 个** `task_output(block, wait_ms)`；`wait_ms` 只限制本次 block 等待，不修改 job 生命周期 |
| 终止 | **1 个** `task_kill`；与 stop **同义**（不另建 task_stop） |
| Job 实现 | **进程内 `ShellJobRegistry`**（对齐 subagent 模式的薄 registry，不共用 subagent store） |
| Permission/sandbox | **沿用前台 bash** 路径（scheduler preflight → external_directory → sensitive_path → evaluatePermissionOnly → ask 确认；ask 在 scheduler 内，非 bash 工具自调） |
| 超时归属 | bash（含后台）与可 block 的 `task_output` 使用 `timeoutOwner: "tool"`；前者管理 job 生命周期，后者管理 `wait_ms` |
| Subagent | **保持专属三件套**；不改成 bash 参数 |
| `timeout` 语义 | **统一为 job 最大生命周期**，fg/bg 通用；bg 到点 registry **自动 `killTree`**，无需模型手动 `task_kill` |
| 超时终态 | 新增 **`timed_out`** 终态，与模型主动 `task_kill` 的 **`cancelled`** **区分**；命名对齐 `subagent` 现有 `timed_out` / `cancelled` 语义 |
| `task_output` v1 | 每次以现有 `ToolExecutionResult.output` 返回**有上限的输出尾部快照**；`metadata` 固定带 `jobId/status/truncated`；**不**引入 cursor/offset，**不**维护隐藏消费位置 |
| 输出持久化 | **本批不落盘**；只保留有上限的内存尾部缓冲，删除 `metadata.outputPath` 契约 |
| Job 保留 | Registry 最多保留 **100** 个 job；超限时按**进入终态的顺序**淘汰最早完成的 job，running job 不淘汰 |
| 终止收口 | `killTree` 后最多等待 child `close` **1 秒**；仍未 close 时按已认领原因落终态，避免 `task_kill` / timeout / dispose 永久挂起 |
| 取消等待 | `task_output(block:true)` 监听当前 tool 的 AbortSignal；取消只结束本次读取，不 kill、不改 job 状态 |
| 终态退出字段 | `completed/failed/cancelled/timed_out` 必带 `metadata.exitCode` 与 `metadata.signal`（不适用的一项为 `null`）；运行中不带这两个字段 |
| `task_kill` 幂等 | 已是 `completed`/`failed`/`cancelled`/`timed_out` → **不再** `killTree`，直接返回该既有终态；仅对 `running` 杀进程并标 `cancelled` |
| 竞态归属 | timeout / 手动 kill / dispose 与自然 exit 先原子认领**终止原因**；实际子进程退出后再写终态与 exit 字段。`terminating` 只是 registry 内部标记，不新增模型可见状态 |
| 默认值 | 维持现状（默认 120s、上限 600s），对齐 Claude 量级；bg 若要跑更久，模型须显式传更大 `timeout` |
| 文档完整度 | 00–04 齐全 |

---

## 3. 已确认：边界（不做的事）

| 项 | 说明 |
|----|------|
| 独立 bg daemon / 重启接回 OS 进程 | 不做 |
| 本批合并 subagent 到 Task* 门面 | 不做（实现可预留共用薄接口，工具面分阶段） |
| Gemini 对外暴露裸 PID 为主 ID | 不做（用逻辑 job id） |
| oh-my-pi hub 全家桶 | 不做 |
| MCP 检索 | 见 mcp improve-1 |
| 完成自动通知注入（可后续） | 本批非必须 |
| 虚假 `memory_*` LLM 工具契约清理 | **不并入**；作为第 3 批独立推进，见 `docs/core/memory/improve-1/`。仅清理模型可调用面的幽灵契约，保留 MemoryLoader 的被动 memory/context 能力 |
| 统一工具响应信封（status/text/error，笔记 P3） | **不并入**（改动面大，非后台/超时因果相关） |
| `timeout` 与 job 生命周期分离成两个参数 | 不做（已确认统一语义，见 §2） |

这里的“不分离”仅指 bash job 不再引入第二个 `max_lifetime` 字段；`task_output.wait_ms` 是独立观测工具的本次等待参数，不改变、也不覆盖 bash 的 `timeout`。

---

## 4. 已确认：与关联议题的关系

| 关联 | 关系 |
|------|------|
| `docs/mcp/improve-1/` | 先实施 |
| `docs/core/memory/improve-1/` | 第 3 批实施；不改变本批 Shell job 的协议或状态机 |
| `docs/shell/improve-1|2` | 分析/脚本；本批不改其主线，可交叉引用 permission 流 |
| `docs/shell/goals-duty.md` N6「不做后台」 | 本批**有意修订**该 Non-Duty：后台 job 管理归 tools + 薄 registry，shell 仍提供 killTree/spawn 支撑 |
| `tools/subagent.ts` / `SessionSubagentHost` | 模式参考；不混 schema |
| 笔记超时双层债 | **并入本批**修复（bash 与可 block `task_output` 的 `timeoutOwner`） |

---

## 5. 参考项目（摘要）

| 项目 | 借鉴 | 不照搬 |
|------|------|--------|
| Claude | `run_in_background`；`TaskOutput(block,timeout)`；Kill≡Stop | 复杂 tasks 图 / Monitor |
| Kimi | TaskOutput/Stop；预览+output_path；进程内账本思想 | 过重 persist/RPC；本批不做 List 也可先 |
| Gemini | 日志落盘思路 | 裸 PID 对外；缺 stop 工具 |
| oh-my-pi | 进程内 job；graceful→hard kill | hub 全能工具 |

细节见 [03-reference-projects.md](./03-reference-projects.md)。

---

## 6. 用户确认记录

| 时间 | 确认项 |
|------|--------|
| 2026-08-09 上轮 | 长命令优先痛点；bash 参数启动；勿把 subagent 改成 bash；进程内 job；可加 1 个 task_output |
| 2026-08-09 本会话 | 文档拆 2 套；先 MCP 后 bash；`task_output` + kill（kill≡stop）；permission 沿用前台；讨论以上一轮为准 |
| 2026-08-09 本会话（第二轮） | `timeout` 统一为 job 最大生命周期（fg/bg 通用，bg 到点自动 kill）；新增 `timed_out` 终态，与手动 `task_kill` 区分；默认值维持现状；幽灵 `memory_*` 与统一响应信封（P3）**均不并入**本批 |
| 2026-08-09 本会话（第三轮） | `task_output` v1 = 有上限尾部快照 + status（无 cursor/隐藏游标）；`task_kill` 对已终态幂等返回原状态，running → `cancelled`（不覆盖 `timed_out`） |
| 2026-08-10 本会话（第六轮） | v1 不落盘、不返回 `outputPath`；`ShellJobRegistry` 只维护有上限的内存尾部缓冲，后续如需日志文件另开议题 |
| 2026-08-11 评审修补 | bash-enabled subagent 同时获得 `task_output/task_kill`；保留 spawn error；前台恢复 stdout 后 stderr；终止 close 等待有 1s 兜底；终态 job 表上限 100 |
| 2026-08-11 合并前复核 | child `exit` 不提前取消生命周期定时器，必须等 `close` 才自然落终态；终态淘汰按完成顺序而非创建顺序 |
| 2026-08-09 本会话（第四轮） | 三批次分别实施、测试并提交：MCP → Shell → Memory；Shell registry 命名定为 `ShellJobRegistry`；`memory_*` 虚假 LLM 工具契约移入独立 memory problem-list，统一工具响应信封继续延期 |
| 2026-08-09 本会话（第五轮） | bash 保持 `timeout`（job 生命周期）；`task_output` 改用 `wait_ms`（本次 block 等待）。Shell 结果使用既有 `output + metadata`：尾部文本在 output，状态与退出字段在工具专属 metadata；终态在子进程退出后才落定 |
