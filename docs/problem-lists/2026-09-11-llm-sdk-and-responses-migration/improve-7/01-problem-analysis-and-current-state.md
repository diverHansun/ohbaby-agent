# 01：基线现状、问题与证据

基线：`openai-responses-migration@8409a863`，2026-09-16。以下为实施前调查，目标设计仅见 02。路径除特别说明外相对仓库根。

## 1. 职责与架构现状

生产入口是持久化 backend → RunWorker → Lifecycle → Context/LLMClient/ToolScheduler → provider → SDK。Context 负责准备请求；LLMClient 累积模型结果；Lifecycle 决定工具和下一步；Message 保存事实；Worker 将运行结果写入账本。

三协议已经跑通工具往返、原生状态保存、重开续聊。Lifecycle 每步调用 prepareTurn，原生步骤先 commitModelStep 再执行工具；overflow 会重新准备上下文并重试一次。相关文件：

- `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts`：run、runModelStep、markAssistantMessageError。
- `packages/ohbaby-agent/src/core/llm-client/streaming.ts`：streamResponse、buildAbortResponse。
- `packages/ohbaby-agent/src/core/context/context-manager.ts`：prepareTurnUnlocked、measureContext。
- `packages/ohbaby-agent/src/core/message/store.ts`、`database-store.ts`：模型步骤原子保存。
- `packages/ohbaby-agent/src/runtime/run-manager/worker.ts`：运行结果与事件分发。

普通工具业务错误已转成 ToolCallResult 并进入下一步，用户取消和保存故障是不同路径。本轮不是新增上述全部能力。

## 2. 承重问题

| ID  | 基线事实与证据                                                                                                       | 风险/回应入口                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| P1  | streaming.ts 的 AccumulatedToolCall 仍为 type=function、function.name/arguments，最后再转自有 ToolCallSnapshot       | 转换多余、命名仍依赖旧 Chat；02 Stage A                             |
| P2  | 收到 finish 即发 isComplete，中间帧和尾部最终解析可多次完成；Lifecycle 每次都发 llm:complete                         | 完成事件重复、晚到错误前可能提前宣告完成；Stage B                   |
| P3  | Lifecycle 单独处理 length，但 content_filter 落入无工具 success=true；Worker 按 result.success 写 succeeded          | 过滤后运行误报成功；Stage B                                         |
| P4  | 普通 serializer 对 assistant finish=error 整条过滤；生命周期把 length/cancel 等压成 Unknown，把多种中断压成 APIError | 持久数据缺少可靠分类，无法安全决定下轮正文；Stage C                 |
| P5  | 摘要 serialization.ts 不检查消息 finish/error，serializePart 直接取 active text                                      | 取消正文可能经摘要重新进入历史；Stage C 的语义交接最小修复          |
| P6  | SDK 默认 2 次重试，项目默认 5 次；外层事件看不到 SDK 内部次数                                                        | 部分错误最多可能 18 次传输尝试；保留行为、补可观测边界测试，Stage D |
| P7  | Context 已有请求快照、工具配对、runtime reset、thrash 等机制，但缺少本轮部分正文与终态变更的贯穿验收                 | 已有机制验证与最小缺口修复，Stage D                                 |

## 3. 数据模型与数据流的具体缺口

### 3.1 完成快照不能直接等同成功

`core/llm-client/types.ts` 已有 isComplete、finishReason、streamStopReason。abort 最终快照也会 isComplete=true；Lifecycle 当前未消费 streamStopReason，主要靠 signal 判断取消。SDK 报取消但外部 signal 未置位时需要验证。

streaming.ts 还有依赖“前面已经发过完成”的纯文本早退；只把中间 isComplete 改成 false 会使正常纯文本缺少最终结果。现有 llm-client.test.ts 甚至固定了空流产生完成快照的行为。空流、仅 usage 无终态、正常 stop 空正文必须分开。

### 3.2 历史记录与发送材料并不相同

`core/message/types.ts` / `events.ts` 已有 MessageOutputLengthError、MessageAbortedError，但实际长度/取消路径多写 Unknown。数据库用 JSON 保存 Message，新增错误分支不必增加 SQL 列，但 TypeScript/Zod 事件 schema 必须同步。

`core/context/serializer.ts` 是普通模型请求路径；`core/context/serialization.ts` 与 `adapters/ui-runtime/prompt-context.ts` 是摘要路径。仅修改前者不能保证失败正文政策一致。

`core/llm-client/streaming.ts` 当前将已有输出后的多种异常都包成 ProviderStreamInterruptedError，包括可能的协议/native 校验错误。它不能直接等同“确认是网络断流”。历史白名单必须有结构化来源，不解析错误文案，也不能按一次 Run 的状态猜每条消息：Message 目前没有 runId。

TextPart 并非都对用户可见；runtime model-context 的 synthetic text 在 UI 中被隐藏。投影必须排除 ignored、compacted、isModelContextPart，而不只是检查 type=text。

### 3.3 工具事实与用量

每个模型步骤有独立 assistant 消息；后一步失败不应抹掉前一步已完成工具。工具执行期间取消，现有路径先保存结果，再返回 cancelled，并不把有效工具消息整条改成失败。serializer 对 pending/running 有“结果未知，可能已有副作用”的占位。

