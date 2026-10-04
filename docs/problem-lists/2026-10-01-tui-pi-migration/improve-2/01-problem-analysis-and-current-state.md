# improve-2：现状与问题

2026-10-02 调查基线：ohbaby `5c2adab5`；本地 pi `5fd446ca1843682e8da3fec4ceb71c42f56fbace`。本文路径相对仓库根，符号为定位依据。improve-1 尚未实施，不能将其两行底栏和完整动态区预算当成现成能力。

## 1.1 核心问题与证据等级

| ID | 现状与影响 | 证据、处理入口 |
| --- | --- | --- |
| I2-P01 | 删除与左右移动按 UTF-16 单元走，可能把 emoji 拆开；绘制光标也截取单个单元 | `components/prompt/editor-reducer.ts` 的 backspace/moveLeft/moveRight/clampCursor；`prompt/index.tsx` 的 renderEditorLineText。隔离探针确认 😀 删除后剩孤立高代理项；Stage 1 |
| I2-P02 | Prompt 同时管理编辑、草稿、补全、提交、队列租约；修改输入容易触碰已存在的可靠性行为 | `prompt/index.tsx` 的 sessionDrafts、draftGeneration、queuedEdit、submitInput；这是维护耦合，不等于这些能力缺失；Stage 2 |
| I2-P03 | 首次提交等待模型信息后再调用注入的 submitPrompt；App 回调读取当时的 recoveryRef.current，存在会话切换窗口 | `submitInput` 的 getCurrentModel 与 `app.tsx` 的 Prompt.submitPrompt。**源码风险，尚未完成端到端复现**；Stage 2 先用延迟反馈环核实 |
| I2-P04 | 输入直接渲染所有逻辑行，没有独立可见窗口；长粘贴、审批、Tasks 同时出现会增加动态帧高度 | `prompt/index.tsx` 的 renderEditorLines；`layout/metrics.ts` 现有固定预留不能保证整帧；Stage 0/1/4，输出策略属于 improve-1 |
| I2-P05 | 审批只显示 title/source/description/纵向 choices；Esc 文案是 safe default，但无 deny 时会提交第一项 | `dialogs/permission-dialog.tsx` 的 findEscapeDefaultChoiceIndex 返回 0；确定的映射问题，不推定日常请求都有无 deny 情况；Stage 3 |
| I2-P06 | Tasks 已有 5 项紧凑模式与 Ctrl+T，但无完成计数，当前项正文不突出；长行续行需验证 | `components/todo-panel.tsx` 的 TodoPanel/selectCompactTodos；Stage 4，局部展示与生命周期默认态 |
| I2-P07 | pi Editor 不是 Ink 组件，直接替换将增加终端宿主及草稿状态适配责任 | pi `packages/tui/src/components/editor.ts` 与公共 index；[03](03-reference-projects.md)；本轮不接入 |

## 1.2 七维诊断

| 维度 | 当前事实 | 缺口或应保留的能力 |
| --- | --- | --- |
| 目标与职责 | Ink/React 负责终端 UI；SDK/store/recovery 负责会话事实与恢复 | 基础编辑和异步业务在 Prompt 相邻，但不应全搬进一个 controller |
| 架构 | App 装配 recovery、权限同步、各 useInput；Prompt 局部模式控制输入 | 多个 useInput 本身不是缺陷，需按实际 isActive/模式验证同一键是否触发两个动作 |
| 数据模型 | EditorState 含 lines/cursor/history/draft；sessionDrafts 已按 session 保存 editor/edit；queuedEdit 含 lease/operationId/retainedSendText | 不重建第二套草稿或 pending 仓库；光标偏移与显示列宽需要区分 |
| 数据流与接口 | Prompt → recovery.submit → SDK 接收回执；队列通过 acquire/renew/edit/release/resubmit；权限带 epoch/root/bindingGeneration | 在 await 前后保持同一操作身份，不能用当前 UI 身份替换原操作身份 |
| 用例 | 草稿切换、队列租约过期保留文本、未知回执重发已经有代码；审批有 pending 与 responseScope | 保护这些既有路径；新增边界测试而非重新设计整套恢复 |
| 非功能 | MainScreen、原生回滚、Ghostty 优先；长动态区会影响阅读 | 输入、审批可见范围需服从 improve-1 的同一预算；不能靠存储截断解决显示问题 |
| 测试 | 已有 editor/permission/todo 局部测试与 App/recovery 合约用例 | 先前相关 12 个局部用例通过，但未覆盖完整字素族；真机 IME/复制/回滚未验收 |

