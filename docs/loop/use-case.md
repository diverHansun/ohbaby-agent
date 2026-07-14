# Loop 模块 use-case.md

---

## 一、Use Case Overview

| # | 用例 | 触发 | 职责落点 |
|---|------|------|----------|
| UC1 | 创建 Loop | `/loop` / LoopCreate / REST | 管理服务 + Scheduler + 首次入队 |
| UC2 | 到期投递 | Scheduler tick | 投递门控 + PromptScheduler |
| UC3 | 空闲冲刷 pending | session 变闲 / claim 释放 | 投递门控 |
| UC4 | 暂停 / 恢复 | 用户或 API | 管理服务 |
| UC5 | 过期最后一次 | 门控发现超窗 | 门控 + Scheduler 删除 |
| UC6 | 删除任务或会话 | 用户 / session.remove | 管理服务 + 级联 |

---

## 二、主流程

### UC1：创建 Loop

```text
1. 客户端确认走 daemon（TUI in-process 无入口）
2. 校验 serve、session、上限、间隔
3. 写入 job（active, createdAt=now）
4. Scheduler 计算并登记后续 nextFireTime
5. 立即请求第一次投递（走门控：可投则入队，忙则 pending）
6. 返回 jobId；UI/模型确认节奏与 7 天窗口
```

**边界**：步骤 5 不等待 LLM 结束；只保证「已安排」。

### UC2：到期投递

```text
1. Scheduler 弹出到期 job
2. 若 status=paused → discard，仍推进或不推进？
   → 约定：暂停期间 Scheduler 可不再为该 job 紧密 tick，
     或 tick 到了也 discard 且不增加 pending；
     nextFireTime 仍按日历推进到未来下一次，避免恢复后瞬间到期风暴
3. 若同 job 已在主通道队列/运行 → skip（不 coalesce）
4. 若不可投递 → pending=true，coalescedCount++（上限语义：保持单 pending）
5. 若可投递 → 写信封入队 → 清 pending → 重算 nextFireTime
6. 若已达 stale 窗口且本轮为最后投递 → 入队后删除 job
```

**暂停与 nextFireTime**：采用「日历继续走、到期丢弃」，恢复后等下一次自然点（与 P2 一致）。实现上避免把所有暂停期错过的点在 resume 时一次性补算。

### UC3：空闲冲刷

```text
1. 检测到 session 可投递
2. 取出该 session 所有 pending job，按到期/pending 时间 FIFO
3. 逐个入队（每个入队后若 session 又变忙则停下，剩余保持 pending）
```

### UC4：暂停 / 恢复

```text
pause:
  status=paused
  若有 pending → 丢弃 pending，coalescedCount 清零
resume:
  status=active
  不投递；等待 Scheduler 下一次 nextFireTime
```

### UC5：过期最后一次

```text
1. 到期处理时发现 now - createdAt ≥ 7d（或显式 stale 标记）
2. 若可投递：入队信封 stale=true，然后删除
3. 若不可投递：仍应在「最后机会」策略上二选一——
   约定（对齐 kimi）：尽量在可投递时做最后一次；
   若长期一直忙，允许在超窗后一旦可投递补一次 stale 最终投递再删，
   或在超窗且持续忙超过宽限后直接删并不投（实现选前者优先，宽限可配置，默认 24h）
```

> 假设：默认优先「最终投递一次再删」；长期不可投递则超时直接删并记日志。写入 non-functional 可观测性。

### UC6：删除

```text
delete job → 移出堆、删行、丢弃 pending
delete session → 该 session 全部 job 同上
```

---

## 三、责任边界表

| 步骤 | 归属 |
|------|------|
| 解析 `/loop 5m …` | slash / skill 层 → 调管理服务 |
| nextFireTime 计算 | Scheduler |
| idle / TUI claim 判定 | 投递门控（读 ledger/queue） |
| accept prompt | PromptScheduler |
| 权限询问弹窗 | 现有 permission 管线（跟会话） |
| 侧栏渲染 | UI；只读 List/事件 |

---

## 四、失败点

| 点 | 行为 |
|----|------|
| accept 抛错 | 记日志；可保留 pending 下 tick 重试；不标任务 completed |
| run 中途失败 | job 保持 active；下次到期再来 |
| serve 崩溃 | job 行 + pending 落库；重启恢复堆与 pending 冲刷 |

---

## 五、文档自检

- [x] 暂停丢弃与忙时合并分用例写清  
- [x] 创建首次入队与周期到期共用门控  
- [x] 无独立子会话步骤  
