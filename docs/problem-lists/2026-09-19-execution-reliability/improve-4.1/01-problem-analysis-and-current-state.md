# 现状、请求链路与问题分析

> 2026-09-29。基线 `8d154655fc64c3ed377eca44c5053a885b966239` / `codex/improve-4`。本文件记录调查事实，不表示下述建议已实施。产品范围见 [goal-duty](goal-duty.md)。路径以仓库根为基准，行号是调查快照，定位以符号为准。

## 1. 证据分层与问题索引

| ID  | 问题                                                        | 证据等级                                                     | 对应目标 |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------ | -------- |
| P1  | 健康进入会话无条件重建视图，制造 generation 不一致与重读    | 2026-09-28 真实本地服务、实际 Web runtime 与浏览器诊断       | G1       |
| P2  | 首次读取与执行恢复/视图初始化存在竞争                       | 2026-09-28 受控初始化闸门诊断                                | G1       |
| P3  | 首次加载超过 800ms 也被标为 Recovering；健康检查抢占 header | hook 代码、受控 React 测试；header 为静态链路                | G1       |
| P4  | Bash 异常行额外显示警告符号                                 | 用户截图、组件与现有测试                                     | G2       |
| P5  | skill 展开全文用来起标题，末尾用户意图可能被截断            | 完整代码链路 + 2026-09-29 sanitizer 探针                     | G3       |
| P6  | 子代理任务标签与连续会话名称混用，点击不同卡片可能换标题    | 代码链路；未单独做本轮浏览器复现                             | G4       |
| P7  | Web 无正文 action 生成空成功卡，下一次消息/run 不清理       | 用户截图 + 生产 reducer 探针                                 | G5       |
| P8  | 同 invocation 的后续 action 覆盖先前有效 output             | 生产 reducer 合成事件探针；协议允许多次 output/action        | G5       |
| P9  | 清卡可能隐藏业务失败，HTTP200 被误当操作成功                | command.fail→正常返回→GoalOverlay 的静态链路                 | G5       |
| P10 | 迟到、重放、跨 scope 的 command 反馈缺少明确展示归属        | 服务端/SDK/Web 静态链路；部分 reducer 条件已验证，待完整集成 | G1/G5    |
| P11 | 子会话常驻 Jump to latest 向下箭头被用户要求移除            | 用户截图和 SubagentView 接线                                 | G7       |
| P12 | 缺少 execution 时所有工具详情都显示相同缺失说明             | 用户截图、组件、既有测试与服务器端渲染探针                   | G8       |
| P13 | 独立工具结果组件未传已有 execution，误显示缺失说明          | 组件代码及带有效 execution 的服务器端渲染探针                | G8       |

2026-09-29 探针直接调用当前生产 reducer 与 sanitizer，未启动服务、没有模型请求，不将其称为浏览器 E2E。结果见 [探针输出](evidence/2026-09-29/reducer-and-title-input-probe.json)，方法及基线测试见 [证据说明](evidence/2026-09-29/research-notes.md)。

## 2. 会话切换与恢复：接续已确认诊断

`packages/ohbaby-agent/src/adapters/ui-inprocess.ts:3650` 的 `initializeSession` 顺序为：等待启动 → 权限根校验 → `promptScheduler.recoverSession` → `initializeSessionView` → 无条件 `owner.rebuild`。

`adapters/ui-state/session-view.ts` 的 rebuild 重新初始化视图并产生新 generation；恢复检查期间却已在旧 generation 上发布状态增量。`packages/ohbaby-sdk/src/session-sync.ts:140` 将新 baseline 与缓冲事件对齐时发现版本冲突，正确拒绝混装，随后重读。

2026-09-28 的三轮、共 15 次选择/切换（包含重复选当前会话）均出现该冲突。首次读取约 5–8ms、HTTP200，无人为网络延迟；第二次 baseline 在重试后成功。此处不是“超过 800ms 才闪提示”。

