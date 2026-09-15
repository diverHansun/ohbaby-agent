# improve-5.5 实施与验收

实施日期：2026-09-15。基线 `8b546e3b8ea8870d4cca79a0c030ad60eecacb2d`，本地分支 `codex/improve-5.5-reasoning`。本轮主体是推理配置与原生状态续接，最后一批回归 improve-1～5。未合并、未推送。

## 1. 用户确认与实际行为

| 项目       | 实际行为                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| 默认设置   | 后端默认开启推理、意图强度 medium；能力表决定目标接口的合法参数                                                         |
| 关闭与调整 | 配置支持 `reasoning.enabled` / `reasoning.effort`，后端 `startSession` 接受请求覆盖；逐字段合并，不覆盖用户未调整的开关 |
| 子代理     | 入队时同时继承父代理开关与强度，保存不可变快照；使用子代理实际模型再次校验，不复用父模型 wire 参数                      |
| 摘要／压缩 | 继承所属代理当前设置；这里的 context-summary 就是压缩摘要，没有新增独立“会话摘要”任务                                   |
| 标题       | 用户明确确认关闭推理；目标模型无法关闭时沿用失败处理，不偷偷打开推理                                                    |
| 前端       | 本轮不新增开关、强度选择条、思考文字展示；未来 UI 仍以开启＋medium 为默认设计                                           |
| cache      | 沿用 improve-5 的可信 Step、session 按输入 token 加权累计；子代理／辅助请求不进入主代理 hit                             |

“默认 medium”是请求意图，不能承诺所有模型都接受 medium。已知二态模型的隐式默认只发送开关，普通模型的隐式默认不发送推理参数；明确不受支持的用户配置在请求前失败。未知模型必须配置能力表。DeepSeek V4 Flash 此次真实测试显式使用其支持的 high，另用 Luna Chat 验证 medium。

实际新增入口是后端配置与 runtime `startSession`，没有扩展公开 HTTP／SDK prompt DTO 来接受每次请求的推理设置。前端接入与公开 API 如需暴露该能力，应后续单独设计。

请求参数正确发送与上游实际兑现开关语义分别验收。Luna Chat 的 `reasoning.enabled=false` 实测仍返回 reasoning 子量与原生状态，因此该路由的关闭语义不能记为通过；新增 `reasoning_effort=none` 对照已观察到关闭后推理子量 0，结果单列在 06，不据其他路由的成功代替它，也不把 harness 的续接通过扩写为全矩阵控制语义通过。

### 已验证的 Luna Chat 配置方式

对于 ZenMux 的 `openai/gpt-5.6-luna` Chat 路由，在现有对应 `models[]` profile 中设置以下能力对象；模型名、provider、endpoint、上下文窗口等原有字段继续按实际配置填写，不复制测试环境的窗口数值。

```json
{
  "reasoningCapabilities": {
    "mode": "effort",
    "wire": "openai",
    "efforts": ["low", "medium", "high"],
    "supportsDisabled": true,
    "temperature": "unsupported"
  }
}
```

`llmParams.reasoning` 可省略以采用默认 on/medium，或设置 `{ "enabled": false }` 关闭。该 profile 的 `wire: "openai"` 会发送 `reasoning_effort`，此次 medium/none 均已实网验证。不要把本次未兑现关闭语义的 `wire: "reasoning"` 作为 Luna Chat 的已验证关闭方案；这也不表示其他模型的同名网关参数都无效。

## 2. 分批实施结果

| 批次              | 交付                                                                                       | 主要验证                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| A：固定问题与合同 | 受限的自有原生状态类型、来源／版本；queued、phase、thinking、初始工具 input 等正式固定样本 | 基线 17 文件／428 项通过；新增故障样本先失败后修复。样本在正式测试文件，不依赖本机忽略目录                               |
| B：配置与参数     | 默认意图、模型能力校验、可选温度、父子与辅助请求快照                                       | 配置往返、错误配置在联网前失败、三协议请求体、并发隔离、子模型与摘要来源                                                 |
| C：协议解析       | Responses queued/phase/reasoning；Anthropic 初始 input／空 delta；Chat 必要推理字段        | SDK 消费本地 SSE，合法形状与未知项／冲突／截断负向测试                                                                   |
| D：接受与保存     | 完整流结束后形成可回放状态；状态、正文、工具、完成标记原子提交；提交后执行工具             | 提前 complete 后错误、取消、length/filter、存储失败、overflow 重试、SQLite 事务回滚／重开                                |
| E：上下文与继承   | 来源检查、保序回放、压缩单元关联、估算代理、私有投影过滤                                   | 切源、同请求估算、native 工具 prune 保护、压缩成功／失败、父子 scope、UI 隐私                                            |
| F：回归与实网     | 全仓回归、独立审查、真实 ON/OFF 请求的工具与状态续接证据                                   | 最终门禁见第 5 节；Luna Chat 关闭语义限制与对照请求逐项见 [06](./06-real-native-reasoning-validation.md)，不标全矩阵通过 |

