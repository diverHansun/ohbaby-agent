# improve-7：Lifecycle 真实 API 复测与组装核对

日期：2026-09-16。用户再次授权使用 `.env` 中的真实凭据复测 agent-loop。生产代码为 `codex/improve-7-agent-loop@9e109416`；本批仅增加测试观测与验收说明，没有修改生产行为，未合并或推送。

## 1. 结论与实测范围

本轮 **9 个独立用例全部取得通过证据，执行 10 次，共 72 次 HTTP**。其中一次压缩用例因新增测试断言过严而失败，保留了失败记录和原 SQLite；修正断言后使用同一模型重跑通过。不能把这次失败省略为“全部首跑通过”。

测试从真实 `createPersistentUiBackendClient.submitPromptAndWait` 进入，经过 RunWorker、Lifecycle、Context、生产 SDK、真实 HTTP 和 SQLite。普通 E1 不替换模型回复；观测器调用原 ContextManager 和原 Lifecycle，只在指定故障用例中注入断流或主动取消。模型选择来自 `tests/models-4-tests.md`，凭据由 runner 读取，不输出或提交。

| 协议 / 固定模型 | 场景 | HTTP | agent-step / llm:complete | 结果 |
| --- | --- | ---: | ---: | --- |
| Chat / deepseek-v4.1-flash | E1：两次读取、工具失败后修正、继续、SQLite 重开 | 10 | 8 / 8 | 通过 |
| Responses / gpt-5.6-luna | 同上 | 10 | 8 / 8 | 通过 |
| Anthropic / claude-sonnet-5 | 同上 | 10 | 8 / 8 | 通过 |
| Responses / gpt-5.6-luna | 真实 length 后主动继续、重开 | 5 | 3 / 3 | 通过 |
| Responses / gpt-5.6-luna | 输出正文后本地注入 ECONNRESET、继续、重开 | 5 | 3 / 2 | 通过 |
| Responses / gpt-5.6-luna | 输出正文后主动 abortRun、继续、重开 | 5 | 3 / 2 | 通过 |
| Responses / gpt-5.6-luna | 工具结果落库后取消、继续、重开 | 5 | 3 / 3 | 通过 |
| Chat / deepseek-v4.1-flash | 工具结果落库后取消，补验 reasoning 字段指纹 | 5 | 3 / 3 | 通过 |
| Responses / gpt-5.6-luna | 断流/取消历史经过真实摘要、压缩后继续、重开 | 5 + 12 | 失败样本 3 / 3；通过样本 9 / 7 | 修正测试断言后通过 |

HTTP 数包含 metadata、标题生成、摘要及模型请求；它不是 agent-step 数。完成事件表示接受了一次模型请求结果，length 也可能有完成事件，但 Run 仍然失败。断流和生成阶段取消没有可信完成，故 3 个 agent-step 只有 2 次完成事件。工具结果落库后取消时，原请求已完成，不能撤销其完成事实。

三协议 E1 都得到 4 个成功 Run；工具结果依次为成功、成功、业务错误、成功。错误由模型收到后处理，未把工具业务错误直接当作整个 Run 失败。

## 2. 本次实际追踪的数据流

```text
用户发消息 → RunWorker → Lifecycle
  → Context.prepareTurn：选历史、拼系统提示与工具、冻结请求、计量
  → Lifecycle.runModelStep：原样交给 provider 的 messages / tools
  → 协议适配器 → 真实 SDK HTTP → 流式累积 → 接受终态与 usage
  → 保存 assistant / 必需的协议状态 / 工具调用
  → 工具 running 落库 → tool:start → 执行工具
  → 工具结果落库 → tool:result
  → 下一步重新 prepareTurn，带上配对调用与结果
  → 无后续工具时返回结果 → Worker 决定 Run 终态
```

本次增加的核对点：

