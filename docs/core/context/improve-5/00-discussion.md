# 讨论记录与已确认要点

> 2026-08-21 首次冻结范围；2026-08-23 确认本批方案方向。正式实施须等用户审查 01–04。

---

## 1. 背景与动机

improve-4 / 4.1 把「发给模型的 messages + tools 有多大」量清楚了，但账单上更便宜的那一截——**prompt cache 命中**——客户端完全看不见。Anthropic 默认还不缓存；OpenAI-compatible 即使服务端隐式命中，字段也被 `normalizeTokenUsage` 丢掉。

用户要的不是再发明一套缓存，而是：

1. 看清每次请求读了多少、写了多少、没缓存多少；
2. 请求形状跟 2026-08 官方协议对齐；
3. 上下文像磁带一样只在右边接长，好让前缀命中。

---

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| 内部模型 | 三元组 **`uncached` / `cacheRead` / `cacheWrite`**，互斥；窗口输入 = 三者之和 |
| Compatible | 仍只有 `openai-compatible` 与 `anthropic` 两种请求形状 |
| 协议立场 | **对齐 2026-08 官方字段名**；vendor 差异留在 adapter。不因 DeepSeek 再开第三种 client |
| 观测 vs 启用 | 先能解析（阶段 A），再发 cache 请求字段（阶段 B），再改前缀（阶段 C） |
| Anthropic | 必须发 `cache_control`，否则官方 Claude 基本 0 命中 |
| OpenAI-compatible | 已有 `stream_options.include_usage`；补 `prompt_cache_key`（稳定 session/thread id）。DeepSeek/智谱**不**额外声明 |
| 前缀规则 | 从左到右精确匹配。动态「今日 git status」、uuid、request id、易变日期/**cwd** 放**本轮 user** 或 metadata，**不进 system 头** |
| 占用分母 | cached 仍计入窗口；禁止改成只算 uncached |
| Context vs Client | ContextManager 只管窗口占用与「历史是否只追加」；cache 解析/请求字段归 interface-provider + llm-client |
| 命中率 | `cacheRead / (uncached + cacheRead + cacheWrite)`；无 cache 活动时不展示百分比 |
| 价格/预测 | 本批不做 |
| 关键改动清单 | 不写行号进度表；02 只到文件/符号级改动面 |

---

## 3. 已确认：边界（本批不做）

| 项 | 说明 |
|----|------|
| 第三种 compatible | Gemini 等差异当上游行为，不新增 client kind |
| GPT-5.6 显式断点 | `prompt_cache_breakpoint` / `prompt_cache_options.mode=explicit` 记录在 02，本批非必做 |
| 跨会话持久化命中统计 | 本批只保证当次请求 + 当前 run |
| compact 策略重写 | 只标注「compact 会打断前缀」；策略复核放 improve-5 之后的第二次压缩审查 |
| 回退 4.1 | `measureUsage({ messages, tools })` 分母不变 |
| 子代理 UI | 子代理可走同一套 usage 解析，不进用户占用 UI |

---

## 4. 与关联议题

| 文档 | 关系 |
|------|------|
| improve-4 / 4.1 | 前序；usage 三角字段现状的直接原因；本批在其上**扩展**而非替换占用模型 |
| `docs/core/context/architecture.md` | 实施后需补一句：cache 三元组在 client 层，占用分母仍含 cached |
| 知识库 `agent-harness/llm-client/` | 概念与官方字段备忘；本批 01/03 以代码与官方 URL 为准 |
| 第二次压缩复核 | improve-5 **实施后**才做；检查 cache 是否误导 compact 触发 |

---

## 5. 参考项目（细节见 03）

本地：`code-cli/deepseek-harness`、`claude-code`、`codex`、`opencode`、`pi`、`kimi-code`。

学：disjoint 三元组、流式 cache `>0` 才覆盖、`prompt_cache_key=sessionId`、Anthropic 断点、动态环境进 user。

不学：把每日日期塞进可缓存 system 头；用 messages 哈希当 cache key。

---

## 6. 用户确认摘录（2026-08-23）

1. 收成三元组；同时做好 OpenAI-compatible 与 Anthropic 的请求/消息兼容（先查最新协议）。
2. 先看是否对齐 2026-08 协议实现，再谈如何兼容。→ **对齐官方名；adapter 翻译；不扩 compatible 种类。**
3. System/Context 像磁带只在末尾接长；动态 git status / uuid / request id 进本轮 user 或 metadata。
4. 用 `plan-code-improvement` 写 improve-5；再审查：代码现状、最新协议、code-cli 借鉴。
