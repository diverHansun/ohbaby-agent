# 05：实施与验收记录

状态：本轮实现与 T01–T22 / E1–E4 计划验收完成，保留全部失败样本及前序容量缺口。分支 `codex/improve-7-agent-loop`，基线 `8409a863`。用户授权分批实施、真实 API 测试、独立审查后本地提交；不 merge/push。

本文件记录结果；目标合同见 02，验收标准见 04。未完成批次不能计作通过。

## 5.1 实施前反馈对齐

已逐项对照 Cursor 反馈与源码：

- Stage A 以 T01 和定向三协议 fixture 为核心条件；另按用户要求做轻量真实工具循环，不强绑完整 E1。
- 固定说明写在 02 §2.4。默认在原 assistant 上保存结构化错误，发送时提取允许正文；无正文/取消事实使用同一 assistant 的一个 synthetic TextPart，不新建 abort 消息管线。
- `(Interrupted)` 合成占位已在 B 移除，不能作为 C 正文材料。
- 工具阶段取消说明不能混入 native 正文；作为工具配对之后的普通历史说明。
- T20 只验证现有 connectModelInternal；不扩大 UI 范围。

Q1 已由用户明确确认。SDK 配置、压缩算法和完整窗口 95% 阈值不变。

## 5.2 Stage A：内部工具累积

生产改动：`streaming.ts` 内部 accumulator 改为 callId/name/argumentsJson。snapshot 继续按 index 排序，parsed calls 继续按首次出现顺序。完成事件与过滤终态留 Stage B。

| 验证                                      | 结果                                                 |
| ----------------------------------------- | ---------------------------------------------------- |
| 改前基线：LLMClient、native、Lifecycle    | 3 文件 / 78 项通过                                   |
| 改前新增行为刻画                          | llm-client 33 项通过；纯形状重构不制造虚假的行为失败 |
| 改后定向单元及三协议集成                  | 5 文件 / 96 项通过                                   |
| 独立审查复跑                              | 6 文件 / 315 项通过，未发现阻断                      |
| harness 防真空配对检查                    | 4 项通过；三份实网证据离线补验均通过                 |
| agent typecheck / 定向 ESLint / diff 检查 | 通过                                                 |

真实 API 使用 `.env` 注入，固定模型不换模型刷结果：

| 协议 / 模型                 | HTTP 总数（含 metadata/title） | agent-step 请求 | 成功 read | 完成事件（B 前基线） |
| --------------------------- | ------------------------------ | --------------- | --------- | -------------------- |
| Chat / deepseek-v4.1-flash  | 4                              | 2               | 1         | 3                    |
| Responses / gpt-5.6-luna    | 4                              | 2               | 1         | 4                    |
| Anthropic / claude-sonnet-5 | 4                              | 2               | 1         | 4                    |

三组均成功；非空 callId 从 tool:start 到成功结果，并出现在后续真实 HTTP 的调用与结果中。重复完成事件是已登记的 Stage B 缺陷，不是重复工具执行。没有将本批轻量循环写成完整 E1 通过。

命令入口：`node scripts/run-real-agent-loop-e2e.mjs --profile=<固定 profile> --mode=stage-a`。profile 清单由 runner 校验。证据目录 `.ohbaby/test-evidence/improve-7/live-loop/`，三份 `*-stage-a-*-audit.json`、对应 session 摘要和 `stage-a-offline-handoff-verification.json`；原始正文、密钥和 native 不透明载荷不提交。定向基线日志在 `stage-a/baseline.log`。

## 5.3 Stage B：请求完成与运行结果

只有流耗尽、终态与工具/native 校验通过后才发布一次 `llm:complete`。取消和未确认终态不伪造完成；`length` / `content_filter` 是已结束但未成功的请求，不执行工具、不提交 native 状态、不自动续写。可信 usage 先接受，普通正文结束标记或 native 保存失败不能抹掉这笔用量。主动取消不再生成 `(Interrupted)` 假正文。

