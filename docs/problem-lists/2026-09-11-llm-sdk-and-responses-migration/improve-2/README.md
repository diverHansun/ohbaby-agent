# Improve 2：独立 OpenAI Responses provider

## 目标

在 **improve-1 已完成 SDK 升级** 的基线上，新增独立的 `openai-responses.ts`，使三条协议平级实现同一套现有 provider 接口：

- `openai-compatible` → `/v1/chat/completions`（默认，用户路径不变）
- `openai-responses` → `/v1/responses`（显式 kind，不对用户露出开关）
- `anthropic` → `/v1/messages`

本轮成功标准：手工或测试把 `interfaceProvider` 写成 `"openai-responses"` 后，agent 能在**不产生原生 reasoning/output-item 续接要求**的模型路径上跑通文本、function tools、abort 和 usage 数字；默认配置与 Chat / Anthropic 出站 wire 语义不变。

这是协议接入的第一个安全切片，不是完整 Responses agent 能力。若响应包含必须在后续轮次原样回传的 `reasoning` item、assistant `phase`、refusal、annotation 或非 function tool，adapter 必须 fail-closed，不能把它压扁成 Chat 历史后继续执行工具。推理模型的工具多轮要等后续 canonical/provider-continuation 设计完成。

## 当前状态

独立验收见[`05-implementation-acceptance.md`](./05-implementation-acceptance.md)，最新技术验收通过修订后的受限ZenMux门（§5.12）。2026-09-13全量preflight通过（3196 tests passed，build通过），生产lifecycle Grok文本与工具往返通过，测试脚本审查补强后再次真实复验通过。原Luna/DeepSeek Responses失败记录保留，不宣称它们兼容。按用户授权完成收尾提交后合入本地openai-responses-migration，main不动。

分支链为 `main` → 本地长期集成分支 `openai-responses-migration` → 本轮临时分支 `codex/improve-2-responses-migration`。只有 04/05 的本地门禁、按04 §4.8修订的ZenMux live证据与独立审查均齐备后，才可合回集成分支；不直接落到 `main`。

## 本轮文档

| 文件 | 作用 |
| --- | --- |
| [`00-discussion.md`](./00-discussion.md) | 已确认决策与边界 |
| [`01-problem-analysis-and-current-state.md`](./01-problem-analysis-and-current-state.md) | improve-1 之后的现状与问题 |
| [`02-optimization-plan-and-change-scope.md`](./02-optimization-plan-and-change-scope.md) | 实施契约 |
| [`03-reference-projects.md`](./03-reference-projects.md) | pi / OpenCode / Kimi / Reasonix 借鉴 |
| [`04-test-and-acceptance.md`](./04-test-and-acceptance.md) | 测试与验收 |
| [`05-implementation-acceptance.md`](./05-implementation-acceptance.md) | 独立验收及收尾复验，最新§5.12 |

## 触发事件

improve-1 在 02 §不改与根 README 中主动切割 Responses；05 已闭环。本轮属于 **主动切割后的独立规划**，开启日期 **2026-09-12**。
