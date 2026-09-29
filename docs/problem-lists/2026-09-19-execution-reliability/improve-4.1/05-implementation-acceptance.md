# improve-4.1 实施与验收

> 2026-09-29。Stage 1–4 及最终审查修复已完成；Pi、独立子代理与最终限定范围复审已完成。最终全量回归、编译客户端视觉验收和服务/截图清理已完成；等待用户本地审查。分支 `codex/improve-4.1`，起点 `8d154655fc64c3ed377eca44c5053a885b966239`。仅本地提交，未 merge、未 push。

## 1. 分批实施与审查

| 批次 | 提交 | 实际验证与结果 |
| --- | --- | --- |
| 方案 | `8e3f3e1b` | Pi `github-copilot/claude-opus-5.5 medium` 及独立文档审查；吸收 blocked 历史、实际修复信号、skill acceptance、输出关联与旧库兼容建议 |
| Stage 1 会话进入 | `e9b615c7` | 380 项定向用例、补充 Web/TUI 用例；独立审查通过；编译服务真实切换前后对照 |
| Stage 2 工具/子会话界面 | `15d0ab46` | 60 项定向用例、物理 SQLite 重开、真实 Web；独立审查通过 |
| Stage 3 命名 | `bc44359c`、`43868bd5`、`009edb76` | 初轮 288 项，修复轮 208 项，标题专用修复 25 项；独立审查两轮后通过；54 次真实标题请求，详见下文 |
| Stage 4 命令反馈 | `31739df3`、`2facccea` | 初轮相关包 1,405 项中 6 个旧夹具失败，修正后对应 52 项通过；最终定向 113 项。复审发现两项恢复边界及输入错误位置问题，修复后 212 项、末次 166 项通过；独立复审通过 |
| Stage 5 综合验收与小修复 | `0ff1374a`、`47605aaa` | Pi 与整阶段独立审查；357 项受影响测试、增量修正后 191 项完整 Web 测试；同一轮限定范围复审通过，实际编译 Web/TUI 复验；最终整仓 5,316 项通过，见第 5 节 |

以上定向用例互有交叉，不相加成整仓数量。每个修复都有针对失败行为的 RED/GREEN；没有用审查结论替代测试。

## 2. 实际行为与验收映射

表中的测试入口为仓库内文件名，配合 04 的完整要求阅读。各批报告已核对；最终质量门与保留限制见第 5 节。