- 定向单元/集成：14 文件 / 393 项通过；独立审查发现终态错误标记落库失败会丢失 usage，补回归后 57 项通过，复审无剩余 P1/P2。
- observer：5 项通过；harness TypeScript 检查通过。
- SDK 配置、外层重试类别不变。已输出文本/推理/工具参数后不会自动重发。未知错误和 native 校验错误不能冒充可回放断流。
- Stage C 仍须完成结构化历史分类及无正文终态的事实/usage 载体；B 的通过不代表 C 已完成。

真实 E1（两次读取、工具业务失败后修正、续聊、SQLite 重开）：

| 固定协议/模型 | HTTP（含 metadata/title） | agent-step / 完成事件 | 结果 |
| --- | --- | --- | --- |
| Chat / deepseek-v4.1-flash | 10 | 8 / 8 | 通过 |
| Responses / gpt-5.6-luna | 10 | 8 / 8 | 通过 |
| Anthropic / claude-sonnet-5，第 1 次 | 5 | 3 / 2 | 断流，未完成 |
| Anthropic，同模型第 2 次 | 4 | 2 / 1 | 无 provider 终态，未完成 |
| Anthropic，同模型第 3 次 | 10 | 8 / 8 | 完整 E1 通过 |

Anthropic 三次累计 19 HTTP；保留原失败证据，不把最后一次通过解释为没有断流。前两次脱敏记录不能追溯底层错误来源；已补安全诊断字段。没有修改生产重试或换模型刷结果。诊断见本地 `stage-b/anthropic-e1-diagnosis.json`。

Responses 真实 `length-terminal`：HTTP 3、agent-step/完成事件 1/1、output 128 tokens、保存正文 688 字符、Run `failed/output_length`、工具/native 零执行；未运行 C 的下一请求历史断言。证据 `live-loop/*-length-terminal-1789554494772-audit.json`。

Stage A 提交：`ad9e883`。B 日志见 `stage-b/`；E1 audit 时间戳为 `1789554104122`（Chat/Responses）、`1789554104123` / `1789554494753` / `1789554645679`（Anthropic）。所有本地证据均位于 `.ohbaby/test-evidence/improve-7/`；敏感正文、密钥、不透明 native 数据不提交。

Stage B 提交：`0dc39b14`。

## 5.4 Stage C：失败回复的保存与历史投影

原 assistant 保存结构化错误。可靠 length/filter、明确 transport/无终态 EOF 只投影 active 可见正文并附说明；取消正文仍可查看，但下一请求只带取消事实。Unknown/APIError、协议/native 校验失败保守过滤。无正文失败/取消的事实使用原 assistant 上一个 scoped synthetic TextPart，退休后不重新生成；无正文 length/filter 的已接受 usage 同载体保存。

工具阶段取消保持已接受 assistant 的原 finish、native 和配对工具结果，取消说明置于结果之后。普通请求、实际摘要和失败回复计量共用选择规则；默认 readable scoring、压缩选段/退休/prune 策略不变。

确定性验证：根定向 6 文件 / 99 项通过；独立审查 8 文件 / 74 项通过。补正既有 transport bridge 取消用例中“取消仍发模型完成”的旧断言，现在检查 complete=0、Run 数值为不完整 usage，13 项通过。无正文事实退休后再调用 ensure 也不会生成新载体。

真实 API E2E，固定模型与 Stage A/B 相同，每例 HTTP 5（共 50），10 例全部首跑通过：

| 场景 | Chat | Responses | Anthropic | 实际检查 |
| --- | --- | --- | --- | --- |
| 真实流中本地注入 ECONNRESET | 通过 | 通过 | 通过 | 原步 complete=0、failed；下一 HTTP 及重开后正文+说明各一次，无失败 native |
| 真实流中主动 abortRun | 通过 | 通过 | 通过 | 原步 complete=0、cancelled；正文留库但两次后续 HTTP 均排除，说明一次 |
| 工具结果落库后 abortRun | 通过 | 通过 | 通过 | 原请求完成保留，工具 completed/output 不变，next/reopen 调用与结果 ID 配对，说明一次 |
| 真实 length 后继续 | 不适用 | 通过 | 不适用 | output_length、正文保留，next/reopen 允许正文+说明一次，无自动续写 |

