# 4. 测试与验收标准

> 仓库没有统一的项目级 `test-blueprint.md`，但已有事实约定：root Vitest，源码旁 `*.unit.test.ts` / `*.contract.test.ts` / `*.integration.test.ts` / `*.smoke.test.ts`。本轮沿用现状，不另建测试制度。

## 4.1 测试范围

| 类型 | 本轮职责 |
|------|----------|
| Typecheck / contract | SDK 完成类型、Query/Command 能力、remote/in-process 公开合同 |
| Unit | completion mapper、scheduler waiter、record builder、脱敏、fail-open helper |
| Integration | in-process/persistent/remote Prompt 生命周期，Server/Agent 记录唯一性 |
| Smoke / CLI 回归 | 旧兼容入口在 improve-1 期间仍能完成，不提前退出 |
| 人工检查 | 结构化日志可读且无 Prompt/密钥；不作为唯一验收依据 |

不以覆盖率百分比为目标。重点验证 Promise resolve 时机、业务终态、竞态、敏感数据与重复记录。

## 4.2 Prompt 数据与生命周期

| ID | 场景 | 类型 | 验证点 | 对应 Phase |
|----|------|------|--------|------------|
| T1 | succeeded completion | contract | status=succeeded、endedAt 必有、error 不可有 | 1 |
| T2 | failed completion | contract | status=failed、结构化 error 必有 | 1 |
| T3 | cancelled completion | contract | status=cancelled、error 不可有 | 1 |
| T4 | interrupted completion | contract | status=interrupted、结构化 error 必有 | 1 |
| T5 | 非终态伪装 completion | unit/type | queued/starting/running 无法构造；运行时 mapper 拒绝 | 1 |
| T6 | accepted 时机 | integration | receipt 在 Prompt 完成前返回，含稳定 clientRequestId/promptId | 2 |
| T7 | wait 成功与四种终态 | integration | 全部 resolve `UiPromptCompletion`，不因业务终态 reject | 2 |
| T8 | 未知 prompt | unit/integration | 明确 reject，不挂起 | 2 |
| T9 | submit-and-wait 组合 | unit/integration | 只调用一次 accepted，再按 receipt.promptId wait | 2 |
| T10 | 完整回答不进入 completion | contract | completion 无 messages/answer/snapshot 字段，内容仍走事件/快照 | 1–2 |

## 4.3 等待、关闭与恢复竞态

| ID | 场景 | 类型 | 验证点 | 对应 Phase |
|----|------|------|--------|------------|
| T11 | 完成发生在 store.get 竞态期间 | unit | waiter 仍 resolve 一次，无漏信号 | 2 |
| T12 | scheduler close 时存在 waiter | unit | waiter 以 closed 技术错误 reject，集合清空 | 2 |
| T13 | close 与 completion 同时发生 | unit | 只 settle 一次，无未处理 rejection | 2 |
| T14 | AbortSignal 中止等待 | unit | 只移除该 waiter；Prompt 状态和其他 waiter 不变 | 2 |
| T15 | daemon 重启恢复 | integration | running 记录恢复 interrupted；重连后同 promptId wait 得到 completion | 2 |
| T15a | close 后新 wait | unit | 立即以 closed 技术错误 reject，不登记 waiter | 2 |
| T15b | 第一次终态持久化失败 | unit | 不伪装成业务 failed；scheduler fault，全部 waiter 以存储技术错误 reject，停止 drain | 2 |
| T15c | executor 失败后 failed 持久化也失败 | unit | scheduler fault；后续 wait/accept 立即 reject，无吞错悬空；诊断有界 | 2 |
| T15d | finish/close/abort 竞态 | unit | 每个 waiter 只 settle 一次，集合和 active lane 最终清理 | 2 |
| T15e | fake-RPC wait abort | contract | 嵌套 options.signal 不被 JSON clone；调用方 reject 且 backend waiter 清理，Prompt 不取消 | 2 |
| T15f | fake-RPC andWait abort | contract | accepted 可完成，signal 只中止组合中的 wait；无泄漏 waiter/未处理 rejection | 2 |

