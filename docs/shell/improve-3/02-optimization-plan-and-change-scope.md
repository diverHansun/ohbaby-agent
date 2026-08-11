# 2. 优化方案与改动面

> 执行契约：后续开发会话按本文 + [04](./04-test-and-acceptance.md) 实施。须在 **MCP improve-1 之后**（或并行分支但合并顺序按 00）。

## 2.0 timeout 适用边界

本生命周期只属于通过 bash 启动的 shell job：它不限制宿主 ohbaby serve，也不计入 subagent_run 的模型运行时间。subagent 继续使用自己的 timeout/status 机制。bash job 的硬上限为 600_000 ms，默认值为 120_000 ms。

---

## 2.1 方案总览

```text
bash(command, timeout?, run_in_background?)
  ├─ false/缺省：前台 await（现逻辑）+ timeoutOwner:"tool"
  │              timeout 到点 → killTree → 终态 timed_out
  └─ true：permission 通过后 spawn → 登记 job（含 timeout 生命周期定时器）→ 立即返回
              { output, metadata: { jobId, status, truncated } }
              timeout 到点 → registry 自动 killTree → 终态 timed_out（无需模型调用 task_kill）

task_output(job_id, block?, wait_ms?)
  → ToolExecutionResult.output = 当前有上限的输出**尾部快照**（非 cursor 增量消费）
  → metadata = { jobId, status, truncated, exitCode?, signal? }
  → 无 cursor/offset；无隐藏「已读位置」状态；每次调用独立取当前尾部
  → wait_ms 只限制本次 block 等待；与 bash job 生命周期 timeout 互不影响

task_kill(job_id)
  → 若 job 已是 completed|failed|cancelled|timed_out：不调用 killTree，直接返回该既有终态（幂等）
  → 若 job 为 running：abort + Shell.killTree → 终态 cancelled
  → `output` 同样为调用完成时的有上限尾部快照；`metadata` 使用同一份 ShellJob 字段
```

**`timeout` 语义统一为「job 最大生命周期」**，fg/bg 通用：

| 触发方式 | 谁发起 | 终态 |
|----------|--------|------|
| `timeout` 到点 | Registry 自动 | `timed_out` |
| 模型调用 `task_kill`（running） | 模型主动 | `cancelled` |
| 模型调用 `task_kill`（已终态） | — | **保持**原终态，不覆盖 |
| 进程自然退出（成功/失败） | 进程自身 | `completed` / `failed` |

进程内 `ShellJobRegistry`：`Map<jobId, JobState>`，归属 session；每个 job 持有一个基于 `timeout` 的到期定时器（fg/bg 共用），定时器在 child `close` 或 registry 兜底落终态前保持有效，单独收到 `exit` 不提前清除。Registry 最多保留 100 个 job，超限时按进入终态的顺序淘汰最早完成的 job，running job 不淘汰。**不**写入 subagent SQLite schema。

Registry 同时提供两级回收：主 session 删除时使用 `disposeSession(sessionId)` 清理 parent，并从持久 subagent store 枚举全部 child records（包含 completed/inactive）逐个执行 `disposeScope(sessionId, contextScopeId)`；共享 child session 中的单个 subagent 关闭时也使用 scope 清理。两条链路都必须先取消/等待所属 run 停稳，再终止并移除对应 running/terminal 记录，防止清理快照之后又登记新 job；bash 自身也在异步 preflight 返回后、spawn 前再次检查 AbortSignal。scope 清理不得影响兄弟 subagent。全局 runtime dispose 仍负责最后兜底。

终态原因必须由一个同步的「终止原因归属」转换原子认领：`timeout`、`task_kill`、dispose 与子进程自然 exit 同时到达时，**先成功认领的一方**决定最终原因。若原因需要 killTree，registry 先记内部终止原因、再等待子进程 close；最多等待 1 秒，仍未 close 时以 `exitCode/signal = null` 收口。该内部标记不新增模型可见 `terminating` 状态。

