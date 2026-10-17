# session-export：会话导出

把一个会话里用户和 AI 的完整讨论导出成文件：**HTML** 给人看，**JSONL** 给程序读。

当前交互（已完成本机端到端验收）：

- **TUI**：`/export [html|jsonl]`，默认导出 HTML，保存到本机的 Downloads。
- **Web**：在会话菜单里选 Export ▸ HTML / JSONL，由浏览器下载。

## 文档地图

### 模块设计（plan-module-design）

| 文档 | 内容 |
|---|---|
| [goals-duty.md](./goals-duty.md) | 做什么、不做什么 |
| [architecture.md](./architecture.md) | 内部结构、HTML 页面和安全约束 |
| [data-model.md](./data-model.md) | 导出概念、过滤规则、JSONL v1 格式 |
| [dfd-interface.md](./dfd-interface.md) | 数据流、对外接口、Downloads 目录规则 |
| [test.md](./test.md) | 模块测试场景 |

use-case 和 non-functional 两份可选文档没有写。用例只有"导出一次"这一个动作，已经在 dfd 里讲清楚了。安全约束写在 architecture §4.3。

### 接入改造（plan-code-improvement）

**轮次地图**：目前只有一轮，improve-1，开始于 2026-10-17，已完成源码复核、后端与前端接入，以及 macOS TUI / Chromium Web 的端到端和视觉验收。

| 文档 | 内容 |
|---|---|
| [improve-1/00-discussion.md](./improve-1/00-discussion.md) | 已确认的讨论结论 |
| [improve-1/01-problem-analysis-and-current-state.md](./improve-1/01-problem-analysis-and-current-state.md) | 现状和缺口，附代码锚点 |
| [improve-1/02-optimization-plan-and-change-scope.md](./improve-1/02-optimization-plan-and-change-scope.md) | 方案、3 个 Stage、改动面 |
| [improve-1/03-reference-projects.md](./improve-1/03-reference-projects.md) | 6 个参考项目的借鉴和取舍 |
| [improve-1/04-test-and-acceptance.md](./improve-1/04-test-and-acceptance.md) | 接入层测试和发布门 |
| [improve-1/05-implementation-acceptance.md](./improve-1/05-implementation-acceptance.md) | 后端批次实施、测试、审查与已知限制 |
| [improve-1/06-frontend-acceptance.md](./improve-1/06-frontend-acceptance.md) | TUI / Web 端到端、HTML 视觉优化、最终检查与证据 |

**阅读顺序**：先看 00 了解结论，再按 goals-duty、architecture、data-model、dfd-interface 的顺序理解模块，最后看 02 和 04 动手。

## 实施进度（2026-10-17）

第一批完成导出模块、SDK、后端适配层、REST、JSON-RPC 和 Web 底层接线。随后用户完成 TUI / Web 界面接入，本轮完成端到端检查、问题修复和 HTML 阅读页优化。最终全量 preflight 通过，6,699 条测试通过；独立审查的问题已修复并复核。收尾按导出核心、协议接线、TUI、Web 菜单、文档五批组织提交，以 main 为集成分支，只推送 main。Linux / Windows Downloads 仅做了注入平台参数测试，跨操作系统手工验收仍未完成。

源码证据与引用修正见 [investigation](./improve-1/investigation/README.md)。

## 功能范围

- **完整范围**：HTML 和 JSONL 导出；TUI 的 `/export`；Web 菜单的 Export 子菜单；跨平台的 Downloads 目录。
- **规划之外**：导入、Markdown、子代理的中间过程、自定义路径、网页输入框里的 `/export`、脱敏。完整清单见 [02 §2.8](./improve-1/02-optimization-plan-and-change-scope.md)。

## 实施约定

实施时按 02 改代码，按 04 和 test.md 自测。如果实施中发现方案有问题，先回来修改文档，再改代码。
