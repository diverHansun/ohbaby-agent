# snapshot 模块 goals-duty.md

本文档定义 `snapshot` 模块的设计目标与职责边界。

> 术语说明：本文中的 `snapshot` 指 workspace / filesystem snapshot，也就是工作区文件状态检查点；它不同于 `core/context` 中的 `CompressionSnapshot`（上下文压缩摘要），也不同于 `core/message` 中预留的 `SnapshotPart` 消息片段。

---

## 一、Design Goals（设计目标）

### 1. 将变更检查点提升为 Turn / Run 级基础能力

agent 的一次 Turn 可能读取、编辑、执行命令并产生文件变更。为了支持差异展示、回滚、调试和审计，系统需要一个独立的变更账本能力，在合适的边界上记录检查点。snapshot 的目标，就是把"这次运行改了什么"从 sandbox 或工具本身中抽离出来，提升为独立模块。

### 2. 提供与执行环境实现无关的 diff / rollback 契约

无论 session 在原始目录、git worktree 还是容器挂载目录中执行，只要存在确定的 `workdir`，snapshot 都应能记录基线、生成 patch、展示 diff、执行回滚。它依赖 sandbox 提供执行目录，但不绑定某一种隔离后端。

### 3. 为审计、恢复和 UI 展示提供统一的数据来源

回滚某个 Turn、展示一轮对话修改了哪些文件、在崩溃后识别未提交改动，这些能力都应依赖同一个 snapshot 账本，而不是分别由 session、run-manager、工具模块各自维护一套状态。

### 4. 保持与权限控制和执行调度的职责分离

snapshot 回答的是"记录什么、差异是什么、如何恢复"，不回答"能不能恢复"，也不负责何时启动一次 Run。权限由 policy / permission 决定，执行调度由 lifecycle / run-manager 决定。

---

## 二、Duties（职责）

### 1. 定义检查点与补丁的核心模型

负责：
- 定义 `SnapshotCheckpoint`：至少包含 `checkpointId`、`sessionId`、`runId`、可选 `turnId`、`workdir`、`createdAt`
- 定义 `SnapshotPatch` / `SnapshotDiff` 的数据结构，作为 UI 展示和回滚的统一输入
- 明确检查点之间的关联关系，支持按 session、run、turn 查询

### 2. 在合适的运行边界记录基线与变更

负责：
- 提供 `track()` / `capture()` 或等价接口，在 Turn 开始或关键变更前记录基线
- 在 Turn 结束或显式提交阶段生成 patch / diff
- 允许同一个 Run 下出现多个 Turn 级检查点，而不是把整个 session 压成一个大快照

### 3. 提供 diff、restore、revert 等恢复能力

负责：
- 提供 `diff(from, to)`，用于展示两个检查点之间的文件变化
- 提供 `restore(checkpointId)` 或等价接口，用于恢复到某一基线状态
- 提供 `revert(patches[])` 或等价接口，用于按顺序回滚一批变更
- restore / revert 必须在获得 session/workdir 写锁后执行，或在确认当前没有 active Run / Task 正在写入同一工作区后执行
- 当无法取得锁或检测到并发写入时，应返回明确的 conflict，而不是强行覆盖文件

### 4. 管理快照账本的保留与清理

负责：
- 为检查点和 patch 提供可查询台账，避免只存在于内存中
- 支持按 session 生命周期、保留策略、存储配额清理旧快照
- 在回滚完成后保留必要的审计元数据，而不是直接抹掉历史

### 5. 向上层提供稳定的查询与展示接口

负责：
- 为 session/revert、UI 差异展示、调试工具提供统一的查询接口
- 输出机器可读的 diff / patch 数据，而不是耦合到某个具体 UI 组件
- 在需要时暴露文件级与块级差异信息，供上层自行渲染

### 6. 记录可恢复的持久化账本

负责：
- 将 checkpoint index、patch metadata、restore / revert 记录持久化到可恢复存储中，避免进程崩溃后丢失审计链
- MVP 可将索引关联到 session storage，将 patch / diff artifact 放入 agent state 目录，并通过 sessionId / runId / checkpointId 关联
- 明确区分"审计元数据"与"可用于恢复的大对象"，让清理策略可以删除旧 patch artifact，但保留必要历史记录