---

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| 启动 | `bash.run_in_background` | 业界主流；少工具 | 单独 start_command 工具 | bash schema 变长 |
| 观测 | `task_output(block, wait_ms)` | 避免与 bash job 生命周期同名冲突 | 仍叫 timeout | +1 builtin |
| 终止 | `task_kill`（≡stop） | 00 同义 | 再加 task_stop 别名 | 命名与 Claude KillShell 不同，文档写清 |
| Job id | 逻辑 id（非裸 PID） | 避免 PID 复用歧义 | Gemini PID | 实现多一层映射 |
| 超时单位 | **毫秒**，与现 bash `timeout` 一致 | 避免 kimi 秒 / Claude ms 混用 | 秒 | description 必须写死 ms |
| `block` 默认 | **`false`** | 防模型误阻塞；需等时显式 block | Claude 默认 true | 多一次调用习惯 |
| `wait_ms`（task_output） | 默认 30_000 ms；上限 600_000（对齐 bash `MAX_TIMEOUT_MS`） | 只表达本次 block 等待，消除同名歧义 | 仍叫 timeout；无上限 | 新工具字段 |
| 输出 | **有上限尾部快照**（有上限内存缓冲）；v1 不落盘 | 无 cursor 也能看近期输出；不引入文件生命周期 | cursor 增量消费；无限内存 | 尾部可能丢更早内容——v1 接受，需 description 写清 |
| Shell 结果形状 | `output` 放尾部文本；工具专属 `metadata` 放状态/字段 | 复用现有 ToolExecutionResult 与 model metadata projection | JSON 塞进 output；全局 envelope | 需为新工具加 metadata 白名单 |
| 终态退出字段 | 终态必带 `exitCode: number|null` 和 `signal: string|null` | close 正常到达时保留完整信息；1s 兜底时明确为 null | 可选字段或只给文本 | 无 close 时无法恢复退出信息 |
| Permission | 启动时走前台 bash 全路径；output/kill 只校验 job 归属 | 00 | bg 降低权限 | — |
| timeoutOwner | bash 与可 block 的 `task_output` = `"tool"` | bash 自管 job 生命周期；task_output 自管最长 600s 的 `wait_ms`，均不被 scheduler 默认 120s 抢先中断 | 只改 scheduler 默认 | 新工具须自带等待上限 |
| task_output 并发 | `readOnlyHint:true`；调度复用控制类并发豁免，不占 `maxReadConcurrency` | 副作用分类与容量分类分离；最多 600s 的 block 不堵塞 read/glob/grep | 继续按 readonly 排队；新增专用并发池 | 复用既有控制类别，避免新增配置面 |
| List 工具 | **本批不做** `task_list` | 减工具；output 未知 id 报错即可 | Kimi 三件套含 List | 发现 job 靠返回值/历史 |
| 完成通知 | 本批不做 | 00 非必须 | Claude 自动通知 | 模型需主动 output |
| Subagent | generic/explore/research 若包含 bash，也必须包含 `task_output/task_kill` | 工具能力闭包；避免启动后台 job 后无法观测/终止 | 禁止 subagent bg | include 增加两个名称 |
| `timeout` 语义（fg/bg） | **统一**为 job 最大生命周期；bg 到点自动 kill | 防「无监督后台进程」；笔记明确后台仍需超时兜底 | 新增独立 `max_lifetime_ms` 只管 bg | 少一个参数但语义需在 description 写清 |
| 超时终态命名 | 自动 → `timed_out`；主动 kill → `cancelled` | 可观测；对齐 subagent；重试安全 | 统一算作 killed；或 killed/stopped 双名 | — |
| `task_kill` 幂等 | 已终态不 killTree、不改状态；只返原终态 | 重试安全；不覆盖 `timed_out` | 对已终态再 killTree；覆盖成 cancelled | — |
| bg 默认 `timeout` | 维持现状默认 **120_000 ms**、上限 **600_000 ms**（不因 bg 单独放宽） | 与 Claude 量级一致；防止「忘记传大 timeout」导致长驻服务被误杀成为显式而非隐式行为 | bg 默认更长（如 1h） | 模型跑 `npm run dev` 类长驻服务须显式传大 `timeout`，需在工具 description 提示 |

---

## 2.3 分阶段实施

### Phase 1 — 超时归属 + 前台行为锁定

- **目标**：bash 声明 `timeoutOwner: "tool"`；单测证明 `timeout: 300000` 不会在 ~120s 被 scheduler 误杀。
- **改动**：`tools/bash.ts`；必要时 scheduler 测例。
- **DoD**：T-P1* 通过；前台既有行为不变。

### Phase 2 — Registry + `run_in_background` + 生命周期超时

