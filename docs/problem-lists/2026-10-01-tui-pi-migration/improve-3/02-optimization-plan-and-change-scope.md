# improve-3：方案与改动面

2026-10-03。供后续实施使用，本轮撰写不改产品代码。用户约束见 [00](00-discussion.md)，界面唯一细节入口见 [前端 03](frontend/03-ui-layout-and-style.md)、[04](frontend/04-interaction-and-states.md)，数据及恢复见 [06](frontend/06-data-api-and-state.md)。

## 2.1 总体方案

保留 React/Ink 和现有 store/recovery。pi-tui 只提供 Markdown 与文本排版基础能力；ohbaby 自己把真实工具事实组织成内联工具块。沿已有调用和结果 ID 配对，按当前展开状态产生显示行，交给前轮统一输出层。

```text
Agent 执行与持久化 → 共享展示投影 → SDK 可选结果字段
                                          ↓
                                      现有 store
                                          ↓
                     分类工具内容 / 助手 Markdown
                                          ↓
              pi 文本能力 + ohbaby theme → Ink 输出层

现有 recovery → 有界快速尝试 → CLI 冷却后自动接续
```

## 2.2 关键决策

| 决策         | 选择与代价                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------- |
| pi 依赖      | 官方 `@earendil-works/pi-tui`，实施时核实发布包并锁定精确版本；本地 0.87.1 仅为调研快照            |
| 宿主         | Ink 独占 stdin/stdout、光标、raw mode、退出恢复；不调用 pi TUI/Editor/overlay                      |
| 文本替换范围 | 助手 Markdown 与本轮工具块的宽度/ANSI 排版；不批量替换 improve-2 编辑器的字素和 tab 契约           |
| 展开         | 一个会话显示布尔值控制已加载工具块；不维护逐工具详情库，不增加选择器或分页                         |
| 工具事实     | 可选、类型化、白名单投影；旧结果兼容，不暴露内部 metadata 全集                                     |
| 真实 diff    | 小范围接入成熟行 diff 算法，先核对仓库可复用依赖；禁止继续伪装全量替换；计算失败不改变实际写入成败 |
| 自动恢复     | SDK 保留单轮有界恢复；CLI 在现有 recovery 内负责冷却后的接续，不改变 Web 默认恢复策略              |

## 2.3 阶段与完成定义

### Stage 0：对齐前轮实际交付

读取 improve-1/2 的 02/04，已有 05 时核对结论，没有则完成相关上游验收后再合入依赖它的 UI 改动。记录实际 commit、Ink/Ghostty 版本、窗口尺寸、tmux/SSH 条件和输出策略。

明确：稳定历史怎么接收修正、活动区域如何计算真实显示行、历史补载如何保持顺序，以及审批/命令面板怎样独占输入。improve-2 长 Tasks 可达性仍按其 Stage 4 处理；不得暗中移入本轮。

DoD：I3-T01；有具体基线和未通过项的责任归属，不能只写“沿用前轮”。纯 diff/DTO/恢复工作不依赖真机，可先独立测试，但不据此标 UI 已集成。

### Stage 1：pi 文本能力与输出验证，分开交付

#### Stage 1a：显示宽度与工具排版

先在 `render/wrap.ts` 和本轮工具块边界验证公开 `visibleWidth`、`wrapTextWithAnsi`、`truncateToWidth`。优先处理中文/emoji、长行、tab、ANSI/OSC 与前缀占列；真实 Ink 不二次换行。替换范围以本轮显示消费者为主，不改变 improve-2 输入编辑器的字素与 tab 契约。`render/wrap.ts` 还被会话选择器、用户/系统消息及 message-row 后备路径共用：若直接替换其内部实现，保持既有导出签名并回归这些调用方的列宽、截断和换行；若语义暂不兼容，先在本轮消费边界接入，不把共享替换伪称为局部改动。reasoning 的隐藏与来源过滤规则不因排版替换而改变。

