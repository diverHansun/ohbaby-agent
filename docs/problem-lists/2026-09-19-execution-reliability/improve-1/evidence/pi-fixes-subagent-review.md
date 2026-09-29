# Pi P1/P2 修复独立复审

时间：2026-09-25 00:43–00:46（Asia/Taipei）。评审基线 `81cd4b00`，对象为 `codex/improve-1-implementation` 未提交工作树中 Pi 反馈后的最终修复。只读检查生产代码；唯一新增文件是本证据。未运行 build，未操作 index/branch/commit。

## 结论

本次审查没有新增可确认的 P0/P1/P2。相同 ready 绑定重复确认不再消耗查询预算；远程 `/new`、`/resume` 保留命令结果事件并更新实际客户端绑定，之后独立审批查询与回答成立。结论依据如下源码检查、60 项定向测试和一次真实 loopback HTTP/SSE 脚本，不替代主代理的最终全量测试和真实模型浏览器验收。

## P1：重复绑定确认与恢复预算

检查 `packages/ohbaby-sdk/src/permission-sync.ts` 的 begin/resync/query：

- connectionGeneration、epoch、root、bindingGeneration 全部相同且已 ready 时，begin 直接返回，保留 requests/revision/attempts，不重新查询或暂时降为 syncing。
- 同一绑定正在查询或等重试时，已有 controller/retryTimer 合并触发。error/unavailable 不因重复 hello、receipt 或 resync 重置预算。
- 真实新连接或新 binding 才进入 begin 的新周期；显式 Retry 是另一条允许重置入口。revision gap 的再次查询仍累计到原周期上限。
- server 的 RPC 入口比较操作前后 bindingGeneration，仅改变绑定时发送 hello；普通同 scope prompt receipt 不再无条件重发 hello。

自动化涵盖连续 8 次相同 ready begin 仍只查询一次、后续增量仍可应用，以及 gap/repeated hello/resync 达到 4 次上限后不会继续查询，显式 Retry 才开始新周期。

## P2：远程 /new、/resume 的轻量选择与事件合同

检查 `packages/ohbaby-server/src/protocols/jsonrpc/rpc-route.ts` executeCommand、`coordination/client-view.ts`、`app/create-app.ts` 的 broadcast/notifyBinding，以及 `protocols/jsonrpc/client.ts` hello/query/respond 路径：

- `/new` 等待 backend.createSession，核对异步前后的客户端绑定，再只更新发起客户端选择；`/resume` 通过独立 session index 校验和 selectPermissionSession 更新绑定。两者都不调用全量 getSnapshot 或 backend.executeCommand。
- 保留 command.started、结构化 output、session.selected action；失败保留 command.failed。command owner 路由只向发起客户端投递，不影响其他客户端选择。
- 已显式改变 bindingGeneration 后，command action 的旧 command generation 不会再次推进绑定；RPC 操作完成时的变化检查发送携带新 epoch/root/generation 的 hello。
- RemoteDaemonClient 接收 hello 后更新 permissionBinding，并向共享恢复器发送带 connectionGeneration 的 resync-required；后续 query 与 respond 携带新绑定。恢复依赖实际 SSE 确认，不把命令 HTTP 返回本身当作审批 ready。
- 支持 resume 的位置参数、`--session_id`、`--session-id` 和等号写法；无有效参数或不存在的 session 产生失败事件并保持原绑定。

## 独立定向测试

```sh
pnpm exec vitest run packages/ohbaby-sdk/src/permission-sync.unit.test.ts packages/ohbaby-server/src/runtime/daemon/client.integration.test.ts packages/ohbaby-server/src/coordination/client-view.unit.test.ts
```

2026-09-25 00:43:30 开始，3 files / 60 tests 全通过：SDK recovery 19、client-view 18、Remote client integration 23。耗时 4.00 秒。没有 build。

## 真实 Remote transport 查询与回答验证

用 `node --import tsx --input-type=module` 从 stdin 执行脚本，直接导入当前源码的 createDaemonHttpServer、createRemoteUiBackendClient 和 createPermissionSync。启动临时 loopback 随机端口 daemon，建立客户端 A、B；领域 backend 为内存 fixture，getSnapshot 固定抛出 history unavailable。fixture 按 root 返回一个待审批项，回答时发出真实经过 server 路由的 permission.resolved。

顺序：

1. A 安装普通与审批订阅；审批 hello 驱动 source createPermissionSync.begin。
2. A 执行 `/new`，等待新 root ready，核对 getSelectedSessionId、requests 和 attempts=1，再 allow_once 并等待 resolved 移除。
3. A 执行 `/resume --session-id root`，对恢复后的 root 重复查询、回答和 resolved 核对。
4. 核对 B 没收到任何 command 事件；A 收到两次 session.selected。finally 释放订阅、同步器、两客户端和 server。

实际输出：

```json
{
  "result": "PASS",
  "realRemoteCommands": ["new", "resume"],
  "queries": 2,
  "replies": 2,
  "historyCalls": 0,
  "otherClientCommandEvents": 0,
  "budgetAttempts": 1
}
```

这验证真实 HTTP/SSE/RPC 适配与共享恢复器组合，不声称使用了真实模型或真实工具执行。无文件写入型工具调用、认证凭证或环境密钥进入证据。

文档经 `prettier --ignore-path /dev/null` 格式化与检查，并通过 `git diff --check`。
