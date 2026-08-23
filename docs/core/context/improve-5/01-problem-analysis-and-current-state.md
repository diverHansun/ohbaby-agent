# 1. 问题基线与当前实施状态

> 时间口径：2026-08-23 对 ohbaby-agent 工作区只读勘测。improve-4.1 的 tools-aware 计量已在代码中；prompt cache 仍为零实现。
> 协议口径：OpenAI / Anthropic / DeepSeek / 智谱 2026-08 公开文档（见文末 URL）。

本文只诊断**现在怎样、差在哪**。怎么改见 [02](./02-optimization-plan-and-change-scope.md)。

---

## 1.1 承重问题

1. **看见的 usage 不是账单上的 usage。** `InterfaceProviderTokenUsage` 只有 `prompt_tokens / completion_tokens / total_tokens`（`services/interface-providers/types.ts`）。OpenAI 的 `prompt_tokens_details.cached_tokens`、Anthropic 的 `cache_read_input_tokens` / `cache_creation_input_tokens`、DeepSeek 的 `prompt_cache_hit_tokens` 在 `normalizeTokenUsage` 里被丢掉。
2. **Anthropic 官方默认不帮你缓存。** `buildRequestParams`（`anthropic.ts`）不发 `cache_control`。对 Claude 官方 API，这通常等于从不 write、从不 read。
3. **流式读错了事件。** Anthropic 只从 `message_delta` 取 usage（`buildStreamEvent`），`message_start` 直接丢弃。官方把 cache 真值放在 `message_start.message.usage`；delta 里 cache 常为 0。即使用户将来补字段，也会被 0 覆盖。
4. **前缀每天、每轮都在抖。** `generateEnvironmentPrompt` 把 `Date`、cwd、`Available tools` 写进 system（`system-prompt/layers/environment.ts`）。更糟的是 **custom instructions 放在 environment 之后**（`assembler.ts` 主代理顺序），日期一变，instructions 也从 cache 里整段作废。
5. **compact 会改历史前缀。** `prepareTurn` 的 mask / prune / summary（`context-manager.ts`）会改写或替换已发送历史。这与「磁带只追加」冲突。本批不重做压缩策略，但观测上必须预期：compact 之后命中会掉一截。
6. **校准因子吃的是残缺 prompt。** Lifecycle 用 `finalEvent.tokenUsage.prompt_tokens` 回调 `updateCalibrationFactor`（`lifecycle.ts`）。Anthropic 开启缓存后，裸 `input_tokens` 往往只是断点后的尾巴；若仍当窗口总量，factor 会被拉崩——这是 4.x 已预见、5 必须堵住的坑。

---

## 1.2 已确认分界（引用 00）

```text
interface-provider / llm-client
  解析 vendor usage → 三元组
  发出 cache_control / prompt_cache_key
  流式合并 usage（禁止 0 覆盖 cache）

ContextManager
  窗口分母 = uncached + cacheRead + cacheWrite
  历史尽量只追加；动态块不要回到 system 头
  不认识 cached_tokens 这种 vendor 名

占用 UI / 本批可展示
  可读 cacheRead 与命中率
  不改「分母只算 uncached」
```

---

## 1.3 interface-provider 现状

### 1.3.1 goals-duty

职责本应是：把两种 wire 形状译成内部事件。当前译完之后 **cache 信息消失**，等于这一层没有履行「如实反映上游 usage」的职责。Context 更不应该补解析——那会把 vendor 分支泄漏进占用模块（与 4.1 方向相反）。

### 1.3.2 architecture

```text
Lifecycle.streamChatCompletion
  → OpenAICompatibleProvider | AnthropicProvider
      buildRequestParams / convertMessages
      stream events → tokenUsage?
  → toUsage / toPartTokenUsageMetadata
  → ContextManager.updateCalibrationFactor(prompt_tokens)
```

