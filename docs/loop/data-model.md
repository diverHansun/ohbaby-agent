# Loop 模块 data-model.md

> 统一认知语言；字段名可在实现时微调，语义不可悄悄改变。

---

## 一、Core Concepts（核心概念）

### Loop 任务（Loop Job）

用户或 Agent 登记的**长期任务定义**：在指定节奏下，向某个主会话投递固定 prompt。  
不是一次 run，也不是一个 Agent 实例。

### 到期信号（Job Due）

Scheduler 发出的「该 job 的 nextFireTime 已到」。只表示时间，不表示已执行。

### 投递（Delivery）

把门控通过的到期，变成主会话执行通道上的一次入队（带信封的 prompt）。  
「入队成功」≠「LLM 跑完」；跑失败不删除周期任务。

### 合并次数（coalescedCount）

因 session 忙（含 TUI claim）而多次到期、最终只投递一次时，信封中携带的合并计数（≥1）。  
暂停期间的到期**不**计入 pending，也不增加待投递合并。

### 过期（stale / expired）

自任务创建时间起超过默认窗口（7 天）后：再投递一次且信封 `stale=true`，然后删除任务定义。

### 暂停（paused）

用户显式暂停单个任务：日程仍可被 Scheduler 算到，但投递门控对到期**丢弃**；恢复后等下一次自然到期。

---

## 二、Entity / Value Object

| 概念 | 分类 | 说明 |
|------|------|------|
| Loop Job | Entity | 有稳定 `jobId`，持久化 |
| Pending Delivery | Entity（可内嵌 job 行） | 每 job 最多一条；进程内+可持久化以便 serve 恢复 |
| Due Signal | Value | 一次性 |
| Fire Envelope | Value | 写入 prompt 文本的结构化前缀/XML |
| Delivery Disposition | Value | 门控结果：delivered / coalesced / skipped_inflight / discarded_paused / stale_final |

---

## 三、Key Data Fields（关键字段语义）

### Loop Job（持久化）

| 字段（逻辑名） | 中文语义 |
|----------------|----------|
| `jobId` | 任务唯一 ID |
| `scopeKey` | 工作区/项目范围键 |
| `sessionId` | 所属主会话；MVP 必填 |
| `prompt` | 每次投递的用户可见任务内容 |
| `intervalOriginal` | 用户原始间隔表达（如 `5m`、`every 20m`） |
| `intervalNormalizedMs` 或 cron 表达式 | 规范化后的调度依据（二选一或并存；UI 展示优先用 original） |
| `status` | `active` / `paused` / （删除则行移除或 `deleted`） |
| `createdAt` | 创建时间；7 天窗口基准（续期则重置，若提供续期） |
| `nextFireTime` | 下次到期（Scheduler 维护） |
| `lastFiredAt` | 上次**成功入队**时间（可选；用于观测，失败不更新或单独记） |
| `pending` | 是否有待空闲投递 |
| `coalescedCount` | 当前 pending 上累计的合并次数 |
| `pendingReason` | 如 `session_busy` / `tui_claim`（供侧栏） |

### 信封（写入主会话的文本结构，逻辑字段）

| 字段 | 中文语义 |
|------|----------|
| `jobId` | 哪个任务 |
| `coalescedCount` | 合并了几次理想到期 |
| `stale` | 是否为过期前最后一次 |
| `prompt` | 原文任务内容 |
| 节奏信息 | 原始间隔或 cron，便于模型理解 |

建议形态对齐 kimi 的 `<cron-fire>…`，产品上可用 `<loop-fire>…`。

### 不建模为独立实体（MVP）

- Loop Agent 实例 ID  
- 每次执行的独立子 session  
- session 级 auto-delivery kill switch  

---

## 四、Lifecycle & Ownership（生命周期）

```text
创建 → status=active，立刻安排第一次入队（queued），Scheduler 登记后续 nextFireTime
     ↓
到期 → 门控：
  paused → 丢弃
  同任务已在队列/运行 → 跳过本次
  session 忙 / TUI claim → pending=1，coalescedCount++
  可投递 → 入队主通道；清除 pending；推进 nextFireTime（周期）
     ↓
createdAt+7d 窗口末 → 最后一次投递 stale=true → 删除 job
     ↓
用户 delete / 删除主 session → 移除 job 与堆项
用户 pause → 丢弃期间到期；resume → 仅等待下次自然到期
```

**所有权**：

- Job 行：SchedulerStore / database（serve 进程写入）
- Pending：建议落在同一 job 行，便于重启恢复
- 主会话消息：session/message 存储；Loop 不另建 transcript

**级联**：删除主 session → 删除其全部 Loop job。

---

## 五、不变量

1. 同一 `jobId` 在主通道上至多一个「来自该 job 的」未完成执行（队列中或 running）。
2. `pending` 为真时 `coalescedCount ≥ 1`。
3. MVP：`sessionId` 非空。
4. 每 `sessionId` 活跃 job 数 ≤ 20。
5. in-process TUI 不持有 Scheduler 写路径。

---

## 六、文档自检

- [x] 「任务定义」与「一次投递/一次 run」已区分  
- [x] 暂停丢弃 vs 忙时合并语义不同且写清  
- [x] 无独立执行体会话模型  
