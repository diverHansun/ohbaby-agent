# context improve-5 · prompt cache 观测、协议兼容与前缀稳定

> 状态：**规划文档已齐，待用户审查后才能实施**。本目录不是实施清单。
> 规划日期：2026-08-23
> 代码基线：ohbaby-agent 当前工作区（improve-4.1 已落地）
> 规划 skill：`plan-code-improvement`（规划模式；本会话不写业务代码）
>
> 前序： [improve-4](../improve-4/README.md) / [improve-4.1](../improve-4.1/README.md) 已收口 request-shaped 占用计量。本批**不回退** `ContextMeasurementPayload` 与 tools-aware 分母。

---

## 1. 一句话

让 ohbaby **看见**缓存命中（内部三元组 `uncached / cacheRead / cacheWrite`），在 **OpenAI-compatible / Anthropic** 两种请求形状上对齐 2026-08 官方协议，并把 system/context 做成「磁带只在末尾接长」的精确前缀，从而在不缩小窗口口径的前提下降低输入成本。

## 2. 本批范围

### 做

1. 在 interface-provider 解析官方 usage，归一成三元组；Lifecycle / 展示可读到命中，而不是把 cache 字段丢掉。
2. 对齐 2026-08 的 Chat Completions / Messages 字段：该发的请求字段发出去，该读的响应字段读进来；**不**新增第三种 ohbaby compatible 形状。
3. 调整 system 与 context 组装顺序：稳定块靠左，动态块（日期、cwd、git status、uuid、request id）进本轮 user 或 metadata。
4. Anthropic 主动打 `cache_control`；OpenAI-compatible 发稳定 `prompt_cache_key`。DeepSeek / 智谱走隐式缓存，只观测、不发明私有请求字段。

### 不做

- 不把占用分母改成「只算 uncached」（cached 仍占窗口）。
- 不做价格目录、成本预测、请求前命中估算。
- 不做 cache 观测的跨会话持久化（本批只保证单次请求 + 当前 run 内可展示）。
- 不改 compact / prune 策略本身（只承认它们会打断前缀；第二次压缩复核另做）。
- 不上 GPT-5.6 的显式 `prompt_cache_breakpoint` 作为本批必做（文档记录，留给命中数据出现之后）。
- 不把 vendor 字段泄漏进 ContextManager。

## 3. 分阶段（实施会话按此切）

| 阶段 | 目标 | 用户可感知结果 |
|------|------|----------------|
| A 观测 | 解析 usage → 三元组 | 一次请求能说出 read/write/未缓存 |
| B 请求兼容 | 发出官方 cache 字段 | Claude 官方路径开始真正写入/命中 |
| C 前缀稳定 | system/context 磁带语义 | 同一会话后续轮次 read 明显上升 |

A 可单独验收；B、C 依赖 A 的数字，否则无法判断「兼容有没有用」。

## 4. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 已确认决策与边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 现状、协议差距、代码锚点 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 实施契约：阶段、改动面、兼容策略 |
| [03-reference-projects.md](./03-reference-projects.md) | deepseek-harness / claude-code / codex / opencode / pi / kimi-code |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 风险导向验收 |
| `05-implementation-acceptance.md` | **实施完成后**由验收模式写入；规划期不存在 |

## 5. 给实施会话的声明

实施只读 **02 + 04**。不要在 ContextManager 里解析 Anthropic/OpenAI 的原始 cache 字段。窗口占用公式以 01/02 的三元组加法为准。
