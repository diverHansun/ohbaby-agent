# 04 测试与验收契约

> 本文是后续实施发布门，不是本次文档工作已执行的测试清单。没有发现项目级 test-blueprint；沿用 colocated Vitest 和现有 integration/contract。核心竞态用确定性 provider、可控 Promise 和 fake clock 验证；浏览器 E2E 按 D15 由 agent 操作实际构建产物与测试模型，不以固定脚本代替。

## 4.1 测试层次与落点

- 核心 unit：`packages/ohbaby-agent/src/permission/permission.unit.test.ts`（已有，更新串行假设）、新增 `permission/permission-lifecycle.unit.test.ts`。
- 真实 scheduler+manager integration：`tests/integration/core/tool-scheduler-permission.integration.test.ts`（已有）；新增 `tests/integration/agents/permission-run-lifecycle.integration.test.ts`，用真实 composition 与可控 provider 验证主/子 run。
- 投影 unit：`packages/ohbaby-agent/src/adapters/app-events/permission-projection.unit.test.ts`（已有）；in-process contract 增补 `adapters/ui-inprocess.contract.test.ts`。
- server：现有 `coordination/client-view.unit.test.ts`、`permission-router.unit.test.ts`、`app/create-app.unit.test.ts`；新增 `packages/ohbaby-server/src/coordination/permission-lifecycle.integration.test.ts`，真实 backend + HTTP/JSON-RPC/SSE，不只 mock owner map。
- 客户端：Web `src/api/daemon/server-client.integration.test.ts`、`src/ui/App.unit.test.tsx`；CLI `src/tui/app.contract.test.tsx`。TUI 走本地 backend，不用 remote 测试替代。
- E2E：按 D15，由实施 agent 启动实际构建的 Web/serve，通过浏览器工具自行操作，不转交用户手工完成，也不以固定点击脚本或提交一行成功 JSON 代替。连接 tests/models-4-tests.md 的测试模型，使用隔离数据库，按实际页面检查刷新、双页、全部关闭后重开、到期撤销、持续输出时审批恢复、切换范围及非首项回答。保留固定验收目标，允许根据真实模型与页面状态调整操作；未触发目标场景不得记为通过。现有 `scripts/run-compiled-web-e2e.mjs` 保留原用途，本轮不要求扩展它作为验收主入口，也不强制新增固定 Playwright 用例。
- CI：当前 `.github/workflows/ci.yml` 只跑 unit、typecheck、lint、build。S4 增加本轮确定性 permission integration/contract 定向命令（见下方自动门）。agent 浏览器 E2E 是独立的实施验收，结果进入 05；不宣称这些操作已成为无人参与的 CI 自动回归。

## 4.2 场景矩阵