问题集中在 provider 边界，而不是 Context 内部再长一套 cache 类型。这是**可逆、局部**的扩展：加字段、加映射，不搬分层。

### 1.3.3 data-model

| 结构 | 现状 | gap |
|------|------|-----|
| `InterfaceProviderTokenUsage` | 三字段 | 无 cacheRead/Write |
| `TokenUsage`（llm-client） | 别名到上一行 | 同上 |
| `TokenUsageMetadata`（message） | camelCase 三字段 | 落盘也丢 cache |
| Anthropic `normalizeTokenUsage` 入参类型 | 只声明 `input_tokens` / `output_tokens` | TypeScript 从根上不许读 cache 字段 |

OpenAI `prompt_tokens`：**包含** cached（子集）。Anthropic `input_tokens`：**不含** cache 段。同一内部字段名不能当同一语义用——这是数据模型层的本质复杂度，必须在 adapter 消掉，而不是让上游每个调用方 if-else。

### 1.3.4 dfd-interface

**OpenAI-compatible 实际发出去的：** `model, messages, temperature, max_tokens, stream, stream_options.include_usage, tools?`。没有 `prompt_cache_key` / `prompt_cache_retention` / `prompt_cache_options` / `prompt_cache_breakpoint`。

**Anthropic 实际发出去的：** `model, messages, max_tokens, temperature, system?, tools?`。没有顶层或 block 级 `cache_control`。system 来自 OpenAI 风格 messages 里 role=system/developer 的拼接。

**流式回来：** OpenAI 依赖最后一块带 usage 的 chunk（`include_usage` 已开，这条是对的）。Anthropic 走错事件。

### 1.3.5 use-case

| 场景 | 现在发生什么 |
|------|----------------|
| 连 DeepSeek 多轮同一前缀 | 服务端可能命中；ohbaby 显示 0 |
| 连官方 Claude 多轮 | 未声明 cache → 基本全价输入 |
| 连智谱 | 隐式命中在 `prompt_tokens_details.cached_tokens`；被丢掉 |
| 用户问「这次命中多少」 | 无法回答 |
| compact 后下一轮 | 前缀变化；即使得 cache 也看不到 |

### 1.3.6 non-functional

- **成本**：看不见命中 = 无法验证省钱，也无法发现「一直在 write」。
- **正确性**：错误 `prompt_tokens` 会污染 calibration 与 overflow 判断（高风险）。
- **兼容**：中转可能剥扩展字段；必须「有则读、无则三元组 write/read=0」，不能当协议错误。
- **可测**：现有 anthropic 测试的 fixture 已带 `cache_* : null`，却断言只要三角字段——说明测试在**固化丢弃行为**。

### 1.3.7 test

- `openai-compatible.test.ts`：断言 `stream_options.include_usage`，不断言 details。
- `anthropic.test.ts`：夹具含 cache 字段，期望输出不含它们。
- `core/context`：improve-4.1 用 rg 守卫 **禁止** context 包出现 cache 字段——这条守卫本批**继续有效**（解析不放进 context 包）。

---

## 1.4 system-prompt / context 现状

### 1.4.1 组装顺序（主代理）

`SystemPrompt.assemble`（`assembler.ts`）：

1. base（稳定）
2. primary task（较稳定）
3. agent addon（较稳定）
4. subagent roles（半稳定）
5. `runtimePrompts`（常变）
6. **environment：日期、cwd、tools 列表（每轮/每天变）**
7. **custom instructions（稳定，却在 6 之后）**

精确前缀从左往右。6 一变，7 整段无法命中。这是当前最大的**自伤**。

environment 文本（`environment.ts`）：`cwd`、`platform`、`Date`、`isGitRepo`、`osVersion`、`Available tools`。`sessionId` 在 input 上但未写入 prompt 正文（好）。无 uuid 注入（好）。日期是 **日历日**，跨天必 bust。

### 1.4.2 context 投影

