# Loop 模块 non-functional.md

---

## 一、Quality Priorities（质量优先级）

冲突时按此排序：

1. **不重复触发 / 不抢占**：同 job 不并行两轮；不打断 TUI claim 中的 session  
2. **不丢任务定义**：serve 重启后 active job 可恢复；pending 可恢复  
3. **成本有界**：默认 7 天过期；每 session ≤ 20 job  
4. **可观测**：侧栏/API 能解释「为何没跑」（busy / tui_claim / paused）  
5. **实现简单**：优于完美补投与复杂优先级队列  

---

## 二、Operational Constraints（运行约束）

### 调度

- 闹钟：MinHeap + 单一定时器；无 job 时不空转  
- 投递门控处理应短；不在门控内等 LLM  

### 容量

- 每 session 活跃 Loop ≤ 20  
- 每 job pending 槽位 = 1  
- prompt 大小建议设上限（可对齐 kimi 量级，实现阶段定数，如 8KiB）  

### 时间

- 间隔最小粒度建议 1 分钟（与 Claude `/loop` 一致）；更短可拒绝或上取整并告知  
- 时区：本地时区解释用户间隔；字段中保留 original 字符串  

### 过期

- 默认窗口 7 天（自 `createdAt`）  
- 最后一次 `stale=true` 后删除  
- 长期不可投递：优先在恢复可投递时补最终 stale 投递；若超窗后持续不可投递超过宽限（默认 24h）则直接删除并打日志  

---

## 三、Reliability & Observability

### 不可接受

- 无 serve 却静默「创建成功」  
- 同一 job 并发跑两轮主会话 turn  
- TUI 占用时强行抢 claim 导致用户输入丢失  
- 重启后 active 周期任务全部丢失  

### 可接受

- 忙时推迟导致实际节奏漂移（用 coalescedCount 告知模型）  
- 暂停期间错过的到期不补  
- 已入队 prompt 在 delete job 后仍可能跑完（除非实现显式取消；MVP 可不做撤销）  
- run 失败后等到下周期  

### 日志 / 指标建议

- due / delivered / coalesced / skipped_inflight / discarded_paused / stale_deleted  
- 标签：`scopeKey`, `sessionId`, `jobId`  
- pendingReason 变更  

---

## 四、Security

- 权限**跟随当前会话**，不强制 full-access  
- 自动任务可能触发审批：属于产品可接受摩擦  
- Loop 工具不在子 Agent、不在 in-process TUI 注册，降低误创建面  
- REST 走现有 serve 鉴权/本地信任模型（与其它 v1 API 一致；App 加固另议）  

---

## 五、Cost

- 7 天默认过期是主成本阀  
- coalesce 避免补跑历史次数  
- 不引入「每 job 长期子会话」的额外 token 基线  

---

## 六、Trade-offs & Deferred

| 暂缓 | 原因 |
|------|------|
| jitter | 单机多任务惊群不严重；二期可学 kimi |
| 工作区型 Loop | 无 session 无法主会话注入 |
| 撤销已入队 prompt | 与队列实现耦合；MVP 可接受 |
| session 总开关 | YAGNI |
| 独立 Heartbeat 四态 | 过重 |
| 只读 Loop 权限档 | 可二期 |

---

## 七、文档自检

- [x] 优先级明确  
- [x] 与 goals 的有界、不抢占一致  
