# 5. 实施验收文档（improve-1）

> 验收日期：2026-08-15
> 验收对象：规划提交 `a06f603` 之后的 improve-1 实现，以及基线 `e9d5c7d` 之上的收尾补强
> 当前结论：**通过**。合同、数据流、记录所有权和故障语义均有实现与自动化证据；独立复审结果在 5.7 记录。

## 5.1 本轮最终合同

### Prompt 数据结构与三种能力

| 能力 | resolve | reject |
|------|---------|--------|
| `submitPromptAccepted` | backend 完成持久接单后返回 `UiPromptReceipt` | 接单校验、权限、传输或存储失败 |
| `waitForPrompt` | 返回严格终态的 `UiPromptCompletion` | 查询、权限、传输、存储或等待中止 |
| `submitPromptAndWait` | 与 `waitForPrompt` 相同 | 与上述两步相同 |

`submitPromptAndWait` 的唯一实现是 `submitPromptAccepted + waitForPrompt`。它不是第三条执行路径；`signal` 只传给 wait，已经接单的 Prompt 不回滚。

`UiPromptCompletion` 继续作为公开完成结果，满足以下不变量：

- 只允许 `succeeded`、`failed`、`cancelled`、`interrupted` 四种终态；
- `endedAt` 必须存在；
- `failed`、`interrupted` 必须带结构化 error；
- `succeeded`、`cancelled` 不带 error；
- 四种业务终态都 resolve，不把业务失败伪装成普通异常；
- Completion 不承载完整回答内容，回答仍由 message/event 数据流提供。

### Scheduler 数据流

```text
accept -> store.accept（线性化点）-> receipt
                                -> FIFO execute
                                -> store.finish(terminal)
wait(promptId) -------------------------------> completion
```

- `store.accept` 成功后，即使 close/fault 紧接发生，调用方仍得到 receipt，不产生“已入库但调用方以为失败”的幽灵 Prompt。
- close/fault 会 settle 当前 waiter；未来 wait 也得到同一关闭或故障结果。
- wait 的 `AbortSignal` 只移除该 waiter，不取消 Prompt，也不影响其他 waiter。
- completion、wait abort、close 三方竞争只允许一个结算者获胜。

### 命令记录数据流

```text
具名原子写方法
  -> Agent host gateway 或 Server REST/RPC gateway（唯一所有者）
     -> UiCommandRecord.started
     -> raw backend
     -> UiCommandRecord.completed
```

- `operationId` 表示一次后端原子写操作；现有领域 ID 各司其职，通过 `correlation` 汇总。
- 记录合同是 `UiCommandRecord`，只记录 `started/completed`；`submitPromptAndWait` 这类组合方法不重复记账。
- `details` 按方法白名单脱敏，默认不保存原始 params、Prompt 文本或密钥。
- started/completed 各自 fail-open，并复用同一 `operationId`；诊断不回显 sink 提供的敏感 error name。
- SDK 定义记录合同、recorder 端口、方法级脱敏 builder 和无 I/O 的 best-effort 包装能力；Agent/Server 提供实际 recorder/sink。`UiCommandRecord` 不是 HTTP/JSON-RPC 传输信封。

## 5.2 规划与实际差异

| 差异 | 最终选择 | 判断 |
|------|----------|------|
| runtime mapper 位于 Agent 而非 SDK | SDK 保持纯合同，Agent 映射运行时状态 | 可接受，避免 SDK 依赖运行时知识 |
| Server 没有复制 recorder gateway | 复用 Agent 导出的 `createUiCommandGateway` | 优于复制，保持一个记录实现 |
| improve-1 中 `CoreAPI` 仍出现手列方法 | improve-2 再收成从权威接口派生的 `Omit` | 符合两轮依赖顺序 |
| 未拆“只读调用方”专用 façade | 只拆接口边界，不为拆分本身加框架 | 符合 YAGNI |

未越界建设公开 `Op`、审计数据库、全事件 `operationId`、完整 params 留存或新的 transport。

## 5.3 审查发现与关闭轨迹

早期独立审查曾发现以下可复现缺口，均在进入最终验收前关闭：

1. scheduler 在 durable accept 后 close/fault 可能拒绝 receipt；现以 `store.accept` 成功为线性化点并补竞态测试。
2. scheduler close、fault、completion 与 waiter abort 的结算证据过弱；现拆成三个明确 winner 测试，并覆盖 executor failure + terminal persist failure 后的 future accept/wait。
3. Server 的 lease 能力曾允许 feature-detect fallback，owner 校验不原子；现 composition root 要求 owner-aware port，store/SQL 按 lease 与 owner 原子校验。
4. JSON-RPC wait 的 HTTP abort 曾未传到 backend waiter；现只把可信 transport signal 传给 wait，且 server shutdown 也能中止 waiter。
5. skill 内部复用公开 gateway 曾可能二次记录；现只注入 raw `submitPromptAndWaitInternal`。
6. fail-open 诊断曾回显 recorder 自定义 error name；现只输出固定错误分类。
7. Prompt 已启动后若队列持久化 running 状态失败，曾只停 projection 而未等待真实 run 终止；现补偿会取消运行树并等待该 `UiRun` 进入 `cancelled`，原始存储错误仍作为技术失败 reject。