| ID | 场景与断言 | 层次 / 落点 | 问题与 Stage |
|---|---|---|---|
| T01 | 一个 manager 两个 root、多个 source 的请求全部 pending；先答最后一个成功，其他保留 | permission unit | P3 / S1 |
| T02 | 主会话预期 runId 与最终 RunContext 一致；子代理认领后的预期 runId 也与实际 runId 核对，其自身 runId 经 runner → RunWorker → lifecycle → ToolCallRequest → scheduler ToolCall → PermissionAskInput/Info 原样传递，不误用父 run。对子代理 `waitForCompletion` 路径故意注入预期/实际不一致，断言明确报错、实际 run 被取消、其已出现的审批撤销且等待收口，无残留可批准请求；实际一 call 连续触发外部目录和 bash 等审批时，各有不同 permissionId，前一步 allow_once 不放行后一步，后一步拒绝使工具不执行但不回滚前一步合法的 always 规则；无真实 run 的独立工具执行不能伪造 ID 进入交互式 ask | scheduler integration + inprocess | P1,P7 / S1,S2 |
| T03 | 拒绝 A 不拒绝 B；拒绝不触发整 run 停止 | permission unit | P3 / S1 |
| T04 | 主/子请求均可使用可记忆的 always；规则仅写入真实来源 session。同子会话匹配且可记忆的已登记待办逐项 resolved、各自推进 revision；后来直接命中已有规则的调用无 pending、无 requested/resolved、无 revision 变化。父会话、兄弟子会话及不可记忆/策略仍拒绝的请求不通过；always 不切换 `full-access` | permission unit + projection | P7 / S1,S3 |
| T05 | 两回答争夺同 ID：allow/allow、allow/reject 各运行两种顺序，恰一个终态/一次 Promise 完成，其他请求不变；认领后注入规则/通知异常，原等待仍终结，不重复副作用 | unit + server integration | P3 / S1,S3 |
| T06 | 未知 choice、cancel、冲突 remember、不可记忆 always 不抢占 pending；非法输入不退化 reject | unit + REST/RPC | P7 / S1,S3 |
| T07 | signal 预先 abort（含已有规则的直接放行路径），以及 wait 已开始但 ask 微任务尚未注册时 abort：无僵尸 pending、无可操作 requested，已结束的调用不被规则快路径放行 | scheduler+manager integration | P4 / S2 |
| T08 | 注册后 abort 精确撤销；abort 先于 always 不写规则；always 先有效再 abort 不回滚合法规则，工具执行仍检查 signal | integration | P4 / S2 |
| T09 | 子 run 超时/失败、primary 失败/完成/中断均无残留审批；fake clock 到期，不等两小时 | agent lifecycle integration | P4,P8 / S2 |
| T10 | 同 session run A 结束、B 已登记：revokeByRun(A) 仅影响 A；未投影请求也被撤销，不经 UI snapshot 和 cancelPending(sessionId) 反查；主/子真实终态出口均覆盖。根 R → 子 C → 孙 G 中只删除 C 的会话记录（现有 remove 默认不级联），G 的待批请求因父链断裂而撤销，R 和其他 root 的有效请求不受影响；source/root 被删除或可信父链校验失败同理，页面切换/断连不撤销；dispose 完成所有等待 | integration | P8 / S2 |
| T11 | 关键提交同步完成、候选失败不留半提交；回答/撤销后卡片不复活。区分通知、单请求与权威一致性故障，普通总线吞异常不能掩盖关键失败；严重故障的等待全部结束，同一 runtime 其他 root 仍能回答 | projection unit + server integration + Web store | P5 / S3 |
| T12 | 按下方 T12a–h 验证独立快照/增量恢复，聊天持续输出不影响取基线；Web、in-process 和既有 RemoteDaemonClient 共用审批契约，全量 RPC getSnapshot 形状保留 | server integration + Web/remote client + inprocess contract | P6 / S3 |
| T13 | root 汇总子/孙，其他 root 与 workspace 排除；resolved 删除后仍按原 root 路由；无 primary active 时仍提示待批；选择子会话作主会话明确报错且原绑定不变，异常 child activeSessionId 提示返回主会话、审批未就绪且无可操作卡；只有根主会话可见/可回答 | client-view + integration | P1,P7 / S3 |
| T14 | 双页同 root 任意一处处理后两边同步；新 clientId 刷新立刻恢复，不等五秒；超过五秒也不丢 | server integration + compiled Web | P2 / S3,S4 |
| T15 | 全部页面断开 backend 仍 pending；新页面恢复；期间任务终态则不恢复可操作卡 | server integration + compiled Web | P2,P4 / S3,S4 |
| T16 | 页面 A 切项目/会话不改变 B；旧 generation requested/resolved 不污染新范围 | Web client integration | P1,P2 / S3,S4 |
| T17 | REST/RPC 同一范围规则：错误 root、workspace、未注册、无认证不能回答；终态 ID 同样校验；他处已答/撤销正常收口；小容量终态记录淘汰后旧 ID 不复活、不泄漏历史来源 | server integration | P2,P7 / S3 |
| T18 | root 解析循环、缺父、跨 workspace 明确报错且 ask Promise 结束；解析期间 abort 后不得注册；不全局广播；关系不可信时不执行 | adapter/server integration | P1 / S3 |
| T19 | Web/TUI 无 Cancel run；来源简短可读，无长篇授权说明、联动数量或二次确认；多 pending 不覆盖丢失，用户能选非首项并回答；另一页回答后卡片撤下；同 callId 连续审批按独立 permissionId 展示各自标题/原因，前一请求消失后新请求可见，旧 ID 的迟到回答不作用于新请求，前一次 allow_once 不放行后一次，不新增步骤计数 | Web unit + TUI contract | P7 / S4 |
| T20 | 真正 in-process TUI 的子审批汇总与一次批准可完成；默认启动不 attach/import server | 真实 inprocess contract + compiled PTY + bin.unit | D2 / S4 |
| T21 | 默认 TUI 与 serve 可并存；两个 runtime 指向同一个隔离 DB，同 session claim 拒绝第二执行，未额外插入用户消息；无跨 runtime 审批承诺 | existing ledger/dual-writer tests + integration | D2 / S4 |
| T22 | 按 D22 修订权限矩阵：主/子代理在 `full-access` 下，对普通工具、skill、显式 MCP、外部目录、敏感路径及原不可记忆 ask 均不产生人工审批；明确 deny 与禁止路径/命令仍拒绝，参数/资源检查仍执行；自动放行不生成 always 规则或跨子会话授权。默认档位的 ask 仍绑定真实 call signal，子请求的 always 不改变 permission level | scheduler integration | P4 / S2,S4 |
| T23 | agent 操作真实构建页面与测试模型，触发子代理 bash 审批，刷新后批准，核对执行一次并最终回复；另测拒绝、配置短执行期限后的超时撤销，以及主代理持续输出期间审批恢复 | agent 浏览器 E2E | P1–P6 / S4 |
| T24 | 按 tests/models-4-tests.md 至少选一个真实模型完成普通 bash、子代理审批刷新和双页回答；复用 T14/T23 实际证据，记录模型/协议、版本及执行结果，不重复编造独立运行 | agent 真实模型 E2E | 外部接线 / S4 |

