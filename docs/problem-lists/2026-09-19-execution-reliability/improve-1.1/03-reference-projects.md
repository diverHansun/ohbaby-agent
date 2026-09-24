# 03 参考项目与取舍

> 2026-09-22 核对本地源码，09-23 补查失败链及迁移取舍。目录根为 `/Users/hansun025/Projects/code-cli/`。下表路径均相对各仓库根；结论只针对调查到的路径，不宣称这些项目整体提供相同的一致性保证。

## 3.1 基线与代码证据

| 项目 / commit | 承重位置 | 已核实行为 |
|---|---|---|
| kimi-code / `19c5aa64ebef86925ad58074ebcac6a5a7a8ff8d` | `packages/server/src/services/gateway/wsBroadcastService.ts` 的 _dispatch、getSnapshotState；同目录 inFlightTurnTracker.ts；`packages/server/src/services/snapshot/snapshotService.ts` | 按会话有序分发；等待已有队列后同步读取 seq/epoch/inFlightTurn 配对；流式 delta 与持久 journal 的序号/offset 处理区分。snapshotService 的 transcript、状态等其他读取并不因此全部原子化 |
| codex / `5c19155cbd93bfa099016e7487259f61669823ff` | `codex-rs/app-server/src/thread_state.rs` 的 SendThreadResumeResponse；`codex-rs/app-server/src/request_processors/thread_lifecycle.rs` 的 listener 命令处理；`codex-rs/app-server/src/request_processors/turn_processor.rs` | resume 响应通过 thread listener 顺序处理，组合活动 turn 与历史并恢复 pending；interrupt 校验目标 turn，不能用旧目标任意停止新 turn |
| deepseek-harness / `47f943859bef60e4160492346772ded9b24f765a` | `packages/client/runtime/src/client/sessions/session.ts` 的 doOpen、installWindow、acceptLiveEvent、repairGap；同目录 projection-store.ts；`packages/host/apiproxy/src/api-proxy.ts`、`packages/host/apiproxy/src/api/sessions.ts`、`packages/host/apiproxy/src/api/events.ts` | open generation 防迟到写；历史窗口与 liveBuffer 衔接、seq 去重和缺口重取；projection 较高版本优先；更早历史失败保留窗口。events API 明确 since 尚未实现，重连是重开流并重读历史 |
| opencode / `d4ad650f738aaa986cee5879c581bd4834277577` | `packages/app/src/context/global-sync/bootstrap.ts`、event-reducer.ts；`packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts` | bootstrap 使用 allSettled 保留部分结果并报告失败；connected 后刷新；part 完整更新与 delta 更新分开。SSE 先装 listener 再 connected，该路由 SSE id 为 undefined，不能据此声称 Last-Event-ID 续传保证 |
| claude-code（CCB）/ `987e55034c38497e1081367fdbe2056a6603ebc7` | README；`packages/remote-control-server/src/transport/event-bus.ts`、sse-writer.ts；`packages/remote-control-server/src/routes/web/sessions.ts` | 本地仓库是社区 Claude Code Best 复原/扩展项目，不是 Anthropic 官方源码。按 session 的 seq 和有限内存 replay；getEventsSince 返回保留尾部，没有明确检测游标已落在淘汰区的完整机制 |
| pi / `57cde86906679fd0581b277a179ab46fa2a09ab6` | `packages/coding-agent/src/modes/rpc/rpc-mode.ts` 的 subscribe、get_state、get_messages；`packages/server/src/supervisor.ts` | RPC 有当前状态查询与消息查询，事件单独订阅；这些路径不能证明状态、消息和事件游标属于同一切点。协议定义中出现 revision 不等于生产恢复流程已接通 |

## 3.2 采用什么，不照搬什么

| 取舍 | 落到本轮 |
|---|---|
| 借鉴 Kimi 的会话内顺序及当前 in-flight 累计状态 | 同步取得已提交视图和版本；正文与思考恢复当前值。但不复制 durable journal，不把其局部保证说成整页一致 |
| 借鉴 Codex 的恢复请求进入与 live 同源的顺序、明确控制目标 | 应用层统一提交；Stop 带确切 runId。不同执行模型下不照搬 Rust actor 或整个 app-server |
| 借鉴 DeepSeek 的 generation、窗口、缓冲、缺口修复 | 旧请求不覆盖新范围，旧页不覆盖新内容；缺口重取。必须同时建立我们自己的源端版本，不能只抄客户端算法 |
| 借鉴 OpenCode 的部分失败隔离与订阅就绪顺序 | 附加读取失败只处理对应区域；listener 先于 hello。allSettled 只是错误收集手段，不自动证明核心基线正确 |
| 借鉴 CCB 的有限缓存和去重，补足缺口显式处理 | 环形缓存过期必须新基线，不能把保留尾部当完整续传；不采用只有日志的关键提交失败处理 |
| Pi 提供简单的状态/消息分离参考 | 说明可以保留简单接口，但分接口本身不构成一致性；不引入无证据的可靠恢复宣称 |

没有一个被查路径可以直接作为 ohbaby 整套方案的正确性证明。本轮以“真实来源身份、同切点版本、客户端连续消费”的测试证明自己的保证。todo/goal/queue 分类依据 ohbaby 当前依赖，而非看参考项目放在哪个 UI 区域。

## 3.3 思考存储取舍补查

本次确认修改的是旧 B+ 的存储限制，不是将其他项目的模型上下文策略直接搬入 ohbaby。

