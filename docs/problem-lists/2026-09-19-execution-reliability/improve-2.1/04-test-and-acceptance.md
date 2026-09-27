# 4. 测试与验收合同

> 本文定义本轮唯一验收 ID。当前是规划，不是通过报告。沿用仓库 [docs-test](../../../../docs-test/README.md)；Web 模块[测试视角](../../../ohbaby-web/improve-3/03-test-criteria.md)只映射这些 ID，不复制另一套标准。

## 4.1 类型、位置与真实边界

纯选择规则/hook/局部组件 unit、单 adapter contract 与源码同目录；跨 server/backend/SDK/SQLite 的新增生命周期测试位于 `tests/integration/web/`；编译客户端用例进入既有 compiled Web runner。保留已有 colocated 跨包回归文件，避免同时改动所有历史组织。源码提取阶段先运行原 App 测试，稳定后另批迁移测试；只改 import/共享 fixture 不删行为断言。

单元可用 fake clock 和受控 Promise；集成使用实际 server/coordinator/adapter/SQLite，仅替换 LLM/外网。网络断开测试需实际关闭 SSE reader/连接，并确认服务器已观察到最后一条关闭；直接调用 coordinator.disconnectClient 不足以验证保留期。浏览器 offline 仿真不能单独证明既有 SSE 已断。

## 4.2 唯一验收矩阵

| ID | 场景 / 验证点 | 层级与执行落点 | Stage |
| --- | --- | --- | --- |
| T01 | 标明 HEAD 与未提交输入；代码/依赖/配置未被意外覆盖，原测试建立基线 | git diff、当前 App/API tests | S0/S5 |
| T02 | 当前空 B 连续 New、切已用 A 后 New、刷新后在 5s 内 New 均复用 B；DB root 数不增 | 扩展现有 new-session-regression.integration.test.ts + 新增 tests/integration/web/new-session-lifecycle.integration.test.ts；编译浏览器 | S0/S1/S5 |
| T03 | 同 client 两 SSE 仅关一条仍占用；全关立即释放空候选但保留路由 timer；同 ID 重连取消旧 timer且保留绑定；复用后重连允许共享，不抢回 | 实际 server 生命周期 + 可控 timer；检查 binding/路由/审批一次生效 | S1 |
| T04 | 只注册未建 SSE：初始宽限内占用、到期释放；JSONRPC-only 客户端持续请求刷新宽限且空会话不被抢；HTTP 请求同理；到期按既有 owner 合同清理 knownClientIds/interaction；在途 create/select/submit pin 不被 timer 删除，结算后释放；旧 timer 不覆盖重连或新请求 | server+backend，fake clock/受控请求与准入闸门；不能 sleep 猜时序 | S1 |
| T05 | 各入口×默认/明确复用/禁止复用的 ID 与 current/created 输出正确；`rpc-route.ts` 不再硬编码 created，`commands/builtin.ts` 的 current/created 与实际复用一致；无选项创建兼容旧结果，`UiSessionIndexEntry` 与 index 持久态无 created；REST/RPC透传，in-process无daemon | commands/service、ui-inprocess contract、JSONRPC client/route、REST contract及index持久化断言 | S1 |
| T06 | 零 part 消息、所有 prompt 终态、run、child、归档、其他项目、活动提交均不误复用；读失败不新建；候选确认与提交竞争；直接 in-process 提交也受权威空检查/准入保护 | 权威 store + SQLite + 受控 Promise 卡住 backend 准入，不靠 sleep | S1 |
| T07 | 并发入口同 scope/策略合并；不同 flag 不合并；其他 client 抢占；忽略 exclude 的 backend 有界失败；旧响应不改新绑定 | server/common operation 与 browser runtime 集成；计次数、终止、ID和DB数 | S1 |
| T08 | 同 scope ready 不重置；syncing 不反复重启；error可恢复；权限独立；旧workspace/epoch响应丢弃 | browser client+store；session sync banner unit | S1/S3 |
| T09 | 草稿隔离、刷新恢复、IME、双 Esc、迟到拒绝不覆盖新稿、receipt/SSE乱序无双行；queued edit失败/续租/切页不串 | 保留 App 行为测试 + composer/session局部测试 | S2/S3 |
| T10 | history加载保留滚动锚点；tool call/result与稳定key；thinking正文后消失；Total一次；todo过滤保持；TodoDock仍在Composer顶部且不进入消息滚动容器 | conversation tests + 原 improve-2 执行进度用例 | S2/S3 |
| T11 | slash键盘/补全/错误留稿、单一keydown链每键至多一次发送/Stop、IME优先、迟到清空/skills回填不覆盖新scope或新编辑revision、connect/compact/goal的操作及迟到结果、目录打开/切换/归档 | Composer/commands/workspace组件 + App接线测试；保留原键盘顺序断言 | S2/S3 |
| T12 | 多审批可选择非首项、full-access确认焦点与降级；Stop RPC-first/terminal-first/断线/切scope/10s提示不回退 | permissions/session + App行为测试 | S2/S3 |
| T13 | 两类机械拆文件后：一个活动workspace一个client/逻辑SSE，多subscriber不增连接；切换/退出清理，旧请求隔离 | 既有 workspace-switch/session-recovery/permission-recovery/client integration | S2/S3 |
| T14 | CSS原有规则顺序、选择器、声明保持；同viewport截图与计算样式核对；focus、窄屏、长消息、reduced-motion | 构建CSS规范化规则序列比较 + 编译浏览器 | S4 |
| T15 | 测试迁移有旧场景→新位置映射，完整关键断言保留；仅分层不删失败场景；新UI模块实际被装配 | test清单与实际全套运行 | S4/S5 |
| T16 | 真实 compiled serve下完整刷新复现；默认TUI `/new`/force-new与空画布不退化；不混入远程attach | 隔离配置/DB/进程 + 浏览器/PTY | S1/S5 |
| T17 | 无新循环依赖和反向feature import；shared有实际消费者；无万能controller；完整测试、lint/typecheck/build及独立审查 | 静态import图/已有lint规则+人工边界审查+实际命令 | S2–S5 |