拒绝/always 的作用范围是已确认合同，不以参考项目行为替代。故意用 deferred barrier 控制交错，而非 sleep 猜竞态；核心双答/撤销测试断言工具执行次数和规则变化，不只断言按钮消失。

### T11 故障注入细分

- T05 额外注册 RuleAdded 监听者，同步重入 respond/revoke；断言规则通知发生在原请求关键提交和终态记录之后，一次决议不重复。always 批量放行逐项检查 signal/策略/健康，原请求提交失败后不能继续放行其他项。
- 在候选构造阶段注入提交失败，断言无半份集合/版本、错误能传回 manager；在普通 Bus listener 注入错误，断言已合法决定不倒退，等待仍结束。不能只测试一个会主动抛异常的 mock，需覆盖现有 Bus/event-router 吞异常的接线。
- 单 socket 写入失败只使该连接重同步；审批转发器失败使受影响订阅失效，不能仅日志告警后仍 ready。reconcile/历史/model 故障不撤销请求，单请求来源失败不影响同 root 其他请求。
- 故意让**最后一条** resolved 在一条连接的 SSE 写入或转发时出现可检测错误，随后不再产生任何事件：服务端立即关闭受影响流，客户端观察断流后退出 ready，重连读权威快照后旧卡消失；若重连失败，保持未就绪且后端拒绝旧 ID 的迟到批准。另一连接保持可用，原工具只执行一次；不能靠下一条事件制造缺口才通过测试。
- 在一个 runtime 的 root A 注入严重关键提交/身份冲突，断言 A 的新 ask/respond 被拒绝、所有 pending Promise 完成、listener 移除，健康查询返回不可用；同 runtime 的 root B 继续回答。再注入共享设施故障，断言只隔离该 runtime，另一个 runtime 正常。
- 模拟坏投影和失败通知，撤销仍不依赖二者完成；旧卡不能执行，重连读不到正常空基线。非法外部参数、正常事件重复/缺口不触发严重冻结。已合法写入的规则不因后续通知失败被回滚。

### T12 独立恢复细分（同时覆盖 D20、T16、T19）

