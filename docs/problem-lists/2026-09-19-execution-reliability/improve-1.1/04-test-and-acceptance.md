# 04 测试与验收契约

> 规划要求，当前未实施、未执行以下产品测试。未发现项目级 test-blueprint；沿用 colocated Vitest unit/contract/integration 及现有构建流程，不新建另一套项目测试规范。确定性竞态与真实浏览器接线各司其职。

## 4.1 测试边界与落点

- agent：lifecycle、message store、run-stream-adapter、ui-inprocess 现有测试补真实多步身份与恢复；新增会话读模型 unit/integration，使用真实 SQLite、真实 composition 和可控 provider。
- server：create-app、coordination 及 REST/RPC/SSE integration；不能只 mock 已经正确的 snapshot 来证明源端提交正确。
- SDK/CLI：schema/contract、RemoteDaemonClient、真正 in-process TUI；不以远程 CLI 测试冒充默认 TUI。
- Web：daemon client/reducer、selectors、会话窗口/历史的 unit/integration；注入 deferred Promise、可控传输和 fake clock，不靠长 sleep 猜时序。
- 浏览器：实施 agent 构建并启动 `pnpm --filter ohbaby-cli start serve`，使用隔离数据及 tests/models-4-tests.md 的真实模型，经浏览器工具逐步操作真实页面。固定的是验收目标，不要求固定点击脚本；现有 compiled-web 脚本不替代这项验收。

## 4.2 场景矩阵

本表 D 编号只指 improve-1.1 的 [00](00-discussion.md)，跨轮决策写明轮次。D8/D9 定义思考保存，D10/D12 定义失败继续与有限保留，D11 定义恢复机制和编号分工。所有条目均为待执行验收要求。

