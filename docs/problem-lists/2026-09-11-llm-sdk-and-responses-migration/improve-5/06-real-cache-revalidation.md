# improve-5 第二轮实网复验：换模型后，缓存数字是否仍然算对

> 实网时间：2026-09-15 10:53–10:58（UTC+8）。生产代码基线：`728d00ae`，分支 `codex/improve-5-cache-accounting`。
> 本轮重跑原有9组，新增5组；只增加测试 profile 和报告，没有修改生产统计、请求参数规则或缓存控制。第一轮结果保留在 [05 实施验收](./05-implementation-acceptance.md)。

## 先看结果

**完整矩阵14组，11组通过，3组未通过。不能说这次全绿，也不能说所有原生模型都已兼容。**

- 原来的9组仍是8组通过；百炼 Responses 的流状态校验问题再次出现。
- 新模型中，DeepSeek V4 Flash 的 Chat、Anthropic 两条链路通过，GPT-5.6 Luna 的 Chat 通过。
- Claude Sonnet 5 / Anthropic、GPT-5.6 Luna / Responses 首先都因 `temperature` 被拒绝。临时省略这个参数后又暴露了后续兼容问题，详见下文；没有把补充诊断包装成完整通过。
- 通过的11组共44次真实请求，原生用量、内部用量、最终 Step、消息记录、校准输入与累计数字均通过核对。没有发现新的缓存加总错误，但失败路径不能算作已验证完整。

你给的三个模型都已实际请求。这里使用的是 **ZenMux 转发的模型与相应协议格式**，并非直连 OpenAI/Anthropic 官方域名；也没有证据证明 ZenMux 每次具体选中了哪条下游路由。

## 命中率怎么读

本文的“命中率”沿用已经确认的含义：**同一个 session 中，可信 Step 的缓存读取 token 总和 ÷ 纳入统计的输入 token 总和**。

每个成功 profile 有4次 HTTP：

1. 独立文本 session：一次简单回答。
2. 工具 session 的第一 Run：调用一次只读测试工具。
3. 同一 Run：读取真实工具结果并回答。
4. 同一个工具 session 的第二 Run：继续一次对话。

下面汇总表统计的是后面三次请求，**没有混入独立文本 session**。因此它确实验证跨 Run 累计。输入数已经包含缓存读取和写入，不能再把缓存加到分母里；也不能直接平均三次百分比。UI 仍只显示四舍五入后的整数。

这些是短时间、固定合成长前缀下的测试会话结果，不是模型普遍性能、费用节省率或线上承诺。第一条请求可能已命中平台历史缓存，本轮没有清空平台缓存或固定其路由，不能把第一条自动称为冷启动。

## 新增模型对比

全部使用 ZenMux。

| 模型              | 调用协议           | 完整 E2E             | 纳入输入 token | 缓存读取 token | session 累计读取占比 |
| ----------------- | ------------------ | -------------------- | -------------- | -------------- | -------------------- |
| DeepSeek V4 Flash | Chat Completions   | 通过                 | 15,801         | 13,824         | 87.49%               |
| DeepSeek V4 Flash | Anthropic Messages | 通过                 | 15,765         | 14,336         | 90.94%               |
| Claude Sonnet 5   | Anthropic Messages | **未通过：HTTP 400** | —              | —              | 不可计算             |
| GPT-5.6 Luna      | Responses          | **未通过：HTTP 400** | —              | —              | 不可计算             |
| GPT-5.6 Luna      | Chat Completions   | 通过                 | 14,340         | 9,499          | 66.24%               |

“不可计算”表示默认测试链路没有形成可信累计，**不是0%**。例如 GPT 的 Chat 成功不能证明其 Responses 也成功；模型相同，接口接收的参数和返回结构仍可能不同。

