# 04 测试与验收契约

> 本文是后续实施发布门，不是本次文档工作已执行的测试清单。没有发现项目级 test-blueprint；沿用 colocated Vitest、现有 integration/contract 和 compiled Web E2E。测试优先用确定性 provider、可控 Promise 和 fake clock，不用真实网络长任务证明竞态正确。

## 4.1 测试层次与落点

- 核心 unit：`packages/ohbaby-agent/src/permission/permission.unit.test.ts`（已有，更新串行假设）、新增 `permission/permission-lifecycle.unit.test.ts`。
- 真实 scheduler+manager integration：`tests/integration/core/tool-scheduler-permission.integration.test.ts`（已有）；新增 `tests/integration/agents/permission-run-lifecycle.integration.test.ts`，用真实 composition 与可控 provider 验证主/子 run。
- 投影 unit：`packages/ohbaby-agent/src/adapters/app-events/permission-projection.unit.test.ts`（已有）；in-process contract 增补 `adapters/ui-inprocess.contract.test.ts`。
- server：现有 `coordination/client-view.unit.test.ts`、`permission-router.unit.test.ts`、`app/create-app.unit.test.ts`；新增 `packages/ohbaby-server/src/coordination/permission-lifecycle.integration.test.ts`，真实 backend + HTTP/JSON-RPC/SSE，不只 mock owner map。
- 客户端：Web `src/api/daemon/server-client.integration.test.ts`、`src/ui/App.unit.test.tsx`；CLI `src/tui/app.contract.test.tsx`。TUI 走本地 backend，不用 remote 测试替代。
- E2E：扩展 `scripts/run-compiled-web-e2e.mjs` 现有**有人值守** harness，覆盖实际构建出的前后端、双页面与刷新。当前脚本没有浏览器驱动，会等待 stdin 人工 JSON；它不是自动化浏览器 CI。实施时新增显式审批 scenario/provider 分路，取消该 scenario 对固定三次主调用/read 的假设，区分主/子请求；扩展浏览器证据 schema 和后端执行次数断言，等待人工证据必须限时，EOF/中断/缺项失败并清理。保留原 E01–E05 验收模式。
- CI：当前 `.github/workflows/ci.yml` 只跑 unit、typecheck、lint、build。S4 增加本轮确定性 permission integration/contract 定向命令（见下方自动门），不将有人值守脚本放进 CI，也不声称人工证据已自动保护。

## 4.2 场景矩阵