## 4.4 接口与兼容

| ID | 场景 | 类型 | 验证点 | 对应 Phase |
|----|------|------|--------|------------|
| T16 | Query 能力 | type/contract | 不暴露写方法；包含 waitForPrompt 与 subscribeEvents | 2 |
| T17 | Command 能力 | type/contract | 包含 Prompt 和必选 queue 管理；不含 getSnapshot | 2 |
| T18 | 完整 backend | contract | in-process、persistent、remote 均满足同一 UiBackendClient | 2 |
| T19 | `CoreAPI`/`SDKAPI` 派生 | typecheck | SDK 方法变化会同步影响派生类型，不再手抄漂移 | 2 |
| T20 | 旧 submit 兼容 | integration/smoke | improve-1 期间旧 CLI/TUI 不提前退出，旧失败行为仍保持 | 2/5 |
| T20a | queue identity | contract | 公开 queue command input 无 ownerClientId；Agent/REST/RPC gateway 从可信 client context 注入 | 2/4 |

## 4.5 ID 与命令记录

| ID | 场景 | 类型 | 验证点 | 对应 Phase |
|----|------|------|--------|------------|
| T21 | operationId 生命周期 | unit | 一次原子写的 started/completed 共用同一个 operationId | 3 |
| T22 | ID 不混用 | contract | transportRequestId、clientRequestId、promptId 等保留各字段 | 3 |
| T23 | returned | unit | 正常返回记 completed/returned，原结果引用/值不变 | 3 |
| T24 | threw | unit | 业务调用抛错记 completed/threw，向调用方重抛原错误 | 3 |
| T25 | Prompt 业务 failed | unit | 方法 resolve completion 时记录 returned，而不是 threw | 3 |
| T26 | recorder 同步 throw | unit | 命令继续，诊断一次，不递归记录 | 3 |
| T27 | recorder 拒绝接收 | unit | 命令继续，诊断一次且不递归 | 3 |
| T28 | Prompt details | adversarial unit | 正文不出现；只允许长度、是否显式 session 等白名单字段 | 3 |
| T29 | model/search details | adversarial unit | apiKey、token、env 实际值不出现 | 3 |
| T30 | 错误摘要 | adversarial unit | stack、HTTP body、疑似 secret 不记录 | 3 |
| T30a | 慢/不完成 sink | unit | recorder 同步接收后业务立即继续；内部缓冲有界、顺序为 started→completed | 3 |
| T30b | observation 依赖抛错 | unit | details、clock/ID、诊断回调异常均不改业务结果，无递归/未处理异常 | 3 |

## 4.6 记录所有权集成

| ID | 场景 | 类型 | 验证点 | 对应 Phase |
|----|------|------|--------|------------|
| T31 | TUI/CLI in-process 写 | integration | agent-host 仅两条记录，raw backend 无额外记录 | 4 |
| T32 | Web REST 写 | integration | server-rest 仅两条记录，returned 记录可补 receipt 关联 | 4 |
| T33 | JSON-RPC 写 | integration | server-rpc 两条记录含 request.id 作为 transportRequestId | 4 |
| T34 | submitPromptAndWait | integration | 只记录 submitPromptAccepted；wait 和组合方法不重复记录 | 4 |
| T35 | executeCommand 内部再写 | integration | 只记录外部 executeCommand；skill 命令注入的 `submitPrompt` 走 raw backend，不得再产生 `submitPromptAccepted` 记录 | 4 |
| T36 | recorder 生产故障 | integration | REST/RPC/in-process 业务结果与无 recorder 时一致 | 4 |
| T37 | RPC interaction ownership | adversarial integration | requested 建 owner；未知/跨 client/重复/并发 response 拒绝且无 backend 调用、无 started record | 4 |
| T38 | interaction owner 清理 | integration | resolved/abort/timeout/client removal/shutdown 清理；短暂重连不误清理 | 4 |
| T39 | interaction 条件回滚 | race integration | 非法响应保持 pending；仅“未消费且仍 pending”可凭 claim token 回滚 | 4 |
| T40 | interaction terminal 竞态 | race integration | resolved/abort/timeout 与失败回滚只有一个获胜；backend 已消费或状态未知时不能二次响应 | 4 |

