# Loop 模块 dfd-interface.md

> 先数据流，后接口。接口是流的载体。

---

## 一、系统中的位置

```text
[Web/App /loop] [Loop* Tools] [REST /loops]
        │              │            │
        └──────────────┼────────────┘
                       ▼
              Loop 管理服务（serve 内）
                       │
          ┌────────────┼────────────┐
          ▼                         ▼
   Scheduler（闹钟）          SQLite job 行
          │
          ▼
   投递门控 ──查询──► claim / PromptScheduler 忙闲
          │
          ▼
   WorkspacePromptScheduler.accept(...)
          │
          ▼
   RunManager → Lifecycle → 主会话消息
          │
          ▼
   （可选）事件流 → 侧栏投影
```

---

## 二、主要数据流

### DF1：创建任务并安排首次执行

```text
输入：prompt + 间隔 + sessionId（隐式 scopeKey）
  → 校验 serve 存活、session 存在、未超上限、间隔合法
  → 持久化 job（active）
  → Scheduler 登记 nextFireTime（后续周期）
  → 立即构造「第一次」投递请求进入门控/队列路径
     （创建成功即入队意图；真正跑仍等空闲）
输出：jobId；任务对 List/REST 可见
```

### DF2：到期到入队

```text
Scheduler：now ≥ nextFireTime → Due(job)
  → 门控：
      paused？→ discard
      同 job 已在队列/运行？→ skip
      不可投递？→ set pending + coalescedCount++
      可投递？→ envelope + PromptScheduler.accept
               → 周期任务重算 nextFireTime 入堆
               → 若 stale 窗口末次 → 投递后删除 job
输出：主通道多一条 scheduler/loop 来源 prompt；或仅 pending 状态更新
```

### DF3：变空闲后冲刷 pending

```text
输入：session 从忙→闲（turn 结束、队列空、TUI claim 释放）
  → 扫描该 session 上 pending=true 的 job
  → 按 pending 产生顺序或 nextFireTime 序 FIFO 投递
  → 清除 pending / 重置 coalescedCount（写入信封后清零）
```

### DF4：暂停 / 恢复 / 删除

```text
pause  → status=paused；清 pending（若有则丢弃，不投递）
resume → status=active；不补投；等 Scheduler 下次到期
delete → 移出堆 + 删行；若队列中已有该 job 的 prompt，不保证撤销已入队项（见非功能）
```

### DF5：删除主会话

```text
Session.remove(sessionId)
  → 级联删除该 sessionId 下全部 Loop job + 堆项
```

---

## 三、接口形态（逻辑契约）

### 3.1 REST（资源式，建议）

| 方法 | 路径（示意） | 语义 |
|------|----------------|------|
| `GET` | `/v1/sessions/{sessionId}/loops` | 列表 |
| `POST` | `/v1/sessions/{sessionId}/loops` | 创建（需 serve） |
| `GET` | `/v1/sessions/{sessionId}/loops/{jobId}` | 详情 |
| `POST` | `/v1/sessions/{sessionId}/loops/{jobId}/pause` | 暂停 |
| `POST` | `/v1/sessions/{sessionId}/loops/{jobId}/resume` | 恢复 |
| `DELETE` | `/v1/sessions/{sessionId}/loops/{jobId}` | 删除 |

请求需带 workspace 路由（如 `x-ohbaby-directory` / scope），与现有 serve 一致。

### 3.2 Agent 工具

| 工具 | 语义 | Plan 模式 |
|------|------|-----------|
| `LoopCreate` | 创建 | Deny |
| `LoopList` | 列表 | Allow |
| `LoopDelete` | 删除 | Deny |
| pause/resume | 可用工具或仅 REST；若暴露工具则 Deny 写 |

- 仅**主 Agent**注册；子 Agent 不注册。  
- **in-process TUI 不注册**整组 Loop 工具。

### 3.3 `/loop` slash

- 仅 Web/App（daemon 客户端）注册。  
- 解析 interval + prompt（可学 Claude `/loop` skill），底层调同一创建 API。  
- 创建后安排第一次执行（入队），并确认文案告知节奏与 7 天窗口。

### 3.4 对内：Scheduler ↔ 门控

```text
Scheduler.emit Due { jobId, scopeKey, sessionId, fireAt, staleCandidate? }
Gate.handleDue(...) → Disposition
Gate 可调用 Scheduler.reschedule(jobId, nextFireTime) / Scheduler.remove(jobId)
```

### 3.5 对内：门控 → PromptScheduler

```text
accept({
  sessionId,
  prompt: envelopeText,
  triggerSource: 'scheduler' | 'loop',
  // origin 元数据供 UI/遥测
})
```

权限：不覆盖 session 当前 permission profile；由 RunDefaultsPolicy 按 triggerSource 映射到与「跟会话一致」兼容的默认（实现时对齐现有 policy 表，避免另造 full-access）。

---

## 四、同步 vs 异步

| 交互 | 模式 |
|------|------|
| Create/List/Pause/Resume/Delete API | 同步返回；创建不等待第一次 run 完成 |
| Due → 入队 | serve 进程内异步；不阻塞 tick 过久 |
| 真正 LLM 执行 | 完全异步于门控 |

---

## 五、失败与边界（接口层）

| 情况 | 对外行为 |
|------|----------|
| 无 serve | Create 失败，明确错误 |
| session 不存在 | Create 失败 |
| 超过 20 个 | Create 失败 |
| 入队成功、run 失败 | job 仍 active；下次到期再试 |
| TUI 占用 | Create 仍可成功；首次入队可能 pending；List 可见 pendingReason |

---

## 六、文档自检

- [x] 数据流覆盖创建、到期、空闲冲刷、暂停、级联删除  
- [x] 接口从属于流  
- [x] TUI 不注册工具写进契约  
