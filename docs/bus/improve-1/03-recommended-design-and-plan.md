# Bus 模块优化 — 3. 协商后的推荐设计与实施计划

> 结论：`Bus` 继续定位为**内部领域事件总线**，不升级为统一 UI 协议管线。UI/daemon 通过显式 projector 消费 Bus 事件，run-scoped 流继续由 `StreamBridge` 承担。

---

## 一、设计结论

### 1.1 不采用原自动桥接方案

原方案建议在 `bus.publish()` 内部自动调用 `streamBridge.publish()`，并把 BusEvent payload 对齐到 `UiEvent`。讨论后决定不采用，原因如下：

1. **领域事件与 UI 协议事件边界会混淆**：例如 Bus 的 `message.updated` 当前表示 message record 更新，SDK 的 `message.updated` 表示 UI 可渲染消息更新；同名但契约不同。
2. **现有 run 流已经独立存在**：`RunManager/Worker` 通过 `StreamBridge` 的 `run/{runId}` scope 发布 `message.part.delta`、`run.updated`、`run.tool.start/result`，不应被 Bus 自动桥接覆盖。
3. **Permission 不是纯转发**：`PermissionEvent` 订阅需要写 UI state、更新 runtime status，再发布 UI event，不能伪装成无状态 mapper。
4. **自动桥接降低可追溯性**：新增事件会隐式进入 UI/daemon 通道，容易把内部事件暴露成外部协议。

### 1.2 采用显式 projector table

推荐方案：

```
Domain Managers
  └─ publish(BusEvent)
       ↓
Bus: internal domain event spine
       ↓
Explicit projectors
  ├─ pure app event projection
  │   ├─ CommandsEvent -> UiCommand*Event / app stream events
  │   └─ InteractionEvent -> UiInteraction*Event / app stream events
  └─ stateful UI projection
      └─ PermissionEvent -> stateStore + runtime status + UiPermission*Event

RunManager/Worker
  └─ streamBridge.publish("run/{runId}", ...)
       ↓
run-stream-adapter
       ↓
UiEvent: run.updated, message.part.delta, message.updated, ...
```

### 1.3 分阶段实施

| 阶段 | 目标 | 解决问题 | 是否改 Bus API |
|------|------|----------|----------------|
| Phase 1 | 抽出显式 app/UI projectors，去重桥接逻辑 | P2, P4, 部分 P5/P7 | 否 |
| Phase 2 | 清理全局 `Bus` fallback，确立 per-backend bus | P3 | 否 |
| Phase 3 | 事件契约与 scope 审计，补契约测试 | P1, P5, P6 的决策基础 | 视审计结果 |
| Phase 4（可选） | 若 Phase 3 证明必要，再做 per-session bus 或局部 session event source | 多会话物理隔离 | 可能 |

---

## 二、Phase 1：显式投影层

### 2.1 Phase 1A：Pure App Event Projectors

**目标**：把 `CommandsEvent` 与 `InteractionEvent` 的重复映射集中到一处，供 `ui-inprocess` 与 daemon adapter 复用。

这些事件是纯映射，无状态副作用：

| Bus event | UI/app event |
|-----------|--------------|
| `CommandsEvent.Started` | `command.started` |
| `CommandsEvent.ResultDelivered` | `command.result.delivered` |
| `CommandsEvent.Failed` | `command.failed` |
| `CommandsEvent.CatalogUpdated` | `command.catalog.updated` |
| `InteractionEvent.Requested` | `interaction.requested` |
| `InteractionEvent.Resolved` | `interaction.resolved` |

建议新增：

| 文件 | 职责 |
|------|------|
| `packages/ohbaby-agent/src/adapters/app-events/projectors.ts` | 定义 domain Bus -> SDK/app stream 的 pure projector table 与 mapper |
| `packages/ohbaby-agent/src/adapters/app-events/bus-subscriptions.ts` | 根据 projector table 订阅 Bus 并输出 mapped event；daemon 文件只保留薄适配器 |
| `packages/ohbaby-agent/src/adapters/app-events/projectors.unit.test.ts` | 验证每个 mapper 的输出契约 |

推荐接口：

