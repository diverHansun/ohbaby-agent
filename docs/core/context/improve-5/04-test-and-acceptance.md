# 4. 测试计划与验收标准

> 本文同时是 improve-5 的测试蓝图和发布门。测试围绕 [01](./01-problem-analysis-and-current-state.md) 的 P1–P11，沿用仓库现有 Vitest `unit / contract / integration / smoke` 分类，不另造测试框架。

---

## 4.1 测试原则

1. **先证明数字正确，再证明字段发对，最后证明真实命中。** mock hit 不能替代 provider smoke。
2. **比较 provider-relevant request。** messages、tools、system/content block、cache field 与顺序要比较；不把无关 JSON property serialization 当 cache 条件。
3. **unknown 不等于 0。** fixture 必须分别覆盖字段缺失和显式 0。
4. **measurement 与 send 是同一份输入。** 不能分别构造两个“看起来一样”的 fixture。
5. **primary/subagent 对称。** 每个跨层关键场景必须有 scope 参数化或专门的 subagent case。
6. **真实 scheduler 优先于纯 resolver mock。** 至少使用两个实际注册 tool，并覆盖一次 lazy MCP load。
7. **真实测试有成本边界。** API-key gated、串行、有限请求次数、明确超时；失败不得自动无限重试。

## 4.2 层次与文件归类

| 层 | 目标 | 建议分类 |
|----|------|----------|
| 纯 normalizer / key / capability / tool sequence | 不变量、边界值、表驱动 matrix | `*.unit.test.ts` |
| adapter request/response wire | 官方 JSON fixture 与最终 request shape | `*.contract.test.ts` 或现有 provider test |
| ContextManager + Lifecycle + store + scheduler | 同一 payload、持久化、prefix、primary/subagent | `*.integration.test.ts` |
| 真实 provider cache | 多 step tool loop 的 write/read 证据 | `*.smoke.test.ts`，由显式 env gate 启用 |

已有未带分类后缀的 provider / LLM tests 可继续直接运行；新增跨层 case 应遵守现有分类后缀，确保 `test:unit/contract/integration/smoke` 不漏。

## 4.3 A：TokenUsage、stream、retry、aggregate

| ID | 场景 | 期望 | 覆盖问题 |
|----|------|------|----------|
| U01 | OpenAI 只有 prompt/completion/total | inclusive input 正确，breakdown 缺失 | P1、P9 |
| U02 | nested `cached_tokens: 0`、无 write 字段 | breakdown 存在，read observed=true/write observed=false，命中率=0%，写入 unavailable | P9 |
| U03 | nested cached > 0、无 write | read=cached/observed，uncached=input-read，write unobserved | P1、P9 |
| U04 | nested cached + cache_write | 两分类 observed=true；三个数互斥，总和=input | P1 |
| U05 | read+write > prompt | input/output 保留，breakdown 丢弃并诊断，无负数 | P1 |
| U06 | DeepSeek 完整或 partial hit/miss | prompt+单字段可推导另一项；两字段验证总和；无 prompt 且仅一个字段时 usage unavailable | P1、P2、P9 |
| U07 | DeepSeek prompt 与 hit+miss 冲突 | breakdown unavailable，不静默伪造 | P1、P9 |
| U08 | 智谱 nested cached | read observed；write=0 但 unobserved，不显示“未写入” | P1、P9 |
| U09 | Kimi top-level cached | read observed；write unobserved；nested 与 top-level 优先级固定 | P1、P9 |
| U10 | Anthropic 仅 input/output、无 cache 分类字段 | input=raw input，breakdown unavailable | P1、P9 |
| U11 | Anthropic cache fields 显式为 0 | breakdown 存在且 read/write observed=true、值为 0 | P9 |
| U12 | Anthropic cache creation | input=uncached+creation，write 正确 | P1 |
| U13 | Anthropic cache read | input=uncached+read，read 正确 | P1 |
| U14 | provider raw total 与 normalized total 冲突 | normalized total 重算并诊断 | P1 |
| U15 | start 有 cache，final delta 分别带 placeholder 0 或增长后的 cumulative input/cache/output | 单调合并：0 不清空，增长值生效，最终一次 normalize | P3 |
| U16 | attempt 1 只收到 usage 后失败，attempt 2 成功 | 结果只含 attempt 2 usage | P3 |
| U17 | attempt 1 已发 text/tool/reasoning 任一 delta 后失败 | 不再透明 retry，不重复任何可见或 reasoning 输出 | P3 |
| U18 | run 内所有请求有 breakdown，但 observed flags 不同 | 数值逐项求和，observed 按逻辑 AND；只展示全量可解释指标 | P1、P9 |
| U19 | run 内任一非零 input 请求缺 breakdown | aggregate input/output 有值，aggregate breakdown 缺失 | P9 |
| U20 | assistant metadata 写入再读取旧记录 | 新 shape round-trip；旧 prompt/completion metadata 可读但不产生假 breakdown | P1、P9 |
| U21 | calibration 收到 Anthropic 高 cache read | 使用 inclusive `inputTokens`，不是 uncached tail | P1 |
| U22 | 既有 public streaming consumer 读取 snake aliases | aliases 等于 canonical total，内部代码无新增 snake 使用 | P1 |
| U23 | context-summary/title 经过共享 client | complete response 使用 canonical usage，不进入 agent-step aggregate/calibration | P11 |
| U24 | run 内一个已完成 agent-step 整份 usage 缺失 | `usageComplete=false`；已知 totals 标 partial/lower-bound；run breakdown、hit rate、write unavailable | P1、P9 |
| U25 | lifecycle → worker → stream bridge 的 complete event round-trip | `llm:complete`、`run.llm.complete` 与还原 event 的 normalized usage 深等价 | P1 |

