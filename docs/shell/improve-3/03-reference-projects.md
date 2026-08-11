# 3. 优秀项目借鉴

## 3.1 借鉴来源

| 项目 | 路径 | 范围 |
|------|------|------|
| Claude Code | `BashTool`、`TaskOutputTool`、`TaskStopTool` / `KillShell` | bg 参数、output block/timeout、kill≡stop |
| Kimi Code | `bash.ts`、`task-{list,output,stop}.ts`、`agent/background/*` | 三件套；预览+path；timeout 单位（秒）对照 |
| Gemini CLI | `shell.ts` `is_background`、`shellBackgroundTools.ts` | list/read；PID 反例 |
| oh-my-pi | `bash` async、`AsyncJobManager`、hub stop/wait | 进程内 job；优雅杀 |

---

## 3.2 可借鉴点

| 项目 | 做法 | ohbaby 取舍 |
|------|------|-------------|
| Claude | `run_in_background`；`TaskOutput(block,timeout)`；Kill≡Stop | **adopt** 启动+output+同义终止；单位用 **ms**（与现 bash 一致） |
| Kimi | output 预览 + `output_path`；Stop 写 reason | **adapt** 预览；**reject** v1 落盘与 `output_path`，本批可不做 List |
| Gemini | 日志落盘 | **reject** v1 落盘；**reject** 裸 PID 对外 |
| oh-my-pi | 内存 job；stop 先优雅再硬杀 | **adopt** 与现 `killTree` 一致；**reject** hub |

---

## 3.3 明确不借鉴

- 独立 background daemon / 跨重启接回
- 把 subagent 塞进 bash 参数
- oh-my-pi hub 全能 `op`
- Claude 多任务类型与 Monitor 一次引入
- Kimi 过重 persist/RPC 账本作为 v1

---

## 3.4 对 02 的影响

| 02 决策 | 来源 |
|---------|------|
| bash 参数启动 + task_output + task_kill | Claude/Kimi + 00 |
| kill≡stop | Claude KillShell 语义 + 用户确认 |
| 逻辑 job id | 反 Gemini PID |
| block 默认 false | 偏 Kimi；防误阻塞 |
| timeout ms | 本仓 bash 既有单位 |
| 不做 List / 通知 | 减范围 |
