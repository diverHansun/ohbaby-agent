# goals interrupt-current 与 light-note 设计补丁

日期：2026-07-03
状态：Accepted

本文补齐当前实现与 `docs/goals/*` 之间的两个行为差距：

- goal `active` 续跑期间，普通用户消息必须优先执行，并中断当前 goal run。
- goal `paused` 时，普通用户消息应让模型看见一个轻量 goal note，但不得自动恢复 goal。

本补丁覆盖后端与 CLI 适配边界。Web 端暂不改；CLI 顶部的 goal 状态提示后续单独设计。

## 一、对标结论

Codex 和 Kimi 的共同点是：goal 有一个很薄的公开状态快照，objective 作为不可信任务数据注入模型上下文，恢复/完成/暂停都通过状态机而不是散落的 UI 旗标表达。

本项目继续采用更简单的三态/空态模型：

- `active`
- `paused`
- `complete`，瞬态，宣告后清除
- `null`，无当前 goal

不新增 `PauseCause`、`resumeIntent`、`interruptedBy` 等持久字段。后续 CLI 状态条只消费 `GoalSnapshot.status`；Web 面板消费 `status`、`objective` 与 `pauseReason`。

## 二、用户插话策略

最终策略：用户普通 prompt 优先，goal continuation 可被打断。

当 goal run 正在执行，用户发普通消息：

1. UI adapter 识别当前 in-flight prompt 的 owner 是 `goal`。
2. adapter 取消当前 active run，等待该 run 的投影和 run-manager completion 收敛。
3. goal 状态转为 `paused`，`pauseReason` 使用简单人读字符串，例如 `interrupted`。
4. 用户消息在同一 session 中启动普通 run。
5. 用户消息结束后，goal 保持 `paused`，不会自动恢复。
6. 用户必须显式执行 `/goal resume` 才会重新进入 `active` 并触发 GoalDriver。

反向情况保持保守：普通用户 prompt 正在执行时，goal driver 不抢占用户 run，只等待 prompt idle 后再尝试续跑。

实现上不要让两个 UI prompt projection 并发写同一个 adapter 状态。`promptInFlight` 不再是简单硬拒绝，而是按 owner 分流：

- `user` 遇到 `goal`：取消 goal run，等待 drain，然后提交 user run。
- `goal` 遇到 `user`：等待 user run idle。
- `user` 遇到 `user`：维持既有串行/拒绝语义。
- `goal` 遇到 `goal`：维持 ensure-driving 幂等，不叠加 driver。

这不是把 run-manager 的 `multitaskStrategy` 全局切成 `interrupt-current`，而是在 CLI adapter 边界实现 owner-aware interruption：adapter 等 goal run 真正注册并可取消后，调用 run-manager 的取消能力，让该 run 以 `cancelled` completion 收敛，再提交用户 run。对用户可见的效果仍是"用户插话中断当前 goal"，同时保留普通 user/user prompt 的既有串行/拒绝语义。

## 三、paused light note

新增一个纯渲染函数，建议命名：

```ts
renderGoalContextNote(snapshot: GoalSnapshot): string | undefined
```

三档输出：

- `active`：仍由 `renderGoalTurnPrompt` 产出全量续跑提醒，供 GoalDriver 使用。
- `paused`：轻提醒。说明存在一个暂停 goal，objective 是不可信数据，当前不会被自动推进；如用户要继续 goal，应执行 `/goal resume`。
- 无 goal / `complete`：空。

light note 的语义边界：

- 不包含预算推进指导。
- 不包含 `GOAL_CONTINUATION_CORE` 自审指令。
- 不要求模型继续 goal 工作。
- 不允许模型通过意图猜测恢复 goal。
- 不改变 `UpdateGoal(active)` 的规则；恢复仍只有 `/goal resume` 一条路。
- `pauseReason` 与 objective 一样是模型可见的不可信数据；若写入 light note，必须包裹/转义，不能裸插入指令文本。

建议把 light note 作为普通用户 run 的模型可见上下文前缀，而不是渲染成可见 UI prompt 文本。用户看到的 transcript 仍是自己的原始输入；模型 history 中可以保留这条轻量上下文，便于后续 turns 理解为什么 goal 没有继续。

## 四、注入点

普通用户 prompt 的提交流程在 session 解析后读取当前 goal snapshot：

1. 解析目标 session。
2. 若本次提交 owner 是 `user`，读取 `runtime.goals.getSnapshot(session.id)`。
3. 若状态是 `paused`，把 `renderGoalContextNote(snapshot)` 拼到发给模型的 prompt 前。
4. UI 侧 `message.appended` 仍展示用户原始 text。
5. goal continuation prompt 本身不附加 light note，避免 active 提醒和 paused 提醒混杂。

该实现不引入通用动态注入系统；只在当前 adapter 的 prompt 启动边界做一次目标态补充。

## 五、测试验收

必须先补测试，再改实现。

新增或更新测试点：

- `goals/injection.unit.test.ts`：paused light note、无 goal 空输出；objective、completion criterion 与 pauseReason 仍做 `<untrusted_*>` 包裹与转义；light note 不含 `GOAL_CONTINUATION_CORE`。
- `ui-inprocess.contract.test.ts`：active goal 续跑时提交普通用户 prompt 不抛 `A prompt is already running`；goal run 被取消，goal 进入 `paused(interrupted)`，用户 prompt 正常完成。
- `ui-inprocess.contract.test.ts`：插话用户 prompt 发给 fake provider 的模型输入包含 paused light note 和 `/goal resume` 提示，但 UI transcript 里的用户消息仍是原始输入。
- `ui-inprocess.contract.test.ts`：paused goal 下普通 prompt 可见 light note，但不会自动触发 `resumeGoal` 或 GoalDriver。
- 回归：普通用户 prompt 正在跑时，goal driver 等待 idle，不抢占用户 prompt。

完成实现后继续跑既有 gates：

- `pnpm test:unit`
- `pnpm test:integration`
- 相关 `ui-inprocess` contract 测试
- `/goal` 命令注册与 `/help` 手动走查

## 六、与既有文档的关系

本设计延续 `docs/goals/architecture.md`、`dfd-interface.md`、`use-case.md` 对 `interrupt-current` 和三档注入的要求。

`docs/superpowers/plans/2026-07-02-goals-module.md` 后段关于 "`promptInFlight` 守卫无需额外并发处理，用户按 Esc 才是插话中断路径" 的实现说明被本文取代。