每个 fixture 额外跑统一 invariant assertion：非负整数、`total=input+output`、breakdown 存在时分类总和=input、observed 与原始字段 presence 一致、可计算的命中率不超过 1。

## 4.4 B：配置、capability、wire 与 scoped key

| ID | 场景 | 期望 | 覆盖问题 |
|----|------|------|----------|
| C01 | 旧 model config 无 `promptCache` | 解析为 `auto` | P2 |
| C02 | 非法 promptCache 值 | config validation 明确失败 | P2 |
| C03 | auto matrix 全表参数化 | 每个 provider/baseURL/interface 得到 02 指定 strategy | P2 |
| C04 | unknown compatible + auto | `observe-only`，不发任何扩展字段 | P2 |
| C05 | disabled + 已知 official endpoint | 不发 key/control，但仍解析 usage | P2 |
| C06 | enabled + unknown OpenAI-compatible | 选择 keyed implicit，拒绝时错误含 strategy | P2 |
| C07 | official OpenAI request | 有 opaque `prompt_cache_key` 与 `include_usage` | P2、P4 |
| C08 | ZenMux OpenAI / DeepSeek / 智谱 auto | 没有 `prompt_cache_key` | P2 |
| C09 | official Anthropic request | 顶层 automatic + 最后 stable system block anchor 都存在，marker 数合法 | P2、P5 |
| C10 | ZenMux Anthropic request | 只有最后一个 eligible block marker，domain messages 未被修改 | P2 |
| C11 | DeepSeek Anthropic auto | 不发 cache control | P2 |
| C12 | primary 同 session 连续请求与 retry | key 完全相同 | P4 |
| C13 | 不同 session | key 不同 | P4 |
| C14 | 同 session：primary、subagent A、subagent B | 三个 key 不同 | P4、P8 |
| C15 | key 安全性 | 定长、有版本、不包含明文 session/scope/user/cwd | P4 |
| C16 | compact、消息增长、MCP epoch 变化 | key 保持稳定；只改变 provider-relevant prefix | P4、P7 |
| C17 | OpenAI SDK 未声明的新 wire 字段 | typecheck 通过，extension 只在 adapter 局部 | P2 |
| C18 | proxy URL、`evil-openai.com`、非 HTTPS/非默认 port | 不会误判为 official capability | P2 |
| C19 | 三个 production LLM caller + legacy omission | 内部都显式传 purpose；summary 有 contextScopeId，title 是 auxiliary；旧 caller 缺值时 observe-only | P11 |
| C20 | config writer / connect round-trip | 缺失值默认 auto；已有 enabled/disabled 不被无关重写丢失 | P2 |

