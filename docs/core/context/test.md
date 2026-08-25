# Context 模块：测试策略

本文定义 Context 的长期测试职责。improve-4～5 联合回归的完整 ID、故障矩阵和发布门见 [04-test-and-acceptance.md](./improve-4-to-5-regression/04-test-and-acceptance.md)。

## 一、测试回答什么

1. 测量和 Provider 是否消费同一 `PreparedModelRequest`？
2. mask/prune/summary/retry/restart 后模型可见 history 是否唯一、tool pairing 是否合法？
3. primary、child/sibling scope 是否隔离？
4. 部分写、并发、abort 和 hard crash 后 durable truth 是否可恢复？
5. 同 run/epoch 的 system、runtime、tools 前缀是否稳定？
6. summary 请求自身超窗时能否有界缩小，而不是无限失败？
7. Context event 是否属于正确 scope/attempt，且不会冒充 durable truth？

## 二、分层职责

| 层 | 典型对象 | 目标 |
|---|---|---|
| unit | compaction policy、cut point、projection、usage、serializer、reference reducer | 快速验证纯逻辑和边界 |
| contract | `PreparedModelRequest`、Context event、Message atomic/idempotent port、Provider cache usage | 防止消费者可见语义漂移 |
| integration | Context + MessageStore + Lifecycle + ToolScheduler/MCP + Bus | 验证真实数据流、并发和重建 |
| smoke/e2e | build、serve/Web、真实 Provider | 验证发布产物和外部 capability |
| property/fault/soak | 上述层的运行方式 | 扩大动作组合、故障点和序列长度 |

E2E 不替代 unit/contract/fault；real-provider skip 不等于 pass。

## 三、关键不变量

- measured `{ messages, tools }` 与 adapter 实际输入深等价。
- `PreparedModelRequest` 创建后不可被 MCP load、permission change、retry 或调用方 mutation 改写。
- `ContextUsage` 使用 input budget；`ratio >= 0.95` 或 `remaining < 4096` 触发 summary rung，`remaining === 4096` 仅靠 floor 不触发。
- cache read/write/uncached 是 inclusive input breakdown，不改变窗口占用总量。
- summary 与被替代原文不同时 active；失败不声称成功。
- 同 initiating message 的 runtime part 基数不超过 1，包括并发/多 manager/restart。
- 同 scope compaction/prompt mutation 串行，提交前 revision recheck；异 scope 可并发。
- restart 后 canonical model view 与 deterministic repair 等价；恢复零 LLM、零历史 event。
- primary/subagent 的 history、calibration、mask、thrash、tool epoch、cache identity 和 event 不串。

## 四、重点场景

### 4.1 Request

- ordinary primary/subagent step；
- final-step `tailDirectives` 只出现一次且 tools=`[]`；
- overflow → force prepare → retry 发送新 request；
- prepare 后 lazy MCP/permission change 不改当前 request，只改下一 request；
- active reasoning/tool loop 不修改已发送 prefix。

### 4.2 Budget ladder

| 输入 | 预期 |
|---|---|
| ratio `0.94999`、remaining `>=4096` | 不进入 summary |
| ratio `0.95` | `prune-summary` |
| ratio `<0.95`、remaining `4096` | 不因 floor 进入 summary |
| ratio `<0.95`、remaining `4095` | `prune-summary` |
| ratio `>=0.50` 且未进 summary | `mask` |
| `force=true` | `force`，不受 thrash lock 拦截 |

### 4.3 Compaction/failure

- summary 非 overflow 失败、inflated、stream abort；
- summary request context overflow 后按完整 turn/API round 严格缩小，清前导 orphan tool result，有 max/abort；
- create summary、append part、第 N 个 compacted update、prune 第 N 个 update、commit 后 event 前故障；
- hard SIGKILL 等待 marker 精确内容，不只等待文件存在；
- auto+auto、manual+auto、manual+manual、manual+prompt；
- primary 与 child 同时 compact；
- repeated compaction 不重复展开旧 summary。

### 4.4 Scope/event/replay

- primary 缺省 scope 只归一为 primary；child 带精确 scope；
- sibling event 交错可按 session/scope/attempt 唯一分组；
- accepted attempt 的 progress/terminal 共用 ID 且 terminal 恰好一次；
- event publish/subscriber 失败不回滚 durable commit；
- reopen 不重发 event、不调用 summary LLM。

### 4.5 Memory/prefix/cache

- global/project `OHBABY.md` 路径边界、失败降级、run 内稳定；
- subagent 不加载 Memory；
- runtime metadata 不进入 UI/summary/title/export；
- 同 tool epoch wire order 稳定，有意 epoch 变化只失效一次后重新稳定；
- cache key 基于 session + scope，tool epoch 不写入 key；
- Provider usage 的 observed zero 与 unavailable 区分。

## 五、测试支撑件

| Fixture | 作用 |
|---|---|
| deterministic `TokenCounter` | 构造精确预算/cut point |
| scripted `ContextLLMClient` | summary success/failure/inflation/overflow/abort |
| request-capturing Provider | 对比 measured/sent wire input |
| failpoint Message adapter | 在 durable boundary 第 N 次失败 |
| store conformance suite | 同一契约跑 in-memory/SQLite |
| barrier/latch | 控制 snapshot/MCP/compact/tool 时序 |
| fail-on-resume client | 恢复期调用 LLM 立即失败 |
| fake clock | 验证 metadata/event/lease，不使用 sleep |
| canonical model-view serializer | live/restart 可稳定 diff |

fixture 必须实现真实 typed port；禁止万能 mock、test-only production getter 或预置 `usageAfter` 自证成功。

## 六、测试组织

- co-located unit/contract：`packages/ohbaby-agent/src/core/context/*.unit.test.ts`、`*.contract.test.ts`；
- Context serializer/store integration：同源码目录的 `*.integration.test.ts`；
- 跨模块集成：`tests/integration/core/`；
- 外部 gate：`*.real.test.ts`、`scripts/run-real-cache-smoke.mjs`、compiled Web runner。

真实故障必须以问题形状命名，不使用 `case1`。属性失败必须输出 seed、shrunk trace、session/scope、expected/actual canonical diff。

## 七、执行门禁

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run test:contract
pnpm run test:integration
pnpm run test:smoke
pnpm run build
```

联合回归新增入口实施后应包括：

```text
test:context:regression
test:context:property
test:context:restart
test:context:soak
test:context:eval
```

这些脚本不存在时不得在验收报告中宣称已运行。

## 八、防假绿规则

- 不只断言“不抛错”或 `toBeTruthy()`。
- 不在同一 manager/store 对象里模拟 restart。
- 不用 wall-clock `sleep()` 制造竞态。
- 不自动 retry flaky 测试后报绿。
- 不把 real-provider skip 写成 pass。
- 不只测 primary 后宣称 subagent 覆盖。
- 不只比较 cache key 字符串而忽略 Provider-relevant prefix。
- 不用不同 model/tools/tail directives 的 usage 比较证明压缩成功。

## 九、验收关系

本文件描述长期模块规则；联合回归的可执行 ID 与最终门以 `improve-4-to-5-regression/04-test-and-acceptance.md` 为准。实施完成后实际证据、偏差和剩余风险写入同目录的 `05-implementation-acceptance.md`，不得回写本文件伪造测试进度。
