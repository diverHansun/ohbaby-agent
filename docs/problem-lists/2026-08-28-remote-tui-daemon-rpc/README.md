# Remote TUI → daemon RPC receiver 丢失

> 状态：**实施与验收已完成，G1–G8 全部通过；详见 05。**
> 日期：2026-08-28
> 代码基线：`8484474`（`main`，已与 `origin/main` 对齐）
> 规划来源分支：本地 `docs/remote-tui-daemon-rpc-plan`，不推送远端

## 1. 一句话结论

`ohbaby --remote-port <port>` 拿到 class 形态的 `RemoteDaemonClient` 后，又经过 CLI 的 in-process fake-RPC。fake-RPC 把实例方法取出来当普通函数调用，丢掉 JavaScript receiver（`this`），所以第一条 `getSnapshot()` 在进入 HTTP 前就报 `Cannot read properties of undefined (reading 'rpc')`。

推荐把修复放在 `ohbaby-sdk/createRPC` 这一处通用调用边界：调用时显式把已连接的 `impl` 作为 receiver。不要给 remote client 手抄方法绑定，也不要让 CLI 按 local/remote 绕开不同边界。

## 2. 范围

### In scope

1. 明确 `.rpc` 错误的真实根因、触发链和受影响用例。
2. 修正 fake-RPC 对 class/object method 的 receiver 语义。
3. 补 SDK 单元、CLI 组合、真实 daemon 集成与 compiled TUI E2E 回归门。
4. 同步 SDK/CLI 架构和 Server 测试文档中的边界语义。

### Out of scope

- 改 daemon JSON-RPC method、HTTP/SSE 信封、auth 或 workspace routing。
- 重写 remote client、改成 arrow method、增加逐方法 facade/bind 清单。
- 删除 remote 路径上的 fake-RPC，或重新设计 local/remote transport 拓扑。
- 处理 daemon 断线重连、后台常驻、LAN/TLS、多用户。
- 扩展 callback API 的 receiver 语义；当前 `subscribeEvents` 由显式 closure 转发，未出现同类故障。

## 3. 文档地图

阅读顺序：README → 00 → 01 → 02 → 03 → 04。实施以 **02 + 04** 为契约。

| 文档 | 作用 |
|---|---|
| [00-discussion.md](./00-discussion.md) | 用户已确认的目标、边界与设计决策 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 根因、完整调用链、测试盲区与 SWE 诊断 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 推荐方案、替代方案、改动面与回滚 |
| [03-reference-projects.md](./03-reference-projects.md) | Kimi Code / deepseek-harness / opencode / pi / claude-code-best / codex 的 receiver 处理方式 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 单元、集成、E2E 与发布门 |
| [05-implementation-acceptance.md](./05-implementation-acceptance.md) | 实际改动、测试证据、SWE 评估与残余风险 |

## 4. 证据摘要

- 真实 compiled TUI E2E：remote TUI 连 daemon 后显示 `.rpc` receiver 错误。
- 最小可执行复现：`createRPC.connectImpl(RemoteDaemonClient)` 后调用 proxy `getSnapshot()`，稳定复现同一 stack。
- 对照实验：以原 client 作为 receiver 调用同一 method，`initializeClient + getSnapshot` 正常完成。
- 现有四个相关测试文件、34 项测试均通过，说明不是代码没有测试，而是测试没有覆盖“CLI fake-RPC 包裹真实 remote client”这个组合缝。

## 5. 实施闸门

02 的推荐方案已经按 04 完成验收：SDK 单点 receiver 修复、CLI/daemon 组合回归、全量自动化门与真实 compiled TUI PTY 均通过。临时分支只保留本地，最终仅合并并推送 `main`。
