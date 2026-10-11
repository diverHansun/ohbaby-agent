# 现状、问题与证据

> 调查基线：`24c7003448840fb4ba5acedb15d31456651e1466`；2026-10-11 复核。未实施本方案。
> 需求见[00](./00-discussion.md)，目标流程见[02](./02-optimization-plan-and-change-scope.md)。以下代码路径相对于`packages/ohbaby-agent/src/`，行号为调查快照，定位以函数名为准。

## 1. 核心问题

| ID | 当前事实与影响 | 代码证据 |
| --- | --- | --- |
| P1 | 摘要客户端换短 system、移除 tools 并拍平历史，共享前缀与正常请求不同；接近满窗时这次输入尤其昂贵 | `adapters/ui-runtime/prompt-context.ts:85`；`core/context/compression-prompt.ts` |
| P2 | `runCompactionCore`先 prune；降到阈值下可不做摘要。历史从改动位置开始变化，且只释放少量空间，容易很快再次触发 | `core/context/context-manager.ts:1188`起；`core/context/constants.ts` |
| P3 | 多份活动摘要同时进入模型视图，生成下一份时却排除旧摘要，无法形成可靠的滚动继承 | `core/context/context-manager.ts:208`、`:823` |
| P4 | 超窗恢复缩小`summaryHistory`，候选仍可能按原`historyToCompress`提交，未读历史被错误退场 | `core/context/context-manager.ts:925`、`:967`、`:988` |
| P5 | 模型能力、普通 maxoutput 偏好及摘要额度尚未分清；本地预留可能被半窗规则缩小，而实际发送另算 | `config/llm/apply-active-model-config.ts:301`；`services/llm-model/modelProfiles.ts:221`；`core/llm-client/streaming.ts:291` |
| P6 | reasoning 已有计数与持久化，但尾段的兼容内存路径及标准 usage 明细不完整；摘要客户端忽略实际 usage | `core/context/compaction-policy.ts:26`；`core/context/token-estimation.ts:59`；`adapters/ui-runtime/prompt-context.ts:85` |
| P7 | 摘要客户端、Context、streaming 及 SDK 存在多层重试；摘要失败还可继续普通请求，再由 overflow 以 force 入口重做 | `adapters/ui-runtime/prompt-context.ts:97`；`core/context/context-manager.ts:865`；`core/lifecycle/lifecycle.ts:658`；`core/llm-client/retry.ts` |
| P8 | 历史 mask／prune、成功次数帽、手动入口与信号接线增加状态组合；与新确认的统一过程和失败保留历史不符 | `core/context/context-manager.ts`；`core/context/compaction-policy.ts:86`；`core/context/types.ts` |

缓存从改动位置之后失配，不等于每次整份请求的缓存必然归零；提供商命中率不能由本地源码直接证明。

## 2. Context 的职责、结构与数据流

现有职责是装配模型输入、计量和选择上下文维护动作。普通请求经`assembleModelRequest()`和 serializer 形成`PreparedModelRequest`。它目前只含 inputIds、messages、tools；reasoning、输出额度和 cache 配置在 streaming 阶段继续解析，测量与发送尚未共享全部最终选项。证据：`core/context/types.ts:95`、`core/llm-client/streaming.ts:291`。

当前维护顺序是判断档位、prune、再判断是否需要摘要；摘要另走短 system 客户端。mask 是投影替换，生产默认关闭；prune 会让符合条件的 completed tool part 退出模型视图，可能连调用与结果一起移除。两者保护条件不同，不能合称“只裁输出文字”。

普通 assistant 正文、user 正文不是常规 tool prune 的直接对象，但摘要提交会让被覆盖的历史 parts 退出活动视图。子代理回传给主代理的结果属于主上下文；子代理自己的内部整段历史不自动复制给主代理。

## 3. 数据模型与持久化

摘要用`kind=context-summary`消息保存，活动视图依据 part 标记选择。已有`commitCompaction()`在一个 SQLite 事务中比较预期 parts、保存摘要并更新标记，可复用。它不需要换成历史版本系统。证据：`core/message/database-store.ts:526`。

原始记录退场是模型视图变化，不是物理删除。当前`hasSummary`检查 rawHistory，后续应区分仍活动摘要与仅留档摘要；这不需要新的 activeSummaryId。证据：`core/context/context-manager.ts:540`。

工具结果已经存入 ToolPart 的正文、状态与 metadata；serializer 按 callId 生成调用和结果。`formatToolResultContentForModel()`是既有纯投影，已处理退出状态、分页和子代理标识。证据：`core/lifecycle/lifecycle.ts:234`、`:1789`；`core/context/serializer.ts:196`；`core/context/tool-metadata-projection.ts:280`。因此新增第二份预览生命周期缺少当前需求依据。

## 4. reasoning、计量与记录的边界

- 显示 reasoning 先流入内存，并按片段保存；有效步骤的原生 model-state 与正文／工具调用一起提交数据库。不能说 reasoning 一律只在内存，也不能把 UI 显示内容一律重复发送。
- 历史回放按当前协议／来源选择原生状态；兼容路径可能从`activeReasoningByMessageId`取文字。完整请求估算已有该路径，尾段估算尚未完全对齐。
- opaque 状态使用 usage 或请求限额的保守代理值；它可能高估，不能报成精确回放 token 或额外计费。
- reasoning 实际用量是 output 的子项，cache read/create 是 input 的分类；不能重复加进 total。缺失明细不等于 0。
- 普通请求记录依赖 runId／messageId／step，手动摘要或失败摘要无法靠成功摘要消息取得完整归属。当前摘要接口返回字符串，不携带成功 requestId 或独立尝试记录。

