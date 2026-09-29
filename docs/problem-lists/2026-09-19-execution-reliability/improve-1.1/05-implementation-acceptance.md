# improve-1.1 实施与验收记录

## 分支与范围

- 基线：`codex/execution-reliability`，`6a304604da3281be3d55bffa1feb6f8eab33a367`，已经包含前置 A/B、improve-1 及其收尾修复。
- 实施分支：`codex/improve-1.1`，从上述当前开发分支新建的本地临时分支。
- 范围：本目录 00–04 的 S0–S4；源端先落地，再接 HTTP/RPC、Web 和默认 in-process TUI。旧 `getSnapshot()` 保留为主动兼容读取；生产恢复不依赖它。没有合并或推送。
- 本地验收结果及提交批次见下文；不合并或推送开发分支。

## 实现要点

应用层 `SessionViewOwner` 按会话串行化短数据库变更和同步投影提交。读取取得不可变版本视图；`runtimeEpoch` 与审批 epoch 相同，重建只更换 `viewGeneration`。历史使用 SQL keyset 和真实业务身份，最近 50 条与完整当前/最近运行可以重叠，分页边界始终来自连续的最近窗口，避免跳过交错的排队消息。

`DisplayReasoningOwner` 在生命周期源端累计展示思考。结束状态与保存状态分开；单 writer、首次加两次退避重试、256 段/16 MiB 待存预算不阻塞正文和工具执行。保存后的固定 part ID 与数据库交接，丢失信息在 live、查询、重建及历史中保留。展示 reasoning 不进入模型协议、摘要或 token 估计；用户展示文本也不混入目标执行注入提示。

来源重建只合并同会话在途请求，不设置会话生命周期总次数上限；后续投影修复失败不污染已经成功初始化的业务写入屏障。SDK 提供统一的四次限额恢复流程、10 秒查询超时和 1024 条/8 MiB 缓冲。HTTP/RPC 在异步查询前后校验 workspace、root、epoch 和 binding；Stop 读取独立 control 并指定确切 runId。回放不会重做旧选择动作。

Web/TUI 使用独立的会话索引、聊天、审批、控制和模型读取。恢复期间保留草稿；旧历史按实体版本合并，删除记录不被迟到分页复活，历史失效可按需重取。提交回执丢失时仅持久化原请求身份并查询结果，不自动重发正文，也不因迟到响应切回原会话。

## 实施与独立审查中的修复

- 缓冲中的新 generation 不能被旧基线忽略；重复 hello、unavailable 和溢出不重置自动恢复预算。
- SQLite 保存成功但 saved 投影尚未提交时，历史仍保持 pending 切点；重建只确认真正纳入基线的 saved ID。
- 保护完整运行时，不能以最老运行消息作为历史游标而漏掉中间排队消息。
- 局部重建保留已经就绪的 todo/goal/context；goal 初始化失败仍阻止执行，但健康的待办和审批独立可用。
- 数据库第 51 条消息仅判断 hasMore，不加载它的附件；100 个主会话、25,000 条消息的查询仪表验证只读取选中根会话。
- 观察者抛错后先尝试 unavailable 通知；不能先静默移除而让本地 TUI 一直认为自己 ready。
- 旧绑定的索引/选择回放不能劫持新范围；Remote 的显式 undefined 可选参数不能覆盖有效默认绑定。
- Web 旧页删除复活、旧页覆盖较新非热窗口实体、丢回执跨会话恢复错草稿、pending 行抢回滚动位置均有先失败后通过的回归。
- Web 首次索引请求失败后，后续 hello 能恢复记住的会话；侧栏读取独立索引，不把当前聊天窗口当作全部会话。
- 默认 TUI 的控制响应断线后不能重新激活 Stop，未知请求不能换 ID 再发；其实际 host 转发入口也纳入验收。

## 验证记录

详见 [实际页面与进程验证](evidence/live-execution.md)。全套测试与后续修复门分开记录，不把较早的通过结果冒充最终代码的验证。

