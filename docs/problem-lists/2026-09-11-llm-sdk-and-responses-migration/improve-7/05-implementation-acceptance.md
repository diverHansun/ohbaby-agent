# 05：实施与验收记录

状态：实施中。分支 `codex/improve-7-agent-loop`，基线 `8409a863`。用户授权分批实施、真实 API 测试、独立审查后本地提交；不 merge/push。

本文件记录结果；目标合同见 02，验收标准见 04。未完成批次不能计作通过。

## 5.1 实施前反馈对齐

已逐项对照 Cursor 反馈与源码：

- Stage A 以 T01 和定向三协议 fixture 为核心条件；另按用户要求做轻量真实工具循环，不强绑完整 E1。
- 固定说明写在 02 §2.4。默认在原 assistant 上保存结构化错误，发送时提取允许正文；无正文/取消事实使用同一 assistant 的一个 synthetic TextPart，不新建 abort 消息管线。
- `(Interrupted)` 合成占位将在 B 移除，不能作为 C 正文材料。
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

Stage C/D 尚未验收。

## 5.4 持续保留的限制

真实百万窗口自然达到 95% 与真实上游 overflow 仍未实测。force 压缩和确定性 fixture 均不能关闭这两项。本轮尚未执行最终 preflight，不声称 improve-7 整体通过。