| ID | 场景与断言 | 层次 / 落点 | 问题与 Stage |
|---|---|---|---|
| T01 | 一个 manager 两个 root、多个 source 的请求全部 pending；先答最后一个成功，其他保留 | permission unit | P3 / S1 |
| T02 | 父/子/孙真实 run/session/message/call 正确；一 call 多审批各有不同 id；无 run 不伪造 ID | scheduler integration + inprocess | P1,P7 / S1 |
| T03 | 拒绝 A 不拒绝 B；拒绝不触发整 run 停止 | permission unit | P3 / S1 |
| T04 | always 仅真实 session；同 session 匹配且可记忆待办可通过，不同 session/不可记忆/策略仍拒绝不通过 | permission unit | P7 / S1 |
| T05 | 两回答争夺同 ID：allow/allow、allow/reject 各运行两种顺序，恰一个终态/一次 Promise 完成，其他请求不变；认领后注入规则/通知异常，原等待仍终结，不重复副作用 | unit + server integration | P3 / S1,S3 |
| T06 | 未知 choice、cancel、冲突 remember、不可记忆 always 不抢占 pending；非法输入不退化 reject | unit + REST/RPC | P7 / S1,S3 |
| T07 | signal 预先 abort，以及 wait 已开始但 ask 微任务尚未注册时 abort：无僵尸 pending、无可操作 requested | scheduler+manager integration | P4 / S2 |
| T08 | 注册后 abort 精确撤销；abort 先于 always 不写规则；always 先有效再 abort 不回滚合法规则，工具执行仍检查 signal | integration | P4 / S2 |
| T09 | 子 run 超时/失败、primary 失败/完成/中断均无残留审批；fake clock 到期，不等两小时 | agent lifecycle integration | P4,P8 / S2 |
| T10 | 同 session run A 结束、B 已登记：revokeByRun(A) 仅影响 A；未投影请求也被撤销；source/root 会话删除或失效撤销其有效请求，其他 root 不受影响；dispose 完成所有等待 | integration | P8 / S2 |
| T11 | 暂停 requested 的投影，再 resolve/revoke：按顺序发布，最终 snapshot/store/UI 无卡片复活；另注入投影异常，验证 pending 撤销、fence明确失败及需重启恢复 | projection unit + Web store | P5 / S3 |
| T12 | snapshot 复制 pending 后暂停，插入 resolved/requested，再继续：水位不配旧快照；失败候选丢弃；持续事件触发有界重试及客户端退避；初连/显式 resync 无需 SSE 断线自动重试；切 generation/dispose 取消计时器；RPC 保留原返回形状；真实 RemoteDaemonClient+server 验证 RPC 初始化后可合法读 REST envelope（不会因注册集合不同返回409）；resync snapshot 失败不提前推进cursor，恢复期间事件缓冲并按新水位应用 | server integration + Web client | P6 / S3 |
| T13 | root 汇总子/孙，其他 root 与 workspace 排除；resolved 删除后仍按原 root 路由；无 primary active 时仍提示待批 | client-view + integration | P1,P7 / S3 |
| T14 | 双页同 root 任意一处处理后两边同步；新 clientId 刷新立刻恢复，不等五秒；超过五秒也不丢 | server integration + compiled Web | P2 / S3,S4 |
| T15 | 全部页面断开 backend 仍 pending；新页面恢复；期间任务终态则不恢复可操作卡 | server integration + compiled Web | P2,P4 / S3,S4 |
| T16 | 页面 A 切项目/会话不改变 B；旧 generation requested/resolved 不污染新范围 | Web client integration | P1,P2 / S3,S4 |
| T17 | REST/RPC 同一范围规则：错误 root、workspace、未注册、无认证不能回答；终态 ID 同样校验；他处已答/撤销正常收口；小容量终态记录淘汰后旧 ID 不复活、不泄漏历史来源 | server integration | P2,P7 / S3 |
| T18 | root 解析循环、缺父、跨 workspace 明确报错且 ask Promise 结束；解析期间 abort 后不得注册；不全局广播；关系不可信时不执行 | adapter/server integration | P1 / S3 |
| T19 | Web/TUI 无 Cancel run；来源可读；多 pending 不覆盖丢失，用户能选非首项并回答；另一页回答后卡片撤下 | Web unit + TUI contract | P7 / S4 |
| T20 | 真正 in-process TUI 的子审批汇总与一次批准可完成；默认启动不 attach/import server | 真实 inprocess contract + compiled PTY + bin.unit | D2 / S4 |
| T21 | 默认 TUI 与 serve 可并存；两个 runtime 指向同一个隔离 DB，同 session claim 拒绝第二执行，未额外插入用户消息；无跨 runtime 审批承诺 | existing ledger/dual-writer tests + integration | D2 / S4 |
| T22 | 权限策略矩阵不变：default/full-access、skill、显式 MCP、外部目录和不可记忆请求；ask 均绑定真实 call signal | scheduler integration | P4 / S2,S4 |
| T23 | scripted provider 派遣子代理 bash，待批准时刷新，批准后执行一次并最终回复；再测拒绝、以子代理现有 timeout_ms 配置短期限后的超时撤销（独立进程不用 fake clock） | compiled Web E2E | P1–P6 / S4 |
| T24 | 按 tests/models-4-tests.md 至少选一个真实模型复核普通 bash、子代理审批刷新和双页回答；记录模型/协议及版本 | 实施后人工 E2E | 外部接线 / S4 |

拒绝/always 的作用范围是已确认合同，不以参考项目行为替代。故意用 deferred barrier 控制交错，而非 sleep 猜竞态；核心双答/撤销测试断言工具执行次数和规则变化，不只断言按钮消失。

## 4.3 执行命令与发布门

