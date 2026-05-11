# _references — 外部参考资料目录

本目录存放 ohbaby-agent runtime 设计的**横向参考资料**，不属于任何 runtime 子模块。

主要用途：在做架构决策、模块边界划分、协议设计时，提供同类项目的对照视角，避免闭门造车，也避免被外部项目的某些"流行做法"误导。

---

## 一、目录组织

| 文件 | 职责 | 何时读 |
|---|---|---|
| `README.md` | 索引与阅读指南（本文件） | 第一次进入本目录 |
| `personal-agents/01-overview.md` | hermes-agent / openclaw 项目简介、源码与公网资料链接、版本快照 | 想了解这两个项目是什么 |
| `personal-agents/02-mechanism-comparison.md` | 按"机制名"对照三家：gateway / daemon / pairing / session / stream / heartbeat / presence | 设计某个具体机制时，想看别人的形态 |
| `personal-agents/03-problem-comparison.md` | 按"工程问题"对照三家：如何接入设备 / 如何唤醒 / 如何流式回传 / 如何处理重启 / 如何路由多通道 | 在解决一个具体问题时，想看别人的解法 |
| `personal-agents/04-takeaways.md` | ohbaby 应借鉴的设计 / 应警惕的设计 / 实现与文档的两个矛盾点 / 可以做的微调建议 | 综合参考资料后回到 ohbaby 的设计决策 |

---

## 二、阅读路径建议

- **首次了解**：`01-overview` → `02-mechanism-comparison` → `04-takeaways`
- **解决具体问题**：直接查 `03-problem-comparison` 的对应小节
- **设计评审**：先读 `04-takeaways` 的"应警惕"清单，再回到机制对照确认细节

---

## 三、参考资料的时效性

本目录的对照基于以下版本快照（截至 2026-05-09）：

- `hermes-agent`：本地仓库 `D:\Projects\agent-components\personal\hermes-agent`，作者 Nous Research，v0.13.x 系列。公网资料以官方 docs 站与 DeepWiki 为主。
- `openclaw`：本地仓库 `D:\Projects\agent-components\personal\openclaw`，作者 OpenClaw 社区，v 主分支。公网资料以官方 docs、Substack 深度分析为主。
- `ohbaby-agent`：当前 `docs/runtime/*` 模块文档为准。

**外部项目演进很快**。本目录所有引用应理解为"在该时间点的快照"，做关键决策前请回到对应仓库或官方文档确认现状。

---

## 四、本目录与 runtime 模块文档的边界

| 文档类型 | 位置 | 性质 |
|---|---|---|
| 模块设计 | `docs/runtime/<module>/architecture.md` 等 | **规范性**（描述 ohbaby 自己的设计） |
| 外部参考 | `docs/runtime/_references/*` | **描述性**（描述外部项目，不规范 ohbaby 行为） |

`_references` 中的内容**不构成 ohbaby 的设计约束**。"借鉴"与"警惕"的最终采纳由模块文档承担。如果某条建议被采纳，应反映到对应模块的 `goals-duty.md` 或 `architecture.md`，而不是停留在本目录。
