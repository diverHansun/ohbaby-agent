# improve-1 独立最终评审证据

评审时间：2026-09-24 至 2026-09-25（Asia/Taipei）。基线为 `81cd4b00`，评审对象为 `codex/improve-1-implementation` 的未提交工作树（包含新增生产代码与测试）。本记录由 final_review 子代理形成；未修改生产代码、测试、index、branch 或提交。

## 范围与结论

完整对照 [02 方案与改动面](../02-optimization-plan-and-change-scope.md) 和 [04 测试与验收](../04-test-and-acceptance.md)，检查独立 pending/实际 run identity、来源链、同步权威投影与健康状态、客户端绑定、独立 REST/RPC/SSE、共享有界恢复、Web/TUI 的响应生命周期。重点追查同步 observer 重入与异步回调跨请求/范围的竞态。

发现并复现的两个 P2 已由负责代理修复，下述独立复验通过。复验时没有剩余可确认的 P0/P1/P2 代码问题。此结论限于本次代码审查；真实模型、浏览器、PTY、构建及整个交付验收由主代理独立执行，不以本记录替代。

## P2：批量撤销期间可重入回答后续请求（已修复）

位置：`packages/ohbaby-agent/src/permission/manager.ts` 的 `revokeMatching`、`ask`、`respond`、`settle`。

复现：创建同一 child session / run 的两个 edit 请求 p1、p2；在 `onCommitted` 收到 p1 的 revoked 通知时，同步调用 `respond(child, p2, { type: "always" })`；随后调用 `revokeByRun(run, reason)`。修复前 Promise 结果为 `[cancel, always]`，重入回复 accepted，并写入该 child 的 edit allow 规则。RunManager 的 cancel 路径先撤销后 abort，因此不能用 AbortSignal 已终止来排除这条路径。

修复：批量撤销全程持有同步 scope guard；ask 在规则/evaluator 快路径之前拒绝该范围，respond 和 settle 同样阻断非撤销决议，finally 释放 scope。嵌套撤销保留外层 guard；不相关 root/run 的正常回答不受影响。

独立复验：相同只读 tsx 脚本返回 `[cancel, cancel]`、重入结果 revoked、session rules 为空；生命周期测试 37 项通过。负责代理另补充 revokeByRun/session/clear/dispose、重入 ask、其他 run 的 always 自动批准、嵌套 guard 和投影失败隔离控制。

## P2：旧 TUI 回复失败污染新请求（已修复）

位置：`packages/ohbaby-cli/src/tui/dialogs/permission-dialog.tsx` 的异步回复完成/失败回调。

复现：使用 React + ink-testing-library 渲染 ready 请求 A，按 Enter，保留未完成的 respondPermission；用同一组件实例改为 B，再使 A 以 `PERMISSION_NOT_PENDING` 和文本 `STALE A ERROR` 失败。修复前 B 显示 A 的错误并触发一次 resync；同一路径也能清除 B 的 pending 状态。

修复：每个 request id、epoch、root、bindingGeneration 组合拥有不可复用的对象 token；回调同时验证 token 与 mounted，pending 使用同步 ref 防连按。A→B→A 不能重新使第一次 A 的回调有效。

独立复验：相同只读脚本中 B 无旧错误，resync 次数为 0；permission-dialog 测试 5 项通过，包含换 epoch 与 A→B→A 场景。

## 其他修复复验

主代理实际启动默认 TUI 时发现新 `subscribePermissionEvents` 被通用 RPC proxy 当成可序列化 RPC 调用，引发 `JSON.parse(undefined)`。core 代理将其加入本地 callback 方法集合，并在没有外部 callbacks 实现时绑定已连接 implementation 的方法；同时覆盖 getPermissionSnapshot 的嵌套 AbortSignal。独立检查 proxy 代码并运行 10 项 proxy 测试通过。本问题由主代理发现，不计入上述两个独立发现。

## 独立自动化验证

