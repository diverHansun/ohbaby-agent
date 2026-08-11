# 4. 测试与验收标准

---

## 4.1 测试范围

| 类型 | 覆盖 |
|------|------|
| 单测 | timeoutOwner、bg 立即返回、registry 状态机、task_output block/非 block、task_kill、归属校验、dispose 清理、**生命周期 timeout 自动 kill 与 `timed_out` 终态** |
| 集成 | permission 链在 bg 启动前仍触发；sandbox preflight 失败不得登记 job |
| 回归 | 前台 bash 既有测例；subagent bg 不受影响 |
| 手工 | 真实长命令（如 `sleep 5` / 短 HTTP server）bg → output → kill |

---

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | Phase |
|----|------|------|--------|-------|
| T-P1a | 前台 `timeout: 300000` | 单测/集成（fake timer） | ≥120s 仍由工具层管理，不被 scheduler 默认 120s 单独误杀；测试不真实等待 120 秒 | 1 |
| T-P1b | 前台短命令 | 回归 | 输出/退出码与改前一致 | 1 |
| T-B1 | `run_in_background:true` | 单测 | 立即返回 `output` 与 `metadata.jobId/status/truncated`；进程仍在跑 | 2 |
| T-B2 | bg 启动前 permission deny | 集成 | 不 spawn / 不登记 | 2 |
| T-B2b | 异步 preflight 中取消 turn/session | 单测（gated preflight） | preflight 返回后不得 spawn 或登记 job | 2 |
| T-B3a | registry session dispose | 单测 | 目标 session 的 running job 被 killTree，全部所属记录移除；其它 session 不受影响 | 2 |
| T-B3b | 主 session 删除 | 集成 | 先 interrupt/cancel 并等待所属 producer 停稳，再从持久 store 清理 parent session 与全部 child scopes；completed/inactive subagent 也覆盖 | 2 |
| T-B3c | subagent scope 关闭 | 单测/集成 | 等当前 run 停稳后只清理该 context scope；共享 child session 的兄弟 scope/job 不受影响 | 2 |
| T-B4 | 前台缺省 bg | 回归 | 仍 await | 2 |
| T-B5 | bg + 短 `timeout`，命令运行超过该时长 | 单测 | Registry **自动** `killTree`；`task_output` 读到 `status: timed_out`；无需模型调 `task_kill` | 2 |
| T-B6 | bg + 未传 `timeout` | 单测（fake timer） | 使用默认值（120_000 ms），行为与 T-B5 等价，只是到点更晚 | 2 |
| T-B7 | fg 超时（既有场景重跑） | 回归 | 终态字段更新为 `timed_out`（而非笼统 error/timeout 文案），确认不破坏既有断言或同批更新断言 | 2 |
| T-O1 | output `block:false` | 单测 | `output` 为当前尾部快照；metadata 必含 `jobId/status/truncated`；**无** cursor/offset 字段 | 3 |
| T-O2 | output `block:true` 至完成 | 单测 | 使用 `wait_ms` 等到 exit；终态 metadata 必带 `exitCode` 与 `signal` | 3 |
| T-O3 | output block 等待超时 | 单测 | `wait_ms` 到点返回；进程可仍在跑；不改变 job 生命周期 timeout；仍是尾部快照 | 3 |
| T-O3b | 合法的长 block 等待 | 单测/集成（fake timer） | `wait_ms:300000` 不被 scheduler 默认 120s 抢先中断；到 `wait_ms` 才返回或进程先结束 | 3 |
| T-O4 | 未知 / 跨 session job_id | 单测 | 明确错误 | 3 |
| T-O5 | v1 输出策略 | 单测 | 输出只来自有上限的内存尾部；metadata 不包含 `outputPath` | 2/3 |
| T-O7 | 连续两次 `task_output`（无 cursor） | 单测 | 两次各自返回当前尾部；不依赖「上次读到哪」的隐藏状态 | 3 |
| T-O8 | 尾部截断 | 单测 | 早期输出被环形缓冲丢弃时，metadata `truncated:true`；未截断时为 false | 2/3 |
| T-O9 | metadata 模型投影 | 集成 | `task_output/task_kill` 的白名单字段经 `tool_metadata` 送达模型；非白名单字段不泄露 | 3 |
| T-O10 | block 中取消当前 turn | 单测 | 本次等待立即取消；job 仍为 running，不触发 killTree | 3 |
| T-O11 | 文件读取槽已满时调用 task_output | 调度器单测 | task_output 仍可执行，不占用、不等待 `maxReadConcurrency`；`readOnlyHint` 保持 true | 3 |
| T-K1 | kill running | 单测 | 进程树退出；`output` 为当前尾部快照；状态 **`cancelled`**（不是 `timed_out`）；close 后必带 exitCode/signal | 3 |
| T-K2 | kill 已 `completed`/`failed`/`cancelled` | 单测 | **不**再 killTree；返回该既有终态 | 3 |
| T-K3 | kill≡stop 文档 | 文档 | README/工具 description 写明同义；主动终态名为 `cancelled` | 4 |
| T-K4 | 对已 `timed_out` 的 job 调 `task_kill` | 单测 | 幂等；终态**保持** `timed_out`，不被覆盖成 `cancelled` | 3 |
| T-R1 | `timeout` / `task_kill` / dispose / exit 同时竞争 | 单测 | 首个**终止原因**归属者获胜；child close 后一次性写终态与 exit 字段；`killTree` 最多一次 | 2/3 |
| T-R2 | killTree 后 child 不发 close | 单测（fake timer） | 1 秒后按已认领原因收口；task_kill/timeout/dispose 不永久等待 | 2/3 |
| T-R3 | 连续产生超过 100 个已终态 job | 单测 | 最早终态被淘汰，最新结果仍可读取，running 不因保留上限被删 | 2/3 |
| T-R4 | 前台双流 chunk 交错 | 单测 | 模型输出仍按旧契约 stdout 后 stderr；后台继续返回交织尾部 | 1/2 |
| T-R5 | spawn error | 单测 | failed 输出保留原始 error message；metadata 可记录 error | 1/2 |
| T-R6 | child 先 exit、close 延迟；终态完成顺序与创建顺序不同 | 单测（fake timer） | 生命周期定时器仍生效；到点 killTree → timed_out；淘汰最早完成而非最早创建的 job | 2/3 |
| T-A1 | generic/explore/research 包含 bash | 单测 | 同时可用 task_output/task_kill | 1 |
| T-D1 | docs 参数表与 schema 一致 | 人工 | 无虚假 description/workdir 必填；无 cursor 参数 | 4 |
| T-D2 | `timeout` / `wait_ms` 参数 description | 人工 | bash timeout 写明 job 生命周期；task_output wait_ms 写明只限制本次等待；两者互不覆盖 | 4 |
| T-D3 | `task_output` description | 人工 | 写明「尾部快照」而非「增量消费」，并说明 output 与 metadata 的字段归属 | 4 |

