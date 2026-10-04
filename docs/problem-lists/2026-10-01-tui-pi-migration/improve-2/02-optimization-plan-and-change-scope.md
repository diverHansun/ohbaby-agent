# improve-2：方案与改动面

> 2026-10-03 接续修订：本轮原保留的 Ctrl+R 由 [improve-3 Stage 4](../improve-3/02-optimization-plan-and-change-scope.md) 改为自动恢复；实施串联到 improve-3 时不再保留手动恢复入口。普通 unknown 不重发、草稿/队列归属、Ctrl+X 后果均不变。下文恢复相关旧表述只描述 improve-2 独立切片的原边界。improve-3 自动恢复可提前交付：已经落地时，本轮不得重新加入 Ctrl+R handler/文案；尚未落地时，保留可工作的旧恢复路径，直到自动路径通过后整体替换。

2026-10-02。**规划契约草案，供用户审阅和后续实施使用；本次不改产品代码。**已确认范围见 [00](00-discussion.md)，新增交互的唯一细节入口是 [前端 03](frontend/03-ui-layout-and-style.md) 与 [前端 04](frontend/04-interaction-and-states.md)。

## 2.1 总体方案

保持 React/Ink 和已有 SDK/recovery/store。先修输入正确性，再收紧草稿、提交和队列的身份边界，最后改审批呈现与 Tasks 局部样式。pi-tui 暂不接入；后续 Markdown 阶段再衡量复用收益。

```text
stdin → 现有模式/焦点判定 → 编辑 reducer → 草稿（原文＋光标）
                                 │
                                 ├→ 有界显示投影 → Ink / 同一布局预算
                                 └→ 带原始归属的提交/队列动作 → recovery / SDK
SDK 权限与任务事实 → 当前身份校验 → Permission / Tasks 呈现
```

## 2.2 关键决策

| 决策   | 选择与原因                                                                | 代价/放弃项                                                   |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 编辑器 | 保留 reducer，按 Intl.Segmenter 字素边界移动/删除                         | 仍维护小型编辑器；不增加 pi Editor 双宿主适配                 |
| 光标   | 内部可保留 UTF-16 offset，所有入口规范到字素边界；显示列另算              | 不能只替换 width 函数便称修好了 Unicode                       |
| 长输入 | 原文完整保存，渲染采用随光标移动的可见行窗口                              | 本轮不做 paste marker、折叠对象、外部编辑器或新编辑快捷键系统 |
| 提交   | 在第一个 await 前固定操作归属与输入快照，复用 recovery 的 pending/receipt | 不新增通用事务总线或第二份待发送库                            |
| 审批   | 纵向 choices＋明确来源/操作/范围；有 deny 的 Esc 拒绝，无 deny 不提交     | 这是前端快捷键修正，不改变后端 choices/鉴权规则               |
| 长审批 | 局部正文窗口，PgUp/PgDn 读完整可用内容，选择和动作提示保持可见            | 不发展成通用工具详情平台；不伪造 DTO 没有的参数               |
| Tasks  | 运行中默认展开、确认停止后默认隐藏；计数/强调/缩进，Ctrl+T 手动切换       | 2026-10-02 增量建议；不改后端 Todo 状态，不把 Ctrl+T 变成翻页 |

## 2.3 阶段与完成定义

### Stage 0：接上 improve-1 的实际基线

读取前轮 02/04 和实际实现差异；05 存在时核对其结论，尚未验收则补齐前轮验收后再推进依赖其输出策略的集成工作。记录实际 commit、Ghostty 版本、尺寸、tmux/SSH 条件。

明确同一个布局入口如何给 prompt、审批、Tasks 分配空间；前轮两行底栏和历史输出契约继续有效。需回答：长 Tasks 展开如何保持全量内容可达、不会使整个动态区溢出。前轮承诺整帧预算，并未承诺新的 Tasks 全文交互：如果实际基线没有可用路径，记录具体条目数/尺寸/失败场景，作为本轮 Stage 4 的小范围交互取舍，不能直接登记成前轮欠账。**本轮不暗中新增 Tasks 翻页系统，不用截断丢项算完成**；若确需新导航，先提交独立线框调整范围，再做 Tasks 集成。字素、草稿等独立部分仍可推进。

DoD：I2-T01 有真实基线记录；未解决的上游问题有明确归属，未把规划目标写成已交付能力。

### Stage 1：完整字素与有界输入

