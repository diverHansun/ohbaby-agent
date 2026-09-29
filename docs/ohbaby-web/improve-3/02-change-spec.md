# 2. Web 模块职责、结构与接线

> 对应[中央 improve-2.1 的02](../../problem-lists/2026-09-19-execution-reliability/improve-2.1/02-optimization-plan-and-change-scope.md)。这是目标规格，尚未实施。New session产品规则只在中央02定义；本文规定Web消费与模块边界。

## 2.1 目录与拆分粒度

用户已确认下列功能目录。它们表达职责，不要求每个内部函数各占一个文件；一个文件可以有多个内聚的私有组件/helper，不为凑目录建立空index、types或hooks目录。

| 模块 | 职责 / 拥有的状态 | 不拥有 |
| --- | --- | --- |
| ui/App.tsx | 根装配、无工作区/活动工作区切换；装配runtime边界 | 不保存消息副本，不放草稿租约/命令表单/连接状态机 |
| ui/workspace/ | ProjectRail、目录选择和打开；目录弹窗局部状态 | 不创建backend client，不推断session空闲 |
| ui/session/ | SessionScreen、侧栏、状态与错误；订阅已有store；local attempts/提交投影、Stop、恢复提示、跨功能协调 | 不实现HTTP/SSE、后端空判断或prompt调度 |
| ui/conversation/ | 消息流/行/part、工具卡、历史与滚动、模型等待/Total、当前主会话TodoDock | 不发送prompt、不建会话、不提供Stop/审批控制 |
| ui/composer/ | 输入、草稿持久化、队列编辑缓冲/租约UI生命周期、reasoning选择、单一keydown/IME/slash选择态/焦点 | 不保存另一份服务端队列，不判定prompt真正结束 |
| ui/commands/ | 纯slash规则、SlashPalette展示、结果、skills回填请求、connect/search/compact/goal表单与Goal chip | 不直接写Composer草稿，不仲裁键盘，不改变会话绑定或管理SSE |
| ui/permissions/ | PermissionModal、权限策略控件与FullAccessConfirmDialog；焦点/确认状态 | 不复制permission registry，不用消息同步ready代替审批ready |
| ui/shared/ | 真实跨功能且语义一致的Markdown、ContextUsage等基础展示 | 不作utils/业务状态大桶，不依赖上层功能 |
| ui/styles/ | reset、全局基础、公共动画；可审计的样式入口顺序 | 不建立新主题系统，不顺便重画界面 |

**提取标准：**有独立职责/副作用生命周期、需要独立风险测试、或已有多个真实消费者，满足其中之一才考虑独立文件。只有多个功能实际共享同一语义才进shared；单一功能内复用留在该功能。小格式化函数、小状态标签和仅服务某个弹窗的helper留在所属文件。

文件命名沿用仓库当前风格：React组件.tsx，纯规则/hook无JSX用.ts。可以逐功能统一命名，但不跨仓库批量改名。目标是读一个功能能找到状态与测试，不设置App或单文件的硬行数指标。

## 2.2 依赖方向与公开边界

```text
bootstrap -> runtime -> api/daemon/client -> http/events + existing SDK sync/store
                 |
App -> workspace + session
session -> conversation / composer / commands / permissions / shared
composer -> commands/slashCommands + commands/SlashPalette（有限单向入口）
功能模块 -> shared + SDK业务类型
```

runtime是同一个既有应用facade，不再造“应用服务层”。React绑定只订阅它拥有的client/store；没有功能模块自行connect/create runtime的权力。store、SDK和transport不能反向依赖React。

功能间的组合交给session；Composer可单向 import commands 提供的纯 slash 规则与 SlashPalette，保留键盘仲裁和候选索引的唯一状态。commands 的表单/结果由 session 装配，通过现有命令能力与 Composer 本地草稿修改路径连接；不建立 session 中转的 `handled`/`onInsertText` 双向协议，也不复制 slash 状态。permissions 策略控件通过 slot/回调组合。

### Composer与commands的最小接线

Composer 持有 draft、从 draft 派生的 query、slash 打开/选中索引、`scopeKey` 与本地编辑 revision。commands 的纯规则计算候选和补全，SlashPalette 负责展示；commands 不保存、持久化或修改另一份 draft，不维护第二个选中态。Composer 可有限依赖这两个 commands 入口，依赖方向不可反转。

