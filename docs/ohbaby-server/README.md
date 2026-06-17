# ohbaby-server 模块设计

> `packages/ohbaby-server` 的模块级设计文档集。本包是 `docs/problem-lists/server/` 规划中"路线 A"的落地——把 `runtime/daemon/` 的传输/协议/协调按职责抽成独立包，承载 web/app（触发条件：web/app 进入开发）。
>
> 规划/决策文档在 `docs/problem-lists/server/`（要不要做、走哪条路）；本目录是模块设计（具体怎么建）。

## 文档导航（按设计顺序）

| 文档 | 职责 |
|------|------|
| [`goals-duty.md`](./goals-duty.md) | 目标 / 职责 / 非职责——边界声明，最重要 |
| [`architecture.md`](./architecture.md) | 端口-适配器 + Hono 装配；包内分层与权衡 |
| [`data-model.md`](./data-model.md) | 核心概念词典（连接/事件信封/缓冲/队列/审批/token） |
| [`dfd-interface.md`](./dfd-interface.md) | 数据流（RPC/事件replay/审批/生命周期）+ 接口语义 |
| [`use-case.md`](./use-case.md) | 6 个用例的编排与失败点 |
| [`non-functional.md`](./non-functional.md) | 质量优先级与刻意暂缓项 |
| [`test.md`](./test.md) | 测试范围、关键场景、契约参数化 |
| [`package-build.md`](./package-build.md) | `packages/ohbaby-server` 的包骨架、构建接线、依赖与发布顺序 |
| [`migration-sequence.md`](./migration-sequence.md) | v0.1.4 的分阶段实施顺序：C1 → server 包 → 测试/真实验证 |
| [`hono-app/`](./hono-app/README.md) | **web/app 适配阶段**：`server.ts`→Hono、REST+SSE、OpenAPI/SDK、SSE replay、多项目 runtime、消费路径统一 |

## 一句话定位

把唯一的 agent backend，通过显式 server 暴露给多前端（CLI/web/未来 app），并把传输/协议/协调连同重协议依赖隔离在 `ohbaby-agent` 之外。默认 CLI 不经过本包。

## 前置实施步骤（不在本包，但必须先做）

**C1：默认 CLI 回 in-process**（在 `ohbaby-cli` / `ohbaby-agent`，见 [`c1-cli-inprocess.md`](./c1-cli-inprocess.md)）。先修地基再抽包，避免把"默认 CLI 强耦合 daemon"的病搬进新包。

## v0.1.4 发布策略

v0.1.4 采用**两阶段、同一 release gate**：

1. C1：默认 CLI 回 in-process，直接删除 `--daemon` / `--in-process` 两个旧 flag。
2. ohbaby-server：建立并迁移显式 server 包；迁移后 `ohbaby serve` / remote client 走 `ohbaby-server`，默认 `ohbaby` 仍不经过该包。

两阶段可以分批 commit、分支开发、分批审查，但不单独发布中间版本。只有 C1、server 包、自动化测试、真实 API key 验证、用户本机验证都通过后，才准备 GitHub/npm v0.1.4 发布。
