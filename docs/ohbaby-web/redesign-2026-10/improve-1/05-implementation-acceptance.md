# improve-1 · 5. 实施验收

## 5.1 元信息与结论

| 项 | 值 |
|---|---|
| 轮次 | improve-1：视觉基础、两栏外壳、组件拆分 |
| 规划基线 | `3d691618`，包含 MCP 只读和隐藏附件的已确认决策 |
| 范围 | 基线之后全部 staged、unstaged 和新增文件；期间新增的 Lychee 品牌调整另作补查 |
| 日期 | 2026-10-23 至 2026-10-24（Asia/Taipei） |
| 方法 | 独立 Standards / Spec 两轴审查；主审运行自动化检查、真实 daemon 和浏览器走查 |
| 结论 | **部分通过，尚不能标记 improve-1 验收完成。** 主体重构和工具链通过，但草稿、slash、无实例状态、手机交互和 Mock 契约仍有缺口。 |

本记录替代实施会话的自评。评审没有修改产品实现；提交用于保存当前实现和待修项，不表示下列问题已经修复。按用户要求，审查临时图片和 `evidence/` 文件在核对后删除，只保留文字证据。

## 5.2 实施概况（对照 02）

| 条目 | 状态 | 实际情况 |
|---|---|---|
| token、移除 overrides | 基本完成 | CSS 颜色集中到 tokens，旧覆盖层删除；TSX 内联色仍有漏网。 |
| 两栏外壳、Projects | 基本完成 | AppController 接运行时，AppShell 管布局；ProjectRail 删除，仍采用目录中心运行时；手机交互未完整落实。 |
| SessionScreen / Composer 拆分 | 基本完成 | SessionScreen 从1292行减至335行，Composer 从1312行减至497行；分出提交、加载、交互、草稿、slash、租约模块。useSteerQueue 448行。 |
| 无目录草稿、无模型入口 | 部分完成 | 正常打开目录和取消能保留文字，连接失败会丢失；无模型点发送能打开已有 /connect。 |
| 通用 Menu | 部分完成 | portal、定位、键盘和焦点归还可用；缺过滤与手机菜单样式。 |
| ApprovalPanel | 基本完成 | 消息区内展示、折叠、翻页；保留审批响应和停止链路。审批期间仍隐藏输入框，与线框不同。 |
| Mock、测试、说明 | 部分完成 | 606个测试通过，增加5个开发场景；Mock 订阅契约错误，不能证明交互闭环。 |

## 5.3 规划与实际差异

| 维度 | 实际差异 | 原因与影响 |
|---|---|---|
| 数据结构 | StoreSnapshot 增加 currentModelLoaded | 区分“未读取”与“确认没有模型”，支持 A6；没有修改 daemon HTTP 协议。 |
| 数据流 | 保留目录中心运行时，增加父级草稿交接 | 未提前实现全局会话；交接早于连接完成，失败路径存在问题，见 R1。 |
| 文件结构 | 本批即将侧栏迁入 sidebar/，增加 shell/、shared/、dev/ | 职责更清晰；runtime/client 的目录生命周期未改。 |
| 品牌补充 | 审查期间工作区增加D26、LycheeMark、favicon和空态调整 | 补查确认空态1个40px荔枝标识、侧栏1个产品字标，颜色来自brand-lychee；同步文档描述。未把上下文组成详情的旧彩色视为品牌例外。 |
| 视觉 | 顶栏44px、侧栏268px、内容宽780px；New chat 为导航行；顶栏无玻璃及连续底线 | 尺寸属于可调初值；顶栏材质偏离02步骤5和03§4.1，不能记为完全一致。 |
| 审批 | 标题获得焦点，内部管理折叠，aria-modal=false，输入框隐藏 | 标题焦点避免 Enter 意外批准、非模态允许阅读消息，合理；输入框可见性与03§4.6不同，仍待决定。 |
| 菜单 | Export 在同一面板切换第二层，归档直接执行；未提供过滤 | 轻量操作方向合理；A8的过滤不能自行视为已取消。ModelMenu 实际属于 improve-4，并非 improve-2。 |
| 通知 | 未单独增加 runtime:model-switch 过滤 | eventReducer 本就忽略 notice.emitted，目前不会显示，无须重复过滤。 |
| Mock | 独立实现，不抽取含 vi.fn 的测试替身；无 pending-move | 独立入口合理；pending-move 依赖后续全局数据，订阅契约仍应本批补齐。 |
| 依赖和产物 | 无新增依赖；生产产物不含 Mock | 同环境提取基线前端构建，JS+CSS gzip 合计增加约1.23kB，低于计划预算。 |