wire snapshot 不能只断言字段“存在”，还要断言不该出现的字段缺失，防止 `auto` 回退成“compatible 全发”。

## 4.5 C：request 收拢、prefix、environment 与 tools

### 4.5.1 request-shaped 与 `additionalMessages`

| ID | 场景 | 期望 | 覆盖问题 |
|----|------|------|----------|
| R01 | 正常 prepare | measurement payload 与 `PreparedTurn.request` 深等价 | P6、P10 |
| R02 | overflow projection / compact / remeasure | 每个分支使用同一个 request assembler，不丢 tools/tail | P6、P10 |
| R03 | force prepare | tools 与 messages 不从 lifecycle 旧变量旁路 | P6 |
| R04 | max-steps finalization | tail directive 同时被量到并发送一次，不持久化为 turn context | P6 |
| R05 | public types/code guard | `additionalMessages` 从 prepare API 与 lifecycle 双传路径消失 | P6 |
| R06 | measurement recorder + provider spy | 最后一次测量的 `{messages,tools}` 与实际 adapter input 相同 | P6、P10 |

R06 是 improve-4.1 的关键升级：不是分别断言“测量有 tools”和“请求有 tools”，而是记录并比较两端的同一最终 payload。

### 4.5.2 runtime snapshot 与稳定前缀

| ID | 场景 | 期望 | 覆盖问题 |
|----|------|------|----------|
| PFX01 | environment unit | 不再生成 `Available tools` | P5 |
| PFX02 | primary system | 不包含 date/cwd/platform/osVersion/isGit/MCP menu；custom/memory 顺序稳定 | P5 |
| PFX03 | subagent system | 同样不包含 runtime environment/menu | P5、P8 |
| PFX04 | primary turn admission | initiating user 只有一个 synthetic runtime part | P5 |
| PFX05 | subagent turn admission | 子代理自己的 user turn 只有一个、scope 内容正确 | P5、P8 |
| PFX06 | 同一 tool loop 两个 model steps | 旧 system/tools/messages 深等价，只有 assistant/tool suffix 增长 | P5、P7 |
| PFX07 | retry | runtime part 不重新生成、不移动 | P3、P5 |
| PFX08 | 下一用户 turn date/cwd 改变 | 旧历史不变，新 runtime part 只作为最新 user suffix | P5 |
| PFX09 | store + crash/resume + projections | model serializer 可见；live UI、持久化 transcript、fallback title、默认 export 隐藏；数据库恢复后位置不变且不重复附着 | P5 |
| PFX10 | compaction | part 被正常测量/处理，不在 request 尾重复补回 | P5、P6 |
| PFX11 | run 中 custom instruction / memory source 改变 | 当前 run snapshot 不漂移；下一 run 才生效 | P5 |
| PFX12 | runtime text escaping | cwd/tool description 中边界字符不会破坏结构标签 | P5 |
| PFX13 | primary/subagent 并行 prepare | 各用 run-local snapshot，共享 ContextManager 无“当前 snapshot”串线 | P5、P8 |
| PFX14 | lineage parent 更新 / 无新 user 的 resume | 独立 initiating id 不变；resume 缺 id 时复用历史 part，不扫描或回写“最后一条 user” | P5、P8 |
| PFX15 | 单 step 产生 >20 个 tool_use/tool_result blocks | official Anthropic stable-system anchor 仍保护 tools+system 基础前缀，尾部 automatic 可继续推进 | P5、P7 |

prefix assertion 使用 provider-relevant projection：

```text
OpenAI-compatible: [system message, ordered tools, ordered messages]
Anthropic:         [ordered tools, ordered system blocks, ordered message blocks]
```

相邻 step 在同 epoch 下，前一个请求的 projection 必须是后一个请求的结构前缀；只允许新增 assistant/tool result 等 suffix。

### 4.5.3 tool sequence 与 MCP epoch