---

## 三、Non-Duties（非职责）

### 1. 不负责创建或选择执行环境

snapshot 依赖 sandbox 提供 `workdir`，但不创建 worktree、不启动容器、不决定 session 在哪里运行。

### 2. 不负责权限决策或审批执行

执行 restore / revert 之前是否需要用户确认，由 `core/policy` + `core/permission` 处理。snapshot 不直接决定某次回滚是否被允许。

### 3. 不负责 Run / Session 的生命周期管理

Run 的创建与取消由 `runtime/run-manager` 负责，Session 的建立与历史消息持久化由 `services/session` 负责。snapshot 只记录与这些边界关联的变更账本。

### 4. 不负责工具调用的调度与结果解释

工具是否成功、stdout/stderr 是什么、某次编辑在语义上意味着什么，都不是 snapshot 的职责。snapshot 只关心文件状态前后差异。

### 5. 不替代版本控制或工作区隔离

snapshot 可以利用 git、shadow repo 或其他底层机制实现 diff / revert，但它不替代 worktree、branch、container 这些执行环境能力，也不负责一般意义上的版本管理策略。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `core/lifecycle` | 提供边界事件 | lifecycle 暴露 Turn 边界和执行结果，但不应直接依赖 snapshot 实现 |
| `runtime/run-manager` | 间接依赖 | run-manager 提供 runId 与运行边界，snapshot 不管理 Run 本身 |
| `runtime/hooks` / run worker | 被依赖 | run worker 或 hook 在 Turn 前后调用 snapshot，避免 core/lifecycle 反向依赖基础设施 |
| `sandbox` | 依赖 | snapshot 基于 sandbox 提供的 workdir 工作，但不拥有 sandbox 生命周期 |
| `services/session` | 依赖（可选） | 可将 checkpoint 索引或回滚记录关联到 session storage |
| `runtime/stream-bridge` / UI | 被依赖 | UI 可读取 snapshot diff 结果展示本轮改动 |
| `project` | 间接依赖 | 根据项目类型或 VCS 能力决定底层快照实现策略 |

---

## 五、模块边界示例

### 5.1 职责内的示例

正确：run worker / hooks 在 Turn 前后记录检查点与补丁
```typescript
const before = await snapshot.track({ sessionId, runId, turnId, workdir })

await lifecycle.executeTurn()

const patch = await snapshot.diff(before.checkpointId)
```

正确：session/revert 使用 snapshot 恢复文件状态
```typescript
await snapshot.restore({
  sessionId,
  checkpointId,
  lockMode: 'exclusive',
})
```

错误：snapshot 不应让 core/lifecycle 直接持有基础设施依赖
```typescript
// 错误：不应该在 core/lifecycle 内部
await snapshot.track({ sessionId, runId, turnId, workdir })

// 正确：lifecycle 发出 Turn 边界，run worker / hooks 调用 snapshot
```

### 5.2 职责外的示例

错误：snapshot 不应决定执行环境
```typescript
// 错误：不应该在 snapshot 中
const workdir = await createGitWorktree(sessionId)

// 正确：workdir 由 sandbox 提供
```

错误：snapshot 不应执行权限确认
```typescript
// 错误：不应该在 snapshot 中
const answer = await permission.ask('Restore this checkpoint?')

// 正确：外层先完成权限决策，再调用 snapshot.restore()
```

---

## 六、文档自检

- 可以用一句话说明该模块的存在意义：snapshot 为 Turn / Run 提供独立的工作区变更检查点与回滚账本，使差异展示、恢复和审计拥有统一数据来源
- 能清楚回答"这个模块不该做什么"：不创建执行环境、不做权限决策、不管理 Run/Session 生命周期、不调度工具、不替代版本控制、不直接耦合 core/lifecycle
- 职责与其他模块无明显重叠：sandbox（执行环境）、run-manager（运行台账）、policy/permission（审批）、session（会话持久化）边界清晰