| 验收 | 实际证据及边界 |
| --- | --- |
| T01–T03 | `healthy-session-entry.integration.test.ts`、`ui-inprocess.contract.test.ts`：明确入口仍检查执行安全，冷读与并发初始化受控闸门；真实 server/双 SDK 及编译 Web runtime 的 15 次选择，每次一个 baseline、无 generation/unavailable 错误。第二客户端选择后以稍后的唯一归档事件作屏障，证明当前 generation 与 baseline 数量不变 |
| T04–T05 | SQLite 执行恢复与 persistent adapter：死 owner 变 interrupted、队列 retained、实际修复重建；失败历史仍可读、原错误保留、普通 GET 不重试持久修复。Goal 初始化失败仍拒绝 initialize/执行，control 返回原因明确的 blocked 状态 |
| T06–T07 | Web banner/selector 与 session-recovery：100ms 快读安静，超过 800ms 普通 Loading，真正失败可重试；新绑定优先，迟到回调不覆盖新选择。浏览器 A/B 无误报恢复横幅 |
| T08 | `tool-card.unit.test.tsx` 覆盖 Bash error/cancelled/timed-out 与其他工具；真实 Bash exit 7 保留红色、错误及 Input/Output、可访问名称，去掉额外警告图标 |
| T09–T11 | title-generator、prompt-sanitizer、command、in-process/persistent：首轮资格、已有标题、长 skill 正文与 args、skill-only 回退、多语言；浏览器首次 skill 正式标题自动出现在侧栏 |
| T12–T13 | nullable namingSource 持久化、retained-store、persistent：重开/幂等重放保留来源；编辑后旧来源失效；取消首个排队项仍让实际首轮命名；不自动执行 retained |
| T14 | 捕获专用请求及 54 次真实 wire 检查：purpose=session-title、maxTokens=200、两条消息、无工具/执行历史/显式执行 cache key，共享配置不变；辅助用量不算主 Run |
| T15 | 人工改名 CAS、后续 UI upsert 仅投影；受控交错保护人工名称。真正标题变化发送已有 session.index.invalidated，真实后端→SSE→Web index 覆盖临时与晚到离屏正式标题 |
| T16–T17 | 子代理读取、DelegationRow/SubagentView：实例名稳定、每次摘要独立；实际两次委派使用同一个 subagent/child session，仅主会话有标题请求。空/JSON/think/超时/错误及 length finish 回退，不增加重试请求 |
| T18–T20 | command acceptance、real daemon/Web、App/TUI：skill 接受即结束外层命令，后续 Run 保持；查询结果保留；解析错误输入附近且编辑清理；主运行真正错误仍显示。正常接受 Skill 运行中刷新后 Stop：interrupted、输入为空、无外层命令卡；重启后的预期停止误报已修复，并在最终服务重启/整页刷新及新一次 Stop 后复验 |
| T21–T22 | 真实 `/goal budget 100` handler 在 HTTP200 返回 failed，面板显示真实错误，无 goal created/聊天卡。service fully await、throw、fail 后 output、早退/取消与首个失败；owner 最终清理而非首次失败即丢失 |
| T23–T25 | store/eventReducer/client、实际两会话 command-lifecycle：多 output、output→action、回执先后、关闭重放、runtime/scope 变化与迟到结果。真实 `/resume` selected action 不丢，有用正文不被纯 action 覆盖 |
| T26–T27 | REST/RPC 普通及 new/resume 返回同一完成合同；旧 daemon void 明确未确认。实际回执截断发生在 handler 接受后：skill 一次请求、同一 clientRequestId、一条 prompt、一次模型执行，无自动重放。真实 Goal 已知失败+丢回执由原面板同时保留原因与未确认状态；旧 epoch 提醒不挡新意图，旧请求 ID 仍禁止重放 |
| T28 | 隔离 compiled Web：新会话→skill 标题→关闭查询窗口→A/B→真实 Bash→子代理两次任务→实际分页→丢回执；DOM/服务记录与人工视觉对账。已核对真实刷新、服务重启、正常 Stop、错误编辑清除和 Goal 已知失败+回执丢失；最终审查小修复已在桌面和 443px 窄屏复验 |
| T29 | 54 次真实标题调用，三协议、六类输入，包含失败和缺陷样本；见第 3 节，不把结构成功等同语义质量 |
| T30 | 71 项 assembler/public API/assets/cache-wire/辅助用量测试通过；截至 `47605aaa`，受保护的 core/system-prompt、context、llm-client、interface-providers、tools、runtime/subagent 路径与 improve-4 基线无差异。未宣称测量真实缓存命中率 |
| T31 | global-single-serve 同库/owner 集成与 132 项 TUI app contract；实际默认 compiled TUI 两次 PID 拥有本库 run，无 child/listener，全局 daemon metadata 不变；Steer 不 abort、Stop 推进普通队列、退出 retained、重开不自动发、手动编辑发送和草稿保留均验证 |
| T32 | migration023 nullable naming_source/title_expected；旧记录及旧连接、新列写入、幂等/重开由 database/persistent/retained 集成覆盖，不批量改标题。未泛化为任意旧版本二进制均兼容 |
| T33 | 编译切换轨迹；真实 SQLite getSnapshot 10/1000 Run 点查询采样；Web 128 在途/60 秒退出/64 notices 与 server 成功失败/detach/finally 清理测试。未新增持久命令平台或任意性能阈值 |
| T34 | 每批 lint/typecheck/hooks 与独立审查；整仓/最终 Pi/整阶段审查结果见第 5 节 |
| T35 | 小/展开面板无向下按钮及空浮层；实际滚动 top59→679；继续任务入口仍正确定位，Load earlier messages 从一组工具加载为两组；原 focus/缓存/分页用例保留 |
| T36 | Bash、web_fetch、subagent_status 缺 execution 的组件用例；同 SQLite 去掉字段后重启/刷新真实浏览器：不显示缺失段落、不伪造时长、原错误不丢。`2facccea` 编译服务重启后再次核对通过 |
| T37 | SQLite 保存→物理重开→分页投影保留合法 execution；无效字段仍拒绝而错误可见。实际 child 两次运行 + Load earlier messages 已覆盖跨页，服务重启后从第二次委派进入、Load earlier messages、展开更早工具：真实 runId、phase/outcome、起止时间及 I/O 均保留 |
| T38 | execution-bearing result 单独出现及之后 call 配对，阶段不丢、不重复；缺字段安静。独立结果的折叠 aria 异常语义已在最终小修复批补齐并覆盖 error/cancelled/timed-out 回归 |