| ID | 场景 | 期望 | 覆盖问题 |
|----|------|------|----------|
| M01 | registry 至少两个 built-in tools | 初始顺序稳定，重复 resolve 相同 | P7、P10 |
| M02 | load lazy MCP tool C | `[A,B] → [A,B,C]`，不变成 registry 原位置 | P7 |
| M03 | 再 load C | 幂等，顺序与 epoch 不变 | P7 |
| M04 | 再 load D | `[A,B,C,D]`，epoch 仅加 1 | P7 |
| M05 | primary 与 subagent 各自 load | sequence/epoch 隔离，不互相污染 | P7、P8 |
| M06 | 同 session 两 subagent scopes | 加载集合、顺序、catalog snapshot 隔离 | P7、P8 |
| M07 | catalog loaded 状态改变 | 旧 user snapshot 不修改；新状态只在新 suffix | P5、P7 |
| M08 | tool schema 改变、权限撤销或 MCP 断开 | 明确新 epoch；不可用 tool 移除，survivors 相对顺序不变 | P7 |
| M09 | closed scope 与整 session 清理 | `disposeScope` 只释放目标 context/MCP/sequence；`disposeSession` 批量释放全部 scope；均幂等 | P7、P8 |
| M10 | 真实 scheduler tool loop | 两个 tool schema 都进入 measurement/send，顺序一致 | P10 |
| M11 | prepare 后、send 前发生 lazy load | 当前 immutable request 不变；新 tool 只进入下一 step/epoch | P6、P7 |
| M12 | 进程重启且 loaded tools 无法重建 | 同 scoped key 可复用，但创建新 tool epoch；首次 miss/write 允许，随后 sequence 稳定 | P7 |
| M13 | 真实 provider epoch 恢复 | epoch0 出现 read；load C 后 `[A,B,C]` 且 epoch+1；epoch1 首次可 miss/write，下一请求必须 read>0 | P7、P10 |

## 4.6 primary / subagent 联合场景

| ID | 场景 | 必须同时证明 |
|----|------|--------------|
| A01 | primary 一轮无 tool | scoped key、runtime part、normalized usage、metadata |
| A02 | primary 两 step tool loop | 单一 request payload、append-only suffix、aggregate usage |
| A03 | subagent 一轮无 tool | 与 primary 同 pipeline，但 system/memory 内容遵守子代理边界 |
| A04 | subagent 两 step tool loop | child scope key、runtime part、tools、usage/calibration 全部生效 |
| A05 | 同一 parent 下并行/顺序两个 subagent | context history、cache key、tool sequence、aggregate state 不串 |
| A06 | child resume/继续 | 同 child scope key 稳定，旧 runtime prefix 不重写 |
| A07 | child 结束回到 parent | child usage 不进入错误的 parent context occupancy UI，但请求 metadata 可审计 |
| A08 | primary 与 child 各触发 compact projection | 两者都保持 improve-4/4.1 的 messages+tools 分母与各自 scope |
| A09 | child compact 触发 context summary | summary request 带 child scope、purpose=auxiliary，并保持 observe-only，不混入 agent-step hit rate |

任何 A03–A09 缺失都意味着“只完善主代理”，本批不能验收。

## 4.7 real cache smoke

### 4.7.1 共同结构

新增 key-gated real smoke，结构借鉴 deepseek-harness：

1. 使用确定性的稳定 system/tool schema，长度跨过所选模型的最低 cacheable threshold。
2. 每次 smoke 在首轮 user suffix 使用只在该次测试内固定的 unique marker/session，让本次序列可区分，并在后续请求保持不变；它不能每 step 重生或污染 system。unique suffix **不能保证整个首请求是 cold**：更左侧的稳定 tools/system 可能已有 partial read，因此不得断言首请求 `cacheRead=0`。
3. turn 1 强制调用真实本地 fixture tool，产生至少两个 model requests。
4. turn 2 在同一 session/scope 追加短 user message。
5. 从生产 `llm:complete` / assistant metadata 读取 normalized usage，不从测试专属 parser 读取。
6. 同时保存脱敏 request projection，证明相邻请求为 append-extension。
7. 首请求之后最多再发 3 个请求；不靠无限重试“刷出”命中。

### 4.7.2 OpenAI-compatible 门

至少选择一个项目实际使用端点：OpenAI official、DeepSeek official 或智谱 official。