实施中合理保留的改进：修正无会话且无压缩通知时 `undefined === undefined` 导致错误进入对话视图的问题；工作目录恢复普通末尾省略；窄屏隐藏抽屉不再留阴影；工具名和 slash 分类去掉彩色强调。工具分类的旧辅助逻辑尚未清理。

## 5.4 审查发现与建议顺序

P2 为本批正式验收前应修复的功能/可用性问题，P3 为设计契约或维护缺口。两轴分别列出；R1和S1涉及的草稿问题不重复计数。

### Standards

| ID | 优先级 | 问题、证据与建议 |
|---|---|---|
| R1 | P2 | **首次打开目录连接失败会丢草稿。** SessionScreen.tsx:140–145 挂载后立即消费初始文字，AppController.tsx:165–168 清空父级草稿；runtime.ts:334–344 此时才连接，失败恢复无client。真实 daemon 的一次 POST /v1/clients 被注入503后，输入从“验收草稿：连接失败应保留”变成空字符串。应在连接成功、目标scope稳定后交接，失败保留原文。 |
| R2 | P2 | **无关刷新会清空并重载 slash 菜单。** SessionScreen.tsx:244 的 inline onListCommands 每次渲染变化，useSlashPalette.ts:87–105 的 effect 随之清空catalog。浏览器给查询增加300ms延迟，再发布内容相同的新model对象，菜单立即消失、查询计数从3增4，恢复时为6。基线使用稳定回调，应恢复并覆盖无关store刷新。 |
| R3 | P2 | **Mock 违反订阅契约。** dev/mock-runtime.ts:27–31 将 subscribeEvents 兜底为 rejected Promise，挂载时 SubagentConversationReader 和 ReasoningControl 各报一次未处理错误；卸载还可能将Promise当退订函数。应显式返回同步退订函数。Mock 当前只能辅助检查布局，不能证明批准、停止、发送的闭环。 |

Standards 共3项，最严重的影响是R1的输入丢失。租约、提交投影、审批选择的提取未发现其他明确新回归；未覆盖路径仍需测试。

### Spec

| ID | 优先级 | 问题、要求与证据 |
|---|---|---|
| S1 | P2 | **无实例仍常驻 connecting，草稿失败路径不符合A7。** 02步骤6要求草稿稳定保留，不能把尚未创建实例的正常状态伪装成连接异常。AppController.tsx:139–150 无条件传入header，MainHeader.tsx:53–60 显示初始connecting。真实 daemon 隐藏最后项目后，无client但顶栏仍显示connecting。草稿失败见R1。 |
| S2 | P2 | **手机交互未完成。** 03§5要求“选中会话后自动关闭”、菜单“底部弹出面板，行高48、字号15”，§3.3要求手机触控目标≥44px。AppController.tsx:121–123 选择后不关闭；390px实测仍为 is-sidebar-open。shared.css:32–46,64–94 保留28px图标按钮、锚点菜单；实测菜单宽176px、行高30px。 |
| S3 | P3 | **Menu 缺过滤及测试。** A8明确列出过滤，Menu.tsx没有对应接口。原单测只验证 onClose(true)；本轮通过真实菜单另外验证了Escape实际归还焦点，焦点行为本身不计失败。 |
| S4 | P3 | **上下文组成详情仍有硬编码蓝、粉等颜色。** A2要求组件样式无字面量颜色，最新视觉约束只将字标和Lychee标识列为品牌色例外。ContextUsage.tsx:17–33,209–226 仍以内联样式输出七种颜色；styles.unit.test.ts只扫CSS，未覆盖TSX。 |
| S5 | P3 | **顶栏材质偏离计划。** 02步骤5要求玻璃顶栏、03§4.1要求底线对齐；shell.css:40–48和侧栏顶栏只设置布局。当前呈现简洁，无功能故障，建议明确确认这项视觉取舍。 |

Spec 共5项，最严重的是S1对草稿与无实例状态契约的违背。附件、Search、Settings已隐藏；没有提前实现全局会话或MCP编辑。

### 浏览器补充