证据：`core/lifecycle/display-reasoning.ts:194`；`core/message/database-store.ts:256`、`:314`；`core/context/serializer.ts:159`、`:208`；`core/context/native-context.ts:27`；`core/llm-client/streaming.ts:595`；`core/llm-client/types.ts:257`。

## 5. 模型接口与预算

`ReasoningConfig`已有 enabled／effort；`/connect`没有数字 thinking 输入框，但 model profile 可以包含 fixed budgets 映射。`resolveRequestReasoning()`已有 fixed B 必须小于总输出的校验，不会自动 clamp B。不能再用摘要 32K 试行值人为制造大 B 不兼容。证据：`services/interface-providers/reasoning.ts:341`。

`applyActiveModelConfig()`把普通 maxoutput 同时写到两个含义容易混淆的字段；profile 优先级可能让普通偏好变成看似真实的模型输出能力。`calculateTokenBudget()`又有最多约半窗预留的旧规则。二者是应先清理的耦合，不是增加新产品限制的依据。

当前 Chat adapter 固定使用`max_tokens`，所支持的端点／模型可能需要`max_completion_tokens`；Responses 和 Anthropic 有各自字段。应按真实协议能力修正，不能全局替换所有兼容接口。证据：`services/interface-providers/openai-compatible.ts:78`、`openai-responses.ts:155`、`anthropic.ts:397`。

`prompt-cache.ts:215`将非 agent-step 用途降为 observe-only；Responses 当前也有本地 observe-only 策略。这不代表接口没有缓存能力。应核对已实现的端点策略与摘要是否共享有效身份，不能复制一个用途标签就声称缓存已接通。

## 6. 用例与失败边界

手动 compact 当前进入 mutation lane，可能将重复调用排队；SDK／Context 手动选项没有完整贯通 signal。界面禁用不足以代替后端 busy 与重复判定。摘要失败后，lifecycle 仍可能发送普通请求，再以 force 恢复，形成跨入口重试。成功两次上限不能解决这个问题。

普通流在已收到正文／reasoning 后会将错误包装成流中断，不继续自动重发（`core/llm-client/streaming.ts:682`）。摘要允许的一次暂时性网络重试不能只改外层次数，还要按用途识别真实断流原因、保留尝试用量，并关闭实际 provider 调用的 SDK 隐式重试；不能因此全局改变普通流规则。

工具的执行 completed 只说明执行结束，不说明普通模型已经读到结果；下一次 prepare 可能先 compact。保留未首次交付的 user 输入与保护工具协议闭合，是不同语义。证据：`core/lifecycle/lifecycle.ts:557`、`:1163`；`core/context/context-manager.ts:1699`。

现有工具源头限制各不相同：Read 分页且约 50KiB 一页；通用“8000 token”限长实际约乘 4 换算字符；子代理已有结果文件。统一再裁一遍可能造成 Read 游标跳过未显示内容。证据：`tools/utils/read-file-page.ts:262`；`tools/utils/output.ts:4`；`utils/truncate.ts:5`；`agents/subagents/result-artifacts.ts:141`。

## 7. 非功能要求与现有验证

当前主要风险是无谓重复读取整窗、摘要信息遗失、恢复后调用关系破坏、实际预算与本地容量不一致，以及失败留下部分历史改动。没有实网证据支持固定缓存命中率或费用节省百分比。

本次讨论中已运行的既有测试包括 native-context、token-estimation、tokenCounting、modelProfiles 四文件 51 项，以及 message database-store／atomic-model-step 两文件 40 项。它们证明部分现有估算、持久化和事务行为，不等于新方案已实现。当前这次文档更新没有重跑业务测试，也没有 ohbaby 实网验收。

后续测试缺口是同份准备请求跨协议发送、重试总数、旧摘要继承、保留边界、失败／Stop／新输入事务时序，以及真实 cache usage；具体安排见[04](./04-test-and-acceptance.md)。

## 8. 文档与代码关系、SWE 判断

| 既有文档或草案 | 当前代码／最新需求 | 处理 |
| --- | --- | --- |
| `docs/core/context/goals-duty.md`、`dfd-interface.md`、`test.md`描述 95%、mask／prune | 与基线实现有关，但新方案要改成 90%与统一 compact | 随实施更新对应模块记录和权威说明，不把目标冒充现状 |
| 早期 plan 描述 20%尾段、50%压后线、手动不改、内容修正重试 | 已被用户后续讨论替代 | 本轮已重写 00～04；历史仅留讨论存档 |
| G1 要求测量与发送共用请求 | 摘要与最终发送选项尚有分叉 | 在现有准备与适配链路补齐，不新建第二套装配器 |

主要复杂度来自同一事实有多个预算口径、多个历史修改入口和多个重试所有者。改造应减少这些分叉。工具配额分配器、完整历史版本系统、通用计费框架和自动升额策略会引入新的状态组合，当前没有必要。