首次进入的另一问题：server select 发起初始化但不等待全部完成；新 partition 尚未创建时，`getSessionView` 的 ready/read 和 catch 后 rebuild 都可能遇到 `Session view has not been initialized`。受控延迟恢复检查已触发该错误。

Web 的 `ui/session/use-session-sync-banner.ts` 把有旧 view、错误、重试以及超过 800ms 的首次加载归入 recovering。`SessionScreen.tsx:876` 渲染顶部恢复横幅；`selectors.ts:160` 则让 executionRecovery 的 recovering 优先于任务状态，显示 Checking execution records。

职责问题：执行安全检查、投影准备、网络视图同步、面向用户的恢复说明被混在一起。修复方向须保留每次必要检查与 SDK 一致性保护，不以缓存 ready 跳过检查，不让普通读取反复写恢复事实。具体同步顺序与提示方案由 02 冻结。

## 3. Bash 感叹号

来源是 [tool-card.tsx](../../../../apps/ohbaby-web/src/ui/conversation/tool-card.tsx) 的 `ToolCard` / `ToolPanel`：

- `ToolCard:80–92` 从 execution.outcome 或 failed 状态计算 abnormal。
- `ToolPanel:143` 把异常含义写进按钮的 aria-label。
- `ToolPanel:159` 额外输出 `<span aria-hidden="true">⚠</span>`。
- failed 同时影响工具名称颜色；详情仍展示 execution、input、output/error。

它是 UI 装饰，不是 Bash 错误内容，也不控制取消、资源保护或失败记录。用户要求可以局限为 Bash 行移除该符号，保留时间、错误正文、可访问语义。共享组件也服务其他工具，不能无说明扩大为所有工具状态清空。

`tool-card.unit.test.tsx:119` 当前显式断言该符号存在，说明已有测试固化了旧设计；后续应更新相关断言，而不能因旧测试通过宣称新需求满足。

## 4. 主会话命名

### 4.1 触发、输入与写回

主会话不是每条消息都起名。主要链路位于 `ui-inprocess.ts`：

1. `resolveSubmissionSession:1153` 为新会话生成临时标题。
2. `isFirstUserMessageForTitle:2534` 排除子代理、非默认标题、已有 UI/持久消息或 messageCount 的会话。
3. `submitPromptWork:2931` 判断新会话或默认空会话的首条 prompt。
4. 主执行开始并附加用户消息后，`:3067` 异步 `scheduleSessionTitleGeneration`，不等待命名完成。
5. `scheduleSessionTitleGeneration:2596` 取得当前 LLM client，单独调用 `generateSessionTitle`。
6. `applyGeneratedSessionTitleIfUnchanged:2621` 仅当当前标题仍等于预期临时标题时写回。

临时标题使用 `services/session/prompt-sanitizer.ts`：脱敏、压缩空白、截断到 48 字符。正式命名失败或 5 秒超时则保留临时标题，后续消息通常不会再触发；没有持久自动重试任务。

“首次一次”指命名任务次数。底层 provider 可以在尚未输出的可重试错误上再次发请求，不等于网络层严格一次。

### 4.2 标题请求组装

[title-generator.ts](../../../../packages/ohbaby-agent/src/services/session/title-generator.ts) 只构造两条消息。

System 文本由以下五句以空格连接：

```text
Generate a concise title for a coding-agent chat session.
Use the same language as the user's first message when practical.
Reply with only the title: no JSON, no markdown, no quotes, no explanation.
Keep it short: at most 8 English words or 24 CJK characters.
Do not include credentials, tokens, keys, URLs with secrets, or private values.
```

User 文本为 `First user message:\n` 加脱敏、压缩空白、截断至前 2,000 字符的提交文本。

