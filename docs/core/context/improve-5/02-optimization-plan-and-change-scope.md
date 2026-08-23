# 2. 优化方案与改动面

> 实施会话的执行契约。规划轮不写业务代码。约束来自 [00](./00-discussion.md)，证据来自 [01](./01-problem-analysis-and-current-state.md)，验收见 [04](./04-test-and-acceptance.md)。

---

## 2.1 方案总览

```text
上游 usage（各家字段不同）
        │  adapter 翻译
        ▼
TokenUsage 三元组
  uncached + cacheRead + cacheWrite = 窗口输入
        │
        ├─→ Lifecycle 校准 / overflow（必须用「和」，禁止裸 Anthropic input_tokens）
        ├─→ 本轮展示命中率 = cacheRead / 三者之和
        └─→ ContextManager 仍按 messages+tools 估窗口；不解析 vendor cache 名

请求方向（阶段 B）
  Anthropic: cache_control（先顶层 automatic ephemeral）
  OpenAI-compatible: prompt_cache_key = 稳定 sessionId
  DeepSeek/智谱: 不发私有开关；只靠前缀 + 读 usage

前缀（阶段 C）
  system 左：身份 / 规则 / 稳定 instructions
  system 不放：日期、cwd、git status、uuid、request id
  本轮 user 右：上述动态快照（磁带接长）
```

原则：

1. **翻译一次，处处使用。** 三元组是唯一内部货币。
2. **官方名只活在 adapter。** Context 继续 4.1 的 rg 守卫。
3. **先看见，再打开，再整形。** 没有 A 的数字，B/C 无法证明自己有用。
4. **兼容 = 对齐 2026-08 官方形状，而不是模仿每一家网关。** 中转少字段时读成 0，不报错。

---

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃项与代价 |
|--------|------|------|--------------|
| 内部 usage | `uncached` + `cacheRead` + `cacheWrite`，互斥 | 与 pi / deepseek-harness / kimi 一致；命中率分母含 write | 不保留「OpenAI 子集 + Anthropic 分段」两套平行类型 |
| OpenAI 入站 | `cacheRead = details.cached_tokens`；`uncached = prompt_tokens - cacheRead`（再减 write 若官方语义为互斥计费分类则按 01 公式，**禁止** `cached+write` 当必须等于 prompt） | Chat Completions 的 `prompt_tokens` 含 cached | 不要把 cached 再加进 prompt_tokens |
| Anthropic 入站 | `cacheRead = cache_read_input_tokens`；`cacheWrite = cache_creation_input_tokens`；`uncached = input_tokens`；窗口 = 三者之和 | 官方加法 | 禁止把 `input_tokens` 当总量 |
| DeepSeek | `cacheRead = prompt_cache_hit_tokens ?? details.cached_tokens`；`uncached = prompt_cache_miss_tokens ?? (prompt - read)`；`cacheWrite = 0` | 官方 hit+miss=prompt，无 write | 只认 OpenAI nested 会把 DeepSeek 命中读成 0 |
| 智谱 | 同 OpenAI nested `cached_tokens`；write=0 | 隐式缓存 | — |
| 流式 Anthropic | `message_start` 纳入 usage；cache 字段 **仅当 `>0` 才覆盖** | 学 claude-code；官方真源在 start | 只读 delta 会得到全 0 |
| 流式 OpenAI | 保持 `include_usage`；取最后一块非空 usage | 已做对 | — |
| 请求 Anthropic | 阶段 B 发顶层 `cache_control: { type: "ephemeral" }` | 官方推荐给多轮；实现成本最低 | 本批不强制 4 个精细断点；不够再加 block 级 |
| 请求 OpenAI | `prompt_cache_key` = 稳定 `sessionId`（可短前缀如 `ob:`） | Codex/OpenCode/Pi 共识 | 不用 messages hash；不对 DeepSeek 必发（发了应被忽略） |
| GPT-5.6 breakpoint | **本批不做** | 无观测前无法判断 implicit write 是否烧钱 | 02 留下阶段 D 备注 |
| 动态环境 | 移出 system 头，进**本轮 user** 尾部（或独立 trailing user） | 用户确认；Codex `environment_context` | 留在 system 末尾仍会 bust 其后所有块 |
| custom instructions | 挪到 environment **之前**（稳定前缀内） | 现在放在日期后面，日更即废 | — |
| tools 文本列表 | 从 environment 删除或移到动态 user | 与 API tools 重复且双处 bust | 阶段 C 做 |
| compact | 不改策略；校准改用窗口和 | 压缩复核是后序批次 | 命中在 compact 后下降是预期 |
| Context 类型 | 不新增 cache 字段 | 4.1 边界 | 统计若将来要做，新开计量投影，不塞进 AssembledContext |

---

## 2.3 分阶段实施

### 阶段 A — 观测三元组（可单独合并）

**目标：** 任意一次完成的 LLM 请求，内部都能拿到完整三元组；校准使用窗口和。

**改动文件（预期）：**

