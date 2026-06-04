# Bus 模块优化 — 4. 测试与验收标准

> 测试目标：证明 Bus 继续保持内部领域事件总线的边界，同时 UI/daemon 投影可追踪、可复用、无串话。

---

## 一、测试原则

1. **Bus 核心行为不因投影层改变**：现有 publish/subscribe/Zod parse/error isolation 测试必须继续通过。
2. **Projection 是显式契约**：每个进入 UI/app stream 的 Bus event 都必须出现在 projector table 或 stateful projection 中。
3. **纯映射和状态副作用分开测**：Commands/Interaction 用纯 mapper 测试；Permission 用 stateful projection 测试。
4. **run-scoped StreamBridge 保持独立**：`run/{runId}` 的 `message.part.delta`、`run.updated` 等测试不应被 Bus projector 改写。
5. **先用契约测试判断隔离需求**：Phase 3 通过 scope 和串话测试评估是否需要 per-session bus。

---

## 二、Phase 1A 验收：Pure App Event Projectors

### 2.1 单元测试

新增或迁移到：

`packages/ohbaby-agent/src/adapters/app-events/projectors.unit.test.ts`

覆盖：

```typescript
describe("app event projectors", () => {
  it("projects CommandsEvent.Started to command.started");
  it("projects CommandsEvent.ResultDelivered to command.result.delivered and omits undefined fields");
  it("projects CommandsEvent.Failed to command.failed");
  it("projects CommandsEvent.CatalogUpdated to command.catalog.updated and omits undefined reason");
  it("projects InteractionEvent.Requested to interaction.requested");
  it("projects InteractionEvent.Resolved to interaction.resolved with accepted/cancelled status");
});
```

每个测试都验证：

- 输出 `type` 与 `ohbaby-sdk` `UiEvent` 名称一致。
- 输出 `uiEvent.type` 不包含 `.internal`。
- `toAppStreamEvent()` 会去掉 `uiEvent.type`，把剩余字段作为 stream `data`。
- optional 字段为 `undefined` 时不会进入 stream payload。
- 输入 payload 不被 mutate。

`CommandsEvent.CatalogUpdated` 已选择进入 in-process UI event handlers；daemon 与 `ui-inprocess` 共享同一套 projector/subscription helper。

### 2.2 订阅集成测试

新增或迁移到：

`packages/ohbaby-agent/src/adapters/app-events/bus-subscriptions.unit.test.ts`

覆盖：

```typescript
describe("startAppEventProjection", () => {
  it("subscribes every projector event and publishes mapped output");
  it("dispose unsubscribes all bus listeners");
  it("subscriber errors from target publish do not break bus domain subscribers");
});
```

目标 publish 接口应足够小：

```typescript
type AppEventTarget = <Type extends AppProjectedEventType>(
  event: ProjectedAppEvent<Type>,
) => void;
```

这样 `ui-inprocess` 和 daemon 都能复用同一套订阅逻辑。

daemon 的 `eventDefinitions` 通用透传必须被删除或改成显式 allowlist。任何 allowlist 事件都必须进入 `event-catalog.md`，并有 contract 测试说明为什么可以绕过 typed projector。

### 2.3 回归要求

- `runtime/daemon/app-events.unit.test.ts` 应验证 daemon app adapter 使用共享 projector，并覆盖 Commands + Interaction app stream 输出。
- `runtime/daemon/bootstrap.integration.test.ts` 应只注入 `startAppEventAdapter`，启动/停止顺序不再包含 command adapter。
- `ui-inprocess` 中 Commands/Interaction 的重复 `bus.subscribe` 分支应消失。
- `ui-inprocess` client 的 `dispose()` 应释放 app event projector 与 permission projection 的 Bus 订阅。
- `runtime/daemon/app-events.ts` 是 daemon 侧唯一 app event projection adapter；不再保留 `command-events.ts` 历史命名适配器。

---

## 三、Phase 1B 验收：Permission Stateful Projection