Lifecycle 使用最后接受结果的 usage，配对当次 PreparedTurn.sentHeuristic；这不依赖 complete 事件出现次数。本轮不能因去重而丢掉最后 usage，也不能对旧尝试重复结算。

## 4. 已跑调查与证据边界

本地证据目录：`.ohbaby/test-evidence/improve-7/investigation/`（未纳入 Git、不是其他机器必有的前置条件）。实施者应把下列复现移入正式测试，04 给出对应场景，不能依赖临时目录才能验收。

| 调查                                               | 观察结果                                                                         | 能证明/不能证明                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------- |
| 6 文件定向单元/集成                                | 136 项通过                                                                       | 旧合同通过，不覆盖本轮所有目标                 |
| 三协议实网读取、继续、SQLite 重开                  | 三组通过；HTTP Chat 6、Responses 7、Anthropic 6，含 metadata/title               | 验证正常生产链路，不是容量极限测试             |
| 三协议两次顺序 read + 回答                         | 每组 3 个模型步骤；调用/结果 ID 与实际 HTTP 配对正确                             | 两个工具均各执行一次                           |
| 同上完成事件计数                                   | Chat 2/2/1；Responses 2/2/2；Anthropic 3/3/1                                     | 复现重复通知；未证明重复工具执行/重复计费      |
| Responses 真实截断                                 | 测试请求上限 128、关闭推理；outputTokens=128，failed/output_length，715 字符保留 | 上游真实 length；未验证下一轮是否带正文        |
| 真实 Responses 流 + 本地断流                       | 3 字符保留，1 次请求、0 自动重试                                                 | 中断由测试注入，不冒充自然网络故障             |
| 传输入口前三次模拟 503、第四次实网成功             | provider 两次尝试，HTTP 3/1，外层重试事件 1 次                                   | 复现 SDK 与外层叠加；前三次未发上游            |
| content_filter 规范化注入 + Responses 协议 fixture | success=true/completed，持久化后端 succeeded；无工具执行                         | 不是上游真实过滤，但贯穿生产状态链，确定可复现 |
| 按目标写的两个复现断言                             | 过滤不得成功、步骤完成只能一次：均失败                                           | 待修复缺陷，不能计作验收通过                   |
| SDK 错误包装离线检查                               | 原始 ECONNRESET 外层可重试；包装 APIConnectionError/Timeout 后外层未识别         | 直接关闭 SDK 不等价；本轮保留分类与配置        |

模型路由：ZenMux `deepseek/deepseek-v4.1-flash` Chat、`openai/gpt-5.6-luna` Responses、`anthropic/claude-sonnet-5` Anthropic。探测窗口分别 1000000、1050000、1000000。没有遍历清单所有模型，没有执行完整仓库 preflight，没有真实百万窗口 95% 与真实 overflow 证据。

## 5. 截图管理规则与本仓现状

截图用于检查遗漏，不作为参考项目实现已被本轮逐项核验的证据。

| 规则                                                 | 已有机制                                                                                                                            | 仍需验证的边界                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 估算对应下一次实际发送；history/tools 变化旧估算失效 | context-manager 从最终 request 计量并返回 PreparedTurn；Lifecycle 每步 resolveTools/prepare                                         | 新增派生正文/取消说明也必须进入相同计量材料，不能只发送不计量                      |
| 保留历史不切断工具调用/结果                          | serializer 同一 ToolPart 生成配对；compaction-policy 按消息边界切分并保护未完成 native 依赖                                         | 失败/取消过滤和摘要投影不能破坏这组事实                                            |
| 模型切换不沿用旧模型 overflow/旧用量触发             | ui-inprocess.connectModelInternal 阻止运行中切换；完成切换后 resetRuntime 并清 contextWindowUsage；新 runtime 创建新 ContextManager | 单测 maps 只按 session/scope key 不能据此宣称生产污染；补完整入口跨模型测试        |
| 刚压缩、无新增内容时避免反复压缩                     | 现有 thrash 是连续低收益后锁定，usage 增加可解锁，force 可绕过                                                                      | 没有 same-history 指纹去重；不承诺“压缩一次后相同历史永不再压缩”，不借本轮新增策略 |

## 6. 文档与实现对照、SWE 取舍

| 历史文档/约束                                                                         | 当前代码                                                 | 本轮处理                                   |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------ |
| docs/core/lifecycle/architecture.md 仍描述 TurnProcessor/processor.ts 等旧布局        | 现为 lifecycle.ts + 独立 runtime/worker                  | 实施同步相关职责说明，不按旧目录图重造组件 |
| docs/core/llm-client/data-model.md 把 isComplete 简写为是否完成，且保留旧 Chat 类型名 | 自有类型已落地，abort 与 provider 终态仍混用完成事件     | 更新精确含义与消费者边界                   |
| improve-6 摘要仅正常 stop 才能接受                                                    | prompt-context 已等耗尽并拒绝 abort/length/filter/空摘要 | 保持；正文可进历史不等于截断摘要可被接受   |
| improve-6 保留压缩算法与完整窗口 95%                                                  | 已实现，但大窗口实网仍未测                               | 保留边界，不以本轮规划冒充补验             |

正确性优先于新增抽象。复用 MessageError 与现有投影入口，避免回放布尔字段堆叠、跨层重试预算器、整套事件溯源或第二个 Agent loop。新增模型可见说明会改变请求和估算数字，测试应验证语义与同请求计量，不能靠还原旧数字掩盖变化。