键盘处理保留原有单一 `onKeyDown` 顺序：Composer 先过滤 IME；候选打开时处理方向/Page 键、Tab 补全、Enter 执行、Esc 关闭；这些分支当次结束，不再触发发送、队列取消或 Stop。之后才走 Enter 发送、Esc 退出队列编辑、Shift+Tab 切 mode、双 Esc 停止；Shift+Enter 保持换行。鼠标选择和键盘执行调用同一命令动作。一次按键只产生一个用户动作，不能靠跨模块 `handled` 往返保证。

同步补全和 overlay 打开后的清空由 Composer 当场按正常 draft 更新/持久化路径完成。异步命令成功后的清空及 `/skills` 回填须携带发起时的 `scopeKey` 和 Composer 编辑 revision；切 scope 或用户继续编辑后丢弃迟到结果，失败保留草稿。revision 只用于异步结果失效，不成为服务端状态；不能靠草稿字符串碰巧相同判断有效。现有 prefill nonce 仍用于区分重复请求，但不能替代 scope/revision 校验。

TodoDock归conversation，但其**页面位置仍是Composer section顶部、消息滚动容器之外**。session装配TodoDock，经Composer一个明确的顶部内容slot传入；维持原todo身份key、展开状态和DOM顺序。Composer不因此import conversation，也不生成一套任意区域slot注册框架。

不为“公开边界”给每个目录增加整桶export的index.ts。使用少数明确入口文件直接import；内部helper默认不导出。跨功能类型放在能力的定义方，或通过现有SDK类型表达；必要的小props类型可以同入口文件导出，禁止为每个对象新建types.ts。

### 具体输入与输出

| 接缝 | 输入 | 输出 / 动作 | 数据归属 |
| --- | --- | --- | --- |
| session -> conversation | 所选scope的messages、已计算prompt rows、等待/耗时事实、todo和history状态、时间样本 | onLoadEarlier；局部滚动/展开 | 不接收全量runtime/client或整个ViewModel |
| session -> composer | draft scope、ComposerModel、只读queued项、admitting/Stop标签、prefill、顶部TodoDock、嵌入式slash/权限区域 | submit/stop；queue acquire/renew/edit/release；reasoning动作 | 草稿与编辑缓冲归composer；prompt事实归store/session |
| composer -> commands 的有限入口 | 本地 query/索引与只读 catalog | 纯候选/补全规则、SlashPalette 展示、选中命令动作 | 键盘、索引与 draft 始终归 composer |
| session -> commands 表单/结果 | catalog/result、活动scope、专用model/search/compact/goal能力 | 命令执行请求与异步结果；清空/skills回填带发起scope+编辑revision | commands自己的表单与pending；Composer校验后修改本地draft |
| session -> permissions | 独立permissionSync状态、当前请求、策略 | respond/setPolicy；confirm/dismiss | 只读权威权限事实，局部确认/焦点归permissions |
| App/session -> workspace | WorkspaceSnapshot、选择/打开/隐藏动作、DirectoryPickerApi | 目录选择、弹窗关闭 | client切换/导航持久化仍归runtime |

“窄接口”可以使用`Pick<UiBackendClient, ...>`或明确回调对象，不要求每个动作包一层无意义转发。抽取第一步允许维持旧props以保证机械等价，但本轮S3完成时应收窄上述叶模块；不能永久保留整个client/ViewModel作为逃生口。

## 2.3 状态所有权与生命周期

| 状态 | 唯一协调者 | 必须保留的失效条件 |
| --- | --- | --- |
| workspace/client/SSE与导航 | BrowserOhbabyWebRuntime及其BrowserDaemonClient | switch/dispose先使旧generation无效，保持单client/逻辑SSE |
| messages/runs/prompts、权限、history、control | 现有SDK同步与Web store | epoch/session/bindingGeneration、revision与history ticket |
| localPromptAttempts、receipt接管、promptProjection、可见队列 | session | 以原workspace/session/clientRequestId识别；formal与provisional不重复 |
| draft、pending requestId/text、queued edit缓冲与续租 | composer | scope变化、新稿输入、租约失败与卸载；迟到续租/失败不能覆盖新scope |
| Stop pending与10秒提示 | session/use-stop-request.ts | sessionId+runId，RPC接受不等于可靠终态；旧run迟到不复活按钮 |
| sync banner | session/use-session-sync-banner.ts | scope/epoch/generation；首次加载与中断恢复分开 |
| 表单pending、命令结果 | commands | 请求版本、连接generation、关闭/切scope；异步清空/skills回填必须过Composer的scope+编辑revision校验 |
| slash打开/选中索引、单一keydown链 | composer | IME、scope与本地编辑revision；候选纯规则来自commands |
| 折叠/阅读位置/工具展开 | conversation | 稳定message/call身份，分页前后锚点，换scope明确重置 |

