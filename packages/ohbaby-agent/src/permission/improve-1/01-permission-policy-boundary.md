# Permission / Policy Boundary Improvement

## 背景

本轮 runtime MVP 收尾时曾尝试在 `runtime/permission-profiles` 中加入
`interactive`、`read-only`、`notify-only`、`full-auto` 等 profile 语义。复盘后确认
这是错误边界：runtime 是运行编排层，不应该承载权限判断、权限预设或策略组合。

runtime 可以记录和透传 run 的元数据，例如 `permissionProfileId`；但 profile 的真实
语义、规则匹配、用户审批、会话内 always approval、模式切换等，都属于 permission
领域，或者属于底层 agent/tool-call 执行机制的拦截点。

## 参考项目观察

### Kimi Code

`kimi-code/packages/agent-core/src/agent/permission/` 将规则、模式、审批和内置
permission policy 放在同一个 permission 领域内：

- `PermissionManager.beforeToolCall()` 是工具执行前的主拦截点。
- `PermissionPolicy` 是 permission 内部插件，不是外部顶层 policy 模块。
- `manual` / `yolo` / `auto` 是用户可见的权限姿态；deny 规则始终优先。
- 子代理通过 parent permission 继承父级权限上下文。

结论：如果 ohbaby 后续要重构，应学习这种“permission 领域拥有判断语义，agent
turn/tool-call 机制提供拦截点”的设计。

### opencode

`opencode/packages/opencode/src/permission/` 是独立 permission service，负责：

- ruleset 求值；
- pending permission ask / reply；
- once / always approval；
- session 级别的自动通过；
- config / agent permission ruleset 合并。

agent profile 只声明权限规则集，工具通过 `ctx.ask()` 进入 permission service。

结论：profile/agent 可以声明规则，但规则解释和审批生命周期仍归 permission。

### pi

`pi/packages/agent` 的底层 loop 只暴露 `beforeToolCall` / `afterToolCall` 钩子。
`pi/packages/coding-agent/examples/extensions/permission-gate.ts` 等扩展在
`tool_call` 事件上实现具体权限拦截。

结论：底层 runtime/loop 应提供稳定拦截点，而不是内建复杂权限语义。

## ohbaby 当前状态

当前 ohbaby 已经有两个相邻模块：

- `packages/ohbaby-agent/src/permission/`
  - 管理 pending ask、reply、always approval、permission events。
- `packages/ohbaby-agent/src/permission/`（统一承载 evaluator / rule / state）
  - 管理粗粒度模式和工具类别决策，例如 `agent` / `ask` / `plan`，
    `readonly` / `write` / `dangerous` 等。

`core/tool-scheduler` 现在统一调用 permission evaluator；如果返回 `ask` 再调用
`permission.ask()`。旧的顶层 policy 模块已经并入 permission 领域。

## 后续调整方向

MVP 后建议将 `policy` 逐步并入 `permission`，或者至少把 `policy` 降级为
permission 内部的规则/模式 provider：

1. 在 `permission` 中定义统一的 `PermissionMode`、`PermissionRule`、
   `PermissionDecision`、`PermissionPolicy`。
2. 将工具类别矩阵迁移为 permission 内部默认规则。
3. 将 `core/agents` / `core/tool-scheduler` 的执行前拦截点收敛为类似
   `permission.beforeToolCall(context)` 的接口。
4. 将 future profile/preset 放入 `permission` 领域，例如
   `permission/profiles` 或 permission config loader，而不是 runtime。
5. 子代理权限继承应靠近 `core/agents`，由 parent agent/session 的 permission
   context 派生，不由 runtime 猜测。

## Runtime MVP 边界

本轮 runtime 收尾只做以下事情：

- 删除 `runtime/permission-profiles`。
- 不在 runtime 中解释 profile id。
- 不向 `policy` 继续增加 profile 语义。
- 如果需要保留 `permissionProfileId`，仅作为 run defaults / run record 的不透明
  字符串，用于后续 permission 重构时接入。
- 将 scheduler / heartbeat / follow-up 等后台助手方向继续推迟到产品定位明确后。

## 验收标准

- `packages/ohbaby-agent/src/runtime/` 下不存在 `permission-profiles` 模块。
- runtime 代码不 import/export `runtime/permission-profiles`。
- `RunManagerDeps` 不依赖 `ProfileRegistry`。
- `RunContext` / `RunHookContext` 不暴露 `PermissionProfile` 语义对象。
- `policy` 模块本轮不新增 profile 字段或 profile 判断逻辑。
- runtime 相关单元测试、集成测试、类型检查、lint 均通过。