模型标识核对自用户提供的页面：[DeepSeek V4 Flash](https://zenmux.ai/deepseek/deepseek-v4-flash)、[Claude Sonnet 5](https://zenmux.ai/anthropic/claude-sonnet-5)、[GPT-5.6 Luna](https://zenmux.ai/openai/gpt-5.6-luna)。本报告数字来自实际请求，不采用页面展示的平台总体命中率。

## 原有9组：上一轮和这一轮

上一轮取05中记录的独立测试会话，本轮也是新 session；此处是两次观测对比，**没有把两轮跨进程累计**。

| 平台 / 模型 / 协议            | 上一轮 | 本轮   | 本轮读取 / 纳入输入 | 本轮完整链路   |
| ----------------------------- | ------ | ------ | ------------------- | -------------- |
| ZenMux / Grok / Responses     | 66.83% | 98.11% | 14,656 / 14,939     | 通过           |
| ZenMux / DeepSeek V4.1 / Chat | 95.99% | 96.65% | 15,103 / 15,627     | 通过           |
| ZenMux / Qwen / Chat          | 88.98% | 89.02% | 15,232 / 17,110     | 通过           |
| ZenMux / Qwen / Anthropic     | 99.06% | 66.20% | 11,301 / 17,071     | 通过           |
| 百炼 / Qwen / Chat            | 89.71% | 89.63% | 15,360 / 17,137     | 通过           |
| 百炼 / Qwen / Anthropic       | 89.93% | 89.24% | 15,232 / 17,068     | 通过           |
| 智谱 / GLM / Chat             | 65.52% | 98.36% | 15,168 / 15,421     | 通过           |
| 智谱 / GLM / Anthropic        | 99.01% | 66.14% | 10,176 / 15,385     | 通过           |
| 百炼 / Qwen / Responses       | 未通过 | 未通过 | 无已接受 Step       | 状态校验仍失败 |

Qwen / Anthropic 从99.06%变成66.20%，而 GLM / Chat 从65.52%变成98.36%。这些变化本身不能证明代码变好或变坏：我们核对的是“是否忠实累计这次返回的数字”。两轮间的平台缓存、路由及生成的上下文可能不同，现有证据无法把波动归因到其中某一个原因，也不适合据此给模型排名。

## 看一次具体加总

新增且通过的三组，工具 session 的逐次数据如下。“写入未返回”仍按未知记录，不假装供应商明确返回0；读取明细完整即可统计 hit。

| 模型 / 协议                            | 请求位置                    | 输入  | 缓存读取 | 缓存写入 | 本次读取占比 |
| -------------------------------------- | --------------------------- | ----- | -------- | -------- | ------------ |
| DeepSeek V4 Flash / Chat Completions   | 第一 Run · 调工具           | 5,188 | 4,608    | 未返回   | 88.82%       |
| DeepSeek V4 Flash / Chat Completions   | 第一 Run · 读工具结果后回答 | 5,296 | 4,096    | 未返回   | 77.34%       |
| DeepSeek V4 Flash / Chat Completions   | 第二 Run · 继续对话         | 5,317 | 5,120    | 未返回   | 96.29%       |
| DeepSeek V4 Flash / Anthropic Messages | 第一 Run · 调工具           | 5,188 | 5,120    | 0        | 98.69%       |
| DeepSeek V4 Flash / Anthropic Messages | 第一 Run · 读工具结果后回答 | 5,262 | 4,096    | 0        | 77.84%       |
| DeepSeek V4 Flash / Anthropic Messages | 第二 Run · 继续对话         | 5,315 | 5,120    | 0        | 96.33%       |
| GPT-5.6 Luna / Chat Completions        | 第一 Run · 调工具           | 4,724 | 0        | 未返回   | 0.00%        |
| GPT-5.6 Luna / Chat Completions        | 第一 Run · 读工具结果后回答 | 4,781 | 4,721    | 未返回   | 98.75%       |
| GPT-5.6 Luna / Chat Completions        | 第二 Run · 继续对话         | 4,835 | 4,778    | 未返回   | 98.82%       |

例如 GPT / Chat：第一次读取为0，后两次分别读取4721、4778个 token。最后累计是 `(0 + 4721 + 4778) / (4724 + 4781 + 4835) = 66.24%`，UI 显示 `hit 66%`。后两次接近99%，不能拿最后一次的98.82%覆盖整个 session。这正是本轮在保护的统计口径。

## 三组未通过，卡在哪里

### Claude Sonnet 5 / Anthropic

主矩阵首个请求返回 HTTP 400，补充诊断确认返回原因是该模型已弃用 `temperature`。本次 harness 沿用的配置是 `temperature: 0.2`；这里不是说所有产品配置都固定为0.2。

随后只在测试包装层临时省略 temperature，保持模型、system prompt、缓存策略和统计代码不变。结果是：

- 文本请求 HTTP 200 并完成，接受的输入7933、输出41，缓存读取0、缓存写入7931；这一个文本样本为明确0%读取。
- 工具请求也返回 HTTP 200，但 Lifecycle 以 `tool_parse_failure` 结束，工具实际执行0次，未完成工具往返。
- 证据只保留了一个已接受的文本 Step。第二次没有可用于核对的完整 usage；**不能把文本的0%冒充工具 session 的最终命中率**。具体工具字段失败原因尚未定位到足够证据，不能断言是模型不会调用工具。

所以，省略 temperature 解决了第一个拒绝点，但没有让完整 E2E 通过。本轮没有顺手修改生产参数管理或工具解析器。

### GPT-5.6 Luna / Responses

主矩阵首个请求 HTTP 400，原因是该模型不支持 temperature。临时省略后，HTTP 200，但返回 message 带有现行受限 Responses adapter 不支持的 `phase`，在 `supportedItem()` 的 phase 校验处被拒绝，仍无已接受 Step。

这不是“缓存命中低”。当前 Chat 链路可用；Responses 参数与消息结构的兼容性还没有完成。本轮没有删除 phase 校验、丢弃字段后假装兼容，也没有更改 production Responses 能力范围。

### 百炼 Qwen / Responses

与第一轮一致：首次 HTTP 200 后，`response.created` / `response.in_progress` 事件的 response.status 不符合现有校验期望。没有已接受 Step。本轮仍未采集到足以说明其具体错误 status 值的证据；不能把它归因于缓存、密钥或额度。

## 测试和诊断证据

| 检查                                         | 本轮结果                                | 能证明什么                              |
| -------------------------------------------- | --------------------------------------- | --------------------------------------- |
| 统计证据 helper 单元 + 真实 runtime 统计集成 | 2文件 / 17测试通过                      | 本地统计与主子隔离回归仍通过            |
| 完整14 profile 实网矩阵                      | 15测试中12通过、3失败，exit 1           | 凭据检查通过；11个模型/协议组合完整通过 |
| 两次400原因诊断                              | 各1次HTTP，均失败                       | 确认两者拒绝temperature；未新增可信样本 |
| 两组省略temperature补充诊断                  | Claude2次HTTP、GPT1次HTTP，均未完整通过 | 定位后续失败阶段；不能提升原矩阵通过数  |

本轮合计52次 HTTP：主矩阵47次，加原因诊断2次，加参数省略诊断3次。44次属于完整通过的profile；另有Claude诊断中的1次文本请求可核对用量，但它不属于完整通过的profile。

主矩阵每组最多4次请求、SDK重试关闭，未无限重跑来追求非零命中。仅补充诊断改变测试包装层的temperature传递，并已恢复；最终仓库测试 diff 只有5个新 profile。未更改 system prompt、cache_control、key、TTL、压缩机制或生产代码。

完整实网断言覆盖生产 SDK/provider → llm-client → Lifecycle → Step观察 → tracker，以及 prepared 请求、校准和 Part。完整 UI/backend 的装配与显示由确定性集成验证；本报告不把这一实网 harness 说成浏览器端到端 UI 测试。

### 复跑主矩阵

```sh
OHBABY_REAL_MIGRATION_PROFILE= \
OHBABY_REAL_MIGRATION_PROTOCOL= \
OHBABY_REAL_MIGRATION_EXTENDED=1 \
pnpm test:cache:real:accounting
```

该命令在本轮状态下不是全绿，必须保留失败退出。单独测新模型可设置以下 profile：

```text
zenmux-deepseek-v4-chat
zenmux-deepseek-v4-anthropic
zenmux-claude-sonnet5-anthropic
zenmux-gpt56-luna-responses
zenmux-gpt56-luna-chat
```

例如：`OHBABY_REAL_MIGRATION_PROFILE=zenmux-gpt56-luna-chat pnpm test:cache:real:accounting`。

### 局部诊断的区别

省略temperature的临时实验在测试provider包装层使用以下调用，**不属于上述正式profile的默认行为**：

```ts
const wireRequest = { ...request, temperature: undefined };
const source = await stream(wireRequest);
```

诊断profile带 `-no-temperature-probe` 后缀，只存在于保存的临时harness快照，没有加入正式profile列表。快照及原文件恢复前副本保存在下述本地日志目录，可复查该实验改变了什么；正式工作文件已恢复。两组诊断都失败，未将其纳入成功命中率汇总。

主矩阵文件清单固定在 `revalidation/matrix-evidence.json`，不会被之后的诊断文件覆盖。全部日志位于 `.superpowers/sdd/02-optimization-plan-and-change-scope/improve-5-20260915/revalidation/`；逐请求数字位于 `.ohbaby/test-evidence/improve-5/real-cache/`。日志和原始数字文件被gitignore排除，本报告表格是可审查的版本化摘要。400原因日志做了凭据脱敏，报告没有包含密钥、请求正文或headers。

主矩阵采用的证据文件：

- `zenmux-deepseek-v4-chat-1789440879280.json`。
- `zenmux-deepseek-v4-anthropic-1789440897436.json`。
- `zenmux-claude-sonnet5-anthropic-1789440900587.json`。
- `zenmux-gpt56-luna-responses-1789440901971.json`。
- `zenmux-gpt56-luna-chat-1789440913962.json`。
- `zenmux-responses-1789440840409.json`。
- `zenmux-deepseek-chat-1789440850131.json`。
- `zenmux-qwen-chat-1789440951295.json`。
- `zenmux-anthropic-1789440863100.json`。
- `bailian-qwen-chat-1789440958095.json`。
- `bailian-qwen-anthropic-1789440920607.json`。
- `zhipu-glm-chat-1789440973979.json`。
- `zhipu-glm-anthropic-1789440938666.json`。
- `bailian-qwen-responses-1789440915111.json`。

## 复核与交付

独立报告审查 PASS：重新核算了11个成功组合的44次原生请求用量，逐项与已接受 Step 一致；两轮对比、跨 Run 累计和52次 HTTP 总数也已核对。另对全部18份本轮证据文件复算 session 分子、分母及比例，均与记录一致。审查通过表示报告和证据对应准确，不会把3个失败组合变成成功。

新增正式测试配置提交为 `fd0a9031`，只增加5个profile；报告与索引另作本地文档提交。提交保留 lint/typecheck hooks。所有改动仍在 `codex/improve-5-cache-accounting`，没有 merge 或 push。