| ID | 必须验证的行为 | 层次 / Stage | 来源 |
|---|---|---|---|
| T01 | 前置 improve-1 的实际 05、接口、默认 TUI 拓扑核对，缺失则阻止依赖其能力实施 | 前置检查 / S0 | D1 |
| T02 | 多步正文、思考、tool part 的真实 message/part/run 身份一致；刷新无重复替身消息、无串归属 | lifecycle→adapter→store integration / S1 | P2 |
| T03 | 持续产生正文/思考时取基线 R；响应延迟期间又产生 R+1..，恢复后无重无漏，结尾与源端累计值一致 | 真实来源 integration / S1 | P1,P3 |
| T04 | 初始化 DB 读取挂起时首次 prompt/goal/消息写入遵循屏障；无浏览器也正常初始化；迟到 seed 不把已结束消息改成 streaming | integration / S1 | P7,P8 |
| T05 | DB 写入与投影提交间暂停，另开 snapshot/history；任何成功响应只能配自身切点；两个来源同会话有序、另一会话继续 | real SQLite + projection integration / S1 | P1,P8 |
| T06 | 所有页面关闭后任务继续；离线期间超过50条消息的 step/run 已结束且不再有新事件，重开仍恢复末尾正文和已保存完整思考 | integration＋浏览器 / S1,S4 | D2,P3 |
| T07 | 当前 run 超过 50 条消息，所有活动输出仍完整；生成/待保存思考不因断连或run结束先被删掉；保存成功后释放展示缓存，消息滑出近期窗口再加载旧页，从DB恢复完整思考，无重复错配 | unit/integration / S1 | D2,D5 |
| T08 | 每次 hello 前 listener 已安装，snapshot 等待时 reader 继续缓冲；每次自动重连均重建基线；global seq 不能先丢会话事件 | 真实 HTTP/SSE/remote / S2 | P1,P4 |
| T09 | 同scope同generation的Q1/Q2并发，Q2先安装并接live、Q1旧完整正文后到，正文不缩短且终态不回退；另测A→B→A，旧 snapshot/history/control/receipt/附加响应到达；服务端异步校验期间切范围；均不跨 binding/generation 覆盖 | REST/RPC＋client integration / S2,S3 | P4 |
| T10 | 重复、缺号、乱序、环形缓存过期，1024条/8MiB 溢出及单条超限；不跳版本/截正文，按有限预算重取 | unit/integration / S2 | P8 |
| T11 | 核心历史读取错误/挂起保留画面并停增量拼接、暂缓发送；后端继续；恢复成功再接变化；不谎报 ready | client integration / S3 | D3 |
| T12 | model/todo/goal正文/早期历史各自失败，不关闭 SSE、不清空已有数据、不锁住已同步对话和审批；unknown 与 empty 区分 | client＋inprocess integration / S3 | D3 |
| T13 | 恢复期间可写草稿，恢复完成不自动发送；control 成功时 Stop 可用；A 结束 B 开始后迟到 Stop(A) 不能停 B | selectors＋runtime/server integration / S3 | D4,P6 |
| T14 | 连续新旧 snapshot/history/control 请求不触发 drain、goal rebuild 或恢复写入；startupReady显式一次启动，无页面时queue继续，goal只正规化一次，读接口不调用getRuntime；初始化失败不开放该范围执行且不阻塞其他会话 | runtime/store integration / S1 | P7 |
| T15 | 相同 created_at、多页边界、新消息插入、历史更新/删除/压缩；稳定游标无重漏，旧页不覆盖新实体，invalidated 页重取 | real DB＋client integration / S2 | P5 |
| T16 | 100个主会话各长历史，恢复当前会话时不调用其他会话 listBySession；DB SQL 真正限页；活动队列按 session，终态 prompt 随页按关联读 | query instrumentation integration / S2 | P5,D5 |
| T17 | source 已提交但普通 listener/socket 抛错，业务不重做；关键投影失败不能被 eventRouter 吞成成功；受影响 session 明确 unhealthy | 故障注入 integration / S2 | P8 |
| T18 | 仅展示投影失败后来源仍累计思考，结束时正常落盘；重建从DB和未保存当前段恢复，不依赖全部历史常驻内存；unhealthy 重建换 viewGeneration；旧代际响应/事件不合并；通知也失败时连接失效且新查询不可用；其他 session/审批/control 不被全局冻结 | integration / S2 | P8,D3 |
| T19 | 已有会话与首条新建提交均覆盖：HTTP响应丢失，刷新后用原clientRequestId＋原workspace找到receipt，无sessionId也能查回真实root；切会话不自动跳回，不新ID重发；查不到保持未知，epoch改变不重放旧提交 | server＋client integration / S3 | P6 |
| T20 | 默认 in-process TUI、显式 remote 与 Web 使用同义查询和真实身份；无自动 daemon attach；独立 runtime 不共享临时思考 | contract＋隔离双 runtime / S0,S3 | D1 |
| T21 | 当前主会话范围鉴权；无会话时正常空选择可创建；child 不获得主会话发送/审批/越权读取；其他项目数据不泄漏 | REST/RPC integration / S3 | 第一轮边界 |
| T22 | 已加载旧历史和滚动锚点重连保留；近期基线只替换自己覆盖区间；旧页标 stale 并按需重取；revision 元组不可只比数字 | Web store/UI integration / S3 | D5 |
| T23 | agent 在真实构建页面和真实模型上触发持续输出，刷新/断网再连/双页/切项目/全部关闭重开，核对当前输出及终态，实际触发才记通过 | agent 浏览器 E2E / S4 | D2,D6 |
| T24 | 回归第一轮独立审批：聊天核心和附加读取失败仍可审批；子孙来源/多页答一次/撤销不复活；新 snapshot 不覆盖 pending；旧能力客户端明确版本不支持 | integration＋浏览器 / S4 | D1 |
| T25 | 带第二轮 tool execution/modelRequests/终态 prompt 关联的 fixture 经 live→snapshot→分页保持字段与归属；不提前实现阶段/计时 UI；epoch 改变后能读已保存思考，但不重放旧任务，也不伪造未保存尾部 | contract/integration / S4 | 跨轮边界 |
| T26 | 正常段结束、转正文/工具、Stop、模型异常、无终态EOF分别保存已收到思考及准确结束状态；空思考不造part；重复收尾/保存重试同ID不重复。暂停DB提交验证不先释放；DB成功但saved回调未提交时历史仍以pending切点读取；DB成功但展示失败后可重建，缓存与历史交接无空窗/重复 | lifecycle＋real DB＋projection integration / S1 | D8,D9 |
| T27 | 同一历史在新增展示ReasoningPart前后，后续模型请求、摘要及token估计不因展示文本变化；当前工具循环合法回传与原生model-state策略保持；无思考模型不变；旧记录缺结束字段按未知，不补造历史思考 | context/serializer/provider contract＋integration / S1 | D8 |
| T28 | 仅展示思考保存失败，模型继续产正文/执行下一步，run 不被该错误停止；首次+2次自动重试、退避及重连不重置预算；模型/工具调用次数不增加。失败状态可刷新恢复，晚到成功同ID交接且不假报正常结束；退避不锁住会话提交；写Promise未settle时后续正文/下一步与核心查询仍推进；DB已写但saved回调未提交时history保持原pending切点，失败不变成工具重试 | lifecycle→store→Web/TUI integration＋fake clock / S1,S3 | D10 |
| T29 | 多会话连续保存失败达到16MiB或256段，按最旧已结束段淘汰；单段超限、待重试/在途写入交错覆盖；多段持续结束而writer悬挂时在途最多一个，其他pending仍可淘汰。文本从待存区和展示缓存释放，缺失提示经live/快照/历史/局部重建保留；同步可完成但不宣称历史完整。正文、工具结果、正在生成段及模型协议内存不受淘汰影响；late callback不复活已淘汰的未保存副本 | resource＋fault integration / S1,S3 | D12 |
| T30 | 同backend下runtimeEpoch与permissionEpoch同值；局部聊天重建不改变审批epoch或就绪；不同代revision数字相同不混接；client generation不作为服务端版本，默认TUI不伪造binding。按02通路矩阵校验schema，复用比较逻辑处理旧响应 | SDK contract＋backend/client integration / S2 | D11 |
| T31 | 逐一触发/new两路径、archive、select、模型保存/metadata/context discovery、Web重连、RPC resync；均走替代通知且没有整页replacement发布或客户端自造。注入旧replacement不覆盖新聊天/审批；旧getSnapshot仍可主动只读查询，旧能力明确不支持。TUI初始/切换/历史/模型/归档/Stop实测，非仅远程CLI测试 | producer→SDK→Web/TUI integration / S3 | P4,P7,D11 |