先核对所选发布包的 exports、Node/构建兼容和许可，锁定精确版本与 lockfile。不要重新包装整个 SDK。调研源码目录为 0.87.1，2026-10-03 本机 Pi 安装依赖已为 1.0.0，两者是不同快照，均不自动成为项目依赖版本。

#### Ctrl+O 输出技术验证门

在 improve-1 实际输出方案中，用一条已完成且已滚出当前视口的长工具结果，验证紧凑→展开→紧凑、历史补载、resize、晚到修正。Static 已打印文本不能只靠 props 更新。禁止把全部历史重新塞进超高动态 Box，或复制一份工具输出到尾部冒充原位展开。

先验证前轮输出策略是否已有可用的历史投影重建路径；没有时，用隔离 fixture 验证“稳定历史一次输出、Ctrl+O 切换时单次重建、内容未变的历史保持稳定、活动尾部正常更新”的候选。按需使用 Pi 式一次清屏、清 scrollback 后重印当前已加载会话；不是每次按键都必须清屏，也不能让普通刷新反复重建全部历史。具体实现仍走 Ink 的统一输出边界，不让工具组件自行写控制序列。真实历史晚到修正和旧页前插仍按 improve-1 的输出契约处理；不得为避免重印而冻结旧值。紧凑与展开两种状态都须验证，Ctrl+O 的限定取舍不自动扩大为所有后台事件均可清屏。

**已确认的行为取舍**：用户在了解原生回滚替换的代价后明确要求学习 Pi。Ctrl+O 展开工具详情，再按恢复正常紧凑 TUI；主动切换允许必要的一次清屏重印，阅读位置可回到底部，原生 scrollback 可被当前已加载会话的投影替换。会话消息事实、顺序、草稿、光标和运行状态必须保留；不能把原生回滚替换等同于删除业务历史。

I3-T03 以“一次主动切换至多一次必要的整体重建，之后刷新稳定”为准，同时记录 shell 回滚、已加载会话和未加载历史的影响。正常 TUI 视图指紧凑投影，不承诺还原切换前的终端滚动坐标；未加载消息仍走既有历史补载。无需再次确认已经接受的主动重绘代价，但技术验证仍要证明 Ink 下确实可用。

若候选都不能满足已确认要求，暂停 Ctrl+O 集成，继续独立的文本、数据纵切和自动恢复；保留当前已通过的紧凑显示。不得暗中把 Ctrl+O 降级为只影响新结果，也不恢复详情页、切 AltScreen 或接管 pi renderer；全轮仍不标完成。这是明确的阶段退路，不是宣称已经找到输出解法。

#### Stage 1b：助手 Markdown

在 `render/markdown.ts` 与 theme 的小边界验证公开 Markdown 和主题接口，接受文本、宽度、主题并返回行。检查列表、表格、代码块、未闭合结构、链接、padding、tab 和有意义的空白；不引入语法高亮平台。Markdown 和工具宽度适配可分别验证、回退；Markdown 失败不阻塞工具数据或宽度切片，Ctrl+O 输出验证失败也不阻止独立的 Markdown 验证。

DoD：I3-T02/T04 分别记录宽度与 Markdown 结果，I3-T03 单独记录输出验证门。真实 Ink 与 Ghostty 证据分开；对应能力通过后移除被替代的旧解析路径，不长期双实现。安装 pi 包的公共成本共享，不把两个切片误写成两套依赖。

### Stage 2a：读、搜索、命令的最小纵切

先将一条 Bash 结果从 Agent 实时事件、持久化、恢复一路送到内联工具块，再扩 Read/Glob/Grep。修改 SDK `snapshot.ts` 的可选展示字段、Agent 的实时/历史投影及 CLI tool-part/message-row；采用前端 06 的白名单和旧记录降级。