- 第一请求的 read 可以为 0，也可以因稳定左侧前缀已有缓存而大于 0；不对它做 cold 断言。若 provider 报 cache write 则记录。
- 在同 epoch 的后续请求中至少一次 `inputBreakdown.cacheRead > 0`。
- `promptCache=auto` 时，wire 字段符合 capability matrix：例如 OpenAI official 有 key，DeepSeek/智谱没有 key。
- 未达到服务最低 prefix 长度时测试应明确 fail-fast 配置错误，不得把必然 miss 当实现 bug。

### 4.7.3 Anthropic 门

使用 Anthropic official endpoint：

- 首个满足长度的请求通常应看到 `cacheWrite > 0`；若更左侧稳定前缀已经被 provider 复用，则允许以 `cacheRead > 0` 取代，不能为了制造 cold 断言而每 step 改前缀；
- 后续同 scope、同 tool epoch 请求看到 `cacheRead > 0`；
- `message_start` 的 creation/read 最终进入 normalized request metadata；
- 再用一个 child context scope 重复最小序列，证明内部 scoped identity 与 history 不沿用 primary，adapter 与 usage 行为一致。Anthropic wire 没有 OpenAI-style key；若 exact bytes 相同而发生服务端复用，不视为 context 泄漏或测试失败。

如实施环境暂时没有对应 API key，测试可以 `skipIf`，但验收记录必须写“协议 contract 已通过、真实服务命中未验证”，不能把 skipped 当 full pass。improve-5 最终完成门要求 OpenAI-compatible 与 Anthropic 两类各有一次人工或 CI 证据。

### 4.7.4 MCP epoch 恢复门

至少在一个支持真实 cache-read 观测的 provider 上执行：

1. epoch 0 连续请求直到获得一次 `cacheRead > 0`；
2. 通过真实 MCP/tool scheduler load C，断言 tools 从 `[A,B]` 变为 `[A,B,C]`，旧工具相对顺序不变且 epoch 只加 1；
3. epoch 1 第一请求允许 miss 或 creation/write；
4. epoch 1 下一请求必须出现 `cacheRead > 0`，并证明 request projection 在新 epoch 内重新成为 append-extension。

该场景证明动态加载只是一次明确失效，而不是从此每 step 都因重排无法命中。它必须通过真实 smoke 入口运行，不能只以 M02 的内存序列单测替代。

## 4.8 improve-4 / 4.1 联合回归

| 回归项 | 不得退化 |
|--------|----------|
| request-shaped occupancy | static、manual、scheduler 三路径都量 `messages + tools` |
| tool schema denominator | 至少两个真实 tools 时 estimated/context usage 包含完整 schemas |
| compact projection | compact 前后、force 路径和 final directive 均使用最终 request |
| cached input | 仍计入 context window 与 calibration |
| summary/memory | stable system snapshot 不丢已有摘要和 primary memory |
| scope | primary 与每个 subagent history/calibration/loaded tools 独立 |
| lifecycle | max steps、abort、retry、tool parsing、finish reason 行为保持 |
| serializer/store | synthetic runtime part model-visible、UI 隐藏、可恢复 |
| improve-4.1 旧工具文本断言 | 只删除 final system 中 `Available tools: ...` 的文本期望；final-step `tools=[]` 的 measurement/send 一致性继续保留 |

联合回归通过后，再按用户约定对 improve-4 / 4.1 / 5 的 context 模块做第二轮全方位实现程度检查；不在 improve-5 中顺手调整 compact 阈值。

## 4.9 守卫与执行命令

### 阶段内快速命令

```bash
pnpm exec vitest run packages/ohbaby-agent/src/services/interface-providers/openai-compatible.test.ts packages/ohbaby-agent/src/services/interface-providers/anthropic.test.ts packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts packages/ohbaby-agent/src/core/context/manager.unit.test.ts packages/ohbaby-agent/src/core/context/projection.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/core/system-prompt/__tests__/assembler.test.ts packages/ohbaby-agent/src/core/system-prompt/__tests__/environment.test.ts packages/ohbaby-agent/src/mcp/integration/dynamic-tool-menu.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts
```

### 完整门

```bash
pnpm exec prettier --check 'docs/core/context/improve-5/*.md'
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run test:contract
pnpm run test:integration
pnpm run test
pnpm run build
```

