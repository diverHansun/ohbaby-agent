# improve-3.1 实施与验证记录

日期：2026-09-28。基线 `1a7018f1`，本地分支 `codex/improve-3.1`。已有规划文件随工作区进入新分支；没有 merge 或 push。

实现已落地，组合验收仍有外部验证缺口。本文记录实际工作，不作为“所有验收门通过”的 05 报告。

## 分批交付

| 提交 | 内容 |
| --- | --- |
| `24cf4cf6` | 确认实施范围，保留 TUI Ctrl+G 内部详情 |
| `59e577d9` | 接受时预留父消息身份和委派顺序，持久化迁移、有界双向历史 |
| `069b72a2` | 独立 scope 投影、锚点窗口、SDK reader、REST/RPC 与共享 SSE |
| `482a1e8c` | Web 紧凑任务行、单浮层/放大、共享消息组件与只读控制面 |
| `94c926d7` | watch 乱序、取消和历史恢复回归修复 |
| `d2b93b3d` | 修复输入区布局回归，完善子会话阅读样式与打开动画 |
| `09462d9a` | 审批卡取代输入区，保留草稿、Todo 状态和停止入口；焦点与重复应答保护 |

执行调度沿用 improve-3。新读取能力按 root/scope 授权，实时版本不混入根投影；接受排队消息只产生展示记录，真正启动时才写入模型历史。重复委派沿用逻辑子会话，显式历史入口定位相应父消息。

Web 移除独立 Subagents header。父消息使用蓝色气泡和 `From parent`，排队标记 `Queued`。浮层/放大共用内容；关闭后保留各子会话工具展开状态。浮层打开时主输入框保留尺寸和草稿，显示 `Read-only subagent`；放大后隐藏输入框。审批提示只有 `Approval required`，关闭后在主会话操作。实际审批卡取代根输入区及 Todo/队列，最后一项审批处理后恢复；纯同步错误不隐藏输入区。

## 审查与修复

原生子代理分工检查身份/分页、传输和 UI，并在完成后独立审查。修复均补有回归：

- 快速 A→B 时，迟到的 A watch 不得覆盖 B；客户端单调 `watchSequence` 保留点击顺序，服务端在异步读取前拒绝低序请求。关闭、响应丢失和取消先于接单均按预分配 ID 释放，旧取消不影响新选择。
- 重连保留同代际已加载历史，不把正在阅读的旧页替换成最新尾部；代际改变重新取权威快照。
- 旧记录缺消息 ID 时报告锚点不可用，不把“execution 存在”误写为精确定位成功。
- 关闭重开保留工具展开状态；点击具体委派仍优先使用显式消息锚点。
- 精确定位后不被 near-bottom 自动跟随覆盖；读取排队委派时不插入前一轮不属于显示窗口的更新。

空会话输入框恢复原相对定位；正文输入区限定在主内容列内，避免侧栏遮挡。浮层按实际输入区矩形定位，恢复白色背景、44px 头部和 180ms 上滑动画。委派接受前失败仍展示原工具错误卡。

运行时旧 E2E fixture 曾因默认后台模式变化和 interrupted 收据形状过期而失败；基线也可复现。修正测试的显式 foreground 参数和 interrupted 断言，未改变执行行为。

## 浏览器证据

使用原生浏览器操作本地编译服务。服务、provider fixture、数据库和工作目录均隔离，结束后关闭自建服务。

- 主任务行打开唯一子浮层；可见 `From parent`、渐进文字/思考、`Queued` 和自然保留的最终回答。
- 同一子代理第二条消息排队时即可定位；完成后没有重复父气泡，向前加载可见两次委派的完整内容。
- 子代理工具沿用主会话的输入/输出折叠卡片；审批到来不弹出子会话审批框，回根后才能处理。
- 放大保持内容，保留实际根标题面包屑；Escape 关闭，根输入恢复。页面刷新后可以从历史任务行重新打开。
- 390×844 与 720×540 验证无横向溢出；浮层下沿距输入框外壳上沿实测 10px。默认桌面同样为 10px。