```typescript
export type ProjectedAppEvent =
  | {
      readonly type: "command.started";
      readonly uiEvent: UiCommandStartedEvent;
    }
  | {
      readonly type: "command.result.delivered";
      readonly uiEvent: UiCommandResultDeliveredEvent;
    }
  | {
      readonly type: "command.failed";
      readonly uiEvent: UiCommandFailedEvent;
    }
  | {
      readonly type: "command.catalog.updated";
      readonly uiEvent: UiCommandCatalogUpdatedEvent;
    }
  | {
      readonly type: "interaction.requested";
      readonly uiEvent: UiInteractionRequestedEvent;
    }
  | {
      readonly type: "interaction.resolved";
      readonly uiEvent: UiInteractionResolvedEvent;
    };

export interface AppStreamEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface AppEventProjector<Event extends BusEventDefinition> {
  readonly event: Event;
  project(payload: BusEventPayload<Event>): ProjectedAppEvent | undefined;
}

export const appEventProjectors = [
  // CommandsEvent.Started, ...
] as const;

export function toAppStreamEvent(event: ProjectedAppEvent): AppStreamEvent {
  const { type, ...data } = event.uiEvent;
  return { type, data };
}
```

`ui-inprocess` 使用 `ProjectedAppEvent.uiEvent` 调用本地 `publish()`；daemon 使用 `toAppStreamEvent()` 去掉 `type` 后调用 `streamBridge.publish("app", type, data)`。如果实现时发现 SDK `UiEvent` 类型与 daemon stream payload 不能完全复用，应新增明确的 app-stream discriminated union，而不是退回裸 `Record<string, unknown>`。

daemon 的通用 `eventDefinitions` 透传不再作为默认路径保留。Phase 1A 应选择以下处理之一：

1. 删除通用透传参数，所有 app stream 事件必须经过 projector table。
2. 如果测试或未接入 daemon 仍需要扩展点，则改成显式 allowlist，并把每个 allowlist 事件纳入 Phase 3 event catalog 与 contract 审计。

不得继续允许任意 `BusEventDefinition[]` 绕过 projector 直接进入 `"app"` stream。

### 2.2 Phase 1B：Stateful Permission Projection

**目标**：把 `ui-inprocess.ts` 中 Permission 相关的 Bus 订阅抽成显式 stateful projector，但不强行与 pure mapper table 合并。

Permission 事件需要上下文：

- `stateStore`
- `permissionState`
- `publish(UiEvent)`
- `getActiveRunId()`
- `pendingPermissionSessions`（仍由 backend 持有并注入，projection 只读写该 Map，不拥有 respondPermission 流程）
- `reconcileRuntimeStatus()`
- `toUiPermissionRequest()`
- `currentPermissionState()`

建议新增：

| 文件 | 职责 |
|------|------|
| `packages/ohbaby-agent/src/adapters/ui-runtime/permission-projection.ts` | 启动/停止 Permission UI projection |
| `packages/ohbaby-agent/src/adapters/ui-runtime/permission-projection.unit.test.ts` | 验证 stateStore、runtime status、UiEvent 输出 |

推荐接口：

```typescript
export interface PermissionUiProjectionOptions {
  readonly bus: BusInstance;
  readonly getActiveRunId: () => string | undefined;
  readonly pendingPermissionSessions: Map<string, string>;
  readonly permissionState: PermissionStateStore;
  readonly publish: PublishUiEvent;
  readonly reconcileRuntimeStatus: () => Promise<UiRunStatus>;
  readonly stateStore: UiStateStore;
}

export interface StartedProjection {
  dispose(): void;
}
```

Phase 1B 保持现有 no-active-run 行为作为 legacy fallback：当没有 active run 时，`UiPermissionRequest.runId` 仍可暂时使用 `callId` 填充以避免行为回归，但测试和代码注释必须标明这不是 run scope。真正的 request id / run id 契约拆分放到 Phase 3 评估。

### 2.3 Phase 1 不做的事

- 不修改 `BusInstance`。
- 不修改 `createBus()`。
- 不修改 `BusEvent.define()`。
- 不修改 `Message/Context/Memory/ToolScheduler/Session` payload。
- 不删除或重写 `run/{runId}` `StreamBridge` 流。
- 不把 `BusEvent` payload 直接对齐 `UiEvent`。

---

## 三、Phase 2：Bus Ownership and Injection Cleanup

### 3.1 目标

确立 **per-backend bus**：一个 UI backend / runtime composition 拥有一个 Bus 实例，并显式注入下游模块。

Phase 2 不做 per-session bus。当前 manager 多数是 backend/runtime scoped，而不是 session scoped；过早引入 per-session bus 会迫使 `MessageManager`、`PermissionManager`、`ContextManager`、`ToolScheduler` 等生命周期一起拆分，收益不足。