### 3.1 单元测试

新增：

`packages/ohbaby-agent/src/adapters/ui-runtime/permission-projection.unit.test.ts`

覆盖：

```typescript
describe("startPermissionUiProjection", () => {
  it("publishes permission.updated when mode changes");
  it("publishes permission.updated when level changes");
  it("publishes permission.updated when a session rule is added");
  it("converts PermissionEvent.Updated into permission.requested and stores pending request");
  it("uses active run id when available");
  it("preserves legacy no-active-run fallback without treating callId as run scope");
  it("converts PermissionEvent.Replied into permission.resolved and removes pending request");
  it("reconciles runtime status after request and reply");
  it("reports or contains async projection errors without unhandled rejections");
  it("dispose unsubscribes all permission listeners");
});
```

### 3.2 集成测试

保留或补充 `ui-inprocess` contract 测试，证明用户可见行为不变：

- 发起权限请求后 UI 收到 `permission.requested`。
- UI snapshot 中 pending permission 出现。
- 回复权限后 UI 收到 `permission.resolved`。
- UI runtime status 从 `waiting-for-permission` 回到 `running` 或 `idle`。

无 active run 时，Phase 1B 先保留当前兼容行为：`UiPermissionRequest.runId` 可以暂时使用 `callId` 填充，但测试名和代码注释必须标记为 legacy fallback，且不能把它解释为真正 run scope。为无 active run 的 permission request 引入独立显示策略、或修改 `UiPermissionRequest` 契约，属于 Phase 3 后的独立决策。

### 3.3 回归要求

- `ui-inprocess.ts` 中 Permission 相关逻辑可以被抽走，但语义不能改变。
- `toUiPermissionRequest`、`currentPermissionState`、`reconcileRuntimeStatus` 相关边界必须在迁移清单中列明。
- `pendingPermissionSessions` 仍由 backend 持有并注入 projection；`respondPermission` 读取路径不能变成 projection 内部隐藏状态。
- Permission projection 不参与 daemon pure app projection；daemon 若未来需要 permission state，应另行设计。

---

## 四、Phase 2 验收：全局 Bus fallback 清理

### 4.1 Phase 2A

验收：

- `permission/manager.ts` 不再导入全局 `Bus`。
- `permission/state.ts` 不再导入全局 `Bus`。
- `runtime/daemon/bootstrap.ts` 不再导入全局 `Bus`，使用 `options.bus ?? createBus()`。
- 生产组合层仍显式创建并注入同一个 per-backend bus。

建议测试：

```typescript
describe("permission bus injection", () => {
  it("requires an explicit bus for permission manager");
  it("requires an explicit bus for permission state");
});

describe("daemon bootstrap bus ownership", () => {
  it("creates an isolated bus when none is provided");
  it("uses the provided bus when supplied");
});
```

### 4.2 Phase 2B

验收：

- `bus/index.ts` 不再导出 `Bus` 全局单例。
- `rg "import \\{ Bus" packages tests` 无结果。
- `rg "\\bBus\\." packages tests` 无生产/测试单例调用。
- 所有测试通过显式 `createBus()` 创建隔离实例。

---

## 五、Phase 3 验收：事件契约与 Scope 审计

### 5.1 事件目录

新增文档建议：

`docs/bus/event-catalog.md`

每个事件至少包含：

| 字段 | 说明 |
|------|------|
| type | 事件类型字符串 |
| owner | 归属模块 |
| scope | app / project / session / run |
| audience | domain / UI projection / daemon / tests |
| frequency | low / medium / high |
| required context | 必须携带的路由字段 |
| UI visible | yes / no / via projector |

### 5.2 契约测试

新增：

`packages/ohbaby-agent/src/bus/event-catalog.contract.test.ts`

或按模块分散：

- `core/message/events.contract.test.ts`
- `core/context/events.contract.test.ts`
- `core/tool-scheduler/events.contract.test.ts`
- `permission/events.contract.test.ts`

测试规则：