审批补充使用新的编译服务和真实 `todo_write` fixture 验证：子窗口仅提示 Approval required；返回根后焦点进入审批标题，输入与 Todo 隐藏但草稿保留，Stop 图标可见。390px 下卡片高 188.195px、消息流底留白 212.195px、卡片底距 12px，状态栏为 44px；默认桌面同样按卡片实高加 24px 留白。审批完成后输入区恢复，四次委派 completed、交付 processed、根和普通排队 prompt succeeded、最终 read 工具完成的数据库检查通过。快速 A→B→A 后只有 A 内容，浮层距输入区 10px；C 工具展开后关闭重开仍展开，放大页保持内容。控制台无 warning/error。

该 fixture 超过 60 秒会显示 improve-3 已有的 runtime system 通知正文；本轮没有改变该存量消息展示行为。

审批后 Todo 在任务仍运行时的恢复由组件测试覆盖；本次浏览器审批通过后立即释放全部子任务，完成态按既有规则收起 Todo。补开的独立浏览器验证页返回 ERR_BLOCKED_BY_CLIENT，已停止该 fixture，未将此补测记为通过。

200% 浏览器缩放和操作系统 reduced-motion 尚未实机覆盖；已核对对应 CSS 降低动态效果规则，不能以代码检查代替该两项浏览器结果。

## 真实模型与 Pi 的实际边界

已有真实两子代理流程使用 `openai/gpt-5.6-luna` / ZenMux Responses，旧版断言运行 104 秒通过（本机日志 `/tmp/improve31-real.log`）。独立审查随后发现 `streamed` 只要求 revision 变化，无法排除纯元数据事件，现已改为要求非空正文增量。加强断言后仅尝试一次，约 0.765 秒在 setup 失败，未进入 provider stream；不能把旧通过结果当作新流式断言通过。最新 `.ohbaby/test-evidence/improve-3/real-background-steer.json` 已被本次失败证据替换。setup 包含不计入 stream 请求计数的模型窗口预检，故 stream 请求数为零不代表没有网络预检。

新增真实同子代理重复委派测试保留为 opt-in，验证忙时接收、展示与正式消息身份、模型上下文隔离。Luna 和清单内 Sonnet 5 的后续尝试均在准备阶段返回请求超时，尚无 execution，不能算 T11 通过。用户优化网络后，补齐独立 home/storage fixture 再尝试一次，仍在约 33 秒的准备阶段超时；agent-step 请求结束但流未正常耗尽，无工具调用和 execution，清理成功。诊断保存在本地 `.ohbaby/test-evidence/improve-3.1/real-same-child-conversation.json`；测试限制最多 15 次请求并清理临时会话，未将凭据写入证据。

本轮 Pi 使用用户指定 `github-copilot/claude-opus-5.5` / medium。前两次实际请求返回 `400 model_not_supported`；用户调整网络后，第三次请求成功，Pi session 元数据确认 provider/model 未切换。其代码与截图审查发现空态输入框定位回归、浮层视觉层次不足、任务行偏高及缺少打开动画；这些意见经本地代码核实后纳入修复。后续只针对审批占位再咨询一次，采纳焦点、防连续应答、实际高度留白与保留停止入口的建议。Pi 没有实施代码，也没有代替原生浏览器操作验收。

## 已执行验证

| 检查 | 实际结果 |
| --- | --- |
| 仓库单元/集成测试 | 453 文件通过、6 跳过；4927 测试通过、17 跳过（最终审批补充后） |
| Web 回归 | 31 文件、404 测试通过（审批补充后） |
| runtime 子代理 E2E | 8/8 通过 |
| build / typecheck | 通过 |
| lint | 0 error，81 个存量 warning |

审批补充定点测试先复现失败，再通过 157 项；独立子代理复查未发现剩余阻断。完整仓库最终测试在本批改动后通过，耗时 201 秒。

## 复现入口

```sh
pnpm test
pnpm lint
pnpm build
pnpm typecheck
pnpm exec tsc -p tests/smoke/subagent-conversation.tsconfig.json
pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-agent/src/adapters/ui-runtime/subagent.e2e.test.ts
node scripts/run-subagent-continuation-e2e.mjs --conversation-ui --approval
OHBABY_RUN_REAL_SUBAGENT_CONTINUATION=1 pnpm exec vitest run --config tests/smoke/subagent-continuation-real.vitest.config.ts
OHBABY_RUN_REAL_SUBAGENT_CONVERSATION=1 pnpm exec vitest run --config tests/smoke/subagent-conversation-real.vitest.config.ts
```