实施时新增测试文件必须真的存在并被 Vitest 收集；以下命令不使用 passWithNoTests：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/permission/permission.unit.test.ts packages/ohbaby-agent/src/permission/permission-lifecycle.unit.test.ts tests/integration/core/tool-scheduler-permission.integration.test.ts tests/integration/agents/permission-run-lifecycle.integration.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/adapters/app-events/permission-projection.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts packages/ohbaby-server/src/coordination/client-view.unit.test.ts packages/ohbaby-server/src/coordination/permission-router.unit.test.ts packages/ohbaby-server/src/coordination/permission-lifecycle.integration.test.ts packages/ohbaby-server/src/app/create-app.unit.test.ts
pnpm exec vitest run apps/ohbaby-web/src/api/daemon/server-client.integration.test.ts apps/ohbaby-web/src/ui/App.unit.test.tsx packages/ohbaby-cli/src/tui/app.contract.test.tsx packages/ohbaby-agent/src/runtime/run-ledger/dual-writer-process.integration.test.ts packages/ohbaby-cli/src/bin.unit.test.ts packages/ohbaby-server/src/protocols/jsonrpc/client.unit.test.ts
pnpm run typecheck
pnpm run lint
pnpm run test:e2e:compiled-web
```

前三条 Vitest 定向命令纳入 CI（必要时分独立步骤），typecheck/lint/build 沿现有步骤；有人值守 compiled Web、compiled TUI 和真实模型结果由 05 附证据，不能当作 CI 自动门。

所有 S1–S4 改动在同一发布门验收。T01–T23 必须通过；T24 无凭证时明确阻塞真实模型验收，不能把 scripted 成功写成真实模型通过。真实模型网络失败不用于否定已证明的确定性协议测试，也不能因此跳过最后一次接线复核。最终集成前按仓库既有 CI 要求补齐其强制检查；不为文档变更现在运行产品全量测试。

### 实际运行步骤

1. 使用独立 OHBABY_HOME/DB/日志目录；凭证只从 .env 注入，不打印、不写入 fixture。先 build，确保 start 的 dist 是当前分支。
2. `pnpm --filter ohbaby-cli start serve --port 0 --no-open` 启动测试后端；两个页面连接同一端口同根会话，另开不同会话/项目作隔离对照。
3. 主/子工具请求批准时刷新 A；B 回答，断言 A 同步，工具只执行一次且主代理得到结果。
4. 断开全部测试页面再连接；另一路用可控执行取消/到期后再连接，分别验证恢复 pending 和不复活终态。
5. T20 使用实际 `buildCoreAPIImpl` 的 inprocess contract（现有 ui-inprocess.contract.test.ts 扩展）验证来源与回应，不能用 TUI app.contract 的 mock 代替。compiled PTY 单独启动 `pnpm --filter ohbaby-cli start`（不带 serve/remote-port，也不带已移除的 in-process flag），环境指向隔离 OHBABY_HOME/DB。使用与 compiled Web 相同协议的 scripted provider，但使用独立 scenario/会话计数；临时模型配置指向该 provider，凭证是测试假值。输入固定任务标记 `PERMISSION_TUI_CHILD`，provider 派遣子代理执行受控 printf；通过实际终端按键选 Allow once，断言子工具执行计数恰为 1、待批清除、最终文本 `PERMISSION_TUI_CHILD_OK`，退出并保存 PTY/后端证据。键位以实际 dialog 为准，不用 RPC 代点批准。默认不加载 server 另由 `packages/ohbaby-cli/src/bin.unit.test.ts` 的现有 bootstrap 测试证明，不靠“没看到日志”推断。
6. 停止测试进程，核对测试端口释放；不修改用户正式数据库，不停止用户已有 serve。

## 4.4 验收材料

05 逐条记录 T01–T24 的通过/失败/阻塞、命令、revision、关键产物和实际偏差。没有实现的条目不得写“设计覆盖所以通过”。最初 evidence 报告只作回归输入，不能充当修改后结果。

验收还要检查模块文档和 02 一致：旧 current 队首约束、callId fallback、审批 Cancel run、客户端独占均已按计划替换；TUI 拓扑未改变。子代理只读树、全部任务停止及重启恢复仍是后续轮次，不在第一轮验收伪造完成。

## 4.5 对抗性重点

| 风险 | 必须验证 | 保留边界 |
|---|---|---|
| 撤销后迟到 always | 无授权副作用、无执行 | 先合法批准后中断不回滚规则 |
| 两页对同请求回答 | 一次决议，双方最终一致 | 不支持跨 runtime 协调 |
| snapshot 与事件交错 | 一致水位或显式重试 | 持续事件重试有界，不能无限堵 HTTP |
| 已删 pending 失去 root | resolved/终态回执仍受范围检查 | 不向其他项目泄漏来源 |
| 请求建立前 signal 已结束 | 不登记不展示、不挂 Promise | 整树强杀不是本轮保证 |
