# 第 3 批：测试与验收标准

> 依据 [02](./02-optimization-plan-and-change-scope.md) 与 [plan/04](../plan/04-test-and-acceptance.md)。这是待实施的验收目标，不是已通过的结果。用仓库已有 Vitest、契约测试与真实 API 探测，不新建测试框架。

## 1. 分层与定向命令

- 单元/契约：摘要请求装配、三协议字段、预算解析、重试计数，用可控样本验精确行为。
- 集成：prepared 材料同源、无前置 prune、失败/Stop 不留副作用、scope 与子代理调用链。
- 真实 API：在独立 ohbaby 服务核对实际字段、实际 HTTP 次数、usage 与 cache 行为。

仓库根执行（示例，不是覆盖声明）：

```sh
pnpm exec vitest run \
  packages/ohbaby-agent/src/core/context/token-estimation.unit.test.ts \
  packages/ohbaby-agent/src/core/context/manager.unit.test.ts \
  packages/ohbaby-agent/src/core/llm-client/prompt-cache.unit.test.ts \
  packages/ohbaby-agent/src/services/interface-providers/prompt-cache-wire.contract.test.ts \
  packages/ohbaby-agent/src/services/interface-providers/openai-responses.unit.test.ts \
  packages/ohbaby-agent/src/core/context/compaction-atomic.integration.test.ts
```

按实际改动补用例，记录实际命令、通过/失败与未覆盖范围。

## 2. 用例（映射 plan/04 编号）

| ID | 本批要证明 |
| --- | --- |
| C1 | 同一份正常 prepared 请求与摘要最终 wire：共享 system/tools/历史顺序/原生状态/thinking 及缓存身份，只有用途、适用输出额度与末尾摘要指令等预期差异。构造**原先会触发 prune** 的旧工具结果，证明准备到摘要发送之间没有前置 prune 改写正文或退场标记——不能只比较两份已经裁过的请求；摘要失败/提交前 Stop 不留下 prune 退场 |
| C2 | Chat、Responses、Anthropic 及代表性兼容端点按已知能力发送输出与 cache 字段；原生状态/签名不被拍平；断点指向真实可复用历史；末尾指令不被当成命中边界 |
| C3 | 首次 + 一次暂时网络重试**至多两次实际调用**；三个 provider 建 client 显式 `maxRetries: 0`，SDK 不另加次数；摘要重试是每次压缩调用一份的局部计数、不共享全局额度；分别覆盖首字节前故障与部分正文/thinking 后断流，后者可用剩余重试但不拼接、不提交半成品；两次消耗分别记录；Stop/length/协议错误不重试，普通请求策略不被误改；普通请求溢出标不可重试、只进 force compact 入口 |
| C4（本批部分） | 空正文、length、工具调用、协议错误、容量不足直接失败，不执行工具、不换提示词、不自动升额、不走短 system 兜底；实际消耗仍记账。**没有可压旧段**属「无需压缩」，跳过且不算失败（无收益的终止在批 4） |
| C5（本批部分） | 记账失败与应用失败不造成模型重发；请求完成未必应用；中断 usage 不伪造；摘要失败时只有日志。手动压缩无活跃普通 step 时，record 所有权走压缩作用域、**不伪造普通 run、不把普通必填改可选、不新增尝试表**；请求前已分配 `summaryMessageId`、返回 requestId 与成功 record。**同事务落库随摘要消息在批 4 完成** |
| E1 | 本批同时接入 90% 与必要提前保护：小窗口按实际总输出更早触发；不另设固定百分比/半窗帽；容量检查的普通请求输出预留取**全量 config.maxTokens**，摘要请求显式传 `requestedOutputTokens`，不取 `profile.maxOutputTokens` |
| E5 | 取消前置 prune/prune-only 并同批清理：专属实现、`PRUNE_*`/配置/再导出、`ContextEvent.Pruned` 及其消费、SDK/CLI/Web 返回状态与旧策略测试；无临时开关、专用旧路径或无操作壳。共用退场事务、工具配对、旧会话读取及仍有效的失败回归保留；受影响类型与契约检查通过 |
| A2 / A4（本批回归） | A2：三类解析出的发送额度与预留额度相等（本批验「摘要额度独立、发送与预留同源」）。A4：用量为已有总量子项、缺失不写 0、不新建用量表、不生成假消息/run |