浏览器 fixture 输入 `I3_START`。终端可用 JSON 命令 `progress` / `release` 指定 A、B、C，`release` 的 `approval` gate 控制审批到达时机；`check` 检查 waiting/terminal，`quit` 清理服务。完整测试中的编译进程会更新 dist，build/typecheck 应在测试完成后顺序运行。

## 用户审查补修：旧委派永久 Connecting

用户截图中的早期记录经本机数据库只读检查确认：工具已 completed，结果在 `state.metadata.subagent.item`，没有对应 execution 记录；子 scope 的消息仍存在。新任务行缺 execution 时误显示 Connecting 并禁用，导致原本可展开的工具结果消失。

补修分两层：无 execution 的已结束调用/已有结果恢复原 ToolCard，允许展开当时保存的输入输出；带 execution 的较新历史，其身份位于 `ToolState.metadata`，持久化 UI 投影此前只透传 Part metadata，现单独保留 subagent execution 身份，防止超出列表首屏后入口失效。不复制旧 item、不伪造 execution、不改用户数据库。

早期 `subagent.item` 完整子会话尚未接入新查看器，仍是明确兼容边界；此次恢复原结果可读，不宣称完整迁移。新格式已完成子代理仍可重开阅读。两个回归先 RED 再 GREEN（23 项定点通过）；受影响 Web/投影/SDK/历史回归 43 文件、522 项通过；独立子代理复审无阻断。

## 2026-09-28 剩余三项补修（实施中）

用户实机暴露并确认纳入：内部通知正文泄露到 Web、上下文统计查询/显示不同步、缓存读取率显示调查（保持原 /status 入口）。此前“未改变存量 runtime 通知展示”现被本批范围取代。

调查证据：同一历史会话 /status 返回 21.1k / 1m 而圆环仍 unavailable，确认投影同步缺口。主 scope 持久化虽有 9 个有效 usage 样本（Σinput=117057、ΣcacheRead=74368），这些不属于新进程内统计，不能用历史比例认定 hit — 错误。统计相关主体相对 1a7018f1 未改变。现有定点测试45项通过，但不代表新增接线路径已验证。

SWE 约束：复用来源标记与现有投影、原统计口径；不引入文本猜测过滤、通用可见性框架或额外统计面板。完成后在本节补充批次提交、测试、独立审查与浏览器结果。

### 第一批：内部消息显示边界

UiMessage 新增可选 runtimeInputKind，持久化和实时投影透传原分类；Web 共用 ConversationStream 在排列和滚动计算之前排除 subagent-status/subagent-result。role 与实际模型请求不变，无正文匹配或全局 system 过滤。新增5项断言先失败，随后主/子共享流、投影以及三种 runtime 输入的模型保留合同共29项通过，独立子代理审查无阻断。

### 用户收紧范围与调查纠正

重新查阅 [既有 cache 合同 K6](../../2026-09-11-llm-sdk-and-responses-migration/improve-5/00-discussion.md) 后确认：进程内生命周期、不跨重启恢复是明确设计，先前将数据库旧9条usage与当前 hit — 比较并认定恢复缺陷不成立。用户要求统计口径/基本算法不变。Last request 回退与历史 cache 重建均撤销（未提交），改为只修原统计的加载/投影/展示。上下文沿用 [improve-6 §5](../../2026-09-11-llm-sdk-and-responses-migration/improve-6/02-optimization-plan-and-change-scope.md) 的最近 prepare/compact 快照及未命中时 tools-aware 估算，不新增公式或统计持久化。Pi 已完成一轮边界核查；后续用户纠正与 Git 证据优先，见下文。

### 第二批：沿用原统计的 UI 接线

