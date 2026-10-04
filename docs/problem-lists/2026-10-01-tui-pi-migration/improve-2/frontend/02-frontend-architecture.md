# improve-2 前端：架构

## 1. 技术边界

保留项目现有 React/Ink、TypeScript、CoreAPI、store、recovery、权限同步引擎和语义主题。无新增 pi 依赖和 UI 状态库，不用 CSS/DOM 模拟终端。字素使用 Node 支持的 Intl.Segmenter，是否缓存实例由简单实现决定。

## 2. 渲染策略

单一 Ink 宿主负责 stdin/stdout 与终端生命周期；MainScreen 历史输出策略由 improve-1 验证并交付。本轮只消费可用宽高、报告内容需求；不能让 Prompt/Permission 各自开终端、清屏或固定 dock。软换行和局部窗口是显示投影，原文本不随尺寸变化。

## 3. 模块组织与依赖

保留现有 `app.tsx → components/prompt、dialogs/permission-dialog、components/todo-panel`。必要的字素/输入投影放 prompt 附近；草稿与队列应用行为只在能独立测试时提取。纯 reducer 不依赖 client，展示不直接改 recovery 内部数据，底层 SDK 不依赖 React。

## 4. 状态归属

| 状态 | 所有者 |
| --- | --- |
| 当前会话、runtime、todos、permissions | 既有 SDK/store/recovery/sync |
| 未发送 editor、cursor、history、编辑前草稿 | 既有按会话草稿机制，必要时精简封装 |
| 已转交提交、未知回执 | recovery 的 pending/requestId，避免第二份待发送事实 |
| queue lease/原重发 operationId | 既有队列编辑应用状态；身份随操作固定 |
| 输入窗口、审批页码、选择、错误、Tasks 手动折叠/回看 | 局部交互状态；绑定 session/run 或审批 identity，不能修改后端 Todo 事实 |

## 5. 组件层级

App 组装事实与模式；Prompt/Permission 是业务交互组件；TodoPanel 是事实投影；编辑 reducer/字素与窗口计算为纯逻辑。不要为了形式把每层都拆目录，也不要把提交、租约、布局装成超级组件。

## 6. 错误处理

编辑/提交准备错误在当前输入区内联显示；已转交后的未知回执由恢复提示表达；租约错误在队列编辑状态显示；权限错误留在对应请求。后台旧操作不弹到另一个会话冒充当前失败。终端退出/异常恢复沿用原入口。详细映射见 [06](06-data-api-and-state.md)。