## T01–T31 证据索引

下表路径以仓库根目录为准；同一行列出多个层次时，表示组合证据，不声称所有故障在同一次真实模型请求中发生。

| ID | 自动证据 / 实际验收 |
|---|---|
| T01 | 核对 improve-1 的 05、开发分支基线和默认 in-process 拓扑；本轮未自动连接 daemon。 |
| T02–T03 | `core/lifecycle/lifecycle.unit.test.ts`、`tests/integration/core/session-recovery-source.integration.test.ts`：真实身份、多步来源、延迟基线与后续版本；另有实际流式刷新。 |
| T04–T05 | `tests/integration/core/session-recovery-source-sqlite.integration.test.ts`、`adapters/ui-initialization.integration.test.ts`：挂起 seed/DB 提交、同会话顺序、跨会话继续、history 一致切点。 |
| T06–T07 | source SQLite 集成的 205 条 running/succeeded 窗口及旧页；实际关闭最后一个页面时仍在生成，重开恢复终态。 |
| T08–T10 | SDK `session-sync.unit.test.ts`、server/remote 与 Web `session-recovery.integration.test.ts`：订阅先行、A→B→A、旧响应、真实 1024 条/8 MiB 上限、四次恢复预算与释放。 |
| T11–T13 | Web recovery/App/store、TUI recovery 与 server coordination 集成：独立 control/审批、草稿、恢复门、确切 runId Stop。 |
| T14 | `ui-initialization.integration.test.ts`、`ui-recovery-subviews.integration.test.ts`、scheduler recovery：查询不调度、不初始化模型，失败会话不开放执行且不阻塞其他会话。 |
| T15–T16 | message database-store、source SQLite、Web store：SQL keyset、删除防复活、迟到旧页不覆盖；100×250 数据中只限页读取当前根会话。 |
| T17–T18 | session-view/event-router/coordinated-run-ledger/display-reasoning 及 transport 故障注入：持久化提交一次、投影 unhealthy、局部重建、来源继续、独立通路不冻结。 |
| T19 | server/remote/Web/TUI 的原请求回执恢复：首条无 sessionId、丢响应、跨 binding、未知结果和 epoch 改变均不自动重发。 |
| T20 | 默认真实 persistent host→RPC→Ink 集成、remote/server contract、默认 PTY；`session-recovery-source.integration.test.ts` 同 session/message ID 的双 runtime 思考独立结束、落库，无临时共享。 |
| T21–T22 | server session-access/coordination、Web store/App：主会话权限、异步范围验证、旧页缓存与滚动锚点。 |
| T23–T24 | 真实页面记录见 evidence；审批独立性、子孙归属、多页一次响应、撤销不复活、版本不支持另由 permission-recovery 与 server contract 回归。 |
| T25 | source SQLite fixture：真实 run/part/call ID、tool metadata 内 execution/modelRequests、终态 prompt 经 live→view→history 一致；新 epoch 恢复 saved 思考且不伪造未保存尾部。只验证现有 metadata 扩展契约，不新增后续轮次 schema/UI。 |
| T26–T28 | lifecycle/display-reasoning unit、source SQLite 集成、context/model-response transport：结束矩阵、重试、writer 悬挂仍继续、saved 交接、真实两步工具循环和模型输入隔离。 |
| T29 | display-reasoning 与 source SQLite：多会话 256 段/16 MiB、单段超限、在途写入、晚回调、正文/工具/active 展示段不变、missing 贯穿 live/history/rebuild。生命周期的 257 段→工具→第二步用例直接断言 ContextManager 接收全部协议思考，模型两次、工具一次，淘汰不改变模型输入。 |
| T30 | SDK/owner/client contract：审批与恢复 epoch 同源、局部 generation 变化、完整版本比较、默认 TUI 不伪造 binding。 |
| T31 | 新建、选择、归档、模型保存、Web/RPC 重连和默认 TUI 接线回归；生产静态扫描无 replacement producer。`ui-model-notifications.integration.test.ts` 直接触发延迟 metadata 与主动 context 探测；SDK/TUI 压缩命令验证 context 更新。 |

