# 3. 优秀项目借鉴

本地仓库均在 `/Users/hansun025/Projects/code-cli/`。调研为只读，日期 2026-08-23。

---

## 3.1 借鉴来源

| 项目 | 路径 | 范围 |
|------|------|------|
| deepseek-harness | `deepseek-harness/` | usage 映射、命中率 UI、不发 cache 请求 |
| claude-code | `claude-code/` | `cache_control`、流式 `>0` 覆盖、OpenAI key、system 动静边界 |
| codex | `codex/` | `prompt_cache_key=thread_id`、环境进 user |
| opencode | `opencode/` | session 级 key、usage 减 cache |
| pi | `pi/` | 三元组 + CH%；Anthropic 断点位置 |
| kimi-code | `kimi-code/` | `inputOther/Read/Creation`；三断点 |

---

## 3.2 可借鉴点

| 项目 | 做法 | 为何相关 | ohbaby 取舍 |
|------|------|----------|-------------|
| deepseek-harness | `cached_tokens ?? prompt_cache_hit_tokens`；`input = prompt - read` | 我们同样吃 DeepSeek 兼容口 | **adopt** 解析；不抄「完全不发 Anthropic 断点」 |
| claude-code | 命中率 read/(input+creation+read)；cache **>0 才覆盖**；消息侧一个断点 | 官方 Claude 主路径 | **adopt** 流式与命中率；TTL/实验特性 **reject** |
| codex | `prompt_cache_key = thread_id`；cwd/date 在 user `environment_context` | 与用户「磁带/动态进 user」一致 | **adopt** key 与环境位置 |
| opencode | `promptCacheKey = sessionID`；total 减 cache | 兼容多 provider | **adopt** key；**reject** system 里 Today's date |
| pi | 内部 `input/cacheRead/cacheWrite`；CH% 同分母 | 与 00 三元组相同 | **adopt** 模型与公式；流式改为 claude 的 `>0` |
| kimi-code | Anthropic：system + last tool + last block | 断点比「只顶层 automatic」更稳 | **adapt**：阶段 B 先顶层；若 0 命中再升到三断点 |

---

## 3.3 明确不借鉴

- 用整段 messages 做 cache key（路由不稳定，且泄漏内容）。
- OpenCode 把每日日期放进 system 前缀。
- 把 Anthropic `input_tokens` 直接当 OpenAI `prompt_tokens`。
- 为 DeepSeek 单独做一种 client kind。
- claude-code 的内部实验（cache edits / 全局 scope / GrowthBook 1h）。
- 在 Context 包展示 vendor 字段名。

---

## 3.4 对 02 的影响

02 的三元组、`>0` 覆盖、`prompt_cache_key=sessionId`、环境进 user、阶段 B 先顶层 `cache_control`，均直接来自上表 adopt/adapt。阶段 D 的显式 OpenAI breakpoint 来自官方 5.6 文档，参考项目大多尚未作为必做路径，故不进本批。