默认开启未单独发布。A–F 的本地提交共同构成本轮交付，不能只挑 B 的配置改动上线。

## 3. 关键实现取舍

### 状态保存与 agent loop

模型返回的正文还是正文，工具还是原来的工具。新增 `model-state` Part 保存下一次请求必须带回的原生数据：Responses 密文／phase／有序 items、Anthropic thinking／签名、Chat reasoning details。它使用项目自有类型，SDK 类型留在 adapter。

Lifecycle 的调度算法没有重写，但“什么时候接受结果、什么时候保存、什么时候允许执行工具”有明确改动。临时 `llm:complete` 不是最终承诺；只有完整流通过校验后，才能提交有效状态。数据库把本次状态、可见投影、待执行工具及完成标记放进同一事务。保存失败时工具执行 0 次；已经接受的 usage/cache 不撤销也不重复计入。

同 provider、同模型、同协议、同 endpoint 的历史才回传私有状态。切源后保留可见正文与已完成工具结果；未完成的原生工具往返不能拼接到另一来源。压缩成功后整组旧状态失活，切回原模型也不复活。新的内部 Part 不投影成 UI 工具或思考文字。

### token 与 cache

供应商 output token 已包含 reasoning 子项。本轮只把 reasoning 子项作为上下文估算的材料，不再次加入实际总量，不拿它补造缺失的 usage。

不透明状态的估算优先使用明确 reasoning token（包括 0）；缺失时退到该响应 output 总量，再缺失时使用同一请求 max output。签名／密文字符长度不冒充 token 数。总 output 代理可能与正文估算有重叠，因此会保守高估、可能提前压缩；它不是费用或精确上下文统计。

缓存样本仍由 Lifecycle 接受最终 Step 后观察，累计输入和 cache read 的整数总量后求比例。恢复原生历史不触发重新记账，也没有添加持久化的 session cache 账本。换模型、压缩保留当前进程内累计；重启后 tracker 重新开始。最近缺明细不会清空已有累计。

### 真实测试推动的额外修复

