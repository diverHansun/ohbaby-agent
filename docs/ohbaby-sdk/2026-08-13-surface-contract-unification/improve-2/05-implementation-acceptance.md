# 5. 实施验收文档（improve-2）

> 验收日期：2026-08-15
> 前置：improve-1 底层合同已通过
> 当前结论：**通过**。各 surface 已采用权威合同，旧双轨清零；独立复审结果在 5.8 记录。

## 5.1 最终 surface 采用

| Surface | Prompt 入口 | 原因 |
|---------|-------------|------|
| CLI `run` | `submitPromptAndWait` | 命令进程必须等待终态后再 dispose |
| TUI | `submitPromptAccepted` | 接单后立即清输入，后续状态完全由事件流驱动 |
| Web | `BrowserDaemonClient` 实现 `UiBackendClient` | HTTP/SSE 只是同一 SDK 合同的 transport adapter |
| Web app | `OhbabyWebRuntime` façade | 负责 workspace、导航、连接生命周期和同步 store，不是第二个 client |

生产代码中的旧 `submitPrompt`、`UiPromptQueueClient`、`supportsPromptQueue`、`OhbabyWebClient` 与 JSON-RPC `submitPrompt` 已清零。三个 Prompt 方法没有被强塞进一个无关接口：基本 Prompt 能力与必选的队列编辑/租约能力保持各自边界，最终由生产 `UiBackendClient` 组合。

## 5.2 Web 数据流

```text
OhbabyWebRuntime façade
  -> 一个 BrowserDaemonClient
     -> HTTP query/command
     -> 一个活动 workspace 的逻辑 SSE 订阅
        -> 一次解包 UiEvent
        -> 先更新 store
        -> 再通知 SDK subscribers
```

“一个 SSE”指一个逻辑订阅，不承诺永远只有一条物理 TCP/SSE 连接。断线重连或 workspace 切换可以替换物理连接，但旧连接必须失效，每个已接受事件只分发一次。hello、resync control frame 和坏序列不会伪装成 `UiEvent` 交给 subscriber。

已覆盖的边界包括：

- connect/register 与 dispose 竞争时，dispose 获胜后不得再开启 SSE；
- snapshot resync 失败不丢弃期间 buffer，也不永久停在 `resyncing`；
- model/catalog 刷新失败不污染已提交 snapshot，buffer replay 仍使 catalog cache 失效；
- overlap reconnect 中旧连接的 retention timer 不删除仍在线 client 的 interaction owner；
- subscriber/store listener 抛错只产生固定 `ui.observation.failure` 诊断，不覆盖真实 transport error。

## 5.3 abort 的领域语义与数据流

冻结语义：`abortRun` 只接受明确的 `UiRun.id`；interaction 取消只走 `respondInteraction`。

Web 保留 session-shaped REST，不新增 run-shaped REST：

```text
runtime.abortSession(sessionId, runId?)
  -> façade 从 UiSnapshot 解析/校验 run
  -> Browser transport POST /v1/sessions/:id/abort { runId }
  -> Server 再从权威 snapshot 解析
  -> backend.abortRun(UiRun.id)
```

| 场景 | Web façade | REST |
|------|------------|------|
| run 属于 session 且仍活动 | 调一次 abort | 200，调一次 backend abort |
| run 属于另一个 session | throw | 409 |
| session 无活动 run | success no-op | 200 no-op |
| run 已完成 | success no-op | 200 no-op |
| 合法但未知 runId | success no-op | 200 no-op |
| present 但 null/数字/空白 runId | TS 本地面不适用 | 400，不 abort |

全局 snapshot status 只作为“正向匹配”快捷路径；若它指向另一个 session，必须继续查看目标 `UiRun.status`，因此两个 session 并行运行时仍能中断第二个 run。

## 5.4 interaction 生命周期

interaction 的 owner/claim 由 Server coordination 层管理，认证 clientId 不来自调用方 params。respond 的 claim/consume 是原子状态机；短暂 SSE 重连不清 owner。

client 真正超过 retention 被移除时：

1. `disconnectClient` 返回该 client 未消费的 interaction IDs 并清理路由；
2. Server 直接对 raw backend 发送结构化 cancelled response，reason 为 `client-disconnected`；
3. 清理不经过外部 command gateway，避免伪造一条用户 `server-rest` 操作记录；
4. `INTERACTION_NOT_FOUND` 视为并发终态已获胜，其余错误只诊断、fail-open。

in-process client dispose 会以 `daemon-stopping` settle broker 中的 pending interaction 并发布 `interaction.resolved`。`"timeout"` 是允许的 cancelled reason，但本轮没有虚构一个自动 UI/SDK timer 合同。

