# Runtime 模块实现差距分析

> 历史快照：本文保留早期差距分析口径，其中 `runtime/permission-profiles` 已被后续架构讨论否决。当前决定以 `03-implementation-plan.md` 和 `packages/ohbaby-agent/src/permission/improve-1/01-permission-policy-boundary.md` 为准：runtime 不拥有 permission profile 语义，只保留 opaque `permissionProfileId` metadata。

> 对比 `docs/runtime/` 初始设计规划（v0 设计文档，62 份）与 `packages/ohbaby-agent/src/runtime/` 当前实现。

---

## 1. 总览：规划 vs 实现

```
docs/runtime/ 规划的模块:
├── daemon/              ✅ 已实现（supervisor + bootstrap + pid + state）
├── heartbeat/           ❌ 未实现（仅 NOOP 占位）
├── hooks/               ⚠️ 部分实现（仅 pre-run / post-run 两个硬编码点）
├── improve-1/           📝 本目录（本次分析产出）
├── interaction-broker/  ✅ 已实现
├── permission-profiles/ ⚠️ 部分实现（profile 仅作为字符串传递，无 registry）
├── run-ledger/          ✅ 已实现（database + in-memory）
├── run-manager/         ✅ 已实现（manager + worker + policy）
├── scheduler/           ❌ 未实现（仅 NOOP 占位）
├── stream-bridge/       ✅ 已实现
└── tasks/               ❌ 未实现（仅 NOOP 占位）
```

**统计：**
- 已完整实现：6 个模块（daemon, interaction-broker, run-ledger, run-manager, stream-bridge, 另有 snapshot 在 runtime 外独立实现）
- 部分实现：2 个模块（hooks, permission-profiles）
- 完全未实现：4 个模块（heartbeat, scheduler, tasks, improve-1）
- 计划外已实现：context compaction, tool concurrency control（位于 `core/` 而非 `runtime/`）

---

## 2. 逐模块差距详解

### 2.1 heartbeat/ — 完全未实现

**规划文档（7 份，~900 行）：**
- `architecture.md` — HeartbeatMachine 状态机 + DeferredQueue 优先级队列
- `data-model.md` — AgentState (active/paused/blocked/sleeping)、WakeSignal、Disposition
- `dfd-interface.md` — JobFired 信号处理的 4 种状态分支
- `use-case.md` — 3 个核心用例

**当前实现状态：**
```typescript
// runtime/daemon/bootstrap.ts:97
heartbeat: DaemonLifecycleComponent = NOOP_LIFECYCLE_COMPONENT, // {}
```

`BootstrappedRuntime` 上有 `heartbeat` 字段，`start()` 和 `stop()` 会调用，但实现是空对象。`"heartbeat"` 作为 `TriggerSource` 在 `DEFAULT_POLICY` 中已配置（notify-only / reject / continue），但没有代码能触发 heartbeat 类型的 run。

**缺失的核心能力：**
1. HeartbeatMachine 状态机 — 管理 agent 的活动/暂停/阻塞/休眠状态
2. DeferredQueue — 在暂停期间暂存信号，恢复后按优先级 drain
3. Disposition 协议 — heartbeat 决定"是否创建 run"的决策协议（与 scheduler 协作）
4. Sleeping 自动唤醒 — 收到 follow-up 时从 sleeping→active

---

### 2.2 hooks/ — 仅有最小实现

**规划文档（4 份，~450 行）：**
- `architecture.md` — HookExecutor（责任链模式），3 个钩子点：pre-run, post-run, on-wake
- `goals-duty.md` — 组合式运行时钩子，不侵入 core/lifecycle，纯 async 函数

**当前实现状态：**
```typescript
// runtime/run-manager/types.ts
interface HookExecutor {
  execute(point: "pre-run" | "post-run", context: RunHookContext): Promise<void>;
}
```

只有 2 个钩子点，且是单一执行器模式（不是责任链/注册表）。`on-wake` 钩子点未实现。

