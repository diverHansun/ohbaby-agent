# 1. 问题基线与当前实施状态

## 1.1 问题陈述

当前默认 composition 把内部 command observation 当作进程输出：

1. slash command 进入 command gateway；
2. gateway 构造 started/completed `UiCommandRecord`；
3. 默认 structured recorder 将 JSON 直接写入 stdout；
4. observation 失败又可能经 composition reporter 写入 stderr；
5. recorder 队列异步排空，dispose 时还可能 flush 尾部记录。

在 TUI 中，这些写操作绕过 Ink 的帧控制；在 `ohbaby serve` 中，它们落到 daemon 启动终端。因此截图中的 JSON 不是项目“不知从哪里来的 log”，而是代码显式写入的 command record。

## 1.2 根因列表

| ID | 根因 | 用户可见后果 |
| --- | --- | --- |
| P1 | structured recorder 缺 sink 时默认写 `process.stdout` | 原始 record JSON 混入 TUI 或 daemon 终端 |
| P2 | Agent/Server 在非 test 环境自动创建 structured recorder | 隐式 I/O 成为生产默认主路径 |
| P3 | `NODE_ENV=test` 自动切 no-op | 测试默认行为与生产相反，Bug 被隐藏 |
| P4 | Agent/Server 各自硬编码 observation failure 到 stderr | 即使移除 stdout，错误路径仍可污染终端 |
| P5 | 默认 composition 持有 recorder 并在 dispose flush | UI 关闭或切换时仍可能出现 late record |
| P6 | 无自动化门保护 recorder 不再直写 process streams | 同类回归只能依赖人工 review |
| P7 | 单元测试只验证 recorder 数据语义，没有验证真实 production 进程 surface | 组件通过但用户体验失败 |

## 1.3 SDK command record 合同现状

`packages/ohbaby-sdk/src/command-record.ts` 定义：

- `UiCommandRecord` 与 started/completed phase；
- correlation、details、operationId 与 outcome；
- 只有 `record(entry): void` 的 `UiCommandRecorder` 端口。

`packages/ohbaby-sdk/src/command-record.ts` 的 `executeRecordedUiCommand()` 与 `packages/ohbaby-agent/src/host/ui-command-gateway.ts` 共同负责：

- 为写命令生成同 operationId 的 started/completed；
- 注入 correlation 与经过约束的 details；
- 将 record 提交给注入的 recorder；
- recorder 抛错时 fail-open，并通过可选 SDK diagnostic seam 通知调用方。

这些合同与 Bug 无冲突。问题不在 record 是否该生成，而在默认 composition 给 recorder 选择了用户终端作为目的地。

## 1.4 structured recorder 现状

`packages/ohbaby-agent/src/host/command-recorder.ts` 当前同时承担两类职责：

- 正当职责：有界队列、FIFO、异步 sink、失败隔离、flush；
- 越界职责：未传 sink 时默认 stdout、未传 diagnostic 时默认 stderr。

这使一个看似纯粹的队列构造函数隐含了全局 I/O。调用者不需要做任何决定，就会修改进程终端；这违反信息隐藏与显式依赖。

该 factory 由 `packages/ohbaby-agent/src/index.ts` 公开导出。把 sink 改为必填属于有意的 API 收紧，需要在发布说明中明确；即使仓库内暂时没有默认生产调用方，也不应为了“制造调用方”而接入 debug 分支。

## 1.5 Agent host composition 现状

`packages/ohbaby-agent/src/host/core-api-factory.ts` 当前 resolver 顺序是：

1. `commandRecorder === false` → 本地 no-op；
2. 显式 recorder → 原样使用；
3. `NODE_ENV === "test"` → 本地 no-op；
4. 其他环境 → 无参创建 structured recorder。

随后 composition：

- 给 gateway 注入一个直接写 stderr 的 observation diagnostic；
- 保存 structured recorder 句柄；
- 在 host dispose 时 flush。

因此 production 默认既会即时输出，也可能在 dispose 尾部输出；测试却通常走完全不同路径。

## 1.6 TUI 现状