| 项目           | 当前实际行为                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 模型           | `resolveLLMClient` 使用注入 client/factory 或当前项目配置；没有标题专用模型设置                                              |
| 请求           | 独立 `streamResponse`，`purpose: session-title`，`maxTokens: 128`，独立 AbortSignal，5 秒期限                                |
| 共享内容       | provider/client 配置，注入时也可能共享 client 对象；不共享主执行 messages 或同一次 HTTP 请求                                 |
| reasoning      | provider 能力允许关闭时，标题请求关闭 reasoning；不能关闭的模型仍遵守其能力约束                                              |
| context/system | 不调用执行 system-prompt assembler、context manager、执行历史拼接或工具菜单                                                  |
| cache          | `core/llm-client/prompt-cache.ts:215` 对辅助 purpose 采用 observe-only，不复用主执行显式 key；不代表 provider 不可能隐式缓存 |
| 协议转换       | OpenAI-compatible 保留 system/user；Anthropic 抽到 system 字段；Responses 转 instructions                                    |
| 输出           | 清理 think、围栏、JSON/title、引号和空白，最后硬截断 80 个 JS 字符；8 个英文词/24 CJK 是提示要求而非同等运行时硬限制         |

可以优化的是这个独立标题 prompt 与素材来源。执行层已有稳定前缀与工具 epoch 设计（如 `bf899620`）不应被顺带修改。尤其不要修改共享 client 的 maxTokens 来控制标题请求，否则会影响主执行。

### 4.3 skill 首次命名的已确认缺口

```text
用户输入 /skill-name 原始要求
  → commands/service.ts executeSkillCommand
  → skills.loadPrompt / formatSkillToolOutput
  → 技能名、目录、scope/source、文件/脚本说明、SKILL 全文
  → 在全文末尾追加 User request: 原始要求
  → submitPromptAndWait(整段文本)
  → submitPromptWork 同时把整段文本传给标题生成器
  → sanitizer 仅保留开头 2000 字符
```

代码锚点：`commands/service.ts:183–215`、`skill/tool.ts:156–192`、`ui-inprocess.ts:3523–3539,3067–3073`、`prompt-sanitizer.ts:1–18`。

探针将 4,100 字符的模拟技能展开文本送入真实 sanitizer，输出 2,000 字符，末尾用户要求完全消失。即使改标题 system prompt，也无法补回已被截掉的任务信息。该探针证明输入丢失，没有测量真实模型错误标题比例。

建议方向：命名使用展开前的技能名和原始要求；执行 prompt 保持现状。有参数时以任务意图为主，无参数时用技能名/简述回退。不要从展开全文中反向猜测或解析 User request 分隔符。

当前 durable prompt record 主要保存 text，没有已存在的独立标题素材字段；若引入旁路命名素材，必须覆盖接受、排队、编辑、retained 手动重发与重启路径，尤其不能编辑正文后仍沿用旧命名素材。具体最小承载方式尚未冻结，不先假定必须新增数据库表或迁移。

### 4.4 并发与测试缺口

已有“生成期间人工改名不被覆盖”的 contract；但读取、比较、写入是分开的操作，`session/manager.ts` / `database-store.ts` 未使用 expected-title 条件更新。人工改名恰在检查后、写回前发生的窄竞态仍需闸门测试，当前列风险而非已复现故障。

现有清洗不能证明模型总能只输出合适标题。后续质量样本应覆盖普通任务、长消息、混合语言、仅 skill 名、有 args 的 skill、空输出和超时；不无证据增加 token/时间额度或切换模型。

## 5. 子代理与连续子会话的名称

子代理不调用 `generateSessionTitle`。主代理模型填写正常 `subagent_run` 参数，实例保存 name、description、initialPrompt；继续同一 subagent_id 使用原实例。证据：`agents/subagent-host.ts:844–895,968–1000,1573–1585`。

底层同一 parent 的多个子代理可共用一个 child Session，各有独立 contextScopeId。第一个子代理的 description 可作为物理 child Session.title。这与用户看到的连续子会话不是同一层：improve-3.1 按 `(rootSessionId, subagentId)` 分离读取和历史，见 `adapters/ui-inprocess/subagent-conversation.ts:118–142`。

Web 的实际展示链路：

- `ui/session/DelegationRow.tsx:66`：每次工具调用按 description → name → prompt 首行生成任务标签。
- `SessionScreen.tsx:982`：点击时把该标签保存为 childTitle。
- `SessionScreen.tsx:1138` → `SubagentView.tsx:98`：面板显示 childTitle。
- 并非读取底层 Session.title，也未发现已存在的独立 conversationId/displayName 字段。