修改 `editor-reducer.ts` 的移动、删除、插入、换行/合行、clamp；绘制光标取整个字素。所有正常操作不能制造孤立代理项，不能拆开 ZWJ 家庭、肤色 emoji、旗帜、组合音标。输入边界落在组合序列内时采用一致的边界修正策略并测试，不能各函数自由取整。

保留现有 Enter、Shift+Enter、↑/↓ 历史、Tab 补全、普通 PgUp 历史补载、候选 PgUp/PgDn。长输入可见窗口跟随光标，换行只改变投影，不改变发送文本；左右跨行和 Home/End 仍可到达原文。仅为输入投影提取小函数，宽度判断复用 Ink 已有依赖语义并实测差异，不重写全局 Markdown/wrap。

**输入投影验证门**：本轮先明确 tab 的展示（建议在显示投影中展开到 4 列 tab stop，原文保留 tab）、输入前缀占列、软换行和行尾空格光标占列。用实际 Ink 渲染验证不会再次换行，不能只测计算函数。有效内容宽度 0 时不画虚假光标，1 列放不下宽字素时显示有界占位并提示扩大窗口，原文和位置不变；不得半个字素出界。规则与字体差异不能通过时先修投影，不能宣称 Stage 1 通过。

输入接收层需验证 CRLF 跨事件分片与字素后缀分片，保持既有 CRLF→LF 规范化；不要把终端键盘 Enter 与粘贴换行混成同一事件。

DoD：I2-T02–T05；单次/分片粘贴同文，中文 IME 实际提交字符不丢；窗口缩放后草稿和光标不变。真机 IME 不可用单元测试替代。

### Stage 2：草稿与异步操作归属

本 Stage 分成 2a/2b 两个可独立验证、独立回退的切片，仍属于同一轮。

#### Stage 2a：提交快照、会话归属与明确拒收

保留 sessionDrafts 的会话隔离和 EditorState，队列租约/retainedSendText/operationId 原语义不变。按责任提取必要的小型 helper/hook：编辑状态、草稿切换、提交动作、队列租约不混成一个“通用 controller”。是否拆文件由反馈环与可测试边界决定。

用延迟 getCurrentModel 复现 I2-P03；在首次异步准备前固定来源会话/新会话代次与完整输入快照。若预提交期间已切换来源上下文，则停止尚未交给 recovery 的提交，将快照保留在原归属的未发送记录；**不要投递到新会话**。一旦 recovery 接管，切换 UI 不取消已提交操作，由原 requestId 查询回执，晚到结果只更新原归属。

按 Enter 时先保存不可变提交快照，再清当前编辑区供下一份草稿输入；冻结的是这次意图，不是编辑器。复用既有串行首发队列，准备中的多份快照保持顺序与原归属，不成为新全局消息队列。新会话快速连续输入最终绑定同一新会话；新建动作的代次不能仅靠 null sessionId 区分。

首发回执使 null → receipt.sessionId，是同一创建代次的正常绑定，不等于用户主动切会话，不能取消已排在后面的 second。只有用户主动离开该创建上下文才取消尚未转交的快照。

普通提交的 existing pending **只存 requestId/sessionId/runtimeEpoch，不保存正文**：结果未知只查询原回执，绝不自动重发；retained unknown 才重放原 operationId/首次文本。明确拒收（如 QUEUE_FULL）或 recovery 接管前拒绝时，由本进程提交快照保留可恢复文本，不扩展 pending 持久格式。用户新草稿不能被旧失败覆盖；未发送快照的恢复操作见前端 04/06。

2a DoD：I2-T06–T08，原草稿/新草稿/准备快照归属明确，普通 unknown 只查询回执。

#### Stage 2b：队列租约与 retained 阅读

队列取消编辑恢复编辑前草稿及光标；租约失效保留修改原文并明确无法保存；未知重发只能复用原 operationId 和第一次发送文本。租约获取/续租/释放的晚到结果不能改其他会话，不让过期租约继续显示可保存。真实结果以 SDK 为准。

retained unknown 禁止改原文，但允许左右/Home/End 只读导航，让长窗口能读完第一次发送的全文；导航不能续租、改 operationId 或替换 payload。

2b DoD：I2-T09–T10。失败、切会话、切回和未知回执均有可观察去向；不以新增字段数量或文件拆分数量验收。

### Stage 3：可理解、可完整阅读的审批