| 子项 | 可控制的交错 / 必须断言 |
|---|---|
| T12a 基线与版本 | 基线前后产生 requested/resolved，以 deferred barrier 延迟响应送达（不在同步提交中人为 await）；基线与集合为同一版本，重放 ≤R 幂等，>R 连续应用。已有规则直接放行不生成审批事件/版本；已登记待办被 always 自动放行则逐项 resolved/递增。持续聊天 delta、其他 root 高频事件不引起本 root 重试或缺口 |
| T12b 无关读取失败 | 从首次注册开始挂起历史读取直到测试结束，另测抛错及 model 查询失败；轻量注册、订阅、审批查询和 UI 挂载仍成功，按钮可回答。晚到全量 snapshot（含旧 permissions）不覆盖待批/ready，也不关闭 SSE |
| T12c 订阅与自动重连 | 安装订阅后才 hello；HTTP 已连接但未 hello 不取就绪基线。每次自动重连均重同步；审批 HTTP 挂起时 SSE reader 仍消费并缓冲，不 await handler 阻塞读流。新 epoch 清旧请求 |
| T12d 范围切换 | root/workspace 切换和 A→B→A；选择先验证再提交、过期并发选择不覆盖新绑定；暂停查询/回答的异步校验后切根，再释放旧调用，不能把旧 root 数据配上新 bindingGeneration 或执行过期应答。旧快照/事件/重试/应答回调不能重启新按钮；相同 ID 也不越界。无 active root 或异常 child activeSessionId 不展示全局审批 |
| T12e 单客户端失败 | 页面 A 审批查询超时/失败，A 未就绪但后端 pending 保留，B 能回答；A 重试读到已处理状态。连接恢复为 live 本身不启用按钮；审批成功后历史/todo 失败不锁按钮 |
| T12f 缺口与资源 | 丢失一个本 root 事件、乱序或缓冲达到条数/字节上限：重新取基线，不能直接跳版本；正常重复不报严重故障。用 fake clock 验证查询超时、累计最多四次查询/退避、耗尽停用与显式重试；同一连接/范围反复触发 hello/resync/gap 不能重置预算，实际新连接/范围或显式重试才能开启新周期；dispose/切 generation 释放查询、计时器、buffer/listener |
| T12g 真实传输 | 真实 backend+HTTP/SSE/JSON-RPC；REST/RPC 注册判定一致，轻量选择及 new/resume/首条 prompt 建会话都更新绑定；查询/回答在异步校验后再次验证 epoch/root/generation，过期绑定不得提交。未注册、错 workspace/root 均不能查询/应答。真实 RemoteDaemonClient 在全量恢复失败时仍可独立同步审批，不提前用全局 cursor 丢审批事件 |
| T12h 不可用范围 | 冻结后独立查询返回 PERMISSION_UNAVAILABLE 而非正常空列表；客户端不自动重试严重错误或启用旧卡。故障通知投递失败也能令连接失效；新查询读独立健康标记 |

所有缓冲、reducer 和全局 seq 过滤入口都要纳入 T12a/c/g，防止审批事件尚未进入独立处理器就被丢弃。T12 的确定性故障注入不要求真实模型触发异常；T23/T24 另负责实际浏览器接线。以上列的是实施验收要求，不是本次文档修订已经跑过的结果。

## 4.3 执行命令与发布门

### S1＋S2 内部验收点（D14）

进入 S3 前，必须验证以下核心行为：

- sessionId/runId/callId 从真实主/子执行链正确传递，缺失执行身份不能伪造。
- 已登记审批独立可回答；拒绝仅作用于该请求，always 保持实际来源 session 的规则范围。
- 回答与回答、回答与撤销竞争只产生一个有效终态；规则副作用与工具执行不会因重复回答而重复。
- 旧 run 的清理不误撤销同 session 新 run 的请求；请求尚未投影也可撤销。
- 调用取消、失败、到期或 run 结束后，不留可批准请求，等待审批的 Promise 明确结束。

范围是 T01–T10 的核心与生命周期部分。使用真实 scheduler、permission manager 及主/子执行生命周期与可控 provider，不以 manager mock 测试代替接线验证。T05/T06 等场景的 server/REST/RPC 断言，以及页面同步和恢复断言，留在 S3/S4 完成；阶段记录分别列出已通过部分和待后续验证部分，不标记整条测试提前通过。保留所有 ask 调用点的类型检查。

本验收点通过才进入 S3；阶段结果最终汇入本轮同一份 05，不单独创建阶段验收文档、不单独发布或合入 main。整轮发布仍须满足下文完整验收要求。

### 完整验收命令