Bash 显示命令及已返回输出，紧凑时命令摘要初值最多 2 个显示行，输出取末尾约 5 个显示行；不制造实时日志订阅，不把后台启动成功标成命令完成。失败保留部分输出和错误；补普通 error 的可选 output 持久化，让现场/恢复一致。Read/搜索默认只给路径、条件、可信数量；修正 `pattern` 摘要和 Glob 二次输出裁剪的完整性事实。未知工具用现有名称、有限参数和原始结果后备，不倾倒任意 metadata。

本切片可先交付紧凑结果，不必等待 Write diff。DoD：I3-T05–T07、T10–T11；真实数据到显示的纵切通过，旧记录仍可读。

### Stage 2b：Edit/Write 的执行事实与 diff

替换 `tools/utils/output.ts` 的全删全增算法。输出含正确 hunk 范围、增删标记、少量上下文；测试首尾增删、重复行、纯插入/删除、CRLF、缺少末尾换行与无变化。沿用 `mutation-budgets.ts` 的输入/输出预算，超预算给诚实的不可用原因，不新建无限 diff 存储。

Write 在原有文件锁、mtime 和取消保护内，在正式写入前读取有界旧内容；成功后把对应 diff/created 等事实写入结果 metadata。只因显示 diff 失败不得把成功写入报成失败。二进制、权限或预算导致旧内容不可用时，仍按原写入语义执行并记录详情不可用。不得在 UI 事后读文件猜测执行时版本。dry-run 保持未写入事实。

新建 Write 内容由该次调用实际输入与成功结果配对展示；覆盖必须消费执行结果保存的 diff。不得把“有 content 参数”自动解释成新建成功。旧记录缺 diff 时显示实际结果说明，不创建补采集任务。

DoD：I3-T08–T11；共享 output 被模型、Web 等消费者使用时，回归其契约；没有必需数据库迁移则不增加迁移脚本。

### Stage 3：Ctrl+O、完整内容与组合布局

按前端 04 接入一个显示开关，只在普通聊天输入上下文处理 Ctrl+O。第一次按键展开工具详情，再按恢复正常紧凑视图；两种视图下任务与事件处理持续运行。切换适用于当前已加载工具结果和随后到来的结果，不发历史请求、不改变 reasoning、Tasks、审批、草稿。历史补载得到的工具使用当前模式。会话切换重置为紧凑；普通恢复/resize 不重置。

短结果无需展开提示；长结果只按实际省略位置标记一次：Bash 保留末尾时标在正文前，Write/diff 保留开头时标在正文后，快捷键说明在现有帮助集中出现，不在每条记录重复。采集时已经丢失的内容不能用 Ctrl+O 恢复；显示预览与源数据限制分别处理。展开显示该结果实际保存的全部可用内容，不能再设一个无入口的隐藏上限。

渲染接入 Stage 1 通过的输出机制，动态帧服从前轮预算；结果较长时使用正常终端输出与回滚阅读。用户主动展开允许一次有必要的布局变化，普通 token/状态通知不得重复展开或重印内容未变的历史；真实修正继续遵守 Stage 1 与前轮契约。

DoD：I3-T03、T12–T14、T18；没有工具阅读页；20 条混合工具、长结果和审批组合仍可读。

### Stage 4：自动恢复接替 Ctrl+R

这是可独立提前交付的切片，不依赖 Stage 1 的 Ctrl+O 技术门或 Stage 2/3 的工具界面。编号用于文档组织，不要求排队等前面全部完成；先记录恢复相关基线，并回归前轮草稿/提交身份即可推进。整体验收仍在 Stage 5。

修改 CLI `session-recovery.ts`、App 的按键入口/状态文案、Prompt 同步提示及相关测试。恢复调度完整覆盖原 retry 承担的身份、初始化/索引、会话同步、control 和原回执查询，避免只接 sync.retry。

保留 SDK 单轮的快速尝试与重复失效预算，CLI 只在本轮结束或尚有待确认事实时调度下一轮；不在每次 onChange 重置失败计数。具体生命周期、冷却初值和持久未知结果见前端 06 §4。transport 已断开时等现有重连事件，不启动另一套网络连接循环。