保持现有同步引擎和身份字段；重排 Permission 内容与映射准确提示，并由 App 分配审批时的区域可见性：隐藏 Tasks、停用并收起 Prompt 正文，只保留前轮两行底栏；短屏收起辅助提示，将真实停止/同步提示并入审批操作区。完整逐行预算见前端 03 §5，不能只改对话框内部。来源区分 Main agent 和子代理；显示真实 title/description，缺少命令原文就使用现有描述，不写“完整命令”。Always 的内置项解释为请求所属会话的匹配规则，不能宣传永久/全项目授权。

纵向选择、默认 allow 优先和现有左右/上下/Tab 选择保持。Enter 提交当前项；有 deny 的 Esc 提交 deny，无 deny 的 Esc 不发请求且说明需显式选择。ready=false、无 context、pending、无 choices 时不能发送；无 choices 显示不可操作与同步状态，不编造按钮。

长正文单独翻页，键位只在审批拥有焦点时生效。发送失败保留请求与选择并允许显式重试，过期触发现有 resync；请求切换时页码/错误归零。保留 Ctrl+C 对当前可控 run 的停止语义，不将其映射为 allow/deny。

DoD：I2-T11–T13；无 deny、超长内容、权限切换/失效、返回草稿均通过。

### Stage 4：Tasks 小修与组合验收

采用 2026-10-02 新讨论的生命周期建议，替代“新 run 默认紧凑 5 项”：当前会话实际进入新 run 且有可展示 Todo 时默认展开；同一 run 的手动收起保持为一行摘要；确认 run 完成、中断或失败终止后默认隐藏，停止不等于把未完成项标成 completed。审批/命令等交互临时遮住 Tasks，返回时恢复当前 run 的本地选择。详细状态与 Ctrl+T 规则以 frontend/04 §4 为唯一入口。

App 结合当前 session/run/epoch 的可信运行事实决定自动显隐，不能只看任意 runtime.kind=error 或一次 Ctrl+C。后端普通 run 已有 hideTodoAfterRun；本轮不改共享后端 visible/Goal 协议。为手动回看使用当前 session 的原始 todos 投影，小型 selector 不先过滤 visible；自动展示仍尊重 visible。数据为空或已经清除时不恢复旧副本，不从其他 work scope 拼凑历史任务。

TodoPanel 标题显示完整列表的 completed/total；可见 in_progress 项轻强调，停止后手动回看标注 Stopped，不能暗示仍在运行。换行从正文起点对齐。默认展开也服从父布局预算；不足时可退化为有明确隐藏数量的紧凑预览，既有 selectCompactTodos 只作为这个降级工具，不再定义正常运行默认态。长列表全文可达性仍受下述 Stage 4 进入条件约束。

组合输入窗口、长审批、Tasks、流式尾部与底栏，在 Ghostty 重跑前轮阅读验收。完成后在本轮 05 记录实际结果和残余风险，不回写计划成进度表。

DoD：I2-T14–T16；前轮回滚/无变化输出/双行底栏无回归。20 项任务在 80×24 的全文可达性是 Stage 4 的显式进入条件：若前轮输出策略不能承载，须先补经用户确认的最小阅读方案，Stage 4 不可标完成。计数/样式可独立验证，但不能代替该条件。暂不采用 Ctrl+T 循环翻页，因为它会改变原展开/收起键义；这项取舍不阻塞 Stage 1–3。

## 2.4 改动面

| 范围           | 预计改动                                                     | 明确边界                                                    |
| -------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| CLI prompt     | reducer、光标/输入窗口、草稿/提交/队列 helper 与测试         | 不重做 slash 协议、命令面板和 SDK recovery                  |
| CLI App/layout | 原始提交归属、模式互斥、消费前轮空间预算                     | 不新建渲染器或第二套 budget                                 |
| CLI Permission | 内容层次、真实提示、局部正文翻页、错误与身份恢复             | 不更改后端授权政策                                          |
| CLI Tasks      | 自动显隐、手动折叠/回看、按会话读取已有 Todo、计数/强调/缩进 | 不修改 Todo schema/执行策略，不删除隐藏数据                 |
| SDK/Agent      | 阅读契约并回归共享行为                                       | 默认无协议/数据库变更；若发现必需接口缺口单列证据后调整规划 |
| 测试/文档      | 局部 unit/contract、跨模块 integration、终端 fixture         | 使用 docs-test；不为本轮搭 Storybook/Web 测试平台           |

## 2.5 数据、兼容与生命周期

详细状态归属见 [前端 06](frontend/06-data-api-and-state.md)。草稿保留在当前进程，不承诺重启恢复；已接收提交按现有回执/恢复协议，不用“草稿保存”替代它。编辑器展示不修改原文；输入沿用 CRLF→LF 规范化，发送继续既有 trim 规则，本轮不偷偷改变其他空白语义。