自动恢复资源限制通过精确条数、UTF-8 字节数、查询次数和释放断言验证。未把整个 Node 进程的内存峰值当成恒定上限承诺；当前生成中的长段及模型协议引用不计入待保存失败预算。性能数值与最终门结果补在下文。

### 查询规模实测

命令：`OHBABY_RECOVERY_BENCH=1 pnpm exec vitest run tests/integration/core/session-recovery-source-sqlite.integration.test.ts -t 'T16 bounds'`，1/1 通过（其余 11 项按名称跳过）。

在 100 个根会话、25,000 条消息、50,000 次 message/part fixture 插入后，初始化屏障、当前 view 与一次 history 共捕获 3 次 message SQL 和 3 次 part SQL；每次分别返回 51 个消息头（含分页哨兵）和 50 个 part，参数均属于选中的 root-050。没有其他根会话的全文读取。

此次本机样本：当前 view 25,215 字节，history 24,791 字节，显式 seed 加 view 读取约 7.70 ms；SQLite 主文件 28,438,528 字节，WAL 29,000,712 字节。Vitest worker 的最大 RSS 为 214,752 KiB，测点 heapUsed 为 58,984,288 字节，包含测试运行时和 fixture 构造，不等同于产品恢复独占内存，也不是性能 SLA。待存思考的硬容量另由 T29 确定性断言验证。

### 子代理独立审查

三名子代理分别检查源端生命周期与客户端、SQLite/调度与传输、默认 TUI 与 SDK host，并交换边界审查。发现的问题均回到实际断言：历史边界漏消息、saved 投影交接、旧索引回放劫持选择、历史删除复活、未知提交跨会话恢复草稿、默认 host 取消信号丢失等。源端和 UI 各自的测试通过不替代完整接线，因此另外执行真实 HTTP/SSE 故障、真实 persistent host→RPC→Ink 和编译进程验收。

### 自动检查

- `pnpm test`：397 个文件通过，6 个文件按原有条件跳过；4,255 项通过、17 项跳过，无失败（`/tmp/ohbaby-improve11-full-tests4.log`）。包含 unit/contract/integration 及打包、真实 CLI/daemon 进程；跳过的真实外部 provider 测试不冒充自动门通过。
- 全套之后的来源重建上限及初始化屏障修复：owner、真实来源、真实 SQLite、初始化、SDK 定向共 6 文件/39 项通过（`/tmp/improve-rebuild-gate.log`）。首次 seed 失败仍阻断执行；已初始化会话重建失败只使聊天 unhealthy，之后 DB 业务可继续，显式下一次重建读回事实。
- 运行状态标签修复：selectors + App 143 项通过；真实构建页面在核心 view 503 时显示 running，实际 Stop 成功。
- 非 fresh bootstrap/index 交错修复：Web daemon 9 文件/74 项通过，包含明确 fresh 不自动恢复和实际断开重连后的完整 transcript 断言。
- `pnpm lint`、`pnpm typecheck`、`pnpm build` 全量成功；最新 Web 变更另执行 `pnpm --filter ohbaby-web build` 并复制至 CLI 内置页面。所有更晚代码变更均重新跑对应测试和检查。
- `git diff --check` 成功；改动文件均按仓库 Prettier 格式化。

Pi 修复后的最终门另记：全量运行 394 文件、4,325 tests 通过；三项 compiled suites 被同一条旧测试无参数调用 `stop` 的 TS2554 阻断，已修为明确旧 runId。随后全量 typecheck 和 lint 成功，被阻断的 package/process suites 复测 4 文件/27 项通过。最终再次完整运行 `pnpm test`：397 文件通过、6 文件跳过，4,341 项通过、17 项跳过，退出码 0，187.91 秒（`/tmp/ohbaby-improve11-full-tests6.log`）；这里不把首次失败写成全量一次通过。132 个改动文件通过格式检查，未把测试凭据写入改动。