**缺失的能力：**
| 规划的钩子点 | 当前状态 |
|---|---|
| pre-run | 有（单一执行器） |
| post-run | 有（单一执行器） |
| on-wake | 缺失 |
| 责任链（多钩子注册） | 缺失 — 只有一个 HookExecutor 实例 |
| 钩子失败隔离 | 有（try/catch 吞掉错误） |
| 钩子优先级/排序 | 未设计 |

**注意**：`core/lifecycle` 内部的 `LifecycleConfig` 提供了 `shouldStopAfterTurn`、`beforeToolCall`、`afterToolCall`，但这些是 lifecycle 层的回调，不属于 runtime hooks。

---

### 2.3 scheduler/ — 完全未实现

**规划文档（7 份，~950 行）：**
- `architecture.md` — Scheduler + MinHeap + SchedulerStore 三层结构
- `data-model.md` — ScheduledJob, Reminder, FollowUp 三种任务类型
- `dfd-interface.md` — 基于 `setTimeout + MinHeap` 的事件驱动（非轮询）
- `non-functional.md` — Reminder at-least-once 语义

**当前实现状态：**
```typescript
// runtime/daemon/bootstrap.ts:97
scheduler: DaemonLifecycleComponent = NOOP_LIFECYCLE_COMPONENT, // {}
```

三种 trigger source（`scheduler`/`heartbeat`/`follow-up`）在 `DEFAULT_POLICY` 中均已配置，但没有调度器能触发这些 source 的 run。

**缺失的核心能力：**
1. MinHeap 优先队列 — 按 `nextFireTime` 排序任务
2. 三种 Job 类型：ScheduledJob（定时）、Reminder（提醒，需 ack）、FollowUp（跟进）
3. SchedulerStore 持久化 — 重启后恢复调度任务
4. Reminder at-least-once 语义 — 只有 heartbeat 确认 disposition 后才标记完成
5. 与 heartbeat 的 Disposition 协议 — scheduler 发信号，heartbeat 决定是否创建 run

---

### 2.4 tasks/ — 完全未实现

**规划文档（7 份，~1040 行）：**
- `architecture.md` — TaskManager + ShellTaskRunner/AsyncTaskRunner + OutputStore
- `data-model.md` — TaskFileAccess (none/workspace-ro/workspace-rw)、SandboxLease
- `goals-duty.md` — 独立后台工作单元、可查询/可停止、三级文件访问隔离

**当前实现状态：**
```typescript
// runtime/daemon/bootstrap.ts:97
taskManager: DaemonTaskManager = NOOP_TASK_MANAGER, // { stopAll: async () => {} }
```

**注意**：存在 `agents/tasks/manager.ts` 的 `AgentTaskManager`，但它管理的是 agent 子任务（open/close/send），而非 daemon 级的独立后台任务。

**缺失的核心能力：**
1. TaskManager 控制面 — create/stop/get/waitForCompletion/stopAll
2. ShellTaskRunner — 子进程执行 + stdout/stderr 捕获
3. AsyncTaskRunner — Promise 包装的异步任务
4. OutputStore — 按行读取、等待特定行
5. SandboxLease 生命周期 — workspace-rw 任务必须持有 sandbox 租约
6. 三级文件访问策略 — none / workspace-ro / workspace-rw

---

### 2.5 permission-profiles/ — 骨架存在，血肉缺失

**规划文档（5 份，~540 行）：**
- `architecture.md` — Registry + Adapter 结构，ProfileRegistry + applyProfile 纯函数
- `data-model.md` — 4 种内置 profile：interactive, read-only, notify-only, full-auto

**当前实现状态：**
```typescript
// runtime/daemon/bootstrap.ts - DEFAULT_PROFILE_REGISTRY
const defaultProfileRegistry: ProfileRegistry = {
  getProfile: async (id) => ({ id, canAskUser: true, canWrite: true, canRunCode: true, onDenied: "prompt" }),
  validateProfileId: async () => true,
};
```

Profile 只作为字符串 ID 传递，没有实际的权限约束逻辑。`applyProfile()` 函数（规划中定义）未实现。`PermissionProfile` 类型中的 `canAskUser/canWrite/canRunCode/onDenied` 字段在 `run-manager/types.ts` 中已定义，但没有代码消费这些字段来限制工具执行。

