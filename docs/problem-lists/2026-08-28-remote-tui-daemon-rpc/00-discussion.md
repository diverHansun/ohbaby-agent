# 0. 讨论记录与已确认要点

> 2026-08-28 根据 cache-hit 批次真实 E2E 发现与本轮用户指令整理。本文只冻结已确认内容；方案建议见 02，尚未确认的决策不会写成既定事实。

## 0.1 背景与动机

在 session cache-hit 批次的远程 TUI E2E 中，TUI 连接真实 daemon 后出现：

```text
Cannot read properties of undefined (reading 'rpc')
```

当时 cache 功能已由 in-process TUI E2E 验收，因此该错误被记录为与 cache 无关的既存 remote 路径问题。用户在 cache 批次合入 `main` 后，要求继续调研此问题、把分析落到 `docs/problem-lists/`，再讨论解决方案。

## 0.2 已确认：目标与范围

| 决策项 | 结论 |
|---|---|
| 用户入口 | `ohbaby --remote-port <port>` 显式连接已启动 daemon 的 TUI |
| 当前阶段 | 调研、规划文档、开发前讨论；不实施生产代码 |
| 成功标准 | remote TUI 能通过既有 `CoreAPI`/`UiBackendClient` seam 完成初始化、收事件和调用方法，不再出现 receiver 错误 |
| 文档落点 | `docs/problem-lists/2026-08-28-remote-tui-daemon-rpc/` |
| 分支规则 | 规划分支只保留本地，不推送远端 |

## 0.3 已确认：边界

| 本批处理 | 本批不处理 |
|---|---|
| fake-RPC → class implementation 的调用语义 | cache/context UI |
| CLI local/remote host 的共同组合缝 | daemon 重连、auto-spawn、TLS/LAN |
| 真实 remote TUI 回归门 | JSON-RPC/REST/SSE 协议重构 |
| 相关架构/测试文档同步 | 为未来 callback 类型预建通用 binding framework |

## 0.4 调研已确认的事实

1. 错误发生在 `packages/ohbaby-server/src/protocols/jsonrpc/client.ts` 的 `RemoteDaemonClient.getSnapshot()` 读取 `this.rpc` 时。
2. 调用尚未进入 `fetch`/HTTP，因此不是 daemon 未启动、端口、auth、workspace 或 wire response 问题。
3. `packages/ohbaby-sdk/src/rpc/proxy.ts` 先从 `impl` 取出 method，再以普通函数形式执行；严格模式下 receiver 为 `undefined`。
4. direct remote client 单测/集成测试会通过，因为 `client.getSnapshot()` 这种属性调用会自动带上 receiver。
5. CLI 的 mock core 全是 `vi.fn`/closure，不依赖 `this`，所以 CLI unit 也无法暴露问题。

## 0.5 用户已确认的决策（2026-08-28）

| 决策 | 结论 |
|---|---|
| 修复层 | SDK `createRPC` 单点保留 receiver；不在 remote client/CLI 做特判 |
| 调用方式 | `Reflect.apply(method, impl, clonedArgs)`；视为现有契约修正而非新抽象 |
| E2E 深度 | 自动化分层测试 + 实施时真实 compiled TUI PTY 验收；不新增长期维护的独立 E2E script |

三项均按 02 推荐方案确认，实施以 02 + 04 为契约。

## 0.6 关键改动清单约定

用户没有要求 02 写符号/行号级“关键改动清单”，因此本规划仅提供按 Phase 和文件/包级改动面，不额外复制一份易漂移的进度表。
