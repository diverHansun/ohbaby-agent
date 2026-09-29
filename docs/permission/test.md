# permission 模块 test.md

本篇说明当前模块应保持的行为回归。跨层发布门和实际客户端验收见 [执行可靠性 improve-1 验收标准](../problem-lists/2026-09-19-execution-reliability/improve-1/04-test-and-acceptance.md)；本文不替代运行记录或声称所有手动场景已通过。

## 一、模块测试范围

| 行为         | 核心断言                                                                             |
| ------------ | ------------------------------------------------------------------------------------ |
| 请求身份     | run/session/call/message/source/signal 必需；来源字段冻结，审批 ID 与 callId 独立    |
| 独立 pending | 同一或不同会话的多条请求都立即登记；可先回答非首项，不需要前一条结束                 |
| 一次决议     | 双回答、回答与撤销竞争、通知重入只能完成一次 Promise 和规则副作用                    |
| 来源规则     | always 只写真实来源 session，可自动结算同 session 已登记且匹配的可记忆请求           |
| 快速路径     | 既有合法规则和 Full Access 直接返回，不发 pending requested/resolved、不推进投影版本 |
| 生命周期     | signal abort、run 终态、来源链失效、clearSession 和 dispose 都结束正确范围的等待     |
| 故障隔离     | 关键提交失败冻结可信 root；普通通知失败不改变合法决议                                |
| 近期终态     | 有界保存最小身份，安全重复/撤销可区分；淘汰后返回 not-pending                        |
| 求值与模式   | deny 优先，default 敏感请求不可记忆，Full Access 不发新人工审批且不写 always 规则    |

UI 渲染、server 认证和独立恢复属于对应 adapter/SDK/server/client 测试，不通过 mock manager 冒充跨层验收。审批不新增墙钟超时，执行期限由运行生命周期验证。

## 二、关键场景

### 请求和响应

1. 首次 ask 登记独立 ID、真实来源和 abort listener，先提交 requested 再通知；Promise 保持等待。
2. 连续登记 A/B，直接回答 B：B 结束、A 保持 pending；每个请求都有自己的 requested 与唯一 resolved。
3. 同一 callId 顺序触发两次审批：第二次使用新 permissionId，第一次回答不能代答第二次。
4. once 不写规则；reject 只拒绝目标请求；suggest 保留非空建议。
5. cancel、未知 choice、不可记忆 always、扩大的 pattern 不认领 pending，不写规则。
6. 两个入口同时合法回答同一 ID，只有一个 accepted；安全重复为 already-resolved；已撤销为 revoked；未知或终态淘汰为 not-pending。

### always 和求值

1. always 静默写规则，关键提交和终态记录完成前观察者不可重入。
2. 自动结算同来源 session 中已经 pending、匹配且可记忆的请求，每条再次检查 signal、最新策略和健康并提交独立终态。
3. root、兄弟 session、不同 pattern 或不可记忆请求不被联动批准。
4. 命中已有 allow 规则的新调用不产生审批转移；规则变化自身也不推进 pending revision。
5. default 下敏感路径即使有 allow 仍需一次确认；Full Access 下敏感/显式 MCP/外部目录等新请求直接放行，已有 deny 仍拒绝，工具自身保护继续生效。
6. Full Access 切换影响后续准入，不自动回答旧 pending，不创建或扩散会话规则。

### 取消和清理

1. 登记前已 aborted 不创建条目；登记后的 abort 拆 listener 并完成等待；批准后执行仍检查 signal。
2. 取消先赢则迟到 always 不写规则；always 先赢后取消不撤回已合法规则。
3. 结束同 session 的 run A 只撤销 A，run B 和其他 run 不受影响。
4. 来源、root 或中间祖先删除撤销经过该节点的请求；不能将其迁移到另一 root。
5. clearSession 清目标规则并撤销来源链请求；dispose 完成全部等待，之后不能新登记。
6. 批量撤销的通知回调重入回答或 ask，不能让正在清理的范围重新放行。
7. 页面关闭、断线或历史读取失败不等于 run 终态，不撤销有效 pending。

### 关键提交与通知

1. requested/resolved 的同步投影与 manager 转移处于同一调用栈，无 await 或普通观察者插入。
2. 关键提交抛错时，即使投影与通知同时失败，也必须结束受影响等待、拆 listener，查询报告 unavailable 而非正常空集合。
3. 已写入合法规则不因后续通知失败回滚；RuleAdded/Replied 失败不重复执行工具或规则副作用。
4. 严重 ID/来源一致性冲突冻结可信 root，其他 root 继续工作；普通非法请求不能触发全局冻结。
5. 专用投递最后一条 resolved 失败后立即失效该订阅/连接，不等待下一条增量才发现；重同步读取权威基线。

## 三、测试位置和运行方式

| 位置                                                                                  | 主要职责                                      |
| ------------------------------------------------------------------------------------- | --------------------------------------------- |
| `packages/ohbaby-agent/src/permission/permission.unit.test.ts`                        | ask/respond、规则、模式和兼容行为             |
| `packages/ohbaby-agent/src/permission/permission-lifecycle.unit.test.ts`              | 独立 pending、身份、竞争、撤销、故障与终态    |
| `packages/ohbaby-agent/src/permission/{classifier,evaluator,rule,state}.unit.test.ts` | 分类、求值、规则和状态                        |
| `packages/ohbaby-agent/src/adapters/app-events/permission-projection.unit.test.ts`    | 原子版本投影、来源一致性和通知隔离            |
| `packages/ohbaby-agent/src/adapters/ui-runtime/permission-source.unit.test.ts`        | 可信来源解析、父链与取消                      |
| `tests/integration/agents/permission-run-lifecycle.integration.test.ts`               | 真实 scheduler / 主子生命周期与 run 身份      |
| `tests/integration/agents/inprocess-child-permission.integration.test.ts`             | 实际 in-process 根审批、子执行与双响应        |
| `packages/ohbaby-agent/src/host/core-api-permission.integration.test.ts`              | 实际默认 host 加本地 RPC 的订阅与独立查询边界 |

```bash
pnpm exec vitest run packages/ohbaby-agent/src/permission
pnpm exec vitest run packages/ohbaby-agent/src/adapters/app-events/permission-projection.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/permission-source.unit.test.ts
pnpm exec vitest run tests/integration/agents/permission-run-lifecycle.integration.test.ts tests/integration/agents/inprocess-child-permission.integration.test.ts packages/ohbaby-agent/src/host/core-api-permission.integration.test.ts
```

测试 fixture 显式提供执行 ID 与调用 controller，不为生产缺失身份添加兜底。故障注入聚焦行为：一个请求是否执行一次、等待是否结束、其他范围是否保留，而不是只断言 Map 内部操作。

## 四、客户端协作验证

实际 Web/TUI 验证必须能看到来源、选择非首项、拒绝单条并确认其他请求仍可回答。聊天历史/model 挂起或失败时，审批仍可通过轻量根元数据、独立快照和专用事件恢复。断线、切范围和同步失败立即停用按钮；旧 epoch/generation 的快照、事件和应答回调不能修改新范围。审批卡不提供 Cancel run。默认 TUI 保持本进程入口，不能以仅测试 in-process adapter 替代实际 host/RPC/编译产物接线验证。
