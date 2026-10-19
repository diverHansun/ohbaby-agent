# 4. 测试与验收标准

> 本批对应 plan/04 §4.6 的 S1–S6、S8–S12（S7 属批 2 多 session 容量）；A1/A5/A7 等跨批项见 §4.4。分类与命名遵循既有测试分类。
> 实施尚未开始，以下用例是待执行的契约；未跑项不能以"相关单测通过"代替。§4.3 的测试文件路径已于 2026-10-15 核对存在，`adapters/goal-execution.integration.test.ts` 为第 2 批计划新增的前置交付，实施时核对该批 05。

## 4.1 方法与命令

| 目的 | 命令（仓库根执行） |
| --- | --- |
| 本批单测 | `pnpm vitest run packages/ohbaby-agent/src/runtime/prompt-scheduler/scheduler.unit.test.ts packages/ohbaby-agent/src/runtime/prompt-scheduler/recovery.unit.test.ts` |
| 本批契约 | `pnpm vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts packages/ohbaby-sdk/src/run-inputs.unit.test.ts packages/ohbaby-cli/src/tui/app.contract.test.tsx` |
| 本批集成 | `pnpm vitest run packages/ohbaby-agent/src/runtime/prompt-scheduler/current-run-inputs.integration.test.ts packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts` |
| 全套测试 | `pnpm test:unit`、`pnpm test:contract`、`pnpm test:integration` |
| 类型与构建 | `pnpm typecheck`、`pnpm build` |
| 手工冒烟 | CLI：`pnpm dev`；Web：`pnpm build` 后经现有 daemon 入口在浏览器走查（`pnpm dev` 只跑 CLI，不含 Web 静态资源，不据此宣称 Web 可见） |

竞态用例用可控 deferred / barrier 与 fake clock，显式卡住关键 await 再触发另一操作，不用 sleep（plan/04 §4.1）。涉及真实 store / 事务的用例写集成，不为集成写全 mock 单元。

## 4.2 用例映射（本批 ID ↔ plan/04 ID）

