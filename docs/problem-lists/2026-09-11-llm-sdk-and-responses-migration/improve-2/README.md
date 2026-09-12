# Improve 2：独立 OpenAI Responses provider

## 目标

在 **improve-1 已完成 SDK 升级** 的基线上，新增独立的 `openai-responses.ts`，使三条协议平级实现同一套现有 provider 接口：

- `openai-compatible` → `/v1/chat/completions`（默认，用户路径不变）
- `openai-responses` → `/v1/responses`（显式 kind，不对用户露出开关）
- `anthropic` → `/v1/messages`

本轮成功标准：手工或测试把 `interfaceProvider` 写成 `"openai-responses"` 后，agent 能在**不产生原生 reasoning/output-item 续接要求**的模型路径上跑通文本、function tools、abort 和 usage 数字；默认配置与 Chat / Anthropic 出站 wire 语义不变。

这是协议接入的第一个安全切片，不是完整 Responses agent 能力。若响应包含必须在后续轮次原样回传的 `reasoning` item、assistant `phase`、refusal、annotation 或非 function tool，adapter 必须 fail-closed，不能把它压扁成 Chat 历史后继续执行工具。推理模型的工具多轮要等后续 canonical/provider-continuation 设计完成。

## 当前状态

规划已完成修订并通过子代理复审，待用户确认后实施。分支链为 `main` → 本地长期集成分支 `openai-responses-migration` → 本轮临时分支 `codex/improve-2-responses-migration`。本轮通过 04 与 05 的门禁后只合回集成分支，不直接落到 `main`。

## 本轮文档

| 文件 | 作用 |
| --- | --- |
| [`00-discussion.md`](./00-discussion.md) | 已确认决策与边界 |
| [`01-problem-analysis-and-current-state.md`](./01-problem-analysis-and-current-state.md) | improve-1 之后的现状与问题 |
| [`02-optimization-plan-and-change-scope.md`](./02-optimization-plan-and-change-scope.md) | 实施契约 |
| [`03-reference-projects.md`](./03-reference-projects.md) | pi / OpenCode / Kimi / Reasonix 借鉴 |
| [`04-test-and-acceptance.md`](./04-test-and-acceptance.md) | 测试与验收 |
| `05-implementation-acceptance.md` | 本轮实施完成后由验收模式写入（规划期不存在） |

## 触发事件

improve-1 在 02 §不改与根 README 中主动切割 Responses；05 已闭环。本轮属于 **主动切割后的独立规划**，开启日期 **2026-09-12**。