因此同一个连续子会话，从初次/继续任务的不同卡片进入时，标题可以不同。现行执行 prompt 的 `subagent-roles.md` 说明 name 是 display name，Web 却优先 description，存在命名语义未统一的问题。

调研后的产品结论已获用户确认：区分“每次任务摘要”和“稳定会话名”，使用已有实例元数据，不增加子会话独立命名请求。不为了引导命名修改主执行 system prompt 或工具 schema 描述。当前代码仍是上面描述的旧行为，尚未实施新约定。

## 6. Slash command 的过程、结果与残留

### 6.1 请求与事件链路

`SessionScreen.tsx:503` 识别 slash → `runtime.ts:151` 解析目录并绑定 clientInvocationId/sessionId → `POST /v1/commands` → `commands/service.ts:271` 发 Started → handler/skill → output/action/failed → `adapters/app-events/projectors.ts:70` → Web `eventReducer.ts:137` → `CommandNoticeList` 或结果 modal。

skill 的具体行为是 await `submitPromptAndWait`，等内部 prompt/run 结束后才发 `skill.submitted` action。action 没有 output，且名字 submitted 不能用来推断它在接受时发生。外层 command 状态与内部 prompt/run 状态同时存在。

Web 对任意 result.delivered 标记 success，无 output 就填 `Command completed`。截图正是这条投影的结果；skill 能否执行不依赖这张卡。

### 6.2 残留的原因

`eventReducer.ts:9,194` 仅按 commandRunId 覆盖并保留最后 8 条。没有下一轮清理、过期或用户关闭动作；`CommandNoticeList:21` 也没有关闭入口。

生产 reducer 探针确认：skill action 生成 success 空卡；其后同会话 message.appended 和 run.updated 不清卡。正常 store.install 继续保留 notices，见 `apps/ohbaby-web/src/store.ts:106`。

这不是持久聊天消息，未找到数据库或浏览器存储的卡片记录；无需设计“清除历史数据库卡片”的迁移。刷新通常创建空 notice 集合，但不能据此忽略正在执行的命令或重放事件。

### 6.3 为什么不能把所有命令事件直接删掉

| 命令类型                            | 有用反馈                                  | 当前问题/约束                                           |
| ----------------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| `/<skill>`                          | 正常 prompt/run 与对话正文；加载/提交错误 | 重复 running 与空 success 卡没有额外信息                |
| `/help /status /skills /mcps`       | 可阅读、可操作的查询结果 modal            | 结果应保留；关闭目前仅记录 closed ID，未移除底层 notice |
| `/connect /connect-search /compact` | 专用 overlay 的运行结果                   | 实际动作主要走专用 RPC，不应额外留聊天卡                |
| `/goal`                             | 原操作面板内的业务结果                    | raw command 返回不等于业务成功，清卡前必须修正错误归属  |
| interaction / permission            | 需要用户输入或审批                        | 属于独立交互协议，不能当残留清掉                        |

`CommandNotice.kind` 只有 running/success/error，不存在 requires-action；需要用户输入是另外的 interaction 协议。应保持这种职责区别，不新建混合状态机。

### 6.4 output、action 和成功不是同一个概念

同一命令可先 emitOutput，再 emitAction。server 的 `client-view.ts:921` 明确说明 result 并非一定终态；`rpc-route.ts:600` 的 new/resume 路径可发两条结果事件。

探针验证，同一 commandRunId 的 text output 会被随后无正文 action 覆盖成 Command completed。因此“每条 result 立刻清掉全部状态”会丢有效输出，也不能据它释放所有 invocation 关联。后续设计应让 action 处理副作用，同时保留已获得的有效正文。