第一次 Pi 核查支持保留进程内缓存统计，但当时给 Pi 的 cold runtime 边界及 cache 展示位置假设不正确，不能据此验收。该轮曾实现 cache view 推送和 Context Usage 行，用户纠正后已全部撤销。Pi 把 4096 端口误读成 token 数量，该句也不作为证据。

当前第二批仅修复上下文查询：合法主会话 cache miss 恢复原 getRuntime/getContextUsage，估算后发布现有 context 事件到 session view；Web 打开原 Context Usage 弹层触发查询，异步结果不会关掉弹层。不引入轮询、前端估算、cache 展示扩展或历史 usage 重建。

### 用户纠正后的范围与回归证据

此前把“修复 cache hit 显示”记为用户批准在 Context Usage 增加 cache 行，属于实施者误读，不是用户确认。8 月 27 日 session-cache-hit 的 03 明确排除顶栏圆环及 click/hover 详情，cache 只在 /status。现已撤销未提交的 cache 行、CSS、session view 字段和推送接线；上文第二批 cache 方案及对应测试数字仅为被撤销尝试，不代表当前验收。

用户指出重启后应有上下文占用。Git 提交 ff3d2a1c4（9 月 25 日）把原 getRuntime 查询改成 getRuntimeIfStarted/null，导致冷历史查询无法估算。此前据此断言 cold null 是原设计不成立。当前修复恢复原初始化/估算链路并补齐视图投影，不改估算算法，也不调用 LLM。

撤销前全量测试为 4952 通过、17 跳过，build/typecheck/lint 通过；范围纠正后需重新进行针对性验证，不能直接沿用旧结果宣称完成。

### 上下文恢复定点验收

- 后端合同 135/135 通过，新增冷查询、并发、零 provider 请求、视图同步和未知会话保护。
- Web App/ContextUsage 161/161 通过；弹层异步更新保留，关闭不重新请求，详情不含 Cache。
- 修正后全仓 build、typecheck、lint 通过（lint 81 项既有 warning，0 error）。
- 原生浏览器真实重启隔离服务，读取已有 fixture 会话：首次点击 Context Usage 后显示 8% Full、~10.2K / 128K。模型 fixture 服务已关闭；没有依赖新的模型请求。冷估算仅总量，遵循原合同。
- 同一历史会话的完成子任务仍能打开，父消息与后续委派、最终回答保留；主会话不再出现内部 Runtime subagent 通知。截图保存在本地 /tmp/improve31-ui/context-after-restart.png 与 child-after-restart.png。

### 最终复核与限制

Pi（github-copilot/claude-opus-5.5，medium）读取整体 diff 与截图后指出异步静态估算可能覆盖较新的实时占用。已先复现再修复：await 后优先保留 tracker 新值，不改公式。后端合同与初始化集成共 145 项通过。模型切换后旧 view.context 的清空及其与旧查询并发的问题属于另一个待核查点，本批未扩展修改。

修正后的全仓运行得到 4939 通过、1 失败、17 跳过；唯一失败仍是 9 月 25 日引入的 cold null 断言。按更早实现恢复“静态总量无 composition”断言并增加零 provider 请求断言后，该集成文件 3/3 通过。未再次重复整仓运行。最终 build/typecheck/lint 通过（0 error，81 项 warning）。

Pi 提出的 fixture 文本连在一起来自测试模型分块本身（controlled release. 后紧接 REPORT_A_FULL），前端不应自行补空格。旧窄屏截图中内部通知为修复前证据，不能当作当前通知隐藏验收；本批新桌面 fixture 验证超时 observation 和最终 result 均不显示，普通 assistant 进度/最终回答保留。

原 /status 在运行后显示 cache hit 60%，重启后 hit —；Context Usage 中无 cache，沿用原展示位置及统计生命周期。

### 小范围视觉修复与本地提交

- `9bd74aea`：恢复历史上下文查询、保留较新实时占用、更新前端同步及纠正后的文档/回归测试。
- 审批卡片只增加 `overflow-wrap: anywhere`，不改尺寸、按钮或颜色。最终编译资产经浏览器验证：copy 的 clientWidth/scrollWidth 都为 349px（修改前为 349/448），composer 隐藏，长路径不覆盖操作按钮。新截图 `/tmp/improve31-ui/approval-wrap-final.png`。本轮未重新拍摄窄屏图，不以旧图宣称当前窄屏验收。
- fixture 的显式 `--usage` 选项仅为测试返回已知 60% 样本，默认行为不变，不影响生产计量。
- Pi 只读审查，修复由主代理与原生子代理完成；已清理本轮隔离服务，未重启用户 4096 服务，未 merge/push。