断流/取消为真实上游流消费时的本地注入，不是上游自然故障证据。逐例摘要及 artifact/log 路径：`stage-c/summary.json`。API 测试运行于 `0dc39b14` 加本批工作树，之后补充测试/文档未改变生产行为。

补充矩阵：三协议真实 SDK/adapter 经 Lifecycle、RunWorker、RunManager、UI 的 length/filter 六格，以及两个新错误 variant 的 SQLite 写入→重开→退休→再重开均通过。核心回归 34 文件 / 436 项通过，1 文件 / 2 项显式跳过（另行 opt-in 的实网测试，已由本轮 harness 提供实网证据）。

harness 独立审查补上 tool-cancel 必须是受控路径 read、恰好一个完成工具的断言；既有三协议证据离线复核全过，额外 HTTP 0。transport/cancel 也补验必须实际注入且发生在至少 64 正文字符之后，避免自然断流冒充注入。记录见 `stage-c/tool-cancel-offline-verification.json` 和 `offline-injection-verification.json`。

Stage C 提交：`ea43c0fe`。Stage D 的管理规则与最终回归见下一节。

## 5.5 Stage D：管理规则与最终回归

不增加生产机制。新增验证覆盖相邻步骤工具集合改变后的冻结请求/计量一致，同一步工具成功与业务失败混合的 ID、参数、结果、顺序；主/子共享会话下失败、SDK abort、取消的正文、usage、校准、终态与 UI 隔离。T20 通过现有 `connectModelInternal` 检查新窗口/runtime、旧校准失效和 cache 账本保留，不改 UI 产品路径。

SDK 重试测试调用已安装 SDK 与生产适配器，仅 fetch/时钟受控。三协议 503 均得到 18 HTTP、6 provider 调用、5 外层重试。三协议 SDK Retry-After=2 秒时，在 100ms 取消会再等 1900ms，但没有额外 HTTP。SDK 包装 ECONNRESET/ETIMEDOUT 后外层不重试、3/1 分布、部分输出不重试和外层退避及时取消由 Chat 专项覆盖；不把这些专项扩写为所有 SDK 错误形态均已实测。SDK 配置和外层分类未改变。

最终 E4（三协议真实摘要，均首跑通过）：

| 协议 | HTTP 总数 | 真实摘要 | 请求估算：压缩前 → 后 |
| --- | --- | --- | --- |
| Chat | 12 | stop、非空 | 13934 → 10624 |
| Responses | 12 | stop、非空 | 12253 → 9089 |
| Anthropic | 12 | stop、非空 | 20638 → 15691 |

每例都先真实读取工具、再在真实流中分别注入断流与取消。实际 summary HTTP 含允许的断流正文、两种说明各一次，排除取消正文和失败 native；3 个原载体退休，后续请求及 SQLite 重开不再派生旧说明。force 不代表自然 95% 或真实上游 overflow。证据：`stage-d/compaction-summary.json`。

最终 Responses E1 补跑：初次模型额外调用一个工具并失败，随后两次 read、业务 read 失败后修正、正常续聊均成功；最后重开后的 HTTP 被累计 20 次预算挡住（B 的 10 次 + 本次 10 次）。额外 SDK fetch 尝试都在本地拦截，未发网络。这个补跑记 `partial-budget-limited`，不是生产重开失败，也不被先前 B E1 或最终 C/D 的重开通过覆盖。本次旧 harness 已清理临时数据库，不能用脱敏 hash 重建同一会话；需要补跑时须另留证据。详情：`stage-d/responses-e1-final-diagnosis.json`。

已补失败工作区保留：本地目录 0700、文件 0600、配置仅引用环境变量凭证，清单仅含路径/ID/计数；成功仍清理。因旧库无法续测，按用户已有真实测试授权，在执行前说明此前 20 次消耗与原因，单独追加最多 12 HTTP，同模型完整 E1 一次补跑通过，实际新增 10（该协议 E1 累计 30）。8 agent-step / 8 complete，工具结果 true/true/false/true，4 个 Run completed；SQLite 重开 native 哈希、工具 Part ID 与实际 HTTP 配对一致。旧 partial 样本保留。证据：`stage-d/responses-e1-final-additional-12-summary.json`；新 audit 时间戳 `1789556657957`。