## 5.4 自动化与真实进程证据

### 定向合同测试

最终收尾命令：

```bash
pnpm exec vitest run \
  packages/ohbaby-agent/src/runtime/prompt-scheduler/scheduler.unit.test.ts \
  packages/ohbaby-server/src/protocols/jsonrpc/client.unit.test.ts \
  packages/ohbaby-server/src/app/create-app.unit.test.ts \
  apps/ohbaby-web/src/api/daemon/server-client.integration.test.ts
```

结果：4 files、114 tests passed。它覆盖 persist-fault 后续入口、andWait 只中止 wait、unknown run no-op、多 session run 解析和 REST 非法输入。

### 全仓与静态检查

- `pnpm run typecheck`：通过。
- `pnpm run lint`：通过。
- `pnpm run build`：5 个 workspace package/app 构建通过。
- 首次 `pnpm exec vitest run --passWithNoTests`：274 files passed、3 skipped、2 个资源超时失败；2415 tests passed、13 skipped。失败分别是 child serve 10s 启动超时与 packaging 内部 build 120s 超时；两个失败用例串行隔离复验均通过。
- 第二次全仓只剩 packaging build 120s 超时；第三次在 packaging 通过后暴露 TUI `connectModel` 轮询 1s 的高负载超时，隔离复验通过。
- 测试基础设施只延长失败判定窗口：packaging 子进程 build 120s → 180s（整体测试仍为 240s）；`waitForConnectModelCount` 1s → 5s。没有跳过测试、减少断言或修改产品 debounce。
- 最终 `pnpm exec vitest run --passWithNoTests`：**276 files passed、3 skipped；2420 tests passed、13 skipped**，单次 clean run 通过。此前失败轨迹仍保留在本文，而不是被最终绿灯覆盖。

### improve-1 真实进程 E2E

```bash
pnpm exec vitest run \
  packages/ohbaby-server/src/runtime/daemon/global-single-serve.integration.test.ts \
  -t "recovers queued work but marks active work interrupted after a real daemon crash|preserves queued work across a graceful daemon stop and resumes it after restart"
```

结果：真实子进程 crash recovery 与 graceful restart 两条均通过（2 passed、7 skipped）。验证 durable queue、active interrupted、queued resume，而非只验证 fake store。

## 5.5 关键验收项

| 验收重点 | 结果 |
|----------|------|
| Completion 严格四终态与条件 error | 通过 |
| 三种 Prompt 方法且 andWait 只组合 | 通过 |
| scheduler close/fault 不悬挂 waiter | 通过 |
| durable accept 不产生幽灵 Prompt | 通过 |
| completion/abort/close 只 settle 一次 | 通过 |
| wait abort 不取消 Prompt | 通过 |
| owner-aware lease 原子校验 | 通过 |
| REST/RPC/Agent host 三入口唯一记录 | 通过 |
| skill 内部调用不双记 | 通过 |
| details 脱敏与 recorder fail-open | 通过 |
| Prompt 启动握手失败不遗留后台 run | 通过 |
| 真实 daemon crash/graceful 恢复 | 通过 |

## 5.6 SWE 评估

本轮增加的是语义边界和可验证性，不是新的抽象层：保留具名业务方法；记录层只做统一命名、关联和脱敏；组合方法不重复执行或记录；Server 复用 gateway 而非复制。Web/Server 只在各自 façade 边界保留少量领域解析，没有为了两处调用引入跨包策略框架。

当前没有已知 Critical 或 Important 残余。全仓首次运行的两个资源超时已隔离复验通过，但仍作为 CI 运行预算信号保留，不宣称它们从未发生。

## 5.7 独立复审

第一轮最终复审发现 0 Critical、2 Important、2 Minor。两项 Important（启动握手失败遗留 run、默认 recorder 诊断回显自定义 error name）均以先失败后通过的回归测试关闭。两项 Minor 经扩大回归证明都不能按原建议处理：`command.result.delivered` 可重复出现，并非成功终态；SSE retention 后会直接 resync 而不重新 initialize，故必须保留 `clientViews` 投影，只清 interaction/command/run owner。

第二轮代码复审进一步发现删除 retained `clientViews` 会破坏 SSE 自动重连后的 snapshot 投影隔离；该改动已撤回，并补协调器与真实 daemon 的 retention/resync 正向测试。最终只读代码复审结论为 **0 Critical、0 Important、1 Minor**，允许提交与合并。唯一 Minor 是成功命令缺少显式 `command.completed`，owner 会保留到客户端路由清理；提前清理会破坏多结果语义，已作为后续合同债务公开记录。

最终文档复审为 **0 Critical、0 Important、0 substantive Minor**；其唯一流程性 Minor 是本段曾为待回填占位，现已关闭。复审已核对代码、04 矩阵、本 05 证据与最终 **276 files / 2420 tests** clean run。