| ID | 优先级 | 问题与证据 |
|---|---|---|
| B1 | P2 | **上下文提示次级文字对比度不足。** 悬停圆环时，shared/context-usage.css:102–106 的10.5px文字是 #6b6964，背景 #1f1e1c，computed style 算得 **3.04:1**。应使用适合深背景的次级文字token。相同文字在普通面板上约4.90:1，不能拿该数值替代深色提示检查。 |

建议先修R1、R2，再修S1、S2、B1和R3；随后补Menu过滤、TSX颜色检查，确认顶栏和审批输入框取舍。不要把本批失败路径全部推给improve-2。

## 5.5 验收证据

### 自动化与产物

| 检查 | 本轮结果 |
|---|---|
| pnpm exec vitest run apps/ohbaby-web --reporter=dot | **45个文件、606个用例通过**；首次5.89s，Lychee补查后复跑5.39s。 |
| pnpm typecheck | 通过。 |
| pnpm lint | 0 errors、122 warnings，与审查前记录数量一致。 |
| pnpm build | 首次全工作区通过，包含CLI及Web资源复制；Lychee补查后额外运行 pnpm --filter ohbaby-web build 通过。500kB chunk提醒在基线也存在。 |
| git diff --check HEAD | 通过。 |
| 产物比较 | 基线Vite gzip：JS156.79kB、CSS12.56kB；本批首次158.64kB、11.68kB，Lychee补查后158.78kB、11.71kB。Python gzip统一复核最终合计增加1226字节。产物未检出mock runtime错误文案、场景文案及mock-scenarios。 |

基线46文件、605用例。本批删除SessionStatus、TypewriterPlaceholder及对应测试，新增Menu与新状态用例，数量变化与组件替换相符。现有测试全通过不能证明新边界已覆盖：R1、R2、R3均未被拦住。本轮未另跑prettier，不沿用实施自评的prettier“通过”。

### 真实 daemon 与浏览器

使用 scripts/run-compiled-web-e2e.mjs，独立临时profile、数据库、workspace及本地脚本化模型服务；没有修改用户模型配置，没有请求外部付费模型。

- **首轮失败如实保留：** 真实发送、read工具、首个回复成功；续问出现“LLM provider request failed after 5 retries”。刷新后首个回复和续问各保留一次、会话ID稳定，但缺续问最终回复。向harness提交真实失败数据，退出码1。
- **复跑通过：** 临时副本只增加provider错误日志，产品代码与断言未改；发送、read、续问、刷新均通过。3次agent-step请求、工具结果被消费、cache key稳定、runtime context每次1份、标题和页面无内部标记。UI/backend/diagnostics/cleanup全部通过，退出码0。
- 首轮异常未定位根因，不能断言由本批引入，也不能因复跑成功声称已修复，保留为端到端稳定性风险。
- 两轮daemon均已停止，harness确认PID和端口释放。

| 场景 | 步骤与观察 |
|---|---|
| 1440×960 | 空态、运行中、侧栏、输入框检查；Lychee补查后另验空态标识40×40px、颜色rgb(192,68,79)、侧栏字标仅1处；暖白层级、紧凑会话行和底部控制区已形成；scrollWidth=1440。 |
| 900×900 | 初始侧栏关闭；抽屉宽268px，遮罩可关闭；运行中空文本为Stop，输入后为Send；scrollWidth=900。 |
| 390×844 | 审批面板宽370px、位于消息区内；1/2→2/2翻页，折叠约56.4px、展开约149.1px；scrollWidth=390。选择真实会话后抽屉不关闭，见S2。 |
| 项目切换 | 临时workspace、os-home切换并返回，原项目会话可选、内容恢复。 |
| 无目录正常路径 | 隐藏最后项目进入真正client=null；输入→选择→取消，文字保留；重新打开成功也保留。无附件/Search/Settings；错误connecting见S1。 |
| 无目录失败路径 | harness没有目录根，仅替换picker列表为临时workspace；连接仍走真实runtime。一次POST /v1/clients返回503，等待错误、关闭picker，输入为空，见R1。 |
| 无模型入口 | 真实daemon页面将store.currentModel设为null，使用真实catalog；发送打开Connect model且保留文本，未保存配置。这是受控状态注入，并非无配置新安装走查。 |
| Slash | 真实catalog可展示；加入300ms延迟并发布无关store更新后，菜单消失再出现、重复查询，见R2。 |
| Menu | Home→Pin、End→Archive；Escape关闭并归还Actions按钮焦点；390px菜单在视口内；过滤未实现。 |
| 上下文 | 72%圆环为琥珀色，70/90阈值由单测覆盖；深色tooltip次级文字实测3.04:1。 |
| reduced-motion | 仿真reduce后非spinner动画为0.001ms、一次迭代，CSS保留spinner；实底回退仅代码检查，未在不支持backdrop-filter的浏览器实测。 |