Composer继续负责编辑租约的本地生命周期，调用session提供的窄能力；session不再复制租约timer或第二份编辑草稿。后端租约有效性仍由backend裁定。useStopRequest和useSessionSyncBanner留独立模块是职责/测试决定，不是要求每个effect都拆hook。

SessionScreen负责组合。提交投影规则先随 session 移动；只有出现独立测试或复用需求时才提取聚焦的 `use-prompt-submission.ts`，不能产生一个囊括所有导航、表单、工具、草稿的 useSessionController/useAppController。原有纯helper先随组件搬，只有反复使用或需要专门测试才继续提取。

新组件定义放模块顶层，不能定义在父组件render内造成身份变化。不能通过给SessionScreen随意增加key来重置一切；先列明哪些状态跨session保留、哪些按scope重置，保护草稿/Stop/审批和连接生命周期。

## 2.4 建议文件组合与迁移规则

下列是有职责依据的落点；同目录小部件允许合并进所列入口，不是要求额外生成每个符号的文件。

| 当前来源 | 目标落点 / 合并方式 |
| --- | --- |
| App: ProjectRail及项目label/color helper；directory-picker/ | workspace/ProjectRail.tsx；workspace/directory-picker/保留已有组件/测试组合 |
| App: ConnectedOhbabyWebApp、EmptyWorkspaceApp、SessionSidebar、StatusBar/ErrorBanner/EmptyState | session/SessionScreen.tsx、session/SessionSidebar.tsx；后三种状态视图可合在session/SessionStatus.tsx；无工作区装配仍由App负责 |
| selectors.ts及相关tests | 总体选择器移session/selectors.ts；conversation的纯消息展示选择可局部提取，不反向import session |
| use-stop-request.ts、use-session-sync-banner.ts及tests | session/原文件名 |
| App: ConversationStream、MessageRow/MessagePart、PromptProjectionRow、ModelWaiting/PromptDuration | conversation/ConversationStream.tsx、conversation/MessageRow.tsx；计时展示可合并conversation/ExecutionProgress.tsx |
| tool-card.tsx及tests；streamScroll.ts及tests；execution-duration.tsx | conversation/原名称；无JSX计时hook改use-execution-duration.ts，供工具/等待/Total共享 |
| App: TodoDock和TodoDockItem/preview/status helpers | conversation/TodoDock.tsx，同一文件保留内聚小部件 |
| App: Composer、草稿存储/lease key、ReasoningControl | composer/Composer.tsx；composer/draft-storage.ts；ReasoningControl因独立请求生命周期可单独文件；编辑hook只在明显降低耦合时提取 |
| composerTextarea.ts、ime.ts、TypewriterPlaceholder.tsx及tests | composer/下迁移；小helper不再层层拆目录 |
| slashCommands.ts及tests；App: SlashPalette | commands/slashCommands.ts、commands/SlashPalette.tsx；Composer单向调用规则/展示并保留完整键盘链与索引态 |
| App: CommandResultModal及各只读result body | commands/CommandResultModal.tsx；短body与helper同文件，不一subject一文件 |
| App: StructuredCommandOverlay及connect/search/compact/goal body | commands/StructuredCommandOverlay.tsx；各有异步/表单职责的body各自文件，search若很短可与connect同文件 |
| App: GoalStatusChip | commands/GoalControl.tsx或与GoalOverlayBody合并，避免在session重复定义goal规则 |
| App: PermissionModal；FullAccessConfirmDialog | permissions/PermissionModal.tsx、permissions/PermissionPolicyControl.tsx（内含确认） |
| MarkdownBlock.tsx、ContextUsage.tsx及tests | shared/下迁移；二者已分别被conversation/commands或composer/commands消费 |
| styles.css | 保留ui/styles.css作为固定入口；全局基础放styles/，功能规则随功能放；按原顺序导入 |
| api/daemon/client.ts | BrowserDaemonClient保留此处，BrowserOhbabyWebRuntime及其接口/factory移src/runtime.ts；bootstrap/UI更新import |