T03/T05 必须验证来源与版本的真实接线，不能只验证正确数据喂给 reducer 后输出正确。T10 使用 fake clock 验证 10秒超时、累计4次查询和退避，不实际等待长任务。相同周期反复 hello/gap 不刷新预算；dispose/切范围后请求、listener、buffer 和计时器全部释放。

T15 必须包括“较新 live 已更新某消息，较旧分页响应才到”的交错，以及窗口外历史被修改后的失效通知。历史语义不假定 append-only。T18 同时验证投影故障不转化成工具重试或任务取消，control/receipt查询不受聊天viewGeneration故障牵连；正文/工具等执行记录保存故障仍走原业务错误处理，展示思考失败单独按 T28/T29 验证。

## 4.3 阶段门与执行命令

S1 内部门：T02–T07、T14、T26–T29 的源端证据通过才接完整客户端。S2/S3 分别验证传输和交互，最终均并入本轮同一份 05，不能把部分阶段通过写成整轮完成。

实施后的自动检查使用现有命令：

```sh
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm build
```

测试必须被现有按类型 runner 收集；新定向 CI 任务须列明包含本轮文件，不能因 passWithNoTests 而空跑成功。实施者在 05 记录实际命令、版本、用例文件、失败修正和结果，不在当前规划补造运行记录。CI 负责确定性 unit/contract/integration；agent 浏览器 E2E 单独验收，不宣称已成为无人操作 CI。

浏览器实施验收顺序：

1. 隔离数据库和项目，构建并启动实际 serve/Web，使用文档测试模型；凭证只从本地配置读取，不写入报告。
2. 创建可持续输出并产生多步工具调用的任务，观察真实 message/run 归属；在输出途中刷新、断网并恢复，不要求逐字重播。
3. 打开第二页，切项目/会话、加载旧历史并停留，重连后检查可见内容及滚动位置；关闭所有页面，待后台继续/结束后重开。
4. 核实草稿恢复不自动发送；聊天恢复未完成但控制可用时实际 Stop 确切目标；另回归根会话审批独立可用。
5. 保留脱敏截图、关键事件/版本、最终持久化内容与累计输出对照。provider 没有产生思考或某竞态未触发时，不能把该项记为真实模型通过；思考与窄竞态另由确定性 integration 覆盖，报告各自证据。

## 4.4 非功能验收与发布门

- 固定数据规模验证查询范围与返回条数，不以本机偶然耗时作为唯一性能标准。记录当前会话与全项目增长时 SQL 次数、响应字节、恢复耗时和内存峰值。
- 单个恢复周期查询次数、buffer 上限和释放可确定断言；展示缓存按正在生成/待保存内容及热窗口计量；保存成功并淘汰后，运行更多已完成会话不能使全部历史思考继续常驻内存。记录内存峰值、SQLite体积和写入量；另按 T29 计量失败待存预算，在途写入、当前长段和模型协议引用单独列出，不虚构整个进程恒定内存承诺。
- 任何缺口、源端未知或基线失败都不能显示已同步；其他 session、独立审批、后台执行按边界继续。
- 全部自动检查、T01–T31 对应证据、第一轮必要回归和实际浏览器 E2E 齐备，才可产出 05 并考虑按总体路线合回开发分支。缺凭证/能力/平台证据时明确阻塞项，不以模拟结果替代。

## 4.5 对抗性审查

重点攻击四处：给旧状态贴新版本；同 scope 的迟到响应覆盖新状态；DB 终态被旧 streaming 覆盖；投影异常被吞后用户仍可错误控制。防御分别是源端切点、完整版本元组、真实消息身份与初始化屏障、独立健康和确切 runId。残余限制：本轮不恢复进程崩溃前未持久化的思考尾部，不接管另一个 runtime，不消除业务执行本身失败。

返回：[README](README.md) · [实施契约](02-optimization-plan-and-change-scope.md)。

D10–D12 的产品取舍已确认；T28–T31 仍须通过真实接线的故障注入和迁移验证，不将文档修改视为测试通过。