```typescript
describe("Bus event scope contracts", () => {
  it("session-scoped events include sessionId");
  it("run-scoped events include runId and sessionId");
  it("project-scoped events include directory or projectRoot");
  it("app-scoped events document why sessionId is optional");
});
```

已知上下文缺口必须在 Phase 3 审计中明确处理：

- `ToolSchedulerEvent.*` 当前主要携带 `callId`、`toolName`、`timestamp`，缺少稳定的 `runId`、`sessionId`、`messageId` 路由上下文。
- `MemoryEvent.Added/Updated/Removed` 当前缺少 `directory` 或 `projectRoot`；只有 `MemoryEvent.Refreshed` 携带 `directory`。
- 这些缺口不要求 Phase 1/2 修改 payload，但 Phase 3 必须给出“补字段、保持 project/app scope、或禁止进入 UI projection”的明确结论。

### 5.3 串话测试

新增：

`tests/integration/bus/event-scope-isolation.integration.test.ts`

覆盖：

- 同一 per-backend bus 下，session A 的 permission request 不会被投影到 session B。
- run A 的 stream events 不会被 run B projection 消费。
- app-scoped command/interaction 事件携带 `sessionId` 时，UI 可按 session 过滤；不携带时必须有明确理由。

### 5.4 命名审计

验收：

- Bus 内部事件和 SDK `UiEvent` 同名但 payload 不同的事件已列入 rename 候选。
- `message.updated` / `message.part-updated` 的最终命名方案已在 Phase 3 出口确认，或明确记录为后续独立迁移项。
- rename 必须有迁移测试，不能只改字符串。

### 5.5 per-session bus 决策

Phase 3 最终必须产出结论：

| 结论 | 后续动作 |
|------|----------|
| per-backend bus 足够 | 不做 Phase 4 |
| 某类事件需要更强隔离 | 做局部 session-scoped event source |
| 全局过滤复杂且高风险 | 启动 Phase 4 per-session bus 设计 |

Phase 3 conclusion: per-backend bus is sufficient.

Evidence:
- `packages/ohbaby-agent/src/bus/event-catalog.contract.test.ts` records all 29 Bus events exactly once and keeps `docs/bus/event-catalog.md` synchronized with source.
- Known context gaps are limited to `MemoryEvent.Added/Updated/Removed` and `ToolSchedulerEvent.*`; these events have `uiVisible: "no"`.
- Commands and Interaction app visibility is only `via-projector`.
- Permission UI visibility is stateful and explicitly depends on projector context, including `projector.activeRunId`.
- Run-visible Message/ToolScheduler UI behavior remains on `StreamBridge` `run/{runId}`, not on Bus projectors.

Decision:
- Phase 4 is not implemented in this optimization.
- Future work must add a failing contract or leakage test before introducing per-session bus or local session-scoped event source.

---

## 六、回归命令

每个 Phase 至少运行：

```bash
pnpm vitest run packages/ohbaby-agent/src/bus/
pnpm vitest run packages/ohbaby-agent/src/adapters/
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-runtime/stream-bridge-run-event-source.unit.test.ts
pnpm vitest run packages/ohbaby-agent/src/runtime/daemon/
pnpm vitest run tests/integration/
pnpm typecheck
pnpm lint
```

根据实际修改范围可先运行更小的目标测试，但合并前必须通过全量相关测试。

---

## 七、最终验收

Phase 1-3 完成后：

1. Bus 核心 API 保持小而同步。
2. Commands/Interaction 映射只存在一套 projector table。
3. Permission stateful projection 从 `ui-inprocess.ts` 中分离，行为不变。
4. 生产路径不依赖全局 `Bus` fallback。
5. 事件目录明确记录 scope、audience 和 required context。
6. 事件目录与 contract test 证明 known gaps 不直接进入 UI projection。
7. per-backend bus 当前足够，Phase 4 不实施；是否进入 per-session bus 必须由新的失败测试支持，而不是架构偏好驱动。