| ID | 场景 | 类型 | 通过条件 | Stage | plan/04 |
| --- | --- | --- | --- | --- | --- |
| S4-01 | goal run 运行中输入普通消息 | integration | 持久接受后、claim 前完成自动 steer；goal 不暂停 / 不取消；输入在下一 step 被消费；`steer.status = steered` | 1/2 | S1 |
| S4-02 | steer 的轮次与 scope 语义 | integration | 不新建 run、不增 goal 轮、不新增 blocked 审计轮；共享当前 run 的 Todo scope / reasoning / 剩余 step；无独立回答承诺 | 1/2 | S1 / S11 |
| S4-03 | 目标已封口 | integration | `not-steered / target-sealed`；原项保留 queued；promptId、消息与接受顺序不变 | 1 | S2 |
| S4-04 | 目标已关闭或已切换 | integration | 目标解析已发现失效时为 `no-goal-run`，事务阶段发现竞争时为 `target-unavailable`；均保留原项 queued | 1 | S2 |
| S4-05 | steer 存储 / 身份真错 | integration | accept 仍持久成功；`steer.status = error` 且带可重试标记；已接受内容可查询；UI 显示错误而非"已 steer" | 2 | S3 |
| S4-06 | 同 `clientRequestId` 重试 | integration | 不伪报 queued：按记录真实 status / receipt 反映（steered → 原 receipt；starting / running / retained / terminal → `existing` + 真实状态）；不二次 steer、无重复消息 | 1 | S4 |
| S4-07 | A 排队后 B 到达；同毫秒连发 | integration | B `not-steered / earlier-queued`；A、B 的 `accepted_at` + `admission_order` 单调；断言不依赖 prompt_id / UUID | 1 | S5 |
| S4-08 | stop / pause 与 accept 交错 | integration | 先停则不再 steer 进该执行；先接受未处理则进入未消费投影；不自动恢复 goal | 1/2 | S8 |
| S4-09 | 非 user-stop 关闭原因 | contract + integration | completed / failed / interrupted / process-interrupted 下未消费输入都可见（不再只认 user-stop）；来源是会话级列表，不是当前可见消息聚合 | 3 | S9 |
| S4-10 | 跨 run 不覆盖 + 分页 + 重启 | integration | 后续 Stop / 新 run 不清掉更早未消费项；老消息不在当前 viewport（分页 / 压缩 / 重连未加载）时仍在 `unconsumedSteers`；重启后仍可发现（durable 读）；旧 run 仍标 running 时先等待既有 execution recovery 补齐关闭事实，再发布恢复列表；恢复失败不能返回假空列表 | 3 | S9 |
| S4-11 | 本地 attempt 已记、未确认 | contract | `unconsumedSteers[].state = "unconfirmed"`；文案为"处理未确认"；`processedRequestId` 只指本地请求成功落盘，不声称模型已理解或 provider 已收到 | 3 | S10 |
| S4-12 | 显式重发与提示恢复 | contract + integration | 新 prompt / 新 userMessageId，`resendOfPromptId` 关联；同 `operationId` 重试幂等（同一 receipt）；允许再次重发（新 operationId → 新子项）；有效子项（queued / starting / running / steered 且接收 run 未关闭 / 已有成功处理标记）存在时原项不提示；子项关闭且未确认处理时原项或子项提供恢复入口；旧 prompt 与旧消息不被改写 / 重放 | 3 | S9 |
| S4-13 | 完成 / 封口防护与大输入 | integration | 正常完成的 close / seal 防护保留；大 protected input 超限显示失败 + 未处理且可重发；压缩不吞输入 | 2/3 | S12 |
| S4-14 | 手动 steer 入口与传输 | contract | `not-steered` 显示"原项保留"而非失败；真错显示错误（adapter 把本地 `AcceptedSteerError` 映射为 `UiPromptError`）；host / SDK / server JSON-RPC / Web daemon 同批透传新结果类型 | 2/4 | S2 / S3 |
| S4-15 | 迁移兼容 | integration | 应用迁移后旧库数据可正常读取（不是在未迁移库上裸查新列）；新写入后重发关联可查；列可空、无历史回填 | 3 | — |
| S4-16 | accept 落盘后、steer 前崩溃 | integration | 恢复与重试保持原记录 queued、不追溯自动 steer（保守决定）；同 id 重试返回记录真实状态，而非静默重试 steer | 1/2 | S3 / S4 |
| S4-17 | complete / 模型 blocked 已落盘，或 run 内 replace 后，旧 run 仍在收尾 | integration | 生命周期检查拒绝旧执行；新输入保持 queued，执行权释放后按用户优先运行，不强行中断允许收尾的 run | 1/2 | S8 / A6 |
| S4-18 | 队列已满时重试已有 clientRequestId | integration | 去重先于容量检查；复用旧记录真实状态与 receipt，零重复接受、零再次 steer | 1 | S4 |
| S4-19 | 关闭、请求确认、重发接受与重发子项失败 | contract + integration | 无需重连即可更新会话恢复列表与 CLI/Web 标记；rebuild 在原 owner 条目外运行，无死锁；列表不因聊天分页或隐藏 cap 丢项 | 3/4 | S9 / S10 |

### 成功后续处理的补充用例（plan/04 S1、S4）

| ID | 场景 | 类型 | 通过条件 |
| --- | --- | --- | --- |
| S4-20 | 自动和手动成功 steer 的 scheduler 后续处理 | integration + contract | 真实 scheduler + current-run-input store：最终 prompt.updated 为 steered，既有 onSteered 被调用，completion waiter 返回 steered；CLI/Web 队列移除该项，无新 run/轮/notice；投影回调抛错不撤销 durable receipt、不阻断 waiter；无 owner 重入 |
| S4-21 | 同 id 重试恰在 accept 落盘后、自动 steer 提交前 | integration | deferred 卡住分流，重试读取 queued 并注册 completion waiter；释放后 waiter 结算，最终 receipt/status 可查；仅一条输入和一次分流，不改投后继 run，不永久 queued |

