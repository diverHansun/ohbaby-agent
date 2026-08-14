# 5. improve-2 实施验收

> 日期：2026-08-14
> 状态：完成；代码、自动化测试、构建、真实进程 E2E、独立代码审查与文档一致性审计均已通过

## 5.1 实际落地

1. CLI 非交互路径使用 `submitPromptAndWait`，按 `UiPromptCompletion` 的四种业务终态决定结果，完成后才释放 client；技术 reject 仍走异常路径。
2. TUI 使用 `submitPromptAccepted`，receipt 到达即结束提交动作；后续状态只从 SDK `UiEvent` 更新，不为每个 Prompt 另建 wait 状态源。
3. Server REST 补齐 `waitForPrompt`、`respondInteraction` 与必选 queue/lease 映射；JSON-RPC 删除旧 `submitPrompt` method，remote `submitPromptAndWait` 只组合 accepted + wait。
4. Web 只保留一个 `BrowserDaemonClient implements UiBackendClient`。`OhbabyWebRuntime` 是 workspace、导航、client 生命周期、session 与 slash 编排 façade，不是第二个业务 client。
5. `runtime.client.getSnapshot()` 异步返回 SDK `UiSnapshot`；`runtime.store.getSnapshot()` 同步返回 Web `StoreSnapshot`。无活动 workspace 时 `runtime.client === null`。
6. 一个活动 workspace 只有一条逻辑 SSE。transport frame 只解包一次；有效 `UiEvent` 先通过 store 的 sequence gate 和投影，再通知 SDK subscribers。
7. 首屏与 resync snapshot 以本地 `snapshot.replaced` barrier 进入同一分发点。SSE incremental 必须严格递增；只有本地权威 barrier 可接受 same-seq，初始 seq=0 也能落地。
8. SDK subscriber 与 store listener 的 observation failure 相互隔离；无效、重复或过期事件不更新 store、不通知 subscriber，也不提前推进 `Last-Event-ID`。
9. SDK 旧 `submitPrompt`、`UiPromptQueueClient`，Server 旧 RPC method、`supportsPromptQueue` fallback，Web `OhbabyWebClient` 和相关兼容 fake/注释已删除。`CoreAPI`/`SDKAPI` 只作为从 SDK 权威能力派生的 RPC seam 保留。
10. Web、Server、CLI 权威文档已改为当前三种 Prompt 能力、SDK client + runtime façade、单 SSE 数据流和当前 REST routes；未落地的 OpenAPI 生成链不再写成现状。
11. Server composition root 必须获得 owner-aware queue execution port；edit、cancel、acquire、renew、release 都在 store/SQL 原子条件中校验认证 client owner，不再先查后写或 feature-detect fallback。
12. Web client 的 close/dispose 能中止尚未完成的注册、snapshot 与 model 请求；旧 workspace 的迟到 resync 不能污染新 store。snapshot barrier 和 buffered event 回放成功后先恢复 live，再刷新 model。
13. catalog cache 失效统一放在事件通过 sequence gate 并成功投影之后，直接事件与 buffered replay 使用同一路径；重复、过期或非法 sequence 不触发失效。
14. REST/JSON-RPC wait 只透传可信 transport abort，不取消已经持久接单的 Prompt；Server dispose 会中止所有悬挂 wait 并关闭 keep-alive 连接。

## 5.2 分阶段提交

| 阶段 | 提交 | 内容 |
|------|------|------|
| improve-2 Phase 1 | `ab19a67` | CLI/TUI 采用明确 Prompt 生命周期 |
| improve-2 Phase 2 | `c4f8204` | Server REST/RPC 采用完整 SDK Prompt 合同 |
| improve-2 Phase 3–5 | `3d8680b` | Web SDK client/façade/单 SSE 收口，并删除旧 Prompt surface |

improve-1 的底层合同、scheduler、interaction owner、command recorder 与审查修复保留在前序提交中；improve-2 没有重建另一套底层语义。

## 5.3 自动化验收证据