### 3.2 Phase 2A：软治理

保留 `Bus` 导出，但生产代码不再依赖全局 fallback。

重点修改：

| 文件 | 改动 |
|------|------|
| `permission/manager.ts` | 移除 `options.bus ?? Bus`，要求显式传入 bus |
| `permission/state.ts` | 移除 `options.bus ?? Bus`，要求显式传入 bus |
| `runtime/daemon/bootstrap.ts` | 改为 `options.bus ?? createBus()`，不再引用全局 `Bus` |
| `permission/index.ts` | 清理默认全局 manager/state 的生产引用，必要时标记 legacy |

### 3.3 Phase 2B：硬治理

当 Phase 2A 通过且确认没有外部消费者依赖 `Bus` 导出后，删除 `bus/index.ts` 中的全局单例。这是内部 breaking cleanup；如果发布包需要兼容窗口，则先标记 legacy/deprecated，再单独移除。

```typescript
export const Bus: BusInstance = createBus();
```

所有代码必须使用以下方式之一：

- 组合层创建：`const bus = createBus()`
- 测试创建：`const bus = createBus()`
- 上层注入：`options.bus`

---

## 四、Phase 3：事件契约与 Scope 审计

### 4.1 目标

先通过文档和测试判断是否需要 per-session bus，而不是预设答案。

每个事件需要标注：

| 字段 | 说明 |
|------|------|
| owner | 事件归属模块 |
| audience | domain / UI projection / daemon / tests |
| scope | app / project / session / run |
| frequency | low / medium / high |
| payload context | 是否包含足够路由上下文 |
| UI visible | 是否允许进入 UI 协议 |

### 4.2 初步分类

| 模块 | 初步 scope | Phase 3 重点 |
|------|------------|--------------|
| Message | session/run | 命名与 UI `message.updated` 冲突，需要审计 |
| Context | session/run | 补齐 `runId` 是否必要 |
| Memory | project | 不应强塞 `sessionId` |
| ToolScheduler | run | 评估是否补 `runId/sessionId/messageId` |
| Permission | session/run + app state | 区分 mode/level/rule/request/reply |
| Session | project/backend | 保持领域 payload，投影到 UiSession |
| Commands | app + optional session | Phase 1 先投影 |
| Interaction | app/run + optional session | Phase 1 先投影 |

### 4.3 命名原则

如果 Bus 内部事件与 `ohbaby-sdk` 的 `UiEvent` 同名但 payload 不同，应优先考虑 rename Bus 内部事件，而不是把领域 payload 改成 UI payload。

示例方向：

| 当前 Bus event | 问题 | 可能的新名字 |
|----------------|------|--------------|
| `message.updated` | 与 `UiEvent.message.updated` 同名不同 payload | `message.record.updated` |
| `message.part-updated` | 命名风格与 UI `message.part.delta` 不一致 | `message.part.updated` |

最终命名需要在 Phase 3 审计后确定。

### 4.4 per-session bus 决策

Phase 3 完成后再判断是否需要 per-session bus：

- 如果 scope 字段清晰、projection 过滤可靠，继续 per-backend bus。
- 如果串话测试暴露高风险，再进入 Phase 4。
- 如果只有某类事件高风险，优先做局部 session-scoped event source，而不是全系统 per-session bus。

---

## 五、Phase 4（可选）：Session-Scoped Event Source

只有当 Phase 3 测试证明 per-backend bus 不足时，才考虑 Phase 4。

可选方向：

1. 全系统 per-session bus。
2. 仅对 Message/ToolScheduler/Permission 做局部 session-scoped event source。
3. 保持 per-backend bus，但在 projector 层引入更强的 scope guard。

scope guard 的边界：projector 只负责协议投影和显式路由过滤，不承担权限决策、生命周期所有权或跨 session 隔离的核心职责。

默认不实施 Phase 4。

---

## 六、推荐实施顺序

1. Phase 1A：抽 pure app event projectors，覆盖 Commands/Interaction。
2. Phase 1B：抽 Permission stateful projection。
3. Phase 2A：移除生产路径全局 Bus fallback。
4. Phase 2B：删除全局 Bus 单例导出。
5. Phase 3：事件契约文档、scope 测试、命名审计。
6. Phase 4：仅在 Phase 3 证明必要时启动。

这个路线保守、可回滚，并且符合 opencode/kimi-code 的共同经验：事件系统要先把边界讲清楚，再决定隔离机制。