---

## 4.3 集成边界

- **Permission/sandbox**：只在 bash 启动调用上评估；task_* 不重新解析 command。
- **Subagent**：并行存在；测例互不登记到对方 store。
- **平台**：Unix 进程组 kill 为主；Windows 走现有 `taskkill` 路径（至少单测 mock）。

---

## 4.4 回归清单

- 前台 timeout/abort/killTree 行为
- commandPrefix / 输出截断
- scheduler 对 bash 的 external → sensitive → ask 顺序
- `subagent_run/status/close` 全绿

---

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| 不堵对话 | bg 调用在秒级返回 | T-B1 |
| 可等待 | block+wait_ms 能等到结束或超时返回，不改变 job 生命周期，也不被 scheduler 默认 120s 抢先中断 | T-O2/O3/O3b |
| 可终止 | kill 后无残留子进程（夹具范围内） | T-K1 |
| 权限不降 | deny 时不启动 | T-B2 |
| 双超时修复 | 大 timeout 前台不被 120s scheduler 误杀 | T-P1a |
| bg 生命周期兜底 | bg job 到 `timeout` 必被自动终止，不可无限期存活 | T-B5/B6 |
| 终态可区分 | 自动超时 → `timed_out`；主动 kill → `cancelled`；已终态不可覆盖 | T-B5、T-K1、T-K4 |
| 输出契约 | output 为尾部快照；metadata 固定 status/truncated、终态带 exitCode/signal；无 cursor；v1 不落盘 | T-O1/O2/O5/O7/O8/O9 |
| 范围 | 无独立 daemon；无 MCP 改动混入；无 memory_*/响应信封改动 | diff 审查 |
| 文档 | goals-duty N6、tools 参数、`timeout`/`task_output` 语义说明已更新 | T-D1/D2/D3 |
| 真实进程 E2E | build 后启动短命令或短 HTTP server，覆盖 bg → output → timeout/kill | 不以 mock 代替；可在本机进程或浏览器完成 |

---

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|--------|------|----------|
| 用 task_output 读他人 session job | job 归属校验 | 需防 id 猜解（id 足够熵） |
| bg 绕过 permission | 启动前同一链 | 实现漏接 → T-B2 必过 |
| kill 杀错进程 | 只杀登记 pid 树 | pid 复用窗口极小但存在 → 逻辑 id + 启动世代 |
| 无限 block | `wait_ms` 必填或默认上限 | 模型传极大 `wait_ms` → 设硬上限 |
| session 删除后 job 成为孤儿 | 先停 producer，再由主 session 删除、subagent scope 关闭、runtime 全局 dispose 三层钩子回收 | daemon 化仍不做，接受宿主进程被强杀时 OS 子进程可能残留的现实 |
| 模型故意/无意传超大 `timeout`（如数天）让 bg 变相长期存活 | 复用现有 `MAX_TIMEOUT_MS`（600_000 ms）作硬上限，不因 bg 放宽 | 硬上限内仍可运行 10 分钟，需配合 session 生命周期整体评估是否足够 |
| Registry 定时器与手动 `task_kill` 竞态（几乎同时触发） | 状态机「先到先得」；已终态不可二次改写 | 极端并发下时序依赖单测覆盖 |
| 把尾部快照误当增量游标 | 无 cursor API；description 写清 | 真增量需求另开批次 |
| 把 `wait_ms` 误解为 job timeout | 字段改名 + description + T-O3 | 模型仍可能传错量级，受 600s 上限保护 |
| 终态缺少退出原因 | child close 后才提交终态；exitCode/signal 固定字段 | killTree/平台实现需统一采集信号 |
