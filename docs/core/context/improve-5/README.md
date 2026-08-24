# context improve-5 · LLM 请求契约、prompt cache 观测与稳定前缀

> 状态：**improve-5 已于 2026-08-24 在 `codex/improve-5` 分七批实施；同日晚独立复测确认本地 targeted + unit/contract/integration（排除 packaging）全绿，随后 Batch G 关闭反馈中的可复现覆盖/投影缺口。G7 compiled Web 与 G8 真实 cache 未在独立复测会话重跑，完整仓库门仍是条件验收**。
> 代码基线：improve-4 / improve-4.1 已实施；分批 commits、门禁例外、ZenMux 证据与独立复测见 [05](./05-implementation-acceptance.md)（含 §5.10）。
> 本分支尚未合入 `main`，也未推送远端。
>
> 前序：[improve-4](../improve-4/README.md) / [improve-4.1](../improve-4.1/README.md) 已建立 request-shaped `{ messages, tools }` 占用计量。本批必须保持 cached input 仍占 context window，不得回退 tools-aware 分母。

---

## 1. 一句话目标

建立一条主代理与子代理共同使用的完整链路：

```text
精确 request-shaped payload
  → scoped cache identity + provider capability strategy
  → OpenAI-compatible / Anthropic wire request
  → inclusive TokenUsage + optional cache breakdown
  → 单请求、当前 run、calibration 与 context 联合验收
```

在此基础上，把稳定内容留在左侧，把运行环境和 MCP 菜单作为固定在本轮 user turn 上的 model-only 快照，使多步工具调用尽量保持 append-only 前缀并实际具备服务端 cache 命中条件。

## 2. 已冻结的核心契约

1. `TokenUsage.inputTokens` 是**完整输入量**；可选的 `inputBreakdown` 才表达 `uncached / cacheRead / cacheWrite`。
2. `inputBreakdown` 存在时，三项互斥且总和必须等于 `inputTokens`；`observed.cacheRead/cacheWrite` 再区分该分类是 provider 明确报告还是为不变量补 0。缺失 breakdown 不能伪装成 0% 命中。
3. 仍只有 `openai-compatible` 与 `anthropic` 两种 interface-provider kind；新增的是缓存能力策略，不是第三种协议。
4. 用户配置策略为 `promptCache: auto | enabled | disabled`；内部再解析成具体 request strategy。usage 观测始终开启。
5. cache key 基于 `sessionId + contextScopeId` 的 canonical identity，经有版本、定长、不可读的 hash 生成；不用 messages hash。
6. 删除 environment 中重复的 `Available tools`；日期、cwd、platform、git repo、MCP 菜单等动态内容固定附着到发起本轮的 user 消息，不能在每个 step 尾部重新插入。
7. improve-4.1 的 `additionalMessages` 手工双向传播在本批收拢：测量与发送只消费同一份 `{ messages, tools }`。
8. 工具顺序按 scope 稳定；新加载 MCP 工具形成一次明确的 cache epoch，之后不得重排已有工具。
9. 主代理和子代理走同一条 request、usage、cache policy、cache key、prefix 与测试链路；差异只来自各自 agent 配置、system 内容和隔离的 `contextScopeId`。
10. Lifecycle、context summary、session title 三个生产 LLM caller 都要显式 request purpose；辅助请求先只观测，不能成为 usage/scope 旁路。
11. run-local prompt snapshot 与 scope-owned tool sequence 分离；每个 step 导出 immutable tool snapshot，lazy MCP load 只影响下一 step/epoch。
12. closed subagent scope 必须定向释放 context、MCP loaded state 与 tool sequence；runtime part 仅对 model serializer 可见，不泄漏到 UI/title/export。
13. normalized usage 必须无损穿过 lifecycle、run-manager worker、stream bridge 与消息 metadata；整份 usage 缺失时 run aggregate 明确标 partial。
14. 实施使用临时分支 `codex/improve-5`，按可验证纵切分批；每批都必须完成 unit + integration、只读子代理审查和原子 commit，不能把所有风险积到最后一次提交。
15. 全部批次完成后从本机编译产物启动 `ohbaby serve`，以 Web 端执行生产链路 E2E；真实 provider cache smoke 与无凭据的普通 CI 分开记账。

## 3. 本批范围

### 做