1. **计量与发送材料一致。** 包装现有 `onRequestMeasured` 和 `prepareTurn`，比较最终计量请求、冻结请求与 provider 入参的规范化指纹。三者均包含完整 messages、tools 和消息中的 modelState。通过样本的每个 agent-step 都相等；没有只拿另造的一份 Chat 消息估算。
2. **协议转换没有弄错工具。** 从真实 HTTP body 提取工具名、调用 ID、参数和结果指纹，与内部自有消息比较。Chat 对应 `tool_calls/tool_call_id`，Responses 对应 `function_call/function_call_output`，Anthropic 对应 `tool_use/tool_result`。参数先解析 JSON 再比较，避免空白和键顺序造成假差异。
3. **需要续传的协议字段未被替换。** 比较 Responses `encrypted_content`、Anthropic signature/redacted thinking 和 Chat reasoning 字段的指纹。只保存哈希，不输出内容。Chat E1 运行时尚未增加 reasoning 别名指纹；后续真实 Chat tool-cancel 补验了该项，不能把后加断言追记为先前 E1 已执行。
4. **保存先于执行和通知。** 在 `tool:start` 查询 SQLite，要求调用已是 running、参数与事件一致、assistant 已接受且无错误；本步确实收到 nativeOutput 时，还要求 native 已保存。在 `tool:result` 再查保存状态，并对成功输出核对事件与数据库哈希。工具业务错误检查了保存状态及下一请求/HTTP 的结果一致性，没有另行断言错误事件原文与数据库错误字段逐字相等。
5. **usage 属于哪些步骤可以核对。** 对 `usageComplete=true` 的 Lifecycle 返回，input/output 必须等于该 Run 已接受完成事件之和。Run 持久化的终态与传给上层的 usage 分别检查，不声称 Run ledger 持久化了整份 usage。
6. **重开后继续发出的材料可靠。** E1 比较重开前后的完整 native state 哈希及工具 Part ID，并检查重开后的实际 HTTP 调用/结果配对。失败历史用例检查正文选择、说明次数和失败原始协议状态的排除。

这里证明的是被观测字段和内部请求交接的一致性，不是“本地估算精确等于供应商计费 token”，也不是 HTTP 包装的所有字节都与内部结构相同。观测器针对每个会话串行执行，本轮不将其扩大解释为新增并发主/子 scope 覆盖。

## 3. Responses 的 8 步组装快照

E1 实测窗口来自 metadata，source=`detected`：Chat 1,000,000；Responses 1,050,000；Anthropic 1,000,000。未缩小窗口制造自动压缩通过。

下表是内部自有消息数；S=system、U=user、A=assistant、T=tool。每一步均有 25 个工具定义，测试权限只允许临时夹具的 read 操作。Responses 的 system 内容进入协议 instructions，因此不能机械要求 HTTP input 的 role 数和内部 role 数完全相同。

| 步骤 | 本步任务 | 发送历史 S/U/A/T | 终态 | 原始估算 / 校准后 currentTokens |
| --- | --- | --- | --- | ---: |
| 1 | 请求第一次读取 | 1 / 1 / 0 / 0 | tool_calls | 11171 / 11171 |
| 2 | 收到第一项结果，发起第二次读取 | 1 / 1 / 1 / 1 | tool_calls | 11433 / 9856 |
| 3 | 收到第二项结果，回答用户 | 1 / 1 / 2 / 2 | stop | 11593 / 9241 |
| 4 | 用户要求读取缺失文件 | 1 / 2 / 3 / 2 | tool_calls | 11778 / 9038 |
| 5 | 收到业务错误；测试恢复文件，模型重新读取 | 1 / 2 / 4 / 3 | tool_calls | 11967 / 9050 |
| 6 | 收到成功结果，回答用户 | 1 / 2 / 5 / 4 | stop | 12127 / 9140 |
| 7 | 用户主动继续 | 1 / 3 / 6 / 4 | stop | 12254 / 9249 |
| 8 | SQLite 关闭、重开后用户继续 | 1 / 4 / 7 / 4 | stop | 12374 / 12374 |

原始估算随着材料增加而变化；校准值还使用此前真实 input usage。重开后内存校准因子重新从默认值开始，所以第 8 步 currentTokens 回到原始估算。这个跳变与历史丢失是两回事：本轮验证了重开前后持久化状态一致。此批没有更改校准算法或持久化策略。