- `services/interface-providers/types.ts` — 扩展 usage
- `openai-compatible.ts` / `anthropic.ts` — 解析 + 流式合并
- 两套 `*.test.ts` — 用真实形状的 fixture（含 DeepSeek 顶层 hit/miss）
- `core/llm-client/types.ts`、`core/message/types.ts` — 同步三元组（或在边界一次性映射，避免三处语义分叉）
- `core/lifecycle/lifecycle.ts` — `toUsage` / calibration 改窗口和

**DoD：** 单测覆盖 1.5 表中各家至少一条 fixture；Anthropic start+delta 合并测过「delta cache=0 不覆盖 start」；`core/context` 仍 rg 不到 vendor cache 名。

### 阶段 B — 请求/消息协议兼容

**目标：** 发出 2026-08 官方启用字段；不增加第三 kind。

- Anthropic `buildRequestParams`：顶层 `cache_control`
- convert 路径保持 OpenAI messages → Anthropic messages；**不**在阶段 B 做复杂多断点，除非 A 上线后官方 Claude 仍 0 命中
- OpenAI-compatible：`prompt_cache_key`；继续 `include_usage`
- 中转不认识字段：忽略或 400 时要有降级（去掉 key/cache_control 重试 **不是** 本批必做；先记录错误。若实施中发现主流中转 400，再加窄降级）

**DoD：** 请求快照测试锁定字段名与位置；Anthropic 无 `cache_control` 视为回归。

### 阶段 C — 前缀磁带

**目标：** 稳定字节靠左，动态靠右。

- `assembler.ts`：custom instructions 提到 environment 之前；runtime 动态块不得插在稳定 instructions 之前
- `environment.ts`：日期、cwd、tools 列表不再进入可缓存 system 头
- Lifecycle 或 context `prepareTurn`：把「本轮环境快照」追加为 **user 侧**短消息（或 metadata + 显式 user 段），每轮只改这一条尾巴
- tools **数组顺序**冻结（已基本做到）；本批不引入 `allowed_tools` 除非现有代码已有同类开关

**DoD：** 两次组装：只改日期/cwd 时，system 稳定前缀字节级相同；环境差出现在最后一条 user。

### 阶段 D（本批不做，仅登记）

GPT-5.6 `prompt_cache_options` + `prompt_cache_breakpoint`；1h Anthropic TTL；持久化命中统计；价格。等 A 的真实数字。

---

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `services/interface-providers/` | 无或小纯函数 `toCacheTriple` | types + 两 provider + 测试 | 无 | 协议翻译中心 |
| `core/llm-client/` | 无 | types / streaming 若透传 usage | 无 | 不要在这里再解析一份 vendor JSON |
| `core/lifecycle/` | 无 | calibration 输入 | 无 | 窗口和 |
| `core/message/` | 无 | metadata 可选 cache 字段 | 无 | 若落盘，名字用三元组不是 vendor |
| `core/system-prompt/` | 无 | assembler + environment | 环境里的动态行 | 磁带顺序 |
| `core/context/` | 无或只接「trailing user」 | `prepareTurn` 插入点 | 无 | **禁止** vendor cache 类型 |
| `docs/core/context/` | 无 | architecture 一句 | 无 | 实施时同步权威文档 |

---

## 2.5 API / 协议 / 迁移与兼容

**进程内：** `InterfaceProviderTokenUsage` 扩字段是有意合同变化；所有构造点要补 0 默认，避免 `undefined` 参与算术。

**对外 HTTP：** 无用户 API 变化。

**上游：**

| 上游 | 阶段 A | 阶段 B |
|------|--------|--------|
| OpenAI Chat Completions | 读 `prompt_tokens_details` | 发 `prompt_cache_key` |
| OpenAI Responses | 若本批仍只走 Chat，不强制改 Responses | Codex 才是 Responses；ohbaby 现状是 Chat |
| Anthropic Messages | 读 start usage + 三段加法 | 发顶层 `cache_control` |
| DeepSeek / 智谱 Chat | 双路径读 hit 或 details | 不发声明 |

**迁移：** 无存储 schema。旧日志缺 cache 字段视为 read=write=0。

---

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 中转因未知字段 400 | 阶段 B 可配置「不发 cache 请求字段」；A 仍能观测 | 关掉 B 的请求字段即可 |
| 校准改窗口和后阈值行为变化 | 单测 + 对照 4.1 占用分母 | 校准公式可开关到旧 prompt_tokens（不推荐默认） |
| 环境改到 user 后模型行为变 | 文案保持同样信息，只换位置；看回归对话质量 | 把环境块移回 system **尾**（仍好过放头） |
| compact 后命中下降被当成回归 | 04 写明预期 | 不改 compact |

不可逆决策：**无**。字段扩展与请求可选字段均可关。

---

## 2.7 与 00 边界对齐

- 三元组、两种 compatible、对齐 2026-08、动态进 user、占用含 cached、不做价格/预测/持久化：均落入 2.2–2.3。
- 关键改动清单：按 00 省略。

---

## 2.8 不在本批

价格引擎、命中预测、GPT-5.6 显式断点、第三种 client、compact 策略、子代理占用 UI、把 cache 写入 ContextMeasurementPayload。
