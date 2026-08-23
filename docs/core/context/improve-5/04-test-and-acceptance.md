# 4. 测试与验收标准

围绕 01 的高风险项，而不是追求行覆盖率。实施会话按阶段跑对应行。

---

## 4.1 测试范围

| 层 | 覆盖什么 |
|----|----------|
| 单测 provider | 各家 usage fixture → 三元组；流式合并；请求 JSON 快照 |
| 单测 system-prompt | 只改日期/cwd 时 system 稳定前缀不变；动态出现在 user 尾 |
| 单测 lifecycle | 校准入参 = uncached+read+write，而不是裸 Anthropic input |
| 守卫 | `core/context` 仍无 `cache_read_input_tokens` 等 vendor 名（4.1 精神） |
| 手工 | 真连一个 OpenAI-compatible（DeepSeek 或智谱）打两轮相同前缀，看 read>0；真连 Anthropic 看 creation 然后 read |

没有现成的独立 LLM e2e 预算时，手工列为发布门的**可选加强**；单测是硬门。

---

## 4.2 关键场景

| ID | 场景 | 类型 | 验证点 | 阶段 |
|----|------|------|--------|------|
| T1 | OpenAI usage 仅三角字段 | 单测 | read=write=0，uncached=prompt | A |
| T2 | OpenAI `prompt_tokens_details.cached_tokens` | 单测 | read=该值；uncached=prompt-read | A |
| T3 | OpenAI 5.6 同时有 cached 与 cache_write | 单测 | 三字段都有；不把 cached 再加到 prompt 上 | A |
| T4 | DeepSeek 顶层 hit/miss | 单测 | read=hit，uncached=miss | A |
| T5 | 智谱 `prompt_tokens_details.cached_tokens` | 单测 | 同 T2 | A |
| T6 | Anthropic 三段 usage | 单测 | 窗口和=read+write+input | A |
| T7 | `message_start` 有 cache，`message_delta` cache=0 | 单测 | 最终仍保留 start 的 read/write | A |
| T8 | 只 `message_delta` 且无 cache 键 | 单测 | 不崩溃；read=0 | A |
| T9 | Lifecycle 校准 | 单测 | 传入窗口和 | A |
| T10 | Anthropic 请求含顶层 `cache_control` | 单测快照 | 阶段 B 回归 | B |
| T11 | OpenAI 请求含 `prompt_cache_key` | 单测快照 | 等于 session 稳定 id | B |
| T12 | 两次 assemble 只改 date | 单测 | system 前缀相同 | C |
| T13 | compact 后不要求命中率不降 | 文档+手工 | 下降是预期，不是 bug | C |
| T14 | context 包 rg vendor cache | 单测或脚本 | 0 命中 | A–C |

---

## 4.3 集成边界

- Provider 是唯一解析 JSON usage 的地方；Lifecycle 只消费三元组。
- SystemPrompt 不读 cache；它只负责字节顺序。
- 中转缺字段 ≠ 失败；等于「未知，当 0」。

---

## 4.4 回归清单

- 4.1：`measureUsage({ messages, tools })` 仍含 tools；静态/手动路径不回退。
- OpenAI `stream_options.include_usage` 仍为 true。
- Anthropic tools/messages 转换行为保持（除新增 cache_control）。
- 不向 ContextManager 公共类型添加 `cached_tokens`。

---

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| 观测 | 合成 fixture 下 T1–T9 全绿 | `packages/ohbaby-agent` 相关 vitest |
| 校准安全 | Anthropic 高 read 时校准分母不是「很小的 input_tokens」 | T9 |
| 协议 | B 合并后请求快照含官方字段名 | T10–T11 |
| 前缀 | C 合并后 T12 绿 | vitest |
| 分母 | 文档与代码注释写明窗口 = 三元组之和 | 审查 02 与类型 JSDoc |
| 范围 | 无价格、无预测、无第三 kind | diff 审查 |

---

## 4.6 对抗性审查

1. **最可能失败的集成点：** Anthropic 流式事件顺序因 SDK 版本不同。防御：同时监听 start 与 delta，`>0` 覆盖。残余：个别 SDK 把 usage 只放在终态 message 上——测试需用 SDK 实际事件形状，而不是只测手写 union。
2. **文档说做了其实没测：** 「中转 400 降级」若实施时没做，04 不得假装做了。本批明确非必做。
3. **先上线再后悔：** 把环境塞进 user 可能改变模型对「当前目录」的注意位置。回滚路径写在 02.6：退回 system **尾**，仍禁止放回 system **头**。
4. **双语义：** OpenAI 子集 vs Anthropic 分段若有一处漏翻译，命中率会 >100% 或校准倒挂。T2+T6 必须同时存在。
5. **compact 误报：** 禁止把 compact 后 miss 当 provider 故障。