## 4.7 集成边界与建议落点

- SDK：扩充 `packages/ohbaby-sdk/src/*contract.test.ts`，必要时新增 `command-record.unit.test.ts`。
- Scheduler：扩充 `packages/ohbaby-agent/src/runtime/prompt-scheduler/scheduler.unit.test.ts`。
- In-process：扩充 `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`。
- Persistent：扩充 `packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts`。
- JSON-RPC：扩充 `packages/ohbaby-server/src/protocols/jsonrpc/{protocol,client}.unit.test.ts` 与 server integration。
- REST：扩充 `packages/ohbaby-server/src/app/create-app.unit.test.ts`，用内存 recorder 断言记录数和内容。
- CLI 兼容：沿用 `packages/ohbaby-cli/src/cli/commands/run.ts` 相关集成与 `tests/integration/cli/*`。

## 4.8 回归清单

1. Prompt FIFO、每 session lane 和幂等冲突行为不变。
2. Web HTTP 202 receipt 不等待模型完成。
3. 非交互 CLI 不在 Agent 完成前 dispose。
4. TUI 在 improve-1 仍能通过旧 Promise 看到最终错误；improve-2 才迁移为事件终态。
5. permission/interaction 路由 ID 不被 operationId 替代。
6. Server auth、workspace scope 和 client ownership 检查在记录/执行之前生效；Prompt/permission 沿用现有规则，interaction 在本轮补齐共享 owner/claim。未授权请求不得生成“已开始业务写”的误导记录。
7. prompt database recovery 不自动重跑已经 interrupted 的执行。
8. remote queue lease 的 owner 始终来自已认证 client；伪造 ownerClientId 不能获取、续期或释放他人租约。

## 4.9 发布门

| 门 | 标准 | 命令/证据 |
|----|------|-----------|
| G1 类型 | 全仓新旧兼容面 typecheck 通过 | `pnpm run typecheck` |
| G2 SDK/Scheduler | 单元与 contract 通过 | `pnpm run test:unit && pnpm run test:contract` |
| G3 跨包 | Prompt 与 recorder integration 通过 | `pnpm run test:integration` |
| G4 全回归 | 无不相关测试回退 | `pnpm test` |
| G5 构建 | 所有 package/app 可构建 | `pnpm run build` |
| G6 安全 | adversarial fixture 中无正文/API key/stack 泄露 | T28–T30 自动化断言 |
| G7 去重 | 三种入口每次均恰好一对记录 | T31–T35 自动化计数 |
| G8 文档 | goals-duty/architecture/data-model 与新合同一致 | 文档 grep + 人工语义检查 |

不要求 `test:smoke:real` 访问真实模型作为本轮发布门；若运行，只作为补充证据，不得暴露密钥。

## 4.10 对抗性审查

| 攻击面 | 防御 | 残余风险 |
|--------|------|----------|
| 把 Prompt failed 当成方法 threw | discriminated completion + T25 | 新命令需继续区分业务结果和调用错误 |
| close/completion 竞态造成悬空或双 settle | waiter 幂等移除 + T11–T14 | 未来换 scheduler 实现需复跑契约套件 |
| Server 与 Agent 双记 | 所有权矩阵 + 真实链路计数 | 新入口若绕过 gateway 仍可能漏记，需类型/测试约束 |
| 通用 details 泄露 secret | 默认无 details + typed whitelist + T28–T30 | 自由文本 error message 仍需持续审查 |
| recorder fail-open 静默失效 | 有界诊断回调/指标 | 非合规审计无法保证零丢失，文档必须明确 |
| operationId 被误当业务实体 ID | 字段分离与 contract tests | 外部日志查询工具需理解 correlation 结构 |
