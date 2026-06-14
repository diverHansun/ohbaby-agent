# server：Web/App 通信层规划

> 在已完成的 `terminal-daemon`（Phase 1-4）基础上，规划 daemon/server 通信层如何适配本机 web 端、（未来）app 端与多前端并发。
> 领域核心架构见 [`docs/agents/architecture.md`](../../agents/architecture.md)；多终端/daemon 的来龙去脉见 [`../terminal-daemon/`](../terminal-daemon/)。

## 文档导航

| 文档 | 职责 |
|------|------|
| [`01-current-state-and-problems.md`](./01-current-state-and-problems.md) | Phase-4 后 daemon/server 层逐文件现状 + 面向 web/app 的问题清单（精确到 file:line） |
| [`02-goals.md`](./02-goals.md) | 目标、非功能需求、YAGNI 红线（明确不做什么） |
| [`03-reference-designs.md`](./03-reference-designs.md) | 四个优秀项目的真实借鉴点（相对路径 + 构造名 + 借鉴说明），被 04/05 引用 |
| [`04-route-a-new-package.md`](./04-route-a-new-package.md) | **路线 A**：抽 `ohbaby-server` 新包的完整方案（架构改动 + 文件迁移 + 适配 web/app/ACP/A2A） |
| [`05-route-b-in-place.md`](./05-route-b-in-place.md) | **路线 B**：不新增包、就地在 `runtime/daemon/` 优化（最小可适配本机 web 端） |

## 两条路线一句话对比

| 维度 | 路线 A（新包 ohbaby-server） | 路线 B（就地优化） |
|------|------|------|
| 抽包 | 新建 `packages/ohbaby-server` | 不抽包，改 `runtime/daemon/` |
| 目标 | 一次到位，承载 web/app/ACP/A2A | 先让本机 web 端可行 |
| 工作量 | 大（迁移 ~16 文件 + 新分层） | 小（3 个能力就地加） |
| 何时该选 | 引入第一个重协议 SDK / 第二个协议适配器成为真需求时 | 现在；本机 web 是近期唯一真实需求 |
| 风险 | 大迁移（Windows 深路径）、测试面广 | 低，纯增量 |

## 推荐

**先走路线 B**，把本机 web 端跑通（它真正缺的只有事件重放 + CORS + 鉴权收紧三件事）；当 ACP/A2A 或远程 app 成为真实需求、或引入 Hono 等重协议依赖时，再按路线 A 抽 `ohbaby-server` 包。两条路线不冲突——B 是 A 的子集，B 做的 event-bus/CORS/auth 在 A 里原样复用。

## 状态

- 基线：`mvp`（Phase 1-4 已合并，HEAD `044333f1`）。
- 本规划尚未实施，处于设计讨论阶段。
- 事件层取舍（UiEvent 直发 vs 抽协议中性领域事件）为待定决策，见 02/04。