## 3. wire 断言与实际 HTTP 调用数

- 直接断言**最终请求体**（不是上层 options）：Chat 的 `max_tokens`/`max_completion_tokens`、Responses 的 `max_output_tokens`、Anthropic 的 `max_tokens` 与 thinking 字段；messages 末尾就是摘要指令；tools 与原 tool_choice 不变。
- Context 测试用模拟摘要客户端验证两次总预算；另在三个 SDK 下方用可控 HTTP transport／本地 mock endpoint 计实际请求数：成功 1 次，一次可重试故障后成功 2 次，两次都失败也不超过 2 次。只统计 mock provider 的上层调用不能证明 SDK 没有隐式重试。
- 普通请求预期同样关闭 SDK 重试，但应用层沿用已有次数与断流策略；摘要在 Context 中分类部分内容后的 transport 中断，不把该规则推广到普通流。

## 4. 缓存 usage

- 分别报告：客户端共享前缀是否稳定、服务端是否真实返回 cache read/create、输入规模与时间。服务端 miss 要区分 TTL、未写入边界、端点不支持与客户端改写，不要求固定命中率。
- 摘要请求当前 `resolvePromptCacheRequest` 对非 `agent-step` 返回 `observe-only`；本批必须接入适用的摘要缓存身份，并用最终 wire 和真实 usage 核验，不用「传了同一个 key」代替。压后首请求建立新缓存，不额外发请求预热。

## 5. 失败不留 prune 副作用

- 注入摘要失败、取消与提交冲突：核对 `time.compacted` 没有任何由「前置 prune」产生的新标记，旧 parts 的退场集合为空；数据库重开后状态一致。
- 构造会让旧实现触发 prune 的样本，跑到摘要失败，断言旧工具正文仍在、模型投影未改写、`ContextEvent.Pruned` 与 `Pruned` 相关类型已不存在。

## 6. 实网收尾（每批收尾动作，不攒到批 5）

在独立 ohbaby 服务、独立端口/数据目录/会话发真实请求，凭据与可用模型从 `tests/models-4-tests.md` 读取（**不写进规划、命令行参数、日志或审查提示**）。可选脚本：`scripts/run-real-cache-smoke.mjs`、`scripts/run-real-context-e2e.mjs`。核对：

1. 三协议实际发送的输出与 cache 字段、真实 usage/cache 结果；记录提供商未返回哪些明细。
2. 完整输入所需的触发与容量保护确实生效（不只看上层 options）。
3. 摘要请求的实际 HTTP 次数符合「首次＋至多一次」。

记录真实模型、协议、窗口能力来源、实际输入/输出/reasoning/cache 用量、结束原因、是否应用摘要。未知用量保持未知。64K/200K/1M 离线边界通过不等于这些规模都做过实网测试。

## 7. 验收判据（通过/不通过）

本批**通过**需同时满足：

1. C1 的最终 wire 逐项对齐（材料同源、末尾指令、tools/tool_choice 不变），且证明准备到发送之间无前置 prune。
2. C3 的 mock provider 实际调用数 ≤ 2，三个 provider 均 `maxRetries: 0`。
3. E1 的容量检查用全量 `config.maxTokens`、摘要显式传 `requestedOutputTokens`。
4. E5 的 prune 生产方与消费者（SDK/CLI/Web）同批清除、无残留壳，受影响类型/契约检查通过。
5. 失败/取消/提交冲突用例中，`time.compacted` 无 prune 新增标记。

任一条不满足即**不通过**。因本批是中间态，通过只代表批 3 职责完成，不代表压缩策略可发布。

## 8. 审查要点

测量与发送是否又各算一次；摘要材料与正常请求是否真同源（含 thinking 与 tools）；重试是否只剩一个所有者；失败路径是否留下了退场标记；清理是否按引用关系而非文本搜索；是否又加了无需求依据的 token 限制、临时开关或双实现壳。设计审查与实施验收分开，参考项目只支持局部选择。