## 4.3 能对原 bug 变红的端到端流程

1. 使用隔离 profile、workspace、SQLite 和 fixture 模型启动本次编译的 serve，不操作用户真实会话。初始空视图不能平白创建会话。
2. 建立有持久消息的 A，点击 New 得空 B；记录 B ID 与 DB root 数 N。
3. 每次等待 POST 返回后再点 New，重复至少六次；ID均B、数量N，排除仅靠请求合并掩盖重复创建。
4. 切 A 后 New 返回 B。刷新 B 页面，等待新客户端完成注册/连接，切 A 后立即 New；在旧 client 5s清理期结束前断言仍B、数量N。
5. 快速重复刷新/切 A/New，记录每次clientId、sessionId、请求时序与DB数；不能只看侧栏标题。
6. 并行控制旧client的submit准入、双SSE和重连，验证T03/T04/T06。独立网络集成覆盖精确窗口，浏览器覆盖真实用户入口；两者不能互相冒充。
7. 实施修复前至少让刷新用例失败一次，修复后同一判据通过；保留失败原因与最终证据。停止本次自有进程，保留用户数据。

## 4.4 执行入口

实施者须按实际新文件维护路径。现有可用入口：

```sh
pnpm exec vitest run apps/ohbaby-web/src
pnpm exec vitest run packages/ohbaby-server/src/coordination packages/ohbaby-server/src/protocols/jsonrpc
pnpm exec vitest run apps/ohbaby-web/src/api/daemon/new-session-regression.integration.test.ts
pnpm exec vitest run
pnpm run lint
pnpm run typecheck
pnpm build
pnpm run test:e2e:compiled-web
```

新增生命周期测试后显式运行 `pnpm exec vitest run tests/integration/web/new-session-lifecycle.integration.test.ts`，该路径为计划新增，不冒充现有文件。compiled runner需补接本轮浏览器场景和DB判据；现有runner退出成功并不自动证明T02/T16。CSS规范化忽略构建哈希/空白，不忽略cascade层、媒体条件、声明或规则顺序。

本轮没有改变LLM协议，不为目录移动强制重跑付费模型请求；受控模型足以验证接线。若实施实际改变模型边界，必须重新评估范围并补相关真实请求验证，不能默默扩大本轮。

## 4.5 通过门与对抗性审查

最终在一个明确工作树/提交状态上跑完整测试，不把旧轮4646通过当成本轮证据；跳过项、平台、失败重跑如实记录。分开记录源代码测试、实际编译Web、默认TUI的结果。New session修复与结构重构均须独立子代理审查；本轮05只在实际验收时写入。

最需对抗的路径是：刚断线但仍在提交的空候选；旧generation/旧timer回写；force-new被合并为reuse；同scope error被短路；组件移动触发卸载导致草稿/Stop归属丢失；CSS顺序改变焦点与按钮状态。防御分别对应T03–T14。跨进程SQLite共享下的会话独占不是本轮新增保证，不能把单server准入保护宣传为分布式锁。