`ContextUsage.usageRatio` 仍有用于 input budget 管理的既有含义；自动摘要的完整窗口占用应看 `currentTokens / contextLimit`。不得从字段名推断成相同分母，也不借本轮复测修改已确认的完整窗口 95% 触发规则。

## 4. 失败历史与压缩结果

- **真实 length：** 小输出上限导致供应商正常返回截断终态；Run 未完成，正文保存。下次用户请求及重开后均包含允许正文和一条固定说明，没有自动续写。
- **断流：** 真正收到至少 64 个可见字符后，本地注入连接错误。原始失败协议消息不重放，保存的正文作为带中断说明的普通文本进入下一请求。
- **主动取消：** 正文留库可查看，下一请求排除取消正文、保留取消事实。工具阶段取消保留已接受的 assistant、完成工具结果及调用配对。
- **真实摘要：** force 调用生产压缩路径，实际 summary HTTP 含断流正文和两种说明，排除取消正文与失败 native。摘要正常 stop 且非空；3 个原载体退休。后续请求和 SQLite 重开后没有重新派生旧说明。

压缩第一次失败来自新增观测器的过严断言：“所有 Responses 工具调用都必须有 native state”。合法纯工具回复可能不需要 native；原 SQLite 显示调用参数和 running 状态已经保存。修正为“本步实际产出 nativeOutput 时，必须保存”后重跑，生产代码未改。第一次 5 HTTP，第二次上限设为剩余 15、实际 12，合计 17，没有突破该用例 20 次预算；原失败 audit、日志、resume 清单和私有数据库都保留。

## 5. 验证与证据位置

本地证据目录：`.ohbaby/test-evidence/improve-7/retest-20260916-lifecycle/`。`summary.json` 汇总 10 个 attempt 的文件名、HTTP 数、完成计数和断言结果；各 `*-audit.json` 保存组装指纹及 SQLite 检查，各 `*-session.json` 保存 metadata、真实 HTTP 概况和重开检查。

- 通过的压缩：`zenmux-gpt56-luna-responses-context-compaction-1789559303433-audit.json`。
- 保留的失败：同前缀 `1789559009212-audit.json`，以及对应 `resume.json`、`responses-compaction.log`。
- 新增/已有观测器与工作区保留单测：3 文件 / 14 项通过；独立子代理再次运行观测器 2 文件 / 12 项通过，并复核真实证据，无剩余 P1/P2。
- Harness 独立 TypeScript 检查通过。定向 ESLint 使用该 harness 的 tsconfig；根 project service 不包含 smoke 文件，需在本地检查配置中指定项目，不改变仓库 lint 规则。
- 本轮不重复报告为“新跑了完整 preflight”；此前完整 preflight 结果见 05。本轮没有生产变更。

复现方式（每个付费用例单独选择 profile/mode）：

```sh
OHBABY_REAL_AGENT_LOOP_EVIDENCE_DIR=.ohbaby/test-evidence/improve-7/retest-20260916-lifecycle \
  node scripts/run-real-agent-loop-e2e.mjs \
  --profile=zenmux-gpt56-luna-responses-context --mode=e1
pnpm exec vitest run tests/smoke/agent-loop-assembly.unit.test.ts tests/smoke/agent-loop-observer.unit.test.ts tests/smoke/agent-loop-workspace.unit.test.ts
pnpm exec tsc -p tests/smoke/agent-loop.tsconfig.json --pretty false
```

## 6. 仍未覆盖的边界

真实百万窗口自然跨过 95%、真实上游 context overflow 仍未测试，force 摘要不能替代。真实 content_filter 未重新诱导，沿用前批真实 SDK 加协议 fixture 的证据。断流是本地受控注入，取消是主动操作，不是自然上游故障统计。SDK 重试上限和退避取消仍沿用前批确定性集成测试；本批不为验证 18 次上限对付费服务制造失败。

因此本轮可以确认已测场景的 Lifecycle 数据交接正确，不能推出所有供应商异常和全容量边界都已经通过。