## 1.3 审批与任务的跨层事实

普通 `PendingTuiPrompt` 与 `pending-prompts.ts` 持久文件只含请求/会话/epoch，不存原文；`session-recovery.ts` 未知提交只查询回执并提示 Do not resend。retained 队列重发才有 operationId/retainedSendText；不能混成一种“重试”。源码已有快速连续首发合约：getCurrentModel 尚未返回时可输入 first/second，最终按序进入同一新会话（`app.contract.test.tsx` 约 L3492）。

`packages/ohbaby-cli/src/tui/dialogs/permission-dialog.tsx` 已过滤 cancel/abort、默认优先 allow、具有 mounted/identity/pending 防护；`use-permission-sync.ts` 使用 SDK 同步引擎。UI 不能因为重新排版就丢掉这些身份保护，也不重新加回已过滤的取消动作。

`packages/ohbaby-agent/src/permission/manager.ts` 的 always 分支把规则登记到请求所属 session，匹配也按该 session；`permission/state.ts` 保存运行时规则。本轮不会把 Always 描述成整个项目、所有子代理或永久磁盘授权。展示层字段定义以 `packages/ohbaby-sdk/src/snapshot.ts` 的 UiPermissionRequest/UiPermissionChoice 为准，只有 title/description 的场景不能伪造完整命令。

新增核对：`app.tsx` L225/283–293 将 todoExpanded 初始化为 false，session/todoRunId 变化时再次收起。`store/selectors.ts` 的 selectActiveTodoList 仅返回 visible=true 的数据，不能直接用于停止后的手动回看。后端 `adapters/ui-inprocess.ts` 的 hideTodoAfterRun 已在普通 run 终止时隐藏，数据不删除；shouldKeepTodoVisibleAfterRun / refreshTodoProjectionAfterRun 对 active Goal 有保留显示的分支。这是现有语义，不需要为了 TUI 交互重新建立 Todo 协议；前端默认隐藏与后端 visible 应分开建模。

Tasks 的 selectCompactTodos 先选进行中、待处理、最近完成，再按原列表顺序呈现。不能为强调“当前”擅自改成单一活动任务假设，多个 in_progress 都是真实状态。

## 1.4 文档与实现对照

| 文档方向 | 当前代码 | 本轮处理 |
| --- | --- | --- |
| plan C：输入可靠、审批后回到草稿 | 草稿恢复已有；字素边界不完整 | 保留既有模型，修编辑和身份边界 |
| improve-1：整帧预算、两行底栏 | 是前轮目标，尚未交付 | Stage 0 依据其实际验收结果接入，不复制一套布局逻辑 |
| plan：说明授权范围、按键后果 | `[intent]` 与 safe default 对用户不够明确 | 提供面向用户的说明；映射必须以真实 choices 为依据 |
| plan：Tasks 小修 | 已有紧凑/展开，无完成计数 | 增量展示；长展开不能悄悄变成新的任务浏览系统 |

## 1.5 SWE 审视与影响面

复杂度应减少在边界处：字素函数不知道 session，草稿不知道 ANSI，recovery 不知道光标，审批不自己决定授权规则。保留已有状态源；只有能单独验证的提交/队列行为才从 JSX 文件提取。文件变短不是验收目标。

预计产品改动以 CLI TUI 为主；SDK/Agent 为事实源和共享消费者回归对象，不预设改协议或数据库。pi 调查不形成依赖安装要求。具体文件、Stage 和回滚见 [02](02-optimization-plan-and-change-scope.md)。