- **目标**：bg 启动立即返回 `job_id`；进程在跑；`timeout` 到点（fg 或 bg）由 registry 统一驱动 `killTree` 并落地 `timed_out` 终态；session dispose 可杀残留 job。
- **改动**：
  - 新 registry 模块（建议 `packages/ohbaby-agent/src/tools/shell-job-registry.ts` 或 `shell/jobs/`），内部维护 job 状态机（`running → completed|failed|cancelled|timed_out`）、到期定时器与不可见的 terminationRequested 原因归属；终态仅在 child close 后写入
  - `bash.ts` 分支；fg 路径的现有 timeout-kill 逻辑收编进 registry（统一实现，避免两套定时器代码）；`createBuiltinTools` / composition 注入 registry
  - 输出：内存尾部缓冲；`truncated: true` 表示当前 output 因上限省略了更早输出；v1 不写文件、不返回 `outputPath`
  - 全局 runtime dispose 兜底；`SessionEvent.Removed` 先取消/等待 parent run 与 active subagent，再从持久 store 枚举并清理 parent session 及全部 child scopes；subagent `onClosed` 先等待当前 run，再执行 `disposeScope(sessionId, contextScopeId)`。bash 在异步 preflight 后、spawn 前复查取消。各清理路径均对所属 `running` job 杀树并标 `cancelled`，随后移除所属记录
- **DoD**：bg 启动不 await 进程结束；`timeout` 到点自动 kill 且终态为 `timed_out`；无 cursor API；无磁盘输出协议；前台路径回归绿；permission 仍在 execute 前触发。

### Phase 3 — `task_output` + `task_kill`

- **目标**：可非阻塞取尾部快照；可 block+`wait_ms` 等终态；可主动 kill（终态 `cancelled`）；已终态幂等。
- **改动**：新工具文件；注册为 builtin；`task_output` 声明 `timeoutOwner: "tool"` 并由自身落实 `wait_ms`，调度时不占文件读取并发槽；归属校验（session 与 context scope 均须匹配）；在 `tool-metadata-projection.ts` 为 `task_output/task_kill` 增加白名单，令模型看见局部 metadata。
- **DoD**：04 场景 T-O* / T-K* 通过；running kill → `cancelled`；对 `timed_out`/`completed`/… 再 kill **不**改状态、**不**再 killTree。

### Phase 4 — 文档同步

- 更新 `docs/tools/{architecture,dfd-interface,data-model,test}.md` 参数真相（`test.md` 仍有旧 `{command, description}` 调用）
- 修订 `docs/shell/goals-duty.md` N6：允许「tools 层进程内 job；shell 提供执行原语」
- 交叉引用本 improve-3

---

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `src/tools/bash.ts` | — | bg 参数、timeoutOwner | — | 核心 |
| `src/tools/shell-job-*.ts` | `ShellJobRegistry` + task_output + task_kill | — | — | 可按职责拆分文件 |
| `src/core/context/tool-metadata-projection.ts` | — | task_output/task_kill metadata 白名单 | — | 复用既有逐工具投影，不创建全局 envelope |
| `src/tools/builtin.ts` / composition | 注册 | — | — | 注入 |
| `src/shell/process.ts` | — | 复用 killTree | — | 尽量不改 |
| session/subagent/runtime dispose | — | session、context scope 与全局钩子 | — | 防泄漏且隔离兄弟 subagent |
| `docs/tools/*`、`docs/shell/goals-duty.md` | — | 同步 | — | Phase 4 |

---

## 2.5 API / 协议 / 迁移与兼容

**bash schema 增量（建议）**：

```ts
{
  command: string;
  timeout?: number;              // ms；job 最大生命周期（fg 等待上限 = bg 存活上限）；到点自动 kill，终态 timed_out
  run_in_background?: boolean;   // default false
  // description? 可选后续；本批可不加
}
```

当 `run_in_background:true` 时，立即返回的 `output` 也是该时刻的有上限尾部快照；`metadata` 复用下述 ShellJob 字段。

**task_output**（`timeoutOwner: "tool"`，由工具自身落实 `wait_ms`）：

```ts
{
  job_id: string;
  block?: boolean;   // default false
  wait_ms?: number;  // ms；block 时本次等待上限（≠ job 生命周期）；tool abort 会提前结束本次等待
}
// ToolExecutionResult:
// task_output 与 task_kill 均返回：
// output = 调用完成时有上限的输出尾部快照
// metadata = { jobId, status, truncated }
// 终态时 metadata 必带 exitCode: number|null 与 signal: string|null；running 时省略二者。
// 这只是 shell 工具的局部 metadata 契约，不代表本批建立跨工具统一响应信封。
// 无 cursor / offset / bytes_consumed
```