局限：真实模型触发审批、浏览器完整steer/queue/租约/子代理闭环未测试，主要依赖自动化；Mock批准和停止为空实现。当前会话没有可用原始参考截图，视觉对照的是定稿设计描述，不能声称逐像素比较。

### A1–A13 对账

| ID | 结果 | 依据 |
|---|---|---|
| A1 | 通过 | 45文件、606用例通过；删除被替换组件测试。 |
| A2 | 部分 | CSS检查通过，TSX内联色未收拢，S4。 |
| A3 | 部分 | 边界改善；Composer497行、useSteerQueue448行超约400行，不应仅为凑行数机械拆分。 |
| A4 | 部分 | 自动化与复跑真实链路通过；slash回归R2，完整子代理/队列浏览器链路未验。 |
| A5 | 通过 | 真实临时项目切换成功，ProjectRail删除。 |
| A6 | 有限通过 | 自动化及受控无模型状态走查；no-model Mock的空catalog不能证明Connect。 |
| A7 | 未通过 | 正常/取消通过；连接失败丢草稿、无实例显示connecting。 |
| A8 | 部分 | 键盘、定位、焦点归还可用；过滤缺失。 |
| A9 | 有限通过 | Mock布局、折叠翻页、阈值测试通过；真实审批闭环未验，输入框偏差待定。 |
| A10 | 部分 | 普通面板、回退、减少动态规则已检查；tooltip文字不足4.5:1，不能笼统宣称全部通过。 |
| A11 | 基本通过 | 字体、slash和通知符合；上下文详情配色漏网S4。 |
| A12 | 通过 | test.md及旧DOM断言已更新。 |
| A13 | 通过 | 全仓typecheck、lint、build通过。 |

### SWE 评估

拆分方向合理：布局不掌握daemon生命周期，展示、草稿、队列和提交按职责分离，没有额外框架或抽象工厂。按复杂度管理、信息隐藏和接口契约原则，主要风险不在行数，而在状态交接：R1过早确认消费，R2将effect生命周期绑定每次渲染，R3让替身违反同步订阅协议。应先建立对应反馈用例再修行为。

架构审查清单聚焦改动：既有提交幂等、未知回执恢复、租约链路在提取后保持；失败回滚未保住新草稿；重复catalog查询增加请求。服务器鉴权、配置写入和网络协议未改，不展开非改动区域历史问题。

## 5.6 重要文件与提交组织

| 文件 / 目录 | 修改 |
|---|---|
| [tokens.css](../../../../apps/ohbaby-web/src/ui/styles/tokens.css)、[shared/](../../../../apps/ohbaby-web/src/ui/shared/) | 视觉token、基础控件、Menu、通知及上下文样式。 |
| [shell/](../../../../apps/ohbaby-web/src/ui/shell/)、[sidebar/](../../../../apps/ohbaby-web/src/ui/sidebar/) | 两栏布局、运行时接线、项目分组与会话操作。 |
| [SessionScreen.tsx](../../../../apps/ohbaby-web/src/ui/session/SessionScreen.tsx)、[composer/](../../../../apps/ohbaby-web/src/ui/composer/) | 会话和输入模块拆分、无目录草稿、无模型入口。 |
| [ApprovalPanel.tsx](../../../../apps/ohbaby-web/src/ui/permissions/ApprovalPanel.tsx) | 取代PermissionModal，增加折叠和翻页。 |
| [dev/](../../../../apps/ohbaby-web/src/dev/)、[bootstrap.ts](../../../../apps/ohbaby-web/src/bootstrap.ts) | 仅开发环境加载固定场景。 |
| [test.md](../../test.md)、本记录 | 测试说明、实际结果与未关闭问题。 |

按职责分批保存：①共享基础组件与视觉token；②外壳、输入区、审批及回归测试整体集成；③开发场景与启动入口；④测试说明和独立验收记录。分批提交保留可审阅历史，正式验收仍以未关闭问题是否处理为准。

代码提交：`b6f78e49`（共享基础）、`9d85f62c`（界面集成及Lychee标识）、`03a1ea1b`（开发场景）；本记录随文档批次提交。上述提交均运行仓库原有lint/typecheck钩子，未跳过检查。