real provider smoke 使用项目已有 `.env` 加载约定，但应为 cache 测试增加独立显式 gate，不复用一个含义不同的 TUI smoke flag。当前 `scripts/run-real-smoke.mjs` 硬编码 ZAI/智谱 TUI tests；实施必须扩展它以显式调度新的 OpenAI-compatible 与 Anthropic cache specs，或新增语义清晰的 cache runner，不能只新增一个永远不会被总入口运行的文件。推荐冻结以下入口（具体 credential 名沿用各 provider 现有配置）：

```bash
OHBABY_RUN_REAL_CACHE_OPENAI_COMPAT=1 pnpm run test:cache:real:openai-compatible
OHBABY_RUN_REAL_CACHE_ANTHROPIC=1 pnpm run test:cache:real:anthropic
pnpm run test:cache:real
```

两个 provider gate 彼此独立，总入口串行调度并明确输出 `pass / skip / fail`；没有凭据是 skip，有 gate 但配置/长度错误是 fail。`pnpm run test:smoke:real` 可再把 cache 总入口纳入项目 real-smoke 汇总，但不能继续只跑旧 TUI test names。G8 的 read 与 M13 epoch 证据必须来自这些生产入口。

守卫：

- `core/context` 不出现 `cached_tokens`、`cache_read_input_tokens`、`prompt_cache_hit_tokens` 等 vendor 字段。
- `additionalMessages` 不再出现在 request assembly 公共路径。
- `Available tools` 不再由 environment layer 输出。
- 未知 endpoint 的 auto request snapshot 不含 key/control。
- 完整 prompt cache key、API key、prompt body 不进入日志 fixture/snapshot。

## 4.10 发布门

| 门 | 标准 | 阻塞级别 |
|----|------|----------|
| G1 usage | U01–U25 全绿，不变量与事件透传无例外 | 硬门 |
| G2 capability | C01–C20 全绿，auto 未盲发 | 硬门 |
| G3 request identity | R01–R06 全绿，measurement/send 同源 | 硬门 |
| G4 prefix | PFX01–PFX15 全绿，runtime 固定在 initiating user | 硬门 |
| G5 tools/MCP | M01–M13 全绿，scope 清理明确，同 epoch 顺序稳定且真实 epoch 可恢复命中 | 硬门 |
| G6 agent parity | A01–A09 全绿，无 primary-only/auxiliary 旁路 | 硬门 |
| G7 4/4.1 regression | §4.8 与全量测试全绿 | 硬门 |
| G8 real cache | OpenAI-compatible 与 Anthropic 各有一次真实 read 证据 | 最终实施验收硬门；普通无 key CI 可条件跳过 |
| G9 文档/范围 | README、00–04、实现注释与配置示例一致；未混入 out-of-scope | 硬门 |

只有 G1–G9 都有结果，才能新增 `05-implementation-acceptance.md` 并把 improve-5 标为完成。`05` 至少记录 commit、执行命令、pass/skip/fail、两类 provider 的脱敏 usage 证据、primary/subagent 证据和剩余风险。

## 4.11 对抗性审查问题

验收者必须主动回答：

1. 一个 gateway 完全不报告 cache 字段时，UI/metadata 是否错误显示 0%？
2. Anthropic start 有 8,000 read、delta 为 0 时，最终 input/calibration 是多少？
3. attempt 1 只有 usage 后失败，attempt 2 是否携带旧 creation/read？
4. 同一 session 下两个 subagent 的 key、tool sequence、runtime part 是否真正隔离？
5. MCP tool 加载后，已有 tools 是否被插回 registry 原位置？
6. 日期变化是否改写旧 system/history，而不是只追加新 user suffix？
7. max-steps directive 是否既被测量又只发送一次？
8. mock request prefix 全绿时，是否仍有真实 provider `cacheRead > 0` 证据？
9. 一个完整 agent-step 没有 usage 时，run totals 是否被错误伪装为完整数据？
10. child scope 关闭后，ContextManager、MCP loaded set 和 tool sequence 是否都只清理目标 scope？
11. live/persisted UI、fallback title 或 export 是否泄漏 runtime part 中的 cwd/OS/MCP 名称？

任一问题无法用测试或脱敏 request/usage 证据回答，均视为实现未闭环。