## 残余边界

- 不承诺恢复进程崩溃前尚未保存的思考尾部；新 epoch 只读取已保存事实，不重新执行旧任务。
- 默认 TUI、显式 remote 与 Web 协议一致，独立 runtime 不共享临时思考；没有自动 daemon attach。
- 超限待存思考会明确缺失；内存预算只约束待存已结束展示段，不限制正在生成的长段或模型自身协议引用。
- T25 以现有 tool metadata 容纳 execution/modelRequests fixture 验证透传；后续阶段的专用 schema、阶段/耗时 UI 未提前实现。
- 窄竞态、失败预算和大容量通过可控测试验证，真实页面/模型结果单独记录；两者不互相冒充。

## Pi 审查

使用用户指定的 `github-copilot/claude-opus-5.5`，工作目录为仓库根目录，独立会话 `codex-improve11-review-20260925-6a3046`。只读审查当前工作树相对基线的全部跟踪及新文件。首轮指出阻断问题，第二轮继续发现边界缺陷；修复后第三轮明确未发现新阻断，可进行本地分批提交，要求提交前补齐真实页面请求计数复测。

- P1-1/P2-5：TUI/Web 区分明确拒绝与响应未知；`PROMPT_SUBMISSION_REJECTED` 只用于确认尚未进入接受写入的错误，接受后抛错仍保留未知。回执为 null 不等于未接受，不自动重发。提供显式忘记记录，未完成的 POST 不能忘记；旧 epoch 记录只提示、不永久阻塞新意图。
- P2-1：首次 seed/goal 初始化失败清除拒绝缓存，下一次显式选择或写入共享新尝试；队列退避后重试，取消不依赖 seed 成功，但等待已经在途的 seed 切点，避免初始化覆盖取消。
- P2-2/P2-3：成功安装基线结束恢复周期、清零预算；失败周期内重复通知不重置预算也不取消有效查询。源端按 generation 去重 unavailable，客户端拒绝已退役 generation 的迟到通知。
- P2-4：TUI 按第一次 Esc/当前 Ctrl+C 捕获的 runId 停止；刷新发现 B 不会把 Stop(A) 转成 Stop(B)。服务端/核心实际停止返回 false 时报告过期目标。
- P3 中 todo/goal/context/session metadata 在重建期间的提交已纳入同一短队列；effort 面板移除 legacy snapshot 轮询。

### 长流传输的测量与决策

这里补做了一个架构取舍：在保留同步提交和严格连续 revision 的前提下，仅把无其他变化的正文/思考前缀增长编码为 `textAppends`。每项含真实 messageId、partId、UTF-16 offset 和新文本；客户端拒绝不存在/重复 part 或偏移不符的事件并重新恢复。消息创建、身份/顺序/元数据/终态/saveState 变化仍发送完整消息。没有另加节流队列或延迟提交窗口；代价是两种事件形态，以及源端仍需比较累计前缀，不能据此声称全部 CPU 成本变成线性。

可控基准：初始正文 300,000 字符，在 baseline 查询暂缓期间追加 100 次 `中😀`，共 700 UTF-8 字节新正文。修复前累计事件 30,063,542 字节，SDK 8 MiB 缓冲溢出；追加编码后 23,392 字节，基线返回后客户端完整 view 与源端逐项相等。该测试不是外部 provider 吞吐测量。

服务端回放同时保留 1,000 条和 8 MiB 序列化字节两个上限。另一个实测发布 1,000 条约 300 KB 的合成事件：累计 300,113,890 字节，只保留最后 27 条、8,103,700 字节；旧游标收到 resync-required。单条超限事件仍实时发送，但不留在回放中。字节预算不是整个进程 RSS 上限。