均在仓库根目录运行，无并发 build：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/adapters/app-events/permission-projection.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/permission-source.unit.test.ts packages/ohbaby-sdk/src/permission-sync.unit.test.ts packages/ohbaby-server/src/coordination/permission-lifecycle.integration.test.ts
```

2026-09-24 23:47:32 开始：4 files、56 tests 通过（10 + 21 + 18 + 7），1.63 秒。

```sh
pnpm exec vitest run packages/ohbaby-sdk/src/rpc/proxy.unit.test.ts packages/ohbaby-agent/src/permission/permission-lifecycle.unit.test.ts packages/ohbaby-cli/src/tui/dialogs/permission-dialog.unit.test.tsx
```

2026-09-24 23:51:54 开始：3 files、52 tests 通过（10 + 37 + 5），424 毫秒。合计独立执行 108 项；不把其他代理报告的测试数并入此合计。

## 既有 runtime running 竞态：确认机制，未扩范围修复

主代理在真实浏览器发现：后台 child 审批结束后数据库 root/child 均已成功，但页面仍显示 Running / Stop；刷新后 idle。只读 RPC 查询同一隔离 daemon 的 getSnapshot 返回 idle、目标 root run 已结束且 permissions 为空。此观察发生在较早构建，不能单凭页面现象断言 improve-1 回归。

受控脚本从基线与当前 `ui-inprocess.ts` 分别提取实际 `updateActiveRunStatus` / `reconcileRuntimeStatus` 代码，在内存转译执行。以延迟的 readSnapshot barrier 暂停 reconcile；其已捕获 activeRunId 后模拟 run 完成并清除 active id、标记 idle；再释放旧 snapshot。基线和当前均可随后发布 `run.updated: running`、`runtime.updated: running`，留下过期 running 投影。基线的 permission projection 也会在 child Replied 时调用 reconcile，因此该竞态不由本轮独立审批引入。

结论：确认旧 reconcile 的异步发布缺少运行代际保护；未证明它就是该次真实浏览器序列的唯一原因。依用户接受的后续 improve-1.1 边界记录，不增加本轮实现范围。复现与本记录均不保存认证凭证、模型密钥或完整敏感日志。

## 活跃模块文档一致性

本代理按主代理授权更新 `docs/ohbaby-server` 与 `docs/ohbaby-web` 的活跃文档，保留历史 improve 文档原状：

- server goals/architecture/data-model/DFD/use-case/test 与 hono-app 协议文档：移除发起 client 独占审批和断连撤销的旧描述；写明 workspace/root 过滤、客户端 bindingGeneration、独立 snapshot/event、轻量元数据入口及稳定错误。
- Web goals/architecture/data-model/DFD/use-case/test 与 UI 文档：独立 PermissionSyncState，ordinary seq/replay 不覆盖审批；hello 前不可回答；共享有界恢复；同根多页、非首项选择、来源标签、实际来源 session 的 always、无 Cancel run。
- permission-button 四份活跃规格移除旧四按钮模型和“权限模型零改动”约束，保留已有专用颜色/尺寸/hover；兼容 abort CSS 不代表公开选项。
- `docs/permission` 由 core 代理负责；SDK/TUI/scheduler 文档由主代理负责。本记录不声称代替他们的文档复核。

文档使用 `prettier --ignore-path /dev/null --write` 格式化，并通过对应 `--check` 与 `git diff --check`。仓库默认 `.prettierignore` 排除 Markdown，因此此处显式绕过该忽略规则，仅处理本代理授权编辑的文档。

## 最后增量审查：Web metadata guard

只读审查 `BrowserDaemonClient` constructor 新增的 `validatedPermissionScope` 与对应 Web/TUI 异常 child 测试；本次未运行测试或 build，以免与主代理最终全套验证并发。未发现新增可确认的 P0/P1/P2。

- query 直接用共享恢复器的 AbortSignal 读取轻量 `getSessionIndex`，不等待聊天历史、model 或全页 store；null root 在共享引擎中保持 idle，不发查询。
- 验证缓存绑定 epoch/root/bindingGeneration；换 root、换 epoch 或 A→B→A 后重新验证。旧 metadata Promise 即使迟到，也只能覆盖缓存 key、导致后续额外验证；共享引擎的 ticket 与绑定校验仍阻止旧结果发布到当前审批状态。
- 正常新建会话的服务端路径先等待 backend 创建完成，再更新客户端 binding 并发 hello；新 root 的 metadata 可在基线查询前读到。原有待历史的 root 切换用例仍与该流程一致。
- metadata 中缺失或标记为 child 的选择不进入审批 baseline 查询，保持不可回答，并提示返回主会话；新增测试在 history 一直未完成时覆盖此行为。

此增量审查不增加独立执行的 108 项测试计数，也不声称替代主代理正在运行的最终验证。
