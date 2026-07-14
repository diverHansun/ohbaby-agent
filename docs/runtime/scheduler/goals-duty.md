# scheduler 模块 goals-duty.md

> **2026-07-13 修订（优先）**：产品级 `/loop` 语义以 [`docs/loop/`](../../loop/README.md) 为权威。本模块**只做闹钟**：计算何时到期、持久化可恢复的 job 行、在到期时发出信号。  
> **不做**：主会话投递、busy/coalesce/pause 门控、TUI claim 判定、信封写入、Agent 工具、REST 产品 API。这些属于 Loop 投递门控与管理面。  
> 下文若仍出现「Scheduler 直接创建 Run / 经全局 Heartbeat」等旧表述，一律以本修订与 `docs/loop` 为准。

本文档定义 `runtime/scheduler` 作为**基础设施闹钟**的目标与职责。

---

## 一、Design Goals（设计目标）

### 1. 空闲时近似零成本的到期触发

用按 `nextFireTime` 排序的最小堆 + `setTimeout` 等到下一触发点；无待触发 job 时不空转。

### 2. 只产生「到点了」信号，不决定能不能跑

到期输出给 Loop 投递门控（或等价消费者）。Scheduler 不查询 session 忙闲、不调用 RunManager、不写主会话消息。

### 3. 持久化用户可感知的周期任务行，供 serve 重启恢复

与 `scheduler_job`（或等价表）同批落地；绑定 `scopeKey + sessionId`（MVP 与 Loop 一致）。进程重启后恢复堆，不丢失 active 日程。

### 4. 进程内单例，挂在全局 serve

一台机器上由 `ohbaby serve` 唯一拥有 Scheduler，避免多进程重复 fire。

---

## 二、Duties（职责）

### 1. 维护 nextFireTime 最小堆

增删改 job；按时间弹出到期项；O(log n) 更新。

### 2. 事件驱动 tick

按堆顶设置 `setTimeout`；到期弹出所有 `nextFireTime <= now` 的项并通知消费者；周期任务在消费者确认「需要续期日程」后写回新的 `nextFireTime`（或由管理面/门控调用 `reschedule`）。

### 3. 持久化 job 行（与 Loop 共享存储）

读写 job 的调度相关字段：`jobId`、`scopeKey`、`sessionId`、`nextFireTime`、节奏字段、`createdAt`、`status` 等。  
**产品字段语义**（pause、pending、coalescedCount、信封）以 `docs/loop/data-model.md` 为准；Scheduler 至少保证调度所需列正确。

### 4. serve 启动恢复

从 DB 加载 active（及门控需要的 pending）相关行，重建堆；不负责冲刷主会话队列（那是 Loop / PromptScheduler）。

### 5. 提供注册 / 取消 / 重算时间的窄接口

供 Loop 管理服务调用：`add` / `remove` / `reschedule` / `listDueMetadata` 等。

---

## 三、Non-Duties（非职责）

### 1. 不负责投递与 busy 门控

不实现 coalesce、TUI claim、paused 丢弃、FIFO 多 job 入队策略——见 `docs/loop`。

### 2. 不负责创建 Run / 注入主会话

### 3. 不负责 `/loop`、Loop* 工具、REST 资源

### 4. 不负责 channel 入站唤醒

### 5. 不负责 cost / 权限画像

### 6. 不实现四态 Heartbeat 状态机

旧 heartbeat 文档不作为本模块依赖。

### 7. FollowUp / Reminder 产品面

可为未来 job kind 预留列，但 MVP 实现与验收以 Loop 周期任务为准；不在本模块单独做产品入口。

---

## 四、与其他模块的关系

| 模块 | 关系 |
|------|------|
| `docs/loop` / Loop 投递门控 | 消费者：接收到期信号并决定是否入队 |
| `ohbaby serve` | 宿主：启动/停止 Scheduler |
| `services/database` | `scheduler_job` 与 Loop 同批 migration |
| `WorkspacePromptScheduler` | **不直接依赖**；经 Loop 门控间接 |

---

## 五、文档自检

- 一句话：Scheduler 是 serve 里的唯一闹钟，只回答「哪个 job 何时到期」。  
- 不做投递与产品入口。  
- 与 `docs/loop` 无职责重叠（闹钟 vs 产品/门控）。