未在本轮扩展两项 P3：in-process 通用事件订阅只有 handler，没有单消费者错误/关闭通道，观察者失败仍显式使该会话不可用，避免静默漏通知；后续可增加订阅级健康契约。已访问会话的 source partition 缓存仍存活到 runtime dispose，单会话热窗口有限不代表跨会话全局淘汰已实现。

### 第二轮复核的进一步修正

Pi 确认首轮问题基本修复，又指出“成功即重置预算”可能掩盖持续故障、Web 每 token 查询模型配置、执行初始化末尾仍被聊天投影错误阻断。逐项补充复现后继续修正：

- 在单周期四次查询之外，增加同 scope 的短时反复失效计数；第二/三次退避 100/250 ms，第四次进入 error。连续健康至少一秒才释放旧计数；重复 hello/重连不清零，明确 retry 或换 scope 才主动重置。Pi 原两秒循环从 96 次查询降为 4 次，随后保持 error；长期健康间隔的六次独立故障仍可恢复。
- `ReasoningControl` 仅在模型失效时刷新能力，session preference 由恢复视图驱动；Web 回归 100 次 token 加 metadata 变化不增加模型查询。TUI control 同样只随新 runs/prompts 刷新，显式 Stop 仍独立重查，400 次 token 不产生额外 RPC。
- 首次 seed 和 goal 初始化仍是执行前置；其后的 todo/goal 显示提交失败只标记聊天不可用，不阻止已经满足执行前置的排队任务。未打开会话的辅助事件不再隐式 seed 整个分区，打开时读取最新事实。
- 审批场景的 Ctrl+C 也使用已验证的根 runId，不能把子代理审批里的 runId 当作根执行；本轮仍不新增整树停止语义。

第三轮独立复核另运行 4 文件、72 tests 通过，并重跑原始失败脚本。剩余非阻断限制：连续四次快速故障后保持 error，重连不会自行解锁，需明确重试/刷新；缺号与换 generation 同时发生可能浪费一次有限查询；未分类的带 code 接纳错误继续保守视为未知结果，可手动忘记。Pi 未真实目测 Ink，也未用外部模型实测初始化的窄窗口，这两处分别由本任务的真实 PTY/Ink 集成和受控 backend 故障注入覆盖，不能冒充 Pi 的实测。

### 最后一次真实流式验证发现与修复

真实页面确认模型请求由 1,312 次降为 1 次。随后发现 React 更新深度异常：每个 snapshot 都调用本地提交记录的无变化 setter，连续同步外部 store 更新下仍可能排队。最终只在确有记录需要清理时调度更新，并保留 functional updater。新增真实 SDK/store/React 连续 400 次微任务回归，旧版 7 次异常、修后零异常，覆盖空记录及并发待接受记录；App 共 126 项通过。全量 4,341 项门之后仅此 App 代码修正，未把定向复测冒充又一次全量测试。

正式构建、无插桩的真实模型输出 14,581 字符，console 零错误，刷新正文完全一致。完整过程见 [真实执行证据](evidence/live-execution.md)。

Pi 同一会话第四轮只读复核最后的 React 修复及回归，另跑 App 126 项通过，结论无新增阻断、可本地分批提交。两条 Markdown MD060 对齐提示为非阻断格式建议；仓库 Prettier 检查通过。最终 typecheck 再次成功；提交 hooks 仍执行全量 lint/typecheck。

测试收尾：隔离服务与代理收到 stop 并正常退出，确认子进程 PID 已不存在，浏览器关闭；自动生成的浏览器快照移至 `/tmp/ohbaby-improve11-browser-evidence`，未纳入仓库。凭据值比对未在改动文件中发现 `.env` 密钥，未提交隔离数据库或原始模型会话。

改动按 SDK 恢复契约、核心来源与持久化、服务端恢复协议、Web/TUI/CLI、验收文档五批提交。开发分支保持 `6a304604da3281be3d55bffa1feb6f8eab33a367`，不 merge、不 push。