## 3. 真实标题采样与限制

按 `tests/models-4-tests.md` 的 GPT Chat Completions、GPT Responses、Sonnet Anthropic 三协议，全部通过生产 title generator/client；没有把模型输出编造为固定答案。54 次 wire/normalized 请求离线核对均为标题专用 200 tokens、无工具、两条输入、不改共享模型配置。

- [初轮 18 项](evidence/2026-09-29/title-samples-initial.json)：全部 5 秒内非空，但 3 项语言选择不合预期，另有引号清理问题。
- [修复一轮 9 项](evidence/2026-09-29/title-samples-round1.json)：skill 参数素材与引号改善，混合语言仍有问题。
- [提示词第二轮第一批](evidence/2026-09-29/title-samples-round2-1.json)与[第二批](evidence/2026-09-29/title-samples-round2-2.json)：18 项中 16 个非空标题语言正确；14 个干净结果，2 个超时回退，另 2 个格式异常（一个正常 stop 带多余标点，一个 length 截断重复）。随后增加 length finish 拒绝规则，有确定性 RED/GREEN；不声称对原随机结果做了不存在的真实重跑。
- [最终其他类型 9 项](evidence/2026-09-29/title-samples-final-remaining.json)：英文、skill-only、引用指令在三协议全部通过，1.58–3.47 秒，0 回退。与第二轮一起覆盖六类输入。

系统提示词只要求短标题、遵从实际请求的动作语言，不执行引用中的指令、不复制代码。它独立于执行 system prompt，没有工具 schema/description。模型仍可能在正常 stop 时给出不理想标点；外层单引号与内部 apostrophe 的组合是清洗保守边界。不为随机标点增加语言判断平台或模型重试。5 秒超时与 length finish 均安静回退，主任务不受影响。

## 4. 结构化证据及运行方式

- [最终会话切换轨迹](evidence/2026-09-29/session-switch-final.json)：实际 HTTP + Web runtime，15 次、真实双客户端因果屏障。
- [默认终端验收](evidence/2026-09-29/default-inprocess-pty.json)：实际 SQLite/provider/process/退出断言；两次 TUI 均退出 0，控制器清理成功。确实验证的是 Steer 接受时同 run、不 abort；该场景随后主动 Stop，没有宣称验证后续模型回合消费。
- [历史快照测量](evidence/2026-09-29/snapshot-history-measurement.md)与[可运行探针](evidence/2026-09-29/snapshot-history-probe.mts)：真实 SQLite 全历史 snapshot 线性点查询；10 runs 约0.17ms、1000约11.5ms，仅本机样本；不是有界恢复路径的耗时证明，没有证据支持本轮另做优化。
- `scripts/run-improve41-ui-e2e.mjs`：自己的 temp HOME/DB/provider/服务和稳定来源代理；人工浏览器操作；可在后端完成后丢单次响应，按 invocation 校验，无 production handler mock。
- `scripts/run-improve41-switch-trace.mts <manifest>`：实际 Web runtime 选择轨迹与双客户端屏障。
- `scripts/run-improve41-title-samples.mts --run`：显式授权的真实样本入口；默认 dry-run，结构断言独立于生成器的回退 catch。