审批请求的 root/session/epoch/bindingGeneration 与 requestId 一起保护响应；同 ID 新 epoch 也须重置旧局部状态。Always 仅按内置 choices 的已知语义解释，未知 choice 保留真实 label，不能由 intent=allow 推断长期范围。保留 cancel/abort 过滤。

不新增 pi 包、不改 lockfile、不迁移持久化。无新全局快捷键；审批 PgUp/PgDn 仅占用原本被审批禁用的 prompt 上下文。Ctrl+C、双 Esc 停止、Ctrl+R 恢复、Ctrl+X 放弃 pending 都按真实主机状态和原归属执行，详见前端 04。

## 2.6 风险与回滚

| 风险                           | 验证与回滚                                                                 |
| ------------------------------ | -------------------------------------------------------------------------- |
| 字素索引与显示列混淆           | 分别测编辑结果和 Ink 实际光标；输入投影可单独回退，不修改草稿存储格式      |
| 抽取逻辑丢失租约/回执保护      | 先保留原用例再移动责任；以 Stage 2 独立改动回退，不重放已接收提交          |
| 快捷键在两个 useInput 同时触发 | 以用户按一次键的合约断言验证；修 scope 判定，不堆 stopPropagation 式假接口 |
| 审批/Tasks 又使动态区过高      | Stage 0 明确上游预算和完整可达性；集成失败退回展示改动，不丢事实           |
| 终端 IME 与测试环境不同        | Ghostty 实测并记录；未验证标缺口，不用 pi 单测通过替代                     |

## 2.7 需求对应

I2-P01 → Stage 1；P02/P03 → Stage 2；P04 → Stage 0/1/4；P05 → Stage 3；P06 → Stage 4；P07 → 本轮选型边界与 03。各 Stage 的测试编号见 [04](04-test-and-acceptance.md)。

## 2.8 不在本轮

pi Editor/完整 renderer、通用焦点/事件/插件框架、全局文本工具替换、Markdown 重新排版、完整工具详情和 Write diff 链路、任务管理扩展、跨进程草稿持久化、撤销栈/词级导航/外部编辑器、改变后端权限规则。后续按实际缺口再定范围，不预开 improve-3。

## 2.9 关键改动清单

沿用用户要求。行号是 `5c2adab5` 规划快照，以符号定位；不是全量文件表，也不记录实施进度。

| ID  | 路径（仓库根相对）                                              | 符号/行号快照                                                                   | 承重改动                                                                                                             |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| C1  | packages/ohbaby-cli/src/tui/components/prompt/editor-reducer.ts | backspace L128、moveLeft L162、moveRight L178、clampCursor L272                 | 全部编辑入口共用字素边界                                                                                             |
| C2  | packages/ohbaby-cli/src/tui/components/prompt/index.tsx         | sessionDrafts L138、切换 effect L191、队列 useInput L306、submitInput L910      | 原草稿归属、租约/回执保护、必要提取                                                                                  |
| C3  | packages/ohbaby-cli/src/tui/components/prompt/index.tsx         | renderEditorLines L819、renderEditorLineText L846                               | 完整字素光标、有界显示投影                                                                                           |
| C4  | packages/ohbaby-cli/src/tui/app.tsx                             | useInput L504、Prompt.submitPrompt L910                                         | 输入模式互斥、操作开始时归属、审批期间 Tasks/Prompt/辅助行可见性、Tasks 按 session/run 的自动显隐与 Ctrl+T、整帧预算 |
| C5  | packages/ohbaby-cli/src/tui/dialogs/permission-dialog.tsx       | PermissionDialog L18、respondWithChoice L166、findEscapeDefaultChoiceIndex L207 | 审批内容/翻页/Esc/身份保护                                                                                           |
| C6  | packages/ohbaby-cli/src/tui/components/todo-panel.tsx           | TodoPanel L13、selectCompactTodos L53                                           | 完成计数、进行中正文、续行缩进及展开/摘要/停止回看显示                                                               |

连带影响：`layout/metrics.ts` 仅接入前轮实际契约；`store/selectors.ts` 分开读取原 Todo 数据与自动显示资格，不改 store 事实；`session-recovery.ts` / `use-permission-sync.ts` 原职责保留并回归；theme 使用既有语义 token。测试路径见 04。历史模块文档/验收不倒改；本轮以此目录为单一实施契约，无必要再建平行模块文档树。