远端首次启动也要验证：现有 JSON-RPC client 缓存了失败的 initializePromise，且 bootstrap 在 SSE 重连循环之外。必要时在 `packages/ohbaby-server/src/protocols/jsonrpc/client.ts` 小范围修复失败缓存与已有循环的重入，保留同一 clientId/startup intent，并先验证 `initializeClient` 的重复调用不重复创建会话或重置授权。不得以反复新建 client 绕过问题。

所有恢复读取都必须有界。先沿 HTTP rpc 已有 signal 通道补齐超时/取消；尚无取消参数的必要网络读取，才补兼容的可选选项及调用链转发。in-process 只在实际阻塞边界或测试证明有挂起风险时补取消，不为形式一致逐层改接口。远端 bootstrap 同样需要期限，不能卡住已有重连循环。具体取消与迟到响应规则见前端 06，不以裸 Promise.race 留下一串悬挂请求。

普通提交结果未知始终沿原 requestId 查询，不重新提交、不生成新 requestId；`receipt=null` 不等于明确未接收。旧 runtime 无法确认的请求保持真实未知，不借自动恢复承诺可恢复一切。明确业务拒绝不进入自动提交重试。保留 improve-2 的未发送快照、retained operationId 和 Ctrl+X 放弃跟踪语义。

先验证自动路径能继续前进，再同一切片删除 Ctrl+R handler 和提示；不另占这个键。若本切片先于 improve-2 的输入/审批集成落地，后续按最新自动恢复契约回归，不恢复旧 handler 或提示；若尚未落地，保留可工作的旧路径直到本切片原子替换，不能只先删键。审批 choice 发送失败的显式重试仍由审批交互负责，不自动替用户作决定。

DoD：I3-T15–T17；无输入情况下暂时故障恢复、原请求被确认、无重复提交；退出/切会话无悬挂定时器或旧结果串入。

### Stage 5：整体验收与交接

用同一 fixture 走发送→Markdown→工具→上滚→Ctrl+O→审批→返回草稿→断线恢复→历史补载。重跑 improve-1 阅读与 improve-2 输入/审批承重验收；再测 60×20、80×24、120×40，深浅背景、低色彩、动画关闭及复制。

DoD：I3-T01–T18 的相关结果可追溯；产品测试、FakeTTY 和真机证据分开记录。实施后写 05/前端 09，不能以“Pi/子代理审核过计划”代替实际测试。

## 2.4 改动面

| 包/目录                              | 改动                                         | 边界                                                  |
| ------------------------------------ | -------------------------------------------- | ----------------------------------------------------- |
| CLI `render/`、theme                 | pi Markdown/宽度小适配，移除被替代解析       | 不迁移编辑器，不另开 stdout                           |
| CLI message/transcript/App           | 分类工具块、Ctrl+O、本轮输出接入             | 不新建工具浏览平台，不复制 store                      |
| CLI recovery/Prompt                  | 自动接续和提示清理                           | 不重写提交/队列，不接管 transport 重连                |
| SDK snapshot/导出/序列化             | 可选类型化展示字段                           | 不改现有必填字段，不全透 metadata                     |
| Agent tools/utils/lifecycle/adapters | 真实 diff、Write 事实、错误 output、共享投影 | 不改变授权和实际执行结果，不无限读文件                |
| Server JSON-RPC client               | 初始化失败后可重入、恢复读取的超时/取消转发  | 同一 client 身份与启动意图，不新建 transport 重连系统 |
| Web                                  | 共享 DTO/工具 output 兼容回归                | 无界面重设计；共享 client 修复需回归                  |
| 议题文档                             | plan 与 improve-1/2 标明被本轮接续的规则     | 不倒改历史验收或伪造前轮实施进度                      |