## 2026-09-28 发送反馈收尾

用户确认：正常发送不显示 unknown 提醒，删除正常气泡的 Sending/Starting 标签，保持发送按钮与 Thinking 原规则。

根因是 BrowserDaemonClient 在 POST 前持久保存未确认的请求身份，并以 `submitting: true` 发布；SessionScreen 只判断记录列表非空就显示 unknown。正常等待回执与真正结果未知因而混在同一提示中。已有组件测试模拟了提交函数，没有经过客户端发布记录的路径。

修复仅涉及展示：SessionScreen 使用 `epoch-changed || !submitting` 筛选恢复提醒，提示及其按钮使用同一列表；完整记录仍供防重发和刷新恢复使用。正常 prompt 投影不再提供 label，ConversationStream 按需渲染 label，失败/中断信息保留。没有改客户端协议、持久化、提交控制、发送 spinner、Thinking 或 CSS。

验证证据：

- 单元回归先得到 5 项目标失败，覆盖误报警、混合记录和两种 Starting/Sending 来源；后端重启期间的提示继续保留。
- 新增 `submission-feedback.integration.test.tsx`，复用真实持久化 daemon、SQLite、REST/SSE、BrowserDaemonClient 和 App，仅在 fetch 边界控制时序。新/旧会话各验证成功及回执丢失；确认等待期间记录仍持久化、收到回执后移除、未知时查原回执且不重发。目标断言先失败，修复后 4/4 通过。
- 完整 Web 单元/集成回归 33 文件、416 项通过；可选 label 的滚动签名补齐后，App、共享流和新集成 162 项再次通过。全仓 build、typecheck 通过；四个修改的 TS/TSX 文件 ESLint、Prettier 通过。
- 独立子代理审查未发现阻断，另跑 178 项定点测试通过。
- 运行 `node scripts/run-compiled-web-e2e.mjs`，使用本次编译 Web、隔离 profile/数据库、动态端口 55781 的生产 CLI/daemon，以及本地 scripted provider。Playwright 延迟新会话和旧会话的 POST；持续 DOM 观察未出现 unknown 或正常标签，按钮保持 busy，Thinking 不提前。真实 read 工具执行、同会话追加、刷新后的消息唯一性全部通过。额外中断一个未到达服务端的 POST，确认 unknown、查询/忘记入口和草稿恢复仍可用。
- 桌面 1280×900、窄屏 390×844 检查发送态。窄屏截图需等待侧栏响应式过渡结束，最初过渡帧不作验收图；稳定证据为 `/tmp/improve31-existing-sending-mobile-stable.png`，桌面为 `/tmp/improve31-new-sending-desktop.png` 和 `/tmp/improve31-existing-sending-desktop.png`。长 fixture 标识符的既有换行表现不属于本次布局改动。正常路径控制台无错误、无框架异常页；故障注入的 ERR_FAILED 和停止服务后的 SSE 连接拒绝为预期测试现象。
- compiled runner 输出 UI、backend、diagnostics 和 cleanup 全部 PASS；实际 3 次 agent-step、1 次标题请求均由本地 provider 完成。隔离服务已 stopped，PID 和端口释放，未操作用户 4096 服务。

Pi 使用用户指定的 `opencode-go/qwen3.8-max`、max 完成只读样式审查；首轮未发现阻断，建议补拍窄屏稳定帧。补拍后沿同一 Pi 会话再次核对截图及已有集成断言，确认三项范围无阻断。Pi 只审查代码/截图，未代替主代理执行测试。此前调查调用的 DeepSeek 因 provider 区域限制失败，不计为审查通过。

本批代码、回归测试与记录合为一个本地提交，不 merge/push。本节只验收用户确认的三项发送反馈，不替代上文整轮真实 provider 和系统设置验证的既有限制。