- 修正 OpenAI-compatible / Anthropic usage 归一化、流式合并、retry 隔离和 lifecycle 聚合。
- 对齐 context summary / session title 等辅助 LLM 请求的 purpose、scope 与 usage 边界。
- 对齐 OpenAI、Anthropic、DeepSeek、智谱及项目实际使用网关的缓存请求/响应协议。
- 引入可配置但保守的 provider capability resolver；未知端点在 `auto` 下只观测，不盲发字段。
- 收拢 request-shaped envelope，并让 calibration 使用 inclusive input。
- 重划稳定 system 与每轮 runtime context 的边界，删除重复工具文本。
- 稳定主/子代理各自 scope 的 cache key、环境快照和工具序列。
- 补 provider contract、生命周期、真实 scheduler、主/子代理隔离和 key-gated real smoke。
- 从本机编译产物启动 `ohbaby serve`，通过 Web 端完成 improve-5 的生产链路 E2E。

### 不做

- 不把窗口占用改为只算 uncached。
- 不改 compact / prune 策略和 95% / 85% 阈值争议。
- 不重构 token pricing，不建设跨 session 的聚合缓存分析库。
- 不引入第三种 interface-provider kind。
- 不在本批实现完整 Codex WorldState、Anthropic deferred tools 或 mid-conversation tool changes。
- 不把 GPT-5.6 显式 breakpoint 设为本批默认；但必须解析其 cache-write usage，并为后续决策保留准确观测。
- 不执行 improve-4～improve-5 的全方位联合回归；该回归由用户在 improve-5 完成后单独进行。本批只保留触及接口所必需的定向兼容测试。

## 4. 实施阶段

| 批次 | 目标 | 批次完成信号 |
|------|------|--------------|
| A · usage 与 stream 正确性 | inclusive usage、observed、stream/retry、aggregate、event transport、calibration | normalized usage 在单请求和当前 run 内可信 |
| B · request capability | policy、purpose、strategy resolver、scoped key、OpenAI/Anthropic wire | 只对已知支持端点发送正确字段，辅助 caller 无旁路 |
| C · request 收拢 | `PreparedModelRequest`、`additionalMessages` 收拢、initiating user identity | measurement、projection 与 send 同源 |
| D · prefix 与 MCP | stable system/runtime part、tool sequence、epoch、scope cleanup、UI projection | 主/子代理前缀稳定且 scope 隔离 |
| E · improve-5 系统验收 | 全量本批测试、real cache smoke、build、compiled `ohbaby serve` Web E2E | 本批实现可运行、可观测、可审计 |
| F · ZenMux 真实补证 | 双协议 cache read、M13、真实 provider compiled Web 与 context UI | G8 由 skip 补为 pass，inclusive UI 语义得到真实证据 |
| G · 反馈闭环 | U03/PFX06/A08 专测、summary runtime 投影、验收映射校正 | 真实缺口关闭，已有行为覆盖不重复造测试 |

A 必须先完成；没有可信观测，B–G 的结果无法解释。每批遵守“实现 → targeted tests → `test:unit` + `test:integration` → 子代理审查 → 修复与复测 → 原子 commit”的闭环。详细 commit 和门禁见 [02 §2.8](./02-optimization-plan-and-change-scope.md#28-分批实施分支与完成信号) 与 [04](./04-test-and-acceptance.md)。

实施已从 `main` 创建临时分支 `codex/improve-5`，A–D 各批形成独立 commit，E 批形成 acceptance commit，F 批补充 ZenMux 真实 provider 证据，G 批关闭独立复测反馈。分支不直接合入或推送 `main`，除非用户另行授权。

## 5. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 用户已确认决策、协议复核后的精确边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 当前代码、数据流、主/子代理、协议与测试缺口 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 数据契约、能力矩阵、request/prefix 架构与实施改动面 |
| [03-reference-projects.md](./03-reference-projects.md) | 六个本地参考项目与官方协议的 adopt / adapt / reject |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 逐批 unit/integration 门、真实 cache smoke、compiled Web E2E 与最终验收 |
| [05-implementation-acceptance.md](./05-implementation-acceptance.md) | 分批 commits、测试结果、compiled Web 证据、G1–G9 与剩余风险 |

## 6. 实施后边界声明

实施以 **02 + 04** 为执行契约。provider 原始字段只在 adapter 边界出现；ContextManager 消费 provider-neutral request payload，不解析 `cached_tokens`、`cache_read_input_tokens` 等 vendor 字段。主代理、子代理和辅助 caller 已纳入同一 request/usage/cache/prefix 链路。用户计划的 improve-4～improve-5 全方位联合回归仍是后续独立工作，本批未把它伪装成已完成。