落点扩展前批交付的 `adapters/goal-execution.integration.test.ts`（真实 scheduler/store/owner）与本批 SDK/CLI/Web 投影测试；不能只检查裸 store 已写 receipt 就判成功。S4-20/S4-21 随 Stage 1、2 验收，列入整批必过场景。

## 4.3 新增 / 修改测试落点（路径已核对存在）

- `packages/ohbaby-agent/src/runtime/prompt-scheduler/current-run-inputs.integration.test.ts`：顺序判定、结果分型、`listUnconsumedSteers`、崩溃恢复（真实 DB store）。
- `packages/ohbaby-agent/src/runtime/prompt-scheduler/scheduler.unit.test.ts`、`recovery.unit.test.ts`：accept 内分流判定、`resolveSteerTarget` 缺省路径、批内多次 accept 顺序。
- `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`、`ui-persistent.integration.test.ts`：receipt 的 `steer` 字段、会话列表投影、新命令透传。
- `packages/ohbaby-sdk/src/run-inputs.unit.test.ts`、`prompt.contract.test.ts`：helper 替换（会话列表取代 latest-stop 布尔）、命令 / 结果类型。
- `packages/ohbaby-cli/src/tui/app.contract.test.tsx`、`apps/ohbaby-web/src/ui/composer/Composer.unit.test.tsx`：标记与重发入口。

## 4.4 跨批依赖（预期，未实施）

- S6 / S7 与 A1 / A5 / A7 属批 2（门禁、用户优先、压缩等待）；本批组合回归：steer 不破坏"当前轮后用户先跑"，goal 数字沿用 `goal.updated`，会话恢复列表经 `SessionView.rebuild` 与既有会话事件刷新，不新增 notice。
- S12 的 seal / close 防护是既有机制，批 5 不得删除；纳入批 5 回归项。
- 批 2 / 批 3 是本批实施前置（见 [00](./00-discussion.md) §5）：S4-01/02/07 依赖门禁与 `getActiveGoalRunForSteer`；本批不承诺"未接线安全降级为 queued"（现行代码无门禁时会打断 goal）；store 级用例（顺序判定、结果分型、未消费查询、崩溃恢复）可独立先行。

## 4.5 回归清单（不能破坏）

- 一 session 一执行者；权限审批与 sandbox 政策不变。
- 显式 stop 仍可中断；手输普通输入不再打断 goal 由批 2 交付，本批 steer 不改变它。
- 队列容量 `maxQueuedPrompts` 与 CLI/Web 队列列表行为不变。
- `filterModelHistory` / protected inputs 的压缩与缓存行为不变。
- 手动 steer 仍可用；不新增第二套顺序或第二把锁。

## 4.6 验收门

`pnpm test:unit && pnpm test:contract && pnpm test:integration` 与 `pnpm typecheck` 通过；手工冒烟（CLI `pnpm dev`，Web `pnpm build` 后现有入口）可见：未消费 / 处理未确认标记、会话横幅、Resend 入口；有效重发子项存在时原项标记被压制、子项取消后恢复；重启后仍可操作。未跑的真实模型或手工项如实记录。

## 4.7 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
| --- | --- | --- |
| accept 区内重入 owner 串行区 | 只调 store 级 steer；集成测试断言无死锁 | 未来改成公共调用无编译期防护（注释 + 测试兜底） |
| 双重 steer（自动 + 手动） | prompt queued→steered 原子转换；手动入口对已 steered 报 `not-steered / prompt-not-queued` | UI 竞态下文案可能短暂滞后 |
| 越队 | `(accepted_at, admission_order)` 比较 | 低；同毫秒用例覆盖 |
| 未确认被当成已发送 | 投影只表达本地事实（本地请求成功标记） | 无法证明 provider 是否收到（如实文案） |
| 重发重复消费 / 身份复用 | 每次重发新建 prompt + `operationId` 幂等去重；不复用 retained 身份 | 连点产生多个显式子项（均为用户可见动作） |
| 提示丢事实 / 压制错误 | pending 不标记；会话级列表跨 run、重启可读；取消 / 失败子项触发恢复 | 长会话可能有较多待恢复项；本批不靠静默截断隐藏记录，性能问题另据实测决定 |