用户要求验收与最终审查后删除测试图片；截图只暂时用于人工/Pi 审查，不作为最终仓库制品。已删除本轮 37 个临时截图文件及文档目录内 8 个副本，共 45 个文件；最终保留文字与结构化记录。真实 .env 凭据不出现在记录里。

## 5. 最终质量门与剩余限制

[最终质量门记录](evidence/2026-09-29/final-quality-gates.json)保存最终整仓数量、构建、受保护路径对比与清理结果。

- 首次整仓：473 文件通过、2 失败、6 跳过；5,287 测试通过、2 失败、17 跳过。两项是旧 title cap 与 blocked control 契约，已精确修正并覆盖复验通过；第二次整仓于 `2facccea` 通过：475 文件、5,294 用例，6 文件/17 用例按原配置跳过，232.92 秒。最终产品提交 `47605aaa` 再跑整仓通过：475 文件、5,316 用例，6 文件/17 用例按原配置跳过，234.99 秒。
- 分批提交 hooks：lint 0 errors、93 原有 warnings；typecheck 通过。`47605aaa` 的完整 build 已通过；最终全量回归后再次构建，恢复 CLI integration 重建时清掉的 Web 资源。
- 执行测试中的 CLI integration 会重建共享 dist，Web 编译资源须在它完成后重新构建；不能并行 build 后把缺少 Web 资源误当产品问题。
- 历史部分修复后下一页失败时，changed 布尔量可能漏记已成功的历史更新。独立审查确认生产 MessageManager 协调器会立即投影视图，投影失败会标记 unavailable 并触发重建，没有已复现的陈旧视图。本轮保留该非阻塞记账限制；没有以一律 changed=true 破坏健康切换。result-only aria 和真实重启后的分页 execution 已补齐。
- Status 长路径、Stop 后旧 Steer accepted、Web 迟到回执以及正常停止误报均已纳入最终修复并复验。TUI 补验只验证 Steer 提示生命周期，不声称重设计了其既有停止状态文案。
- 最终指定 Pi `opencode/claude-opus-5-5 medium` 已完成，完整原文已展示用户；整阶段独立子代理审查完成。核实意见后合并为一个最终小修复批，未更换 provider。
- 本轮拥有的 Web/TUI/provider/proxy 已关闭，PID/端口释放；测试标签页关闭、viewport override 已重置，45 个测试图片文件已删除。用户原有 4096 服务未修改。

实际平台为 macOS；不存在跨平台桌面视觉通过声明。未执行的项目不由历史 improve-4 通过结果代替。

## 6. 最终审查采纳记录

Pi 与独立子代理均确认主范围已落实，提出停止后的错误/提示残留、输入附近反馈定位、长文本换行及可访问性收尾。控制器逐项核实后交一个实施代理统一修复，最终限定范围复审在 `47605aaa` 通过，无未关闭的 scoped code findings：

- 实际默认终端 Steer 后 Stop，旧成功提示仍留在新任务；Web 另有迟到 ack 风险。仅将提示与目标 Run 绑定，不改变 steerAttempts/执行协议。
- 普通 Skill 正常 Stop 时即时页面正确，但服务重启再开出现 `user-stop` 错误横幅；保留预期 interrupted 事实，按既有正常 Stop/shutdown 展示规则免除误报，真正失败仍显示。Pi 建议 shutdown 也报提示，未采纳其扩张：现有 Run projection 已将预期 shutdown 视为 idle。
- Pi 推断输入错误被 composer 覆盖，控制器已实际确认：错误 y670–720、composer y609–720，截图看不到错误；改用已有 topContent，不新增定位系统。
- Status 长路径裁切实际成立；最小换行与窄屏布局修正。443px 现有 modal 已有18px边距，未采纳无证据的统一改宽建议。
- command close 按钮补显式 aria 与现有风格；独立工具结果补异常可访问名称，并保留无额外 glyph。Pi 原建议对该路径推断 Bash 不可靠，以独立审查的无 glyph 方案为准。
- 真实业务错误+未确认信息拼接出现双句号，局部修正分隔，不改错误含义。