第一次 preflight：format/lint/typecheck 通过；测试 3586 通过、1 失败、16 跳过。唯一失败是旧 cache 用例把已收到 stop、但尚未 EOF 时取消的请求算成可信完成。按 02 的耗尽边界更正该测试（保持第一步 1000 input / 800 cache），14 项定向通过；生产缓存算法未改。修正后完整 `pnpm preflight` 通过：format、lint、typecheck、348 文件 / 3587 测试、全工作区 build 全过；16 项保留原有跳过（14 项 opt-in 实网、2 项平台相关 migration），不将其计为通过。最后新增失败证据保留 helper 不涉及生产，另跑 harness 8 项及独立 TypeScript 检查通过。原失败日志保留为 `stage-d/preflight-before-accounting-update.log`。

### T01–T22 断言对应

下表文件位于 `packages/ohbaby-agent/src/`；详细期望由 04 维护，此处记录验证落点。全部目标断言已有通过证据。最终独立复审覆盖全部 13 个生产文件，另独立运行 12 文件 / 142 项通过，无剩余 P1/P2。没有修改 SDK 默认配置、压缩算法/95% 规则或切模型产品入口。

| ID | 主要测试文件 |
| --- | --- |
| T01 | `core/llm-client/llm-client.test.ts`、三协议 adapter/native 测试 |
| T02–T05 | `core/llm-client/completion.unit.test.ts`、`core/llm-client/native-state.unit.test.ts`、`core/lifecycle/lifecycle.unit.test.ts` |
| T06 | `adapters/ui-runtime/scoped-failure.integration.test.ts`、`model-response-transport.integration.test.ts`、真实 E3 |
| T07 | `adapters/ui-runtime/protocol-terminal.integration.test.ts`（三协议 × length/filter 六格）、真实 Responses length |
| T08 | `core/lifecycle/lifecycle.unit.test.ts`、`core/message/atomic-model-step.integration.test.ts` |
| T09 | `core/lifecycle/failed-history.integration.test.ts`、`core/message/interruption.unit.test.ts` |
| T10–T11 | `core/context/serializer.integration.test.ts`、`core/lifecycle/failed-history.integration.test.ts`、真实 E2/E3 |
| T12 | `adapters/ui-runtime/prompt-context.unit.test.ts`、`summary-completion.integration.test.ts`、真实 E4 |
| T13–T14 | `core/context/failed-history.unit.test.ts`、`serializer.integration.test.ts`、`core/message/interruption.unit.test.ts` |
| T15 | `core/lifecycle/lifecycle.unit.test.ts`、三协议终态六格、已有 runtime accounting 集成 |
| T16 | `core/llm-client/sdk-retry.integration.test.ts` |
| T17–T18 | `core/lifecycle/dynamic-tools.integration.test.ts`、Context prepared-request/compaction 测试、真实 E1/E4 |
| T19 | `core/context/manager.unit.test.ts`、`native-policy.integration.test.ts`、SQLite compaction 与真实重开 |
| T20 | `adapters/ui-inprocess.contract.test.ts` |
| T21 | `core/context/manager.unit.test.ts`、既有低收益锁/force/每 run 上限与重置测试 |
| T22 | `adapters/ui-runtime/scoped-failure.integration.test.ts`（子断流、SDK abort、主动取消三格） |

## 5.6 持续保留的限制

- 真实百万窗口自然达到 95% 与真实上游 overflow 仍未实测。force 压缩和确定性 fixture 均不能关闭这两项；迁移整体仍保留这一前序缺口。
- 三协议过滤终态由真实 SDK + 受控协议 fixture 覆盖，未诱导付费模型生成有害内容触发真实上游过滤。断流/取消实网用例的故障来自本地注入。
- Anthropic E1 前两次中断的底层来源未能追溯；保留原失败记录，不能以第三次成功宣称不会再断流。
- SDK 退避取消仍可能等待当前延迟结束，错误包装后的可重试范围保持原样；没有新增自动续写。

结论：improve-7 本轮合同已完成并通过上述验收；这不等于所有上游网络情形、全容量边界或整个迁移均已验证。仅本地分批提交，未 merge/push；用户本地 `tests/models-4-tests.md` 未纳入提交。