| 闸门 | 结果 | 证据 |
|------|------|------|
| 定向失败回归 | 通过 | 7 个文件、149 个测试通过；覆盖 in-process/persistent 四终态、remote CLI、TUI 与 Web reconnect |
| Web 专项 | 通过 | 5 个文件、65 个测试通过；覆盖 client、server adapter、workspace switch、store listener 与 App |
| 全仓 lint | 通过 | 所有 package/app 源码通过 ESLint |
| 全仓 typecheck | 通过 | `tsc -b` 通过；Browser client 直接满足 `UiBackendClient` |
| 全仓测试 | 通过 | 276 个测试文件通过、3 个跳过；2390 个测试通过、13 个外部真实依赖测试跳过 |
| 全量构建 | 通过 | SDK、Agent、Server、CLI、Web 及 CLI 内嵌 Web assets 全部构建成功 |
| 静态删除检查 | 通过 | 生产源码与测试无 `UiPromptQueueClient`、旧 `.submitPrompt(`、`supportsPromptQueue`、`OhbabyWebClient` 或 JSON-RPC `submitPrompt` method |

关键行为覆盖：

- CLI/TUI：andWait/accepted 的 Promise 时机和四终态解释；TUI 明确不调用 wait。
- Server：REST wait 所有权、abort、shutdown、四终态；interaction unknown/越权/重复/并发 claim；认证 owner 覆盖 lease spoof。
- Web：一个 stream 服务多个 subscriber；store-first 顺序；subscriber/listener 隔离；duplicate/old/same-seq source distinction；initial/resync/workspace generation。
- 记录：local agent-host、server-rpc、server-rest 各自在唯一 gateway 记录；组合方法、wait、raw backend 与 skill 内部 Prompt 不重复记录；recorder fail-open。

## 5.4 真实构建产物 E2E

验收直接 import 刚构建的 `packages/ohbaby-server/dist/index.js` 与 `packages/ohbaby-sdk/dist/index.js`，启动随机端口 daemon，使用临时 SQLite、临时 workspace 和内存 fake LLM，再走浏览器实际使用的 REST + SSE：

1. `POST /v1/clients` 注册浏览器 client；
2. 建立一条 `GET /v1/events` fetch-stream；
3. `POST /v1/prompts` 返回 HTTP 202、`clientRequestId`、`promptId`、`sessionId`、`userMessageId`；
4. `GET /v1/prompts/:id/completion` 返回 `succeeded`，`endedAt` 必有且无 `error`；
5. completion 不含回答文本；同一回答在 snapshot 与 SSE 数据流中均可见；
6. server-rest 只输出同一 `operationId` 的 started/completed 两条记录，completed correlation 补充 `promptId`，details 只有长度与布尔元数据；
7. SSE reader、daemon 与临时目录均在结束时关闭或清理。

本次实际输出摘要：receipt HTTP 202、completion `succeeded`、`completionHasAnswer=false`、`snapshotHasAnswer=true`、`sseHasAnswer=true`。

最终修复后又执行了可复现的真实 daemon 子进程回归。测试会监听随机真实端口，使用临时 workspace 与 SQLite，通过 HTTP 和 remote SDK 覆盖 durable receipt、崩溃恢复、`interrupted` completion、`endedAt`、结构化 provider failure 与脱敏：

```bash
pnpm exec vitest run packages/ohbaby-server/src/runtime/daemon/global-single-serve.integration.test.ts \
  -t "recovers queued work but marks active work interrupted after a real daemon crash|keeps provider 429 distinct from local queue-full in a real process"
```

结果：1 个测试文件通过，2 个真实进程 E2E 通过，7 个未选用例跳过。

## 5.5 删除检查边界

历史讨论、迁移规划和归档文档允许提及旧名称，用来解释“为什么删除”；检查对象是生产源码、测试 fake 和当前权威文档。内部函数若只是描述领域动作，也不得复活旧公开 client 方法或旧 RPC method。

## 5.6 独立审查

独立代码审查经历多轮“发现—复现—修复—复审”，最终结论为：Critical 0、Important 0、Minor 0。审查者独立复现了 Web model failure 恢复 live、buffered catalog v1→v2、pending registration 的 lifecycle abort、owner-aware gateway 类型保持等边界；定向 127 个测试、typecheck 与 diff check 均通过。

最终文档一致性审计结论同样为 Critical 0、Important 0、Minor 0；审计者独立复跑全仓测试与真实 daemon 子进程 E2E，并确认 shutdown wait、wrapper 删除、catalog sequence gate、CLI/OpenAPI/REST 权威文档、lease owner 与 workspace generation 均已闭环。