**task_kill**：

```ts
{ job_id: string }
// running → 原子认领 cancelled 原因 → killTree → child close 或 1s 兜底 → cancelled
// completed|failed|cancelled|timed_out → 不 killTree，返回既有终态
// 返回同一份 ShellJob metadata；终态同样必带 exitCode 与 signal
```

- 旧调用（无 bg 字段）= 前台，兼容。
- 进程重启：内存 job **丢失**；不复活 OS 子进程（若有孤儿，依赖 OS；文档写明）。
- 不引入跨版本持久化协议。
- **不**引入 cursor 增量协议（v1）；若未来需要真增量，另开 improve。

---

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 后台进程泄漏 | dispose 杀树；kill API；**统一生命周期 timeout 兜底**（本节新增） | 关闭 bg 参数（feature 开关） |
| 模型不 block 一直空转 poll | description 写清；可选后续通知 | — |
| output/job 表撑爆内存 | 32KB 级有界缓冲 + 最多 100 个 job；不落盘 | 降低保留上限 |
| kill 与前台 timeout 竞态 | 统一经 registry abort | — |
| 权限绕过 | output/kill 不重新跑命令；禁止改 command | 代码审查 |
| 模型忘记为长驻服务传大 `timeout`，bg 被默认 120s 误杀 | description 显式提示「bg 默认沿用同一上限，长驻服务需显式传大 timeout」 | 若体验差，后续可评审是否给 bg 单独更宽松默认值（本批不做） |
| `timed_out` 与 `cancelled` 终态混用导致排障困难 | 先原子认领终止原因，child close 后写状态；已终态不可覆盖 | 单测锁定两条路径 |
| `task_kill` 重试覆盖 `timed_out` | 已终态直接返回，不 killTree | T-K4 |
| 误把尾部快照当成「只返回未读增量」 | description 写清「当前尾部快照」；无 cursor | 产品误解 → 后续再议真增量 |
| 同名 timeout 被误解为改写 job 生命周期 | task_output 仅接受 `wait_ms`；工具 description 明确“只等本次读取” | T-O3/T-D2 |
| metadata 未投影给模型 | 为 task_output/task_kill 显式添加逐工具白名单 | metadata projection 单测/集成 |
| session 删除后后台 job 失去调用入口 | 先停稳生产者，再按主 session 或 subagent context scope 清理 registry | T-B3a/T-B3b/T-B3c |
| block task_output 占满只读并发槽 | 控制类调度语义直接豁免 read 槽；`readOnlyHint` 保持不变 | T-O11 |

---

## 2.7 与 00 对齐

| 00 | 02 |
|----|-----|
| run_in_background + task_output + task_kill | Phase 2–3 |
| kill≡stop | 仅 task_kill |
| 进程内表 | Registry |
| 沿用前台 permission | Phase 2 DoD |
| 先 MCP 后本批 | README/本文开头 |
| 不收编 subagent 工具面 | §2.8 |
| `timeout` 统一为 job 生命周期，bg 到点自动 kill | Phase 2 + §2.5 schema |
| 新增 `timed_out` 终态；主动 kill → `cancelled` | Phase 2/3 DoD + §2.5 |
| `task_kill` 已终态幂等；不覆盖 `timed_out` | Phase 3 + §2.5 |
| `task_output` 使用 `wait_ms`；尾部快照在 output、状态在 metadata；无 cursor | Phase 3 + §2.2/§2.5 |
| v1 只保留内存尾部，不落盘、不返回 `outputPath` | Phase 2/3 |
| 终态带 exitCode/signal；先认领原因再 close 落终态 | Phase 2/3 + §2.5 |
| 默认值维持 120s/600s，不因 bg 放宽 | §2.2 决策表 |
| 幽灵 memory_*、统一响应信封不并入 | §2.8 |

---

## 2.8 不在本批

- `task_list`、完成通知注入、持久 PTY、独立 daemon
- 统一 Task 门面收编 `subagent_*`
- MCP BM25
- 修改 subagent 超时默认 2h 语义
- Windows/Unix killTree 大行为变更（只复用）
- 虚假 `memory_*` LLM 工具契约清理（与 bash 无关，见 `docs/core/memory/improve-1/` 第 3 批）
- 统一工具响应信封 status/text/error（笔记 P3，改动面大，非因果相关）
- bg 单独放宽默认 `timeout` 上限（本批维持与 fg 一致的 120s/600s）