`commands/run-context.ts:44` 的 fail 发布事件但不抛错；`commands/service.ts:297` catch 后也可正常返回；REST 返回200。`GoalControl.tsx:79` 当前仅 await 返回就显示 successMessage。静态链路存在业务失败但面板显示成功的风险，原错误可能只在通用卡片中出现。清理必须与错误归位一起完成，后续用真实 handler 或服务端故障注入验证。

### 6.5 会话、关闭与重连归属

- 常规切换通常经过 changedScope 无 view 的分支，清空 notices；直接 install 带 view 的新 scope 却可能保留旧数组。应有明确作用域规则，不依赖某个中间帧。
- server `client-view.ts:1018` 以 client owner 路由结果，不要求它仍显示原会话。
- SDK result/failed 事件包含 commandRunId/clientInvocationId，不直接携带 sessionId。清理 started 元信息后，迟到事件在 reducer 中会生成无 scope 的 notice，selectors 又把整个数组交给视图。
- 同 scope 重同步保留 notices；SSE 可重放结果。关闭后不能因重放重新出现。
- disconnect 清理服务端 command owner，与仍在运行的 command 交错可能丢反馈；当前仅静态风险，尚未做本轮端到端复现。

需要保留的是识别正在处理的 invocation 所必需的关联，不是把其卡片永久留在聊天里。后续优先利用现有 identity；若必须补字段，仅做当前链路所需的最小扩展。

### 6.6 可复用的 TUI 边界

`packages/ohbaby-cli/src/tui/store/events.ts:283–345` 已做到普通 started 不一律显示卡，无 output 的 result 忽略，failed 仍保留；`:121,198,228` 在当前会话新消息/run 时清理命令临时 notice；切换时仍保存必要的 command/session 关联来辨认迟到事件。

Web 可以对齐这些语义，不必把 TUI 的布局搬到 Web。两端真实查询结果和失败可见性仍需回归。

## 7. 文档与代码的差距

| 现有说明                                               | 当前实际代码                                       | 本阶段应补充的内容                          |
| ------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------- |
| improve-4 05：当时实施与验收通过                       | 正常切换出现额外 generation 冲突，测试遗漏中间反馈 | 新阶段登记缺陷及独立验收，不回填为旧轮已修  |
| Web skill-invocation：统一命令提交技能，事件流显示执行 | 外层空成功 action 又被 Web 投影为聊天卡            | 反馈归属和清理契约；执行能力保持            |
| session goals-duty：标题默认自动生成，可人工编辑       | 主/子路径不同，skill 展开文本可污染主标题          | 首次命名素材、子会话名称和防覆盖边界        |
| subagent prompt：name 是 display name                  | Web 卡片/面板优先 description，面板随卡片变化      | 明确会话名与任务摘要关系；不修改执行 prompt |
| Web 工具失败规则：保留可读错误和结果                   | 除颜色/详情又显示警告符号                          | Bash 符号移除，错误信息仍保留               |

## 8. SWE 判断与后续验收候选

问题集中在已有层次之间的语义衔接：执行恢复不等于页面恢复，完整执行 prompt 不等于命名素材，command 输出不等于最终成功，任务摘要不等于连续会话名称。优先修正这些边界和现有数据来源，不叠加新平台或大量缓存。

以下调研场景已转入 [04 的 T01–T38](04-test-and-acceptance.md)，与 02 一起待整体审查，尚未执行：

- G1：快速/慢速/首次/重复/多客户端切换，真实恢复失败，A→B→A 与草稿/操作归属；观察全过程并核对 baseline 次数和 generation。
- G2：Bash 失败、取消、超时与 live/snapshot 展示；无警告符号，但错误、耗时、展开和可访问语义仍正确。
- G3：普通首条与后续、人工标题、skill 有/无 args、长正文、入队/编辑/retained 手动重发；命名素材不丢，不改变执行输入。
- G3：标题请求捕获，仅包含辅助标题消息，没有 tools 或主执行显式 cache key；不改共享 client 配置；标题用量与主 Run 隔离。
- G4：多个子代理隔离，同一子代理继续、点击不同任务卡、名称缺省和长/多行输入。
- G5：无正文成功无卡；查询结果仍可用；output→action 不覆盖；真实 command.failed + HTTP200 不冒成功；skill 加载/提交/执行失败有正确出口。
- G5：关闭、下次输入、切换、迟到、重复和重放、同 ID 不同 runtime；不复活旧卡，不丢审批，不无期限保留关联。
- 验证层次：先确定性单元与集成，再编译版 Web/TUI 过程验收；标题质量另用真实模型样本评估，不能由单测绿色替代。