TUI 与 Agent backend 在同一 Node.js 进程。Ink 只能协调 React/Ink 自己的渲染输出，无法吸收 backend 对 `process.stdout.write` / `process.stderr.write` 的旁路写入。

所以从 TUI 组件做 JSON 过滤无法修复根因：record 根本没有进入 React 树。正确修复点是 composition 与 recorder 边界。

## 1.7 Server composition 现状

`packages/ohbaby-server/src/app/create-app.ts` 复制了与 Agent 几乎相同的策略：

- test 默认 no-op，其他环境自动 structured recorder；
- command gateway diagnostic 硬编码 stderr；
- app dispose flush 默认 recorder。

Server 还存在另一条 `reportInteractionCleanupFailure()` stderr 输出。它是不同语义的 cleanup failure，不是 command observation，本批不修改。这也说明不能在整个 `server/app/**` 宽泛禁止所有 process stream。

## 1.8 仓库已有 `OHBABY_DEBUG` 范式

`title-generator.ts` 与 `token-usage.ts` 对它们自己的降级诊断采用“默认静默，显式 `OHBABY_DEBUG` 才写 stderr”。这证明仓库已认识到无条件 stderr 会破坏 TUI 帧。

但它不自动推出 command record 应复用该变量：command record 是连续、结构化且可能高频的数据流，和一条失败诊断的产品语义不同；用户本批也明确不建设 debug/log 出口。因此本事实只作为边界证据，不转化为实现需求。

## 1.9 测试现状与盲区

现有测试覆盖了：

- structured recorder 的顺序、有界队列、sink/diagnostic 失败隔离；
- Agent 与 Server 显式 recorder 的 command record 合同；
- gateway 的 correlation、details、operationId、redaction 与 fail-open。

关键盲区是：

1. Vitest 默认处于 `NODE_ENV=test`，自动 no-op 避开了生产分支；
2. 默认 sink/diagnostic 被当作功能测试，而不是错误边界；
3. 没有子进程以 `NODE_ENV=production` 执行真实 host composition 并捕获 stdout/stderr；
4. 没有自动化规则阻止低层 recorder 再次直写 process stream；
5. 没有明确测试“未传 recorder”和 `false` 在所有环境一致 no-op；
6. 没有把 dispose 后的 late output 纳入 surface 验收。

“默认静默”是一个否定命题，不能只靠一个内存 spy 和微任务等待证明。需要三层证据：

- unit：structured factory 无 sink fail-fast，sink 失败默认静默；
- composition：Agent/Server 在 production env 下默认 no-op，显式注入仍工作；
- process：真实子进程执行 command + dispose，父进程捕获 stream。

## 1.10 改动影响面

| 模块 | 预期变化 |
| --- | --- |
| SDK record/gateway | 行为不变，不新增 no-op 或 options |
| Agent structured recorder | sink 必填；默认 diagnostic 静默；禁止直接 process I/O |
| Agent host | undefined/false → 本地 no-op；删除 env 分叉、terminal reporter、默认 flush |
| TUI | 无需渲染层补丁；从根因上恢复完整 Ink 输出所有权 |
| Server | 与 Agent 同形；保留无关 cleanup reporter |
| Tests | 增加 unit/composition/process/E2E 证据 |
| Docs | 同步 SDK、UI、Server 默认行为与生命周期合同 |

## 1.11 SWE 原则审视

- **单一职责**：队列 recorder 不应同时决定终端策略。
- **DIP**：I/O 目的地由显式集成者注入。
- **KISS**：两个本地 no-op 比新增 SDK 公共 singleton 更小、更易删除。
- **YAGNI**：不加没有调用方的 diagnostic option，不增加 debug 产品路径。
- **显式生命周期**：谁创建带队列的 recorder，谁负责 flush/dispose。
- **测试真实性**：production 子进程是覆盖本 Bug 的必要证据，不能由 `NODE_ENV=test` 单元测试替代。

## 1.12 与既有文档关系

本批保留 2026-08-13 command record 的数据和 gateway 合同，只 supersede “默认 production composition 自动把 record 输出到终端”的策略。实现完成后，权威文档必须明确：默认 no-op、显式注入、低层零隐式 I/O、调用方生命周期所有权。