## 2.5 兼容与回退

新增展示字段可选。旧客户端忽略，旧记录无字段时使用可信 input/output/error；数量未知不显示 0，diff 缺失不编造。字段需经过实际 RPC/快照/持久化路径测试，不能只改 TypeScript 类型。

pi 适配、数据纵切、Ctrl+O、自动恢复分成可独立审查和回退的改动。展示回退不清除工具事实、不重跑工具。恢复变更回退必须保留可工作的恢复路径，不能留下“删除 Ctrl+R、也没有自动接续”的中间版本。共享 diff 文本改变需检查消费者，不能只更新快照掩盖语义变化。

## 2.6 风险

| 风险                           | 验证与处理                                                      |
| ------------------------------ | --------------------------------------------------------------- |
| 历史展开破坏 MainScreen 阅读   | Stage 1 先用真实输出验证；失败停该集成，不用新阅读页绕过        |
| 双重换行或 ANSI 泄漏           | I3-T02/04/18；控制序列归一化在显示边界，保留原数据              |
| 错误 diff 或持久化丢失事实     | Agent→SDK→CLI 的同一 fixture 三路径对照                         |
| 恢复自旋、并发查询、旧回执污染 | 假时钟、请求计数、延迟跨会话/epoch 返回测试                     |
| 范围膨胀                       | 仅解决本轮真实数据缺口；不抽象通用 renderer/controller/恢复平台 |

## 2.7 需求映射

P01/P02/P08 → Stage 2a；P03/P04 → Stage 2b；P05 → Stage 1；P06/P09 → Stage 4；P07 → Stage 0/1/3。所有 Stage 的测试映射见 04。Ctrl+R 的取消覆盖 improve-2 的旧保留要求，其余前轮约束继续继承。

## 2.8 范围外

全量 pi 迁移、pi Editor、工具搜索/筛选/分页、独立阅读页、原始日志无限保存、外部日志服务、剪贴板依赖、新语法高亮系统、流式参数猜测 diff、自动重跑失败工具、模型重试策略重做、权限/Tasks/队列扩展。没有提前建立 improve-4。

## 2.9 承重改动入口

延续 plan 要求的文件与符号清单。行号以 `5c2adab5` 为快照，不作为实施进度表。

| 入口                                                                                                                        | 承重责任                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/ohbaby-cli/src/tui/render/markdown.ts` 的 mdToAnsi；`render/wrap.ts`                                              | 减少自制文本解析、控制 ANSI 与 Ink 的宽度边界                |
| `packages/ohbaby-cli/src/tui/components/message/parts/tool-part.tsx:9`；`message-row.tsx`                                   | 同一调用的标题、结果和状态，紧凑/展开                        |
| `packages/ohbaby-sdk/src/snapshot.ts:150` 的 UiToolResult                                                                   | 可选展示事实契约                                             |
| `packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts:193`；`adapters/ui-state/persistent-store.ts:83`       | 实时与历史共享白名单投影                                     |
| `packages/ohbaby-agent/src/tools/utils/output.ts:50`；`tools/utils/mutation-budgets.ts`；`tools/write.ts`                   | 正确行 diff 与执行时有界采集                                 |
| `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts` 的工具结果状态转换                                                  | error 部分输出与序列化链                                     |
| `packages/ohbaby-cli/src/tui/session-recovery.ts:285`；`app.tsx:551`                                                        | 自动恢复接续与取消 Ctrl+R                                    |
| `packages/ohbaby-server/src/protocols/jsonrpc/client.ts:657` 的 ensureInitialized、runSseReconnectLoop；SDK client 读取签名 | 初始化失败缓存、读取期限与取消传递，验证同一 client 重入幂等 |

连带：tool state 类型/校验、SDK RPC、CLI Prompt 提示、package.json/lockfile、相关测试。前轮 transcript 输出入口以 Stage 0 的实际实现定位，不预先把某个 Static 改法写死。
