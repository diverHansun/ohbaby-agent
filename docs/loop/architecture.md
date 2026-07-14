# Loop 模块 architecture.md

> 前置：`goals-duty.md` 已定。本文只解释结构如何落实那些目标，不新增产品职责。

---

## 一、Architecture Overview（总体架构）

Loop 在实现上拆成三层协作（可同包不同目录，逻辑边界如下）：

```text
┌─────────────────────────────────────────────────────────────┐
│  管理面（Web/App / REST / Loop* 工具 / /loop slash）          │
│  创建·列表·暂停·恢复·删除；创建时检查 serve；写任务定义           │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  runtime/scheduler（闹钟）                                    │
│  MinHeap + setTimeout；计算 nextFireTime；持久化 job 行       │
│  输出：JobDue / JobFired（含 jobId、scopeKey、sessionId）     │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  Loop 投递门控（Delivery Gate）                               │
│  空闲判定 · pending/coalesce · pause 丢弃 · FIFO · stale 删除 │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  WorkspacePromptScheduler + RunManager + Lifecycle            │
│  主会话入队 → 空闲后执行 → 消息进入主会话上下文                 │
└─────────────────────────────────────────────────────────────┘
```

### 主要组件

| 组件 | 职责 |
|------|------|
| **Loop 管理服务** | 任务 CRUD、pause/resume、上限校验、创建后首次入队安排、过期策略入口 |
| **Scheduler（闹钟）** | 仅时间：堆、tick、持久化 `nextFireTime`、serve 恢复入堆 |
| **投递门控** | 把「到期」变成「0 或 1 次主会话入队」；持有 per-job pending 与合并次数 |
| **主通道** | 现有 prompt 队列与 run；不感知 cron 表达式细节，只消费带 `triggerSource` 的 prompt |

### 依赖方向

```text
管理面 → Loop 管理服务 → Scheduler（注册/取消/读状态）
Scheduler → 投递门控（到期通知）
投递门控 → PromptScheduler / claim 查询
投递门控 ↛ SubagentHost
```

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. 交付模型：主会话注入（学 kimi / Claude）

**选择**：到期后入主会话队列，而不是独立 Agent。

**理由**：

- 满足「主 Agent 看见结果」且避免双上下文（goals-duty §1）
- 参考项目已验证：忙时延后 + 合并/去重即可
- ohbaby 已有 `WorkspacePromptScheduler`，复用优于再造执行体

**代价**：与用户轮次串行，不能与用户 turn 真正并行——接受。

### 2. 调度与投递分离

**选择**：Scheduler 不知 session 是否可跑；投递门控不知堆算法。

**理由**：对应 goals「到点与能不能跑分离」；Scheduler 可单测；门控可单测。

**不采用**：kimi 式「进程内 CronManager 直接 `steer`」绑死在单 Agent 进程——与全局 serve 多 workspace 拓扑不匹配。

### 3. 投递门控用规则表，不用四态 Heartbeat 状态机

**选择**：MVP 用显式规则（idle / pending / paused / same-job-inflight），不引入 active/paused/sleeping/blocked 通用机。

**理由**：KISS；参考项目亦无独立 Heartbeat；旧 `docs/runtime/heartbeat` 四态对当前交付模型过重。

**可演进**：若未来 Reminder at-least-once、channel 唤醒共用门控，再考虑加厚状态机。

### 4. Pending 合并而非补发风暴

**选择**：忙时每 job 最多一个 pending + `coalescedCount`；暂停期到期丢弃。

**理由**：对齐 kimi coalesce；暂停=用户不要自动跑（P2），避免恢复瞬间突袭。

### 5. 单任务控制面，无 session 总开关

**选择**：pause/resume/delete 仅针对单个 job。

**理由**：YAGNI；总开关可事后用「列表批量」在 UI 做，不必进核心模型。

---

## 三、Module Structure & File Layout（建议落点）

> 路径为建议，实施时可按包边界微调；逻辑分层不变。

```text
packages/ohbaby-server/
  src/runtime/scheduler/          # 闹钟：heap、store、tick
  src/runtime/loop/               # 投递门控 + 管理服务门面
  src/routes/loops/               # REST

packages/ohbaby-agent/
  src/tools/loop/                 # LoopCreate/List/Delete（主 Agent only）
  # 不在 in-process TUI 工具集注册

packages/ohbaby-cli/ 或 web 包
  /loop slash                     # 仅 daemon 客户端
```

持久化：`scheduler_job`（或等价表）由 database migration 与 SchedulerStore **同批**恢复；字段见 `data-model.md`。

---

## 四、Architectural Constraints & Trade-offs（约束与取舍）

| 约束 / 取舍 | 说明 |
|-------------|------|
| 必须有 serve | 无 serve 不能创建；已有任务在 DB，serve 起来再跑 |
| TUI = 可能的 busy 源 | 不抢占 claim；侧栏可显示「因本地 TUI 占用等待」 |
| 仅会话型 | job 必有 `sessionId`；删 session 级联删 job |
| 权限跟会话 | 不强制 full-access；自动任务可能弹审批——接受 |
| 7 天 stale | 最后一次 `stale=true` 后删除；续期=重新创建或显式续期 API（若做） |
| 旧 heartbeat 文档 | 不作为本架构依据；冲突以 `docs/loop` 为准 |

### 明确放弃的备选

| 备选 | 为何放弃 |
|------|----------|
| 每次新建子会话执行 | 与主会话可见目标冲突，且 SubagentHost 现共享子会话，不能直接复用 |
| 长期独立 loop Agent | 多余实例生命周期；压缩与主会话重复 |
| 1s 轮询调度 | serve 长驻时浪费 wake；已选 MinHeap+setTimeout |
| in-process TUI 也跑 scheduler | 违反单 owner，且 TUI 退出即停 |

---

## 五、文档自检

- 每个结构点可追溯到 goals-duty。
- 未引入独立执行体或四态 Heartbeat。
- Scheduler 与投递门控边界可读、可测。
