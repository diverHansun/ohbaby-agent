# 参考项目核实与本批取舍

> 更新：2026-10-12。整体参考调查见 [plan/03](../plan/03-reference-projects.md)；本文只补第 3 批相关的核实与不照搬处，不复述全部对照。
> 参考根目录：`/Users/hansun025/Projects/code-cli/`。

## 1. 本批实际核对（小范围）

| 主题 | 项目与位置 | 读到的行为 | 本批用法 |
| --- | --- | --- | --- |
| 摘要输出独立选项不改缓存身份 | 本地 claude-code `src/services/compact/compact.ts:1213-1217` | fork 路径注释明确：不设 `maxOutputTokens`，靠与主线程相同的 cache-key 参数（system、tools、model、messages 前缀、thinking 配置）蹭同一份 prompt cache，设了会 clamp 掉 thinking | 借「摘要分叉要保持缓存相关配置、只改用途需要的输出额度」；并把额度用 per-request override 落，避免经底层顺手压低 thinking |
| 溢出分类隔离 | kimi-code `packages/agent-core-v2/src/human/llm/requester/retry.ts:39-49` | `isRetryableError` 把 `context_overflow` 归为不可重试 | 借「溢出错误不可重试，只进 force compact 入口」；本批先把 SDK 重试收进应用层 |
| 保留段固定预算 | pi `packages/coding-agent/src/core/compaction/compaction.ts:129` | `keepRecentTokens: 20000` | 只借固定预算口径（批 4 使用）。`core/settings-defaults.ts:11` 的运行时默认与此处函数默认都为 20000，plan 的位置引用有效 |
| 末尾追加指令、历史边界 cache 标记 | ZCode `apps/zcode-cli/packages/core/src/runtime/methods/compact-active-helpers.ts`（`buildCompactSummaryRequestMessages`） | 把摘要指令作为末尾一条 user 消息追加在 entries 之后 | 借「末尾追加指令」的形状；标记仍按 ohbaby 已有顶层/分块策略落，不照搬其请求装配 |

## 2. 本批不照搬处

- **不照搬参考项目的请求形状**：Pi 拍平历史、Reasonix 只给待压段、Kimi 可能重算工具配置、ZCode 把条目重新装配——本批是「同一份 prepared 正常请求 + 末尾指令」，不重建请求。
- **不照搬短 system / 无 tools 兜底**：claude-code 的短 system 兜底有 20K 输出并关 thinking，本批采用其「保持缓存配置」的理由，不采用兜底装配。
- **不照搬固定重试次数**：Kimi 每次压缩至多 5 次、Codex 5 次、claude-code 重建版 11 次；本批是首次＋至多一次网络重试（共两次），且三个 provider 显式 `maxRetries: 0`（[plan/03 §5.6](../plan/03-reference-projects.md)）。
- **不照搬任何统一 32K 硬帽或普通偏好继承**：正文 16K、fixed 加已有 B、effort 试行 32K 都是本项目的工程选择，不带「参考项目证明最优」的含义。

参考项目只支持局部选择；本批规则以 [plan/00](../plan/00-discussion.md) 与 [plan/02](../plan/02-optimization-plan-and-change-scope.md) 为准。