实施时新增测试文件必须真的存在并被 Vitest 收集；以下命令不使用 passWithNoTests：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/permission/permission.unit.test.ts packages/ohbaby-agent/src/permission/permission-lifecycle.unit.test.ts tests/integration/core/tool-scheduler-permission.integration.test.ts tests/integration/agents/permission-run-lifecycle.integration.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/adapters/app-events/permission-projection.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts packages/ohbaby-server/src/coordination/client-view.unit.test.ts packages/ohbaby-server/src/coordination/permission-router.unit.test.ts packages/ohbaby-server/src/coordination/permission-lifecycle.integration.test.ts packages/ohbaby-server/src/app/create-app.unit.test.ts
pnpm exec vitest run apps/ohbaby-web/src/api/daemon/server-client.integration.test.ts apps/ohbaby-web/src/ui/App.unit.test.tsx packages/ohbaby-cli/src/tui/app.contract.test.tsx packages/ohbaby-agent/src/runtime/run-ledger/dual-writer-process.integration.test.ts packages/ohbaby-cli/src/bin.unit.test.ts packages/ohbaby-server/src/protocols/jsonrpc/client.unit.test.ts
pnpm run typecheck
pnpm run lint
pnpm run build
```

前三条 Vitest 定向命令纳入 CI（必要时分独立步骤），typecheck/lint/build 沿现有步骤；agent 操作 compiled Web、compiled TUI 和真实模型的结果由 05 附证据，不能当作 CI 自动门。

所有 S1–S4 改动在同一发布门验收。T01–T24 必须通过；缺少凭证或浏览器操作能力时，明确标记受影响的 E2E 阻塞，不能把 mock/脚本成功写成真实浏览器通过。真实模型网络失败不用于否定已证明的确定性协议测试，也不能因此跳过最后一次接线复核。最终集成前按仓库既有 CI 要求补齐其强制检查；不为文档变更现在运行产品全量测试。

### 实际运行步骤

1. 使用独立 OHBABY_HOME/DB/日志目录；凭证只从 .env 注入，不打印、不写入 fixture。先 build，确保 start 的 dist 是当前分支。
2. `pnpm --filter ohbaby-cli start serve --port 0 --no-open` 启动测试后端；两个页面连接同一端口同根会话，另开不同会话/项目作隔离对照。
3. 主/子工具请求批准时刷新 A；B 回答，断言 A 同步，工具只执行一次且主代理得到结果。
4. 断开全部测试页面再连接；另一路用可控执行取消/到期后再连接，分别验证恢复 pending 和不复活终态。
5. T20 使用实际 `buildCoreAPIImpl` 的 inprocess contract（现有 ui-inprocess.contract.test.ts 扩展）验证来源与回应，不能用 TUI app.contract 的 mock 代替。compiled PTY 单独启动 `pnpm --filter ohbaby-cli start`（不带 serve/remote-port，也不带已移除的 in-process flag），环境指向隔离 OHBABY_HOME/DB。由 agent 连接测试模型，发起包含子代理和低影响工具调用的任务，通过实际终端按键选 Allow once，核对同一 callId 执行一次、待批清除、最终回复与执行结果一致，退出并保存 PTY/后端证据；不以固定回复文本或脚本回执代替实际交互。键位以实际 dialog 为准，不用 RPC 代点批准。默认不加载 server 另由 `packages/ohbaby-cli/src/bin.unit.test.ts` 的现有 bootstrap 测试证明，不靠“没看到日志”推断。
6. 停止测试进程，核对测试端口释放；不修改用户正式数据库，不停止用户已有 serve。

## 4.4 验收材料

05 逐条记录 T01–T24 的通过/失败/阻塞、命令、revision、关键产物和实际偏差。 浏览器验收另记录实际操作顺序、模型/协议、脱敏的 session/run/call/request 标识、关键页面截图或状态、工具执行证据及进程清理结果；按钮消失不等于工具成功，未实际触发的场景标为未验证。没有实现的条目不得写“设计覆盖所以通过”。最初 evidence 报告只作回归输入，不能充当修改后结果。

验收还要检查模块文档和 02 一致：旧 current 队首约束、callId fallback、审批 Cancel run、客户端独占均已按计划替换；TUI 拓扑未改变。子代理只读树、全部任务停止及重启恢复仍是后续轮次，不在第一轮验收伪造完成。

## 4.5 对抗性重点

| 风险 | 必须验证 | 保留边界 |
|---|---|---|
| 撤销后迟到 always | 无授权副作用、无执行 | 先合法批准后中断不回滚规则 |
| 两页对同请求回答 | 一次决议，双方最终一致 | 不支持跨 runtime 协调 |
| 审批快照与事件交错 | 独立 root 版本、连续应用；缺口重新同步 | 不等待全局 seq 静止；历史失败不阻塞审批 |
| 已删 pending 失去 root | resolved/终态回执仍受范围检查 | 不向其他项目泄漏来源 |
| 请求建立前 signal 已结束 | 不登记不展示、不挂 Promise | 整树强杀不是本轮保证 |