| 问题                                        | 修复与证据                                                                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Luna Responses 的 done 与 terminal 密文不同 | 安装 SDK 7.13.0 明确要求回放 `output_item.done`；已有 done 密文时保留它，缺失才用 terminal 补齐。id/type/status/summary/正文冲突仍拒绝，重复 done 冲突仍拒绝                                                           |
| Luna Chat 的 reasoning index 是字符串       | 按 [ZenMux 官方示例](https://zenmux.ai/docs/api/openai/create-chat-completion.html) 支持规范十进制字符串，保留原始值；同 index 的 summary/encrypted 分开保序。任意字符串、歧义增量及后补 ID 造成的同类型身份冲突仍拒绝 |
| complete 后 overflow 被包装成连接错误       | `streamResponse` 保留既有上下文超限错误分类，交 Lifecycle 执行原有的一次强制压缩重试；只有替代成功尝试的 usage/state 被接受                                                                                            |
| finish 后出现新文字／工具                   | Chat／Anthropic 拒绝结束后的新输出；允许协议本来支持的末尾用量、关闭事件等收尾信息                                                                                                                                     |
| content_filter 后仍可能解析工具             | 不解析、不执行该工具，可信最终 usage 仍按现有位置处理                                                                                                                                                                  |
| 正文恰好为 `(Empty response)`               | 空响应改由结构上的 null 表示，正常同名字面文本不会被误删                                                                                                                                                               |

## 4. 验收项到正式测试的映射

以下路径均相对仓库根目录。表中给出实际证据入口；它不代表 04 每句描述都在真实外网复现。

| 验收项                              | 可运行证据                                                                                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01–T04：能力、合同、固定样本       | `services/interface-providers/` 的 `reasoning.unit`、`native-state.unit`、`openai-responses.unit`、两个 `*-native.integration`；完整路径位于 `packages/ohbaby-agent/src/`                                                                                   |
| T05–T09：配置、wire、继承           | `config/llm/__tests__/reasoning-config.unit`；provider 测试；`runtime/run-manager/manager.unit`、`agents/subagent-host.unit`、`core/agents/runner.unit`、`adapters/ui-runtime/reasoning-summary.integration`、标题测试                                      |
| T10–T13：协议负向边界               | 三协议 provider 测试以及 `openai-responses.integration`                                                                                                                                                                                                     |
| T14：连续工具多步                   | `tests/integration/core/native-multistep.integration.test.ts`：同 Run 两次工具执行后正文，真实 SDK＋SQLite＋Context＋Lifecycle＋scheduler，只有 HTTP/SSE 为 fake；另有真实 harness 的跨 Run 工具续接                                                        |
| T15–T18：完成、重试、保存           | provider 原生测试、`core/lifecycle/lifecycle.unit.test.ts`、`core/message/atomic-model-step.integration.test.ts`；T17 经过真实 Lifecycle→streamResponse→InterfaceProvider 边界，外部 provider 是 fake，不能称为 SDK 实网重试                                |
| T19–T23：恢复、切源、压缩、私有投影 | `core/context/native-context.unit`、`native-state.integration`、`native-policy.integration`、UI persistent 测试与真实 harness 的 SQLite 重开；T21 另由 `native-multistep.integration` 验证同 session 后续 Run 的 medium→off→high、历史回传及 tracker 不清零 |
| T24–T26：用量、估算、归属           | `core/llm-client/native-state.unit`、context native 测试、原子保存测试、`tests/integration/runtime/prompt-cache-step-accounting.integration.test.ts`、辅助用量隔离测试                                                                                      |
| T27：前序回归                       | 全仓测试，包括编译包消费者、CLI、TUI、server、SDK、原有用量和 cache 测试                                                                                                                                                                                    |
| T28：三协议 ON/medium 与 OFF        | `tests/smoke/reasoning-native.real.e2e.test.ts`；真实请求、原生续接与关闭语义分别列在 06，Luna Chat 的网关 OFF 参数未兑现不标通过                                                                                                                           |
| T29：扩展矩阵                       | 本轮实际为 ZenMux 五个参数／协议组合；官方智谱／百炼、真实子代理联网、所有档位遍历未新增复验，不标全部平台通过                                                                                                                                                          |
| T30：审查                           | 独立子代理审查及修复复验，见第 5 节                                                                                                                                                                                                                         |

SQLite 故障测试使用真实事务与注入失败，包含关闭重开后的完整性验证；未运行操作系统强杀进程／断电测试。实网使用数据库重开验证续接，没有真实触发超限压缩；自动／手动压缩、prune、估算与继承由本地真实组件集成测试验证。实网 profile 分别新建 ON 与 OFF 会话，不能把它描述为同一会话里遍历所有开关与档位。

## 5. 验证记录

最终全仓 `pnpm test`：**333 个测试文件通过，5 个文件按配置跳过；3450 项通过，16 项跳过**。其中包含单元、协议合同、真实组件集成、编译产物消费、CLI 安装包 smoke 和多进程重启测试；普通 test 未代替真实 LLM E2E。

| 检查 | 实际结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过，无错误／警告 |
| `pnpm format:check` | 通过 |
| `pnpm test` | 333 文件、3450 项通过；16 项跳过 |
| `pnpm build` | 通过，全部 workspace 包与 Web 构建完成 |
| 新 E2E harness 与多步测试专项检查 | 12 项 harness + 1 项多步集成通过，专用 tsconfig／ESLint 通过；runner 语法检查通过 |
| 三协议真实 LLM | 23 次 HTTP、20 accepted Steps；3 次解析失败保留；原生 Chat wire 的 medium/none 对照通过，generic wire 的关闭语义失败保留 |

收尾检查曾发现新增测试遗漏 `TokenUsage` 类型导入，导致编译型集成失败；已补导入并重新运行整个仓库，以上为修复后的结果。最后的 lint 修改仅显式化 null 判断、类型及测试字符串转换，之后又运行对应定向测试。真实数据逐项见 06。

独立审查实际发现并促成了 filter 工具执行、空文本哨兵、结束后新增输出等修复；修复后再次验证。overflow 修复的独立复验为 5 文件／95 项通过。最终报告审查从 8 份 JSON 重算 23 HTTP、20 accepted Step、10 次工具执行、6692/876/7568 tokens，逐行与 06 一致；代码与文档审查无剩余阻断。审查不等于所有未来模型组合都被证明兼容。

## 6. 本地提交与后续边界

本次按四组整理本地提交，依赖顺序如下；对应 A–F 的研发批次，不代表可逐个独立发布。

1. A：规划合同、用户决策与验收标准。
2. B/C：配置能力、三协议请求与原生解析、自有状态合同及对应测试。
3. D/E：最终 Step 接受、原子保存、上下文与继承、外围回归测试。
4. F：真实 E2E runner、脱敏证据、最终验收与统计报告。


- 先由用户审查本地分批提交，再决定是否合并或推送。本轮没有执行 merge/push。
- SQLite JSON 中可能新增 `model-state` Part，旧二进制不保证能读取。验证和试用应使用独立数据或先备份；回退代码不等于可直接用旧版本打开已写入新状态的数据库。
- 本轮没有新增或调整缓存策略、system prompt、TTL 或 key 策略；Anthropic 原生 thinking 块不能承载缓存标记，adapter 沿既有策略选择合法块。实网零 cache read 是观测结果，不能据此宣称缓存机制失效，也不能声称已经验证了生产环境中的非零命中。
- 未实现模型通过子代理工具自行覆盖推理强度；该后续能力需要单独明确允许的参数和覆盖优先级。
- 新模型、网关协议变化仍需要能力表与固定样本支持；本轮没有承诺完整 Responses、hosted tools、后台任务或服务端历史托管。

## 7. 独立验收（规划复查会话，2026-09-15）

对照 00/02/04 与基线 `8b546e3` → HEAD `ddcaea72`。不重跑全仓 `pnpm test`，不重跑付费实网。数字用仓库内 8 份 `evidence/real-native/*.json` 重算。

### 7.1 结论

**部分通过。** improve-5.5 的主体（默认推理意图、三协议原生状态续接、原子保存、标题关闭、子代理/压缩继承、improve-5 cache 口径保持）可以按本文和第 6 节的限制验收。不能写成全矩阵通过、全部网关关闭语义通过、或已验证非零 cache。

实网 cache read 全 0 不构成 T28/发布门失败：04 §4.7 第 5 条写明非零 cache 不是本轮承诺。用户计划另开一轮 cache 命中复测，与本轮原生续接验收分开。

### 7.2 独立核对

| 项 | 结果 |
| --- | --- |
| 06 数字 | 23 HTTP、20 accepted Step、输入 6692、输出 876、总量 7568、cache read 0、工具 10，与 8 份 JSON 一致 |
| A–F 改动面 | 落地。A 的样本落在同目录测试/smoke，未新建 `tests/fixtures/`（调整，可接受） |
| 承重契约 | 默认 on/medium 在请求 merge，不写回配置；`commitModelStep` 已接线；`onStepUsage` 仍在 aggregate 之后；UI 不投影 `model-state` |
| T28 | Responses medium/none、Anthropic adaptive medium/disabled、Chat native medium/none 有真实 reasoning/thinking 回放。Luna Chat generic `enabled=false` 仍返回推理，不标关闭通过 |
| T27 | 仅有实施会话声称的 333 文件 / 3450 项；本独立验收未复跑 |
| T29 | 仅 ZenMux 五组合；百炼/智谱未复验 |
| 越界 | 未见前端推理 UI、`previous_response_id`、hosted tools、cache key/TTL、system prompt、子代理并入主 cache |

### 7.3 规划偏差（不阻断主体）

- Part 写入顺序实际为 text → model-state → tools；02 曾写 text → 首个 tool → model-state。usage 仍只落一个 carrier，语义可接受。
- Core 依赖 `interface-providers/native-state` 的自有 Zod 合同，不是 SDK `Response` 类型泄漏；依赖方向比「协议止于 adapter」更紧，属可维护代价。
- 默认开启迫使大量无关测试补 `reasoningCapabilities` stub。

### 7.4 SWE / 架构清单（改动面）

| 发现 | 严重性 | 依据 | 建议 |
| --- | --- | --- | --- |
| 保存失败不执行工具、overflow 只留成功尝试 | 已处理 | 事务边界 / 幂等 | 保持；不要用 Set 去重第一次 complete |
| 实网 90s 超时、SDK retries=0 | 已处理 | 超时与重试纪律 | 保持 opt-in E2E |
| 未知能力请求前失败；网关忽略 OFF 已单列 | 已处理 | 降级不假装成功 | Luna Chat 生产 profile 用已验证的 `wire: openai` |
| `model-state` 不进 UI/summary | 已处理 | 私有数据不投影 | 新增 Part 分支必须继续穷举 |
| 新 Part 写入 SQLite 后旧二进制不可读 | 残余 | 单向门 | 试用独立库/备份；回退代码 ≠ 回退数据 |
| 非零 cache、同会话切档、实网压缩、百炼/智谱 | 未覆盖 | 04 已登记 | cache 另轮复测；其余保持未覆盖，不补标通过 |


## 8. 正式 Agent cache 收尾（2026-09-15，晚于第 7 节独立验收）

新增 [07 正式 Agent 缓存验证](./07-formal-agent-cache-validation.md)：生产 persistent backend / prompt / 内置工具 / SQLite / 压缩 / `/status` 全链路实网复验。Responses、Anthropic、Chat 的最终 session 累计 hit 分别为 78.25%、59.33%、55.99%；三次真实压缩成功，Chat 同会话 medium → high 及压缩继承 high 已观察。累计在压缩、切档时保持，后续零命中只增加分母。

第 6～7 节的零 cache 与未覆盖记录对应此前短续接矩阵，保留为历史，不能再用于描述 07 的新证据。供应商扩展仍有未覆盖项，Luna Chat generic OFF 限制不变，不把收尾写成全平台通过。原型控制器的入口诊断、所有新增 HTTP 和用量均在 07 单列，未合并或推送。
