# 1. Web 模块现状

> 2026-09-27，HEAD `3ac9a6b3` 加当前未提交修复。全局基线及输入清单见[中央01](../../problem-lists/2026-09-19-execution-reliability/improve-2.1/01-problem-analysis-and-current-state.md)。这里仅分析Web结构。

## 1.1 现有边界

`bootstrap.ts`读取服务端注入并创建runtime；`api/daemon/client.ts`同时包含BrowserDaemonClient与BrowserOhbabyWebRuntime；store保存同步投影；React通过useSyncExternalStore读取。SDK是业务DTO权威，HTTP/SSE只在adapter层处理。这些边界可保留，不需要改框架或状态库。

`ui/App.tsx`包含根挂载、工作区/会话协调、local prompt attempts与投影、ConversationStream、Composer、审批、slash结果及connect/compact/goal弹窗。现有`directory-picker/`已经提供了局部模块样例：窄API、组件内部状态与相邻测试。

## 1.2 高耦合接点

| 位置 | 当前职责混合 | 拆分需要保持的关系 |
| --- | --- | --- |
| App ConnectedOhbabyWebApp L462 | store/workspace订阅、提交回执、错误、overlay、导航 | 顶层生命周期与会话交互协调分开；异步结果仍绑定原scope |
| selectPromptProjection L267及localPromptAttempts | 本地提交、正式消息、prompt状态的优先级 | session唯一拥有协调，conversation只显示计算结果 |
| Composer L2661 | 草稿、sessionStorage、租约、slash、IME、提交、权限控制 | 本地编辑与服务端准入分开；编辑缓冲不能随重新render丢失 |
| ConversationStream L1511 | 滚动、分页、消息、工具和计时 | 保持稳定消息key和历史锚点；不能依赖输入/Stop能力 |
| StructuredCommandOverlay L3775及各Body | 表单、专用API、异步防迟到 | commands拥有；不将副作用抽成万能表单引擎 |
| use-stop-request.ts / use-session-sync-banner.ts | 可靠终态等待与恢复提示 | 都属于session界面状态；独立文件有测试理由 |
| selectors.ts L67 | 总体ViewModel及局部选择规则 | 总体装配留session；特定展示投影随功能，叶组件不读全量snapshot |
| styles.css与App.unit.test.tsx | 全局样式与所有功能行为 | 先保留保护网，再单独迁移，防止同时改实现和验收标准 |

## 1.3 状态和依赖风险

前端已区分权威同步与本地草稿，但跨功能逻辑仍靠App闭包共享。Composer接受整个ViewModel和UiBackendClient，很多叶子组件因此能接触并不需要的状态和动作。把这些参数原封不动塞进新文件不会降低耦合。

提取后最危险的是改变组件身份、key、挂载位置、effect cleanup和订阅数量；这些变化可能造成失焦、草稿丢失、迟到Promise覆盖新会话、Stop状态提前清除。样式拆分还可能改变cascade；测试迁移可能误删跨功能场景。

## 1.4 与原设计的关系

`architecture.md`的独立Composer/ConversationStream等结构尚未完整落地；`ui/components.md`描述的是产品行为，并不要求所有组件同一文件。本轮改变组织与能力边界，保持现有视觉、命令/审批/输入语义。原架构文档的旧snapshot恢复描述与improve-1.1的已实现同源恢复，以后者及实际实现为准；本轮不能倒退到旧整页replacement路径。

关键修改文件及权威文档同步点见[02](02-change-spec.md)；测试风险映射见[03](03-test-criteria.md)。