不扩大处理 Skill 气泡整份展开文本的显示；这是可后续讨论的展示范围，涉及 live/历史/编辑/排队统一，当前不改执行文本。历史部分修复 changed 的非阻塞记账缺口、正常 stop 标题标点/引号边界如实延期。T37 的真实重启后分页详情验证已完成，无需为补数量重复加测试。

最终复审又发现同一修复项的两个遗漏，已在同一轮内纠正：真实 Stop 带有 `terminalReason: cancelled` 与 `RUN_INTERRUPTED/user-stop` 两种事实，不能让笼统的 cancelled 遮住具体原因；Web 在编辑或 A→B→A 后收到旧 Steer 回执，也不能重新显示提示。新增用例先复现失败，修正后 191 项 Web 测试通过，复审关闭两项。没有改动执行/重试身份。

## 7. 真实客户端证据与测试操作边界

- [编译 Web 验收](evidence/2026-09-29/compiled-web-final.json)：实际 UI 完成工具回合及 follow-up，刷新后正文各一份；六次 New 与选择已用 A/刷新后再 New 都复用空 B。SQLite 确认仅两个主会话，A 有 5 条消息/2 个 Run/2 条 prompt，B 三项均为 0；三次执行 wire 的 cache key 稳定、工具结果被后续模型回合消费、标题请求独立、诊断无正文泄漏，控制器退出 0 并清理。使用编译 `0ff1374a`；后来 `47605aaa` 的局部展示修正由实际 Stop 与专项回归补验。
- [Web 综合观察及故障断言](evidence/2026-09-29/web-ui-final.json)：保留实际 invocation 关联、回执截断、同一 skill prompt/run 只执行一次、原业务错误与未确认状态并存、旧库/分页、视觉观察及最终清理记录。最后曾把 `record.observation` 错传为对象，测试控制器按合同拒绝；之后补传正确字符串。该误操作如实保留，导致控制器清理后退出 1，不能把这份人工综合记录称为整个脚本全绿；它不涉及产品请求或执行失败，独立 command-loss 断言与 UI 观察分别成立。
- [最终终端提示补验](evidence/2026-09-29/steer-notice-final.json)：正确 marker 后 Steer 的同 Run/provider 保持断言通过；真实 PTY 上 Stop 后 accepted 提示消失，新输入不复活，TUI 退出 0。首次误把 fixture marker 的下划线打成空格，模拟 provider 拒绝了三次请求；因此该控制器退出 1，不能代替第 4 节那次完整且干净的默认终端验收。两份记录明确分开，不删掉失败以冒充通过。
- 通用 Web 控制器最初因非 PTY 的 stdin 已关闭而无法提交浏览器证据；该次以 SIGINT 清理后重新在 PTY 完整运行。最终上面的编译 Web JSON 来自重跑退出 0 的实例。
- 最终浏览器在 `47605aaa` 重开正常 Stop 历史并重新发起一次 held run→Stop→整页刷新：都没有 user-stop alert，输入为空，interrupted 历史仍在。桌面错误框 y564–615 可见；443px 错误框 y637–695 可见且编辑清理。443px Status 外框 407px、内容 clientWidth=scrollWidth=405px，完整长路径换行，关闭按钮键盘可用。截图已人工查看后删除，未将 DOM 存在等同视觉正确。
- [Pi 最终审查原文](evidence/2026-09-29/pi-final-review.md)保留修复前的建议；最终采纳/未采纳及事实校正以本节和第 6 节为准。[最终限定范围复审](evidence/2026-09-29/final-fix-review.md)记录两项遗漏如何关闭。原始措辞中的“截图证明”不能替代控制器的实际复现。
