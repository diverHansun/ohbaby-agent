# improve-2 前端：组件契约

## 1. 分层与组合

沿用 [02](02-frontend-architecture.md) 的层级。只有真实重复或独立测试价值才抽组件；“发送→恢复”“编辑租约→重发”是应用流程，不封装成巨型万能组件。

## 2. 索引

| 组件/逻辑 | 层次 | 职责与位置 |
| --- | --- | --- |
| Prompt | 业务交互 | `components/prompt/index.tsx`；组装输入、当前模式和既有应用动作 |
| editor reducer / 输入窗口投影 | 纯逻辑 | prompt 附近；原文编辑、字素边界、显示行映射 |
| PermissionDialog | 业务交互 | `dialogs/permission-dialog.tsx`；呈现真实请求、局部阅读和选择 |
| TodoPanel | 展示 | `components/todo-panel.tsx`；计数/条目/展开提示 |
| App/layout | 宿主装配 | 单一输入归属、同一空间预算，不下沉成通用 UI 平台 |

## 3. 关键契约

### Prompt / 输入投影

用于未发送文本与队列编辑；不用于保存已接收提交或解释 permission 规则。结构：可选模式说明、可见输入行/光标、局部错误或窗口提示、原两行底栏。

输入：完整 EditorState、当前可编辑/可提交状态、宽高预算、语义动作。输出：完整原文/合法光标变化、显式提交意图；不把裁剪文本回写 state。状态与 04 对齐；被其他面板占用焦点时不响应按键、不画活动光标。retained unknown 的只读状态保留阅读导航，和失焦禁用区分。纯 reducer 不知道 CoreAPI。

### PermissionDialog

用于待处理的 UiPermissionRequest；不作为工具输出详情或授权规则管理器。结构：来源/标题、正文窗口、纵向 choices、键提示、同步/错误；使用 warning 表示等待，error 表示实际失败，选中有 `>`。

输入保留 client/request/ready/context/onResync，增加的尺寸只来自上层预算。输出仍是 respondPermission 的真实 choiceId 与原 context，不造新的授权 DTO。局部只存选择、页码、pending、error；identity 变化重置。空/同步/发送中不可提交，无 deny Esc 不提交；长文本可读完。若抽正文组件，它不接 client，也不自己决定 allow/deny。

### TodoPanel

用于已有任务事实的展开/摘要/只读回看，不用于任务编辑。App 决定自动显隐与当前 run 的手动偏好，TodoPanel 只消费投影数据、展示模式和宿主布局信息；completed/total 为纯派生。没有自建 activeTaskId 或第二份 Todo 仓库。visible=false 不再代表手动回看也必须隐藏，空列表/已清空数据仍不渲染。进行中正文 accent/适度强调，已完成弱化，marker 与文字双重辨识。

## 4. Component 与流程边界

会话草稿保存、租约和回执恢复分别留在最小应用边界。不能为了复用 pi 的可能性先给全部组件套 controller；组件换外观也不能改变这些流程。验证组件的关键 States 用现有 Ink/Vitest fixture，不新增 Storybook。