runtime拆分只搬现有职责：传输client不import上层runtime；跨文件接口由拥有方导出，不为了编译而创建循环import或重复状态。unknown prompt持久化属于browser client，导航/workspace持久化属于runtime；原helper随owner搬，暂不为每个helper新增文件。保留HTTP/SSE/eventReducer/store原有机制；wire中的历史混合类型暂不全盘搬迁。

## 2.5 样式、测试和完整接线

样式先固定现有入口与级联顺序，再迁规则。某功能规则与其他模块穿插且提取会改变顺序时，允许暂留有标注的入口片段；不要靠提高specificity或!important掩盖搬迁差异。本轮不引入CSS Modules/新主题库，不要求所有组件独立CSS文件。

先移动源码并保留原App行为测试，单独提交后再迁局部测试；可调整import/fixture引用，不能同时删旧断言或放宽预期。App仍保留跨功能装配和真实用户交互用例；模块test测各自职责。styles.unit.test读取路径的测试应适配实际入口，不以“文件文本相同”替代构建/浏览器级联验证。

完整接线至少覆盖bootstrap到runtime/App、New请求意图、store订阅、permissions独立同步、commands到prefill、Composer提交到session投影、conversation history/计时、Stop。新增但未被App消费的模块不能视为完成拆分。TUI不import Web模块；本轮只回归其共享backend语义。

## 2.6 关键改动清单

> 用户明确要求。行号基于2026-09-27工作树，定位以符号为准；不是实施进度表。跨包New session清单只在中央02。

| ID | 文件 / 符号 | 快照位置 | 改动与承重原因 |
| --- | --- | --- | --- |
| W1 | apps/ohbaby-web/src/ui/App.tsx / mount、OhbabyWebApp、ConnectedOhbabyWebApp | L428/L448/L462 | 保留根入口，提取SessionScreen；不改变挂载身份 |
| W2 | 同文件 / selectPromptProjection、localPromptAttempts、submitText | L267/L497/L640附近 | session持有提交/回执投影，防止重复行和跨scope迟到 |
| W3 | 同文件 / ConversationStream、MessageRow、ModelWaiting、PromptDuration | L1511/L2076/L2293/L2332 | 数据驱动展示与稳定key，独立于输入/控制 |
| W4 | 同文件 / Composer、ReasoningControl、草稿/租约helper | L2661/L2465/L173 | 本地编辑与窄操作边界；保留存储键、IME与租约语义 |
| W5 | 同文件 / CommandResultModal、StructuredCommandOverlay及各body | L1767/L3775 | commands内聚表单/结果；Composer保留键盘与slash选择态，异步清空/skills回填校验scope+编辑revision |
| W6 | 同文件 / PermissionModal、FullAccessConfirmDialog | L2364/L3558 | 权限独立同步、一次回答和焦点恢复 |
| W7 | apps/ohbaby-web/src/api/daemon/client.ts / acceptBinding、BrowserOhbabyWebRuntime | L295/L1156 | 同scope失败恢复与两类机械分文件分批处理 |
| W8 | apps/ohbaby-web/src/api/daemon/http.ts / createSession；src/bootstrap.ts | L222/L1 | New意图出站与runtime新入口；不增加第二条连接 |
| W9 | apps/ohbaby-web/src/ui/App.unit.test.tsx、styles.css、styles.unit.test.ts | 原文件整体 | 先保留行为保护，再迁局部测试/CSS；不同提交审查 |
| W10 | docs/ohbaby-web/architecture.md、data-model.md、dfd-interface.md、ui/components.md、test.md | 各结构/状态/数据流/测试章节 | 实施后同步实际模块与接口，不把旧目录图留作权威 |

连带影响：所列已存在组件/helper相邻tests与imports、src/store引用的类型；不按全量git文件表建立任务。现有文档链接需更新真实路径，历史规划本身不回写成进度。

返回：[中央阶段方案](../../problem-lists/2026-09-19-execution-reliability/improve-2.1/02-optimization-plan-and-change-scope.md)；验证映射：[03](03-test-criteria.md)。