`prepareTurn` 可能：mask 旧 tool 结果、prune 标记 compacted、插入 summary。发给模型的前缀因此不是「会话字节的单调追加」。对 cache 来说这不是 bug，是**另一件产品功能**；本批只要求：compact 后不要误报「cache 坏了」，并在 04 用场景盖住。

### 1.4.3 tools 稳定性

API `tools` 数组原样转发、不重排（好）。但 system 里又抄了一份 `Available tools` 名字列表。tools 增减时：**schema 前缀 + system 环境块**两处同时变。Codex 的经验是：tools 集合与顺序跨 turn 冻结；限工具用 `allowed_tools` 而不是改数组（OpenAI 5.6 文档同此）。

---

## 1.5 2026-08 协议 vs 代码（对照）

| 能力 | 官方（2026-08） | ohbaby |
|------|-----------------|--------|
| OpenAI 读缓存 | `usage.prompt_tokens_details.cached_tokens` | 不读 |
| OpenAI 写缓存（5.6+） | `prompt_tokens_details.cache_write_tokens` | 不读 |
| OpenAI 路由 key | 顶层 `prompt_cache_key` | 不发 |
| OpenAI 流式 usage | `stream_options.include_usage` | **已发** |
| OpenAI 显式断点 | content 上 `prompt_cache_breakpoint` | 不发（本批非必做） |
| Anthropic 启用 | 顶层或 block `cache_control` | **不发** |
| Anthropic 读/写 | `cache_read_input_tokens` / `cache_creation_input_tokens` | 不读 |
| Anthropic 总量 | read + creation + `input_tokens` | 误用裸 `input_tokens` |
| Anthropic 流式真源 | `message_start` | 只读 `message_delta` |
| DeepSeek | 顶层 `prompt_cache_hit_tokens` + `prompt_cache_miss_tokens` | 不读 |
| 智谱 | `prompt_tokens_details.cached_tokens` | 不读 |

**是否要对齐最新协议？要。** 对齐的意思是：官方名进 adapter、语义进三元组；不是把 GPT-5.6 的 breakpoint 强加给 DeepSeek。

---

## 1.6 SWE 原则审视

- **本质 vs 偶然：** 「两家 usage 加法不同」是本质复杂度，必须在边界翻译。把 vendor 字段堆进 ContextManager 是偶然复杂度。
- **信息隐藏：** 调用方只该看见三元组；`prompt_cache_hit_tokens` 不得漏出。
- **YAGNI：** 本批不做价格引擎、显式 5.6 breakpoint、持久化统计。
- **校准链路**是不可靠默契：错的 `prompt_tokens` 会静默搞坏压缩时机——这比「UI 少一个百分比」更危险。

---

## 1.7 与既有文档

| 文档说 | 代码做 | gap |
|--------|--------|-----|
| 4.1：context 包禁止 cache 字段 | rg 为 0 | 保持；解析放 provider |
| 4 / 4.1：占用分母含全部 prompt | `measureUsage({messages,tools})` | 本批不得改成 uncached-only |
| 5 的 00 旧文：字段名未冻结 | 本次 00 已冻三元组 | 01/02 必须用这套名字 |
| architecture：client 译协议 | 译了文本，没译 cache | 本批补 |

---

## 1.8 改动影响面（现状视角）

会碰到：`interface-providers/types.ts`、`openai-compatible.ts`、`anthropic.ts` 及其测试、`llm-client/types.ts`、`message/types.ts`、`lifecycle.ts`（校准输入与 usage 累加）、`system-prompt/assembler.ts` + `environment.ts`、`prepareTurn` 的消息拼接（动态块插入点）。**不应**为了 cache 去改 `token-estimation.ts` 的字符启发式，也不应改 compact 阈值。

---

## 协议 URL（规划期核对）

- https://developers.openai.com/api/docs/guides/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://api-docs.deepseek.com/guides/kv_cache
- https://docs.bigmodel.cn/cn/guide/capabilities/cache
