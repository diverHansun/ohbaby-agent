# UI 文档导航与状态

> 对账日期：2026-08-15

`docs/ui/` 混合了当前 surface 合同与早期的目标组件设计。目录中的 `hooks/`、`views/`、`contexts/` 文档可用于理解设计意图，但**不是当前文件拓扑的权威来源**；其中提到的 `useKeyboard`、`useStream`、`HomeView` 或 `Router` 等抽象不保证在代码中存在。

当前实现与测试的权威入口是：

- `packages/ohbaby-cli/src/tui/app.tsx`：TUI 编排、SDK 事件订阅、Prompt 接单与全局快捷键；
- `packages/ohbaby-cli/src/tui/components/`：实际 Ink 组件；
- `packages/ohbaby-cli/src/tui/store/`：snapshot、事件投影与 transcript store；
- `packages/ohbaby-cli/src/tui/app.contract.test.tsx`：TUI surface 行为合同；
- `docs/ohbaby-sdk/2026-08-13-surface-contract-unification/`：本轮冻结的跨前端合同和验收证据。

## 当前稳定合同

1. 普通 TUI 输入调用 `submitPromptAccepted()`，只等待接单；运行进度和四种业务终态由 `UiEvent` 投影到本地 store。
2. `abortRun(runId)` 必须接收明确的 `UiRun.id`。命令 interaction 的取消只走 `respondInteraction()`。
3. 一个活动 workspace 只有一个**逻辑**事件订阅。重连时物理 SSE 可以替换，但每个已接受的 `UiEvent` 只能解包并分发一次。
4. `interaction.resolved` 负责清除 pending interaction。`"timeout"` 是允许的 cancelled reason，但当前合同不承诺 UI 或 SDK 自动创建超时定时器。

## 阅读旧页面时的规则

- API 名称和数据语义若与 SDK 当前类型冲突，以 `packages/ohbaby-sdk/src/` 和本轮 surface-contract 文档为准。
- Hook/View 页面中的伪代码不能用于推断当前调用链；先从 `app.tsx` 和对应合同测试核对。
- 本轮只对齐旧页面中的 Prompt/abort 语义，没有借机重建整个 TUI 文档体系。