命令路由的 `command.result.delivered` 允许同一 `commandRunId` 连续产生多条结果，因此它不是成功终态，不能在首条结果后清 owner。当前 owner 在 `command.failed`、client retention 到期或 runtime reset 时释放；若未来需要让长连接成功命令更早释放，必须先增加明确的 command completion 合同，本轮不靠事件形状猜测终态。

## 5.5 测试与真实 E2E

### 定向回归

本轮收尾分别执行并通过：

- Web/Server 多 session abort、mismatch、completed/no-run/unknown no-op 与非法 REST body；
- in-process dispose settle command interaction；
- Server retention 后取消、overlap reconnect 保 owner，以及真实 in-process backend 的 interaction cleanup；
- Agent/Server recorder fail-open 诊断脱敏；
- TUI 四终态矩阵：Queued UI 消失且不主动调用 wait/andWait。

T8 没有要求四种终态使用四套专属文案；本轮不为“看起来更完整”发明额外 UI 产品语义。

### improve-2 真实服务/远程 E2E

```bash
pnpm exec vitest run \
  tests/integration/cli/daemon-global-fifo.integration.test.ts \
  apps/ohbaby-web/src/api/daemon/server-client.integration.test.ts
```

结果：2 files、6 tests passed。前者启动真实 daemon listener，用两个远程 JSON-RPC client 验证同 session FIFO、abort 后 drain；后者验证 Web façade 经 HTTP/SSE 的接单、事件、双 session abort 与 no-op。

全仓、typecheck、lint、build、资源超时修复轨迹与最终 **276 files / 2420 tests** clean run 见 improve-1 05 的 5.4。两轮共享同一最终工作树，不重复制造不同口径。

## 5.6 规划差异与不过度设计检查

| 议题 | 最终做法 | 判断 |
|------|----------|------|
| Web façade 与 client | 一个 `BrowserDaemonClient` + 一个 runtime façade | 高内聚；没有两个 business client |
| Server recorder | 复用 Agent gateway module | 没有复制记录逻辑 |
| active-run 解析 | Web/Server 边界各保留小 helper，并以同一矩阵测试 | 两处 transport 边界职责不同，不为 DRY 强建共享包 |
| Query/Command 拆分 | 明确接口边界，不新增“只读调用方框架” | 遵循 YAGNI |
| SSE | 一个逻辑流，可替换物理连接 | 准确描述重连现实 |
| `docs/ui` | 标记历史/目标拓扑，只对齐稳定合同与真实快捷键 | 不把本轮扩成 TUI 文档重建 |

## 5.7 完成矩阵

| 验收重点 | 结果 |
|----------|------|
| CLI/TUI/Web 选择正确 Prompt 语义 | 通过 |
| Browser client 实现权威 `UiBackendClient` | 通过 |
| runtime 只做 façade，不形成第二 client | 通过 |
| 一个逻辑 SSE、一次解包、store 先于 subscriber | 通过 |
| wait/respondInteraction Web transport 完整 | 通过 |
| `abortRun(UiRun.id)` 与 interaction cancel 分离 | 通过 |
| session-shaped REST 的 mismatch/no-op 语义 | 通过 |
| client removal/shutdown settle interaction | 通过 |
| 三类外部写入口不重复记录 | 通过 |
| 旧生产符号扫描清零 | 通过 |
| 当前文档不再把历史 Hook/View 当现状 | 通过 |

当前没有已知 Critical 或 Important 残余。

## 5.8 独立复审

第一轮最终代码复审发现 0 Critical、2 Important、2 Minor；文档复审发现 0 Critical、0 Important、3 Minor。两项实现缺口与文档示例/职责表述均已逐项修正；两项 Minor 建议则由扩大回归证明不成立：多结果事件不能当作成功终态，SSE retention 后的直接 resync 也要求保留 client view。

第二轮代码复审发现并关闭 1 个新 Important：不能在 retention 到期时删除 `clientViews`，因为 SSE 自动重连不会重新 initialize，删除会让 resync snapshot 退回全局视图。最终实现保留投影，只清 routing owner，并以协调器单测和真实 daemon retention/resync 测试闭环。

最终只读代码复审结论为 **0 Critical、0 Important、1 Minor**，允许提交与合并；该 Minor 即 5.4 已说明的成功命令 owner 生命周期债务。最终文档复审为 **0 Critical、0 Important、0 substantive Minor**，已同时核对代码、04 矩阵、两份 05、测试数字与文档状态。