| 项目与仓库相对路径 | 核实的做法 | 本轮采用及限制 |
|---|---|---|
| OpenCode：`packages/opencode/src/session/processor.ts` 的 finishReasoning 和收尾；`packages/core/src/session/projector.ts` 的 PartUpdated | 结束时更新完整 reasoning part，成功后删除运行内存项；收尾也处理未结束段，PartUpdated 投影到 DB | 借鉴先保存再释放、正常及异常收尾统一。流式 delta 与完整 PartUpdated 区分，不能据此声称每 token 都落盘或崩溃不丢尾部 |
| Pi：`packages/coding-agent/src/core/agent-session.ts` 的 message_end；`session-manager.ts` 的 _persist | 消息结束时保存完整 assistant；持久化函数调用同步文件写入 | 借鉴按结束边界保存；不是 ohbaby SQLite 的直接实现，不说明两者写入失败策略相同 |
| Codex：`codex-rs/rollout/src/policy.rs` | Reasoning response item 可以进入 rollout；记忆提取另有筛选规则，delta 与完整项区别处理 | 借鉴存储用途分离；不能将原生 reasoning state 等同于 ohbaby 展示纯文本，不能推导保存后就应全部回灌模型 |

进一步沿调用链核查，四个项目并非统一采用“写失败就停止 run”：

| 项目 / 错误链 | 核实事实 | 对本轮的限制 |
|---|---|---|
| OpenCode `session/processor.ts` 的 process / halt | 处理链异常经过 retry/catch(halt)，设置消息错误；cleanup 仍执行 | 借鉴先保存后释放，不据此声称展示思考写失败天然隔离 |
| Pi `packages/agent/src/agent.ts` 的 processEvents / runWithLifecycle | await 事件监听器，appendMessage 的文件错误可进入 run 失败处理 | 保存完整执行消息与单独展示记录不是同一取舍，不照搬其失败范围 |
| Kimi `packages/agent-core/src/agent/records/persistence.ts` 的 scheduleFlush / throwIfError；agent/index.ts 的 emitRecordsWriteError | 后台写失败记录错误并通知，后续 append/flush 继续抛错 | 借鉴明确通知，不能误写为“失败永远不会影响后续运行” |
| DeepSeek Harness `packages/session/session-persistence/src/write-behind.ts` 的 startWrite / flush；coordinator.ts 的 reportBackgroundFailure | 后台失败保留有序批次、记录告警；显式 flush 失败向调用方返回，新工作/flush 可触发再次尝试 | 借鉴后台保存与执行方分开、真实失败保留；其队列机制不自动证明文本总内存有界 |

本轮 D10/D12 是用户明确选择：展示思考保存失败继续 run、有限保留且超限明确缺失。它不是某一项目现成策略的复制；重试只写同一 part，不能扩大为完整执行事件后台化。16 MiB/256段等是可测试、可调整的工程预算，不声称来源于这些项目。

## 3.4 Fable 审核建议的逐项取舍

来源：[Fable-5.1 对 improve-1.1 的审核](https://opncd.ai/share/BhfcfWuk)，已在浏览器核对全文。采用经本地源码验证且符合用户确认的部分，未将外部审阅当作实现依据的替代品。

| 审核问题 | 本轮取舍及落点 |
|---|---|
| 范围重，分页/receipt/自动重建能否后延 | 承认本轮是跨模块改造；02 §2.1 区分正确性基础、已确认配套及有限保障，S1先验证源端。不撤回用户确认的按需历史；receipt只复用现有记录查询，不建可靠消息中间件；重建仅当前视图、有限预算、一个入口，不建自动修复平台 |
| 思考为什么不落盘 | 查明旧 B+ 是历史产品决定，01补原因；用户 D8/D9 已改变目标，结束落盘、当前累计、上下文隔离。没有采纳每token写库，也不宣称落盘消除了所有缓存/存储成本 |
| 八个编号混杂 | 02 §2.2 列owner、变化时机、比较边界及各通路字段；runtimeEpoch/permissionEpoch同owner同值，client generation仅本地；T30验收。复用小型版本比较函数，不造万能同步框架 |
| 初始化谁触发 | 02 §2.2 沿现有ui-persistent startupReady接backend就绪，scheduler显式启动；轻量Goal owner与模型runtime分开，选择/写入前一次seed，读取不触发执行；T04/T14覆盖无人开页面及重复GET |
| 旧snapshot.replaced如何退场 | 02 §2.5逐类迁移后端触发者、Web/RPC自造事件及TUI reducer。仅保留旧主动查询形状；停止仓内全量广播和全替换执行分支，不长期双轨；T31覆盖模型、归档、选择等不能丢的通知 |
| TUI改多少 | 同批迁移本地SDK读取、真实消息、合并及失效通知，明确必要验收；不加默认daemon连接、不复制网络hello/localStorage。显式remote另验；T20/T31 |
| D编号撞车 | 中央04表头明确所有D指improve-1.1的00；跨轮用轮次+编号，不重编号破坏已有引用 |

Kimi 的同步 seq/inFlight 捕获、DeepSeek 的客户端 openGeneration/liveBuffer、OpenCode 的按事件刷新、Pi 的只读状态/消息接口，分别支持上述局部取舍；它们没有共同证明 ohbaby 已具备完整恢复保证。仍须按04做真实来源及消费者集成验证。

返回：[README](README.md) · [工程方案](02-optimization-plan-and-change-scope.md) · [测试](04-test-and-acceptance.md)。