**缺失的核心能力：**
1. ProfileRegistry — 通过 ID 查找 profile 对象
2. applyProfile() — 将 profile 约束叠加到策略决策上
3. 4 种内置 profile 的具体行为定义
4. onDenied 策略（prompt/skip/abort）的实际执行

---

### 2.6 部分实现的特性

| 特性 | 规划状态 | 当前实现 |
|---|---|---|
| `"queue"` multitask strategy | 类型已定义 | 未实现，行为同 `"reject"` |
| `"pause"` disconnect mode | 类型已定义 | 未消费，无运行时效果 |
| LLM 调用重试 | 未在规划中明确提及 | 完全缺失（注释说 "consumers can retry"） |
| `"channel"` / `"follow-up"` trigger | 在 DEFAULT_POLICY 中配置 | 零触发代码 |
| Pre-run / post-run hooks | 2 个硬编码点 | 缺少责任链、优先级、on-wake |
| Context compaction | 无规划文档 | 已在 `core/context/` 完整实现 |
| Tool concurrency | 无规划文档 | 已在 `core/tool-scheduler/` 完整实现 |

---

## 3. 现有实现的内部债务

此部分已在之前的代码审查中分析，简要复述：

| 问题 | 影响 | 估算节省 |
|---|---|---|
| 6 个工具函数复制 6 次（`errorToMessage` 等） | 维护负担，不一致风险 | ~120 行 |
| daemon/types.ts 中 9/19 个接口仅单一实现 | 认知负担，间接调用开销 | 消除 7 个接口 |
| run-ledger 两个实现的状态转换逻辑重复 | 修改需同步两处 | ~80 行 |
| JSON 安全处理在 stream-bridge 和 worker 中重复 | 不一致风险 | ~30 行 |

---

## 4. 依赖关系分析

未实现的模块之间存在协议依赖，不能孤立实现：

```
scheduler ──(JobFired 信号)──▶  heartbeat ──(Disposition 决策)──▶  runManager.create()
                                      │
                                      ├──(WakeRequested)──  channel/webhook/etc.
                                      │
                                      └──(SignalDisposition)──▶  scheduler (ack Reminder)

tasks ──(SandboxLease)──▶  runManager
hooks ──(pre-run/post-run/on-wake)──▶  runManager.create()
permission-profiles ──(applyProfile)──▶  runManager (RunContext)
```

**关键洞察**：heartbeat 和 scheduler 是强耦合的一对——scheduler 负责"何时触发"，heartbeat 负责"能否触发"。两者通过 Disposition 协议通信。必须一起设计接口，但可以分阶段实现。

---

## 5. 影响评估

### 缺失模块对用户场景的影响

| 场景 | 依赖的缺失模块 | 当前状态 |
|---|---|---|
| 定时任务（"每天早上 8 点整理新闻"） | scheduler + heartbeat + permission-profiles | 不可用 |
| 睡眠唤醒（"有新消息时通知我"） | heartbeat + scheduler(FollowUp) | 不可用 |
| 后台任务（"在后台 git pull 最新代码"） | tasks | 不可用 |
| 暂停恢复（用户离开后继续） | heartbeat(AgentState) | 不可用 |
| 多触发源权限差异化 | permission-profiles | 不可用 |
| 自定义钩子扩展 | hooks（责任链） | 受限（只能替换单个执行器） |

### 缺失特性对稳定性的影响

- 无 LLM 重试 → 网络抖动导致 run 失败，用户需手动重试
- 无 `"queue"` strategy → 无法排队等待，只能拒绝或中断
- 无 `"pause"` disconnect → 用户断开连接后 agent 不确定是否继续

---

## 6. 优先级建议

```
P0 — 阻塞核心场景:
  - heartbeat + scheduler（定时/提醒/跟进触发）
  - permission-profiles 完整实现

P1 — 显著提升体验:
  - hooks 责任链（多钩子注册、on-wake）
  - tasks（后台任务）
  - LLM 重试

P2 — 完善边界:
  - "queue" multitask strategy
  - "pause" disconnect mode
  - channel/follow-up trigger 实现

P3 — 代码卫生:
  - 消除工具函数重复
  - 移除 YAGNI 接口
  - run-ledger 状态机提取
```