2026-09-29 的 54 项现有定向单元测试全部通过，只说明基线行为可运行；其中有测试仍断言旧图标。新需求对应的修复与验收均未开始。

## 9. 追加：子会话向下箭头与工具阶段缺失提示

### 9.1 箭头的实际行为与范围

`apps/ohbaby-web/src/ui/session/SubagentView.tsx:226–240` 总是渲染 footer 中的 Jump to latest：小面板为浮动按钮，展开视图也有同一按钮。点击先设置当前阅读位置 sticky，再调用 SDK reader.jumpToLatest，完成后递增 latestToken；ConversationStream 的对应 effect 贴底。该按钮不负责正常向下滚动或一般分页。

正常阅读另有 readingCache、anchorMessageId、onNearEnd→loadLater、loadEarlier 和有后续页时的 Load later messages 边界；移除箭头不能连带移除这些通路。SDK 的 jumpToLatest 仍是独立接口，是否清理未使用的内部接线应查实际调用方，不因删按钮就删除公共 API。

现有 SubagentView 单测把该按钮当作最后一个 Tab 焦点；实施时需要更新为真实剩余控件，并验证焦点闭环、Escape、展开/关闭不退化。原 improve-3.1/frontend 的 03/04 明确设计过该按钮，本次用户要求覆盖该交互；旧文档保留历史记录，实施时同步活跃规格。

### 9.2 阶段信息从哪来

- 新执行：`core/lifecycle/lifecycle.ts:1788–1815` 的 save 将阶段观测写入工具 part 的 `metadata.execution`，最终工具结果与阶段事实一同保存。
- 历史投影：`adapters/ui-state/persistent-store.ts:108,141–144` 将同一 metadata 投影到 UI call/result.execution。
- SDK：`packages/ohbaby-sdk/src/execution.ts:66–110` 的 projectToolExecution 对缺失或无效的 phase/createdAt/phaseStartedAt 返回 undefined，不捏造时间。
- 普通工具卡：`tool-card.tsx:75` 取 result.execution，缺省才取 call.execution；`:179` 无数据时无条件展示缺失文案，不检查记录年代或工具种类。
- 独立结果：`OrphanToolResultCard:110–127` 没有把 result.execution 传给 ToolPanel，所以即使结果有合法阶段信息，也会走缺失文案分支。分页窗口缺少对应 call 时可能使用该组件。

旧格式没有这些新增可选字段本身可以正常；第二轮已明确旧记录不补造时间。但是逐张展示同一句实现层说明既不能恢复信息，也容易让人误以为工具执行失败。若新版记录本来有 execution 却在读取/展示后消失，则是真正需要修复的丢失，不能统称 legacy。

本次没有读取用户真实数据库，因此不声称截图中每条旧记录均属哪一种情况。截图证明用户可见现象，代码/探针证明触发条件和独立结果组件遗漏。

### 9.3 动态诊断与后续要求

用 React server rendering 渲染实际组件、强制展开工具详情，合成三种输入：旧 call 无 execution、有 execution 的正常配对 call/result、仅有 result 且带 execution。结果分别为：显示缺失提示 / 正确显示 Execution / 错误显示缺失提示；三者 output 均可见。证据和复现命令见 [工具历史探针说明](evidence/2026-09-29/tool-history-notes.md)。这不是浏览器或用户数据回放。

`tool-card.unit.test.tsx:395` 原测试明确要求 legacy 展开时显示该说明，需要随产品要求更新。新增回归要验证无字段时安静展示、有字段时完整保留、真实错误仍可见，以及保存→重新打开→历史分页→子会话的阶段事实一致。
