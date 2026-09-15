# 6. 三协议原生推理真实续接验证

> 日期：2026-09-15（Asia/Taipei），实际运行 16:30–16:52。分支 `codex/improve-5.5-reasoning`，测试时 HEAD `8b546e3b8ea8870d4cca79a0c030ad60eecacb2d` 加本轮工作区实现。所有请求均通过 **ZenMux 网关**，不是直连 OpenAI/Anthropic 原厂。本文记录 F 的真实请求证据；全仓验收见 05。

## 6.1 结论与范围

共发出 **23 次生成 HTTP 请求**，均返回 HTTP 200；其中 3 次在流解析阶段失败、没有 accepted Step，20 次完成生产运行时接受、工具往返和 SQLite 重启续接。五组完整矩阵均通过文本、工具、usage、持久化与原生状态回放断言，其中 Luna Chat 的 generic wire 组存在下述关闭语义失败；三个协议均取得真实 reasoning/thinking，不是仅凭 phase 或 HTTP 200 判断。

必须保留一个平台行为限制：**Luna Chat 的 generic OFF 请求已发送 `reasoning.enabled=false`，但网关仍报告 56、17 个 reasoning tokens，并返回 reasoning summary/encrypted 状态。** 随后的独立 native wire 对照使用 `reasoning_effort=none`，实际观察到 0、0 个推理 tokens 且没有新增原生 reasoning；ON medium 则取得真实 encrypted 状态并回放成功。不能将旧 generic 组报告的 `passed=true` 扩大解释为上游关闭语义已兑现；该报告保留原观察，新的 harness 已把 runtime 成功与 OFF 语义失败分开。Luna Responses、Claude Anthropic、DeepSeek Chat 的 OFF 也均报告推理子量 0。

本轮累计 accepted 输入 6692、输出 876、总量 7568 tokens；输出已包含推理子量，不再重复相加。**另 3 次失败请求的供应商最终 usage 未取得，消耗未知，7568 不是全部 23 次请求的计费总量。** 失败报告里的 `testAcceptedUsage=0` 只表示 accepted Step 集合为空。

**本次 ZenMux Luna Chat 配置应显式使用 `reasoningCapabilities.wire="openai"`，发送 `reasoning_effort=medium/none`。** 这是官方参数与真实对照支持的已知 profile；不要把 generic `enabled=false` 样本当作关闭成功，也没有把 ZenMux 模型别名猜测加入生产默认解析器。

所有成功步骤的已知 cache read 都是 0；本次测试加权读取比例为 0/6692 = 0%。这些短续接输入可能未达模型的缓存门槛，不能由此判定缓存机制失效，也没有为等非零命中追加请求。

## 6.2 运行组件、配置和能力依据

Harness 使用真实 `Lifecycle`、`ContextManager`、`createMessageManager` + SQLite store、工具 scheduler、生产 SDK/adapter 和 `createPromptCacheUsageTracker`。网络捕获只被动读取请求与响应，不改响应 phase、status、reasoning 或工具参数。系统提示、memory 和本地 token counter 为确定性测试输入；此矩阵不触发 summary/compaction。

每个模式使用独立 session：首个 Run 请求一次无参数工具，实际执行后由 `shouldStopAfterTurn` 停止；关闭并重开 SQLite，创建新的 manager/context/tracker，再由下一条用户消息启动第二个 Run，回传此前的工具调用、结果及原生状态并生成正文。每模式正好两次 HTTP、一个实际工具执行；五组共十个工具往返、十次 SQLite 重开。新 tracker 初始为空是既有产品行为，不是恢复失败。

| Profile                           | 模型/协议                               | ON wire                                                  | OFF wire                    | 能力来源                                                                                                                                                             |
| --------------------------------- | --------------------------------------- | -------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zenmux-gpt56-luna-responses`     | `openai/gpt-5.6-luna` / Responses       | `reasoning.effort=medium`                                | `reasoning.effort=none`     | [OpenAI 模型](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、[ZenMux 路由](https://zenmux.ai/openai/gpt-5.6-luna)                                      |
| `zenmux-claude-sonnet5-anthropic` | `anthropic/claude-sonnet-5` / Anthropic | `thinking.type=adaptive` + `output_config.effort=medium` | `thinking.type=disabled`    | [Sonnet 5 变化](https://platform.claude.com/docs/en/docs/about-claude/models/whats-new-sonnet-5)、[ZenMux 路由](https://zenmux.ai/anthropic/claude-sonnet-5)         |
| `zenmux-deepseek-v4-chat`         | `deepseek/deepseek-v4-flash` / Chat     | `reasoning={enabled:true,effort:high}`                   | `reasoning={enabled:false}` | [ZenMux 模型能力](https://zenmux.ai/deepseek/deepseek-v4-flash)                                                                                                      |
| `zenmux-gpt56-luna-chat`          | `openai/gpt-5.6-luna` / Chat            | `reasoning={enabled:true,effort:medium}`                 | `reasoning={enabled:false}` | [OpenAI 模型端点/档位](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、[ZenMux Chat API](https://zenmux.ai/docs/api/openai/create-chat-completion.html) |
| `zenmux-gpt56-luna-chat-native`   | 同一模型 / Chat native wire 对照        | `reasoning_effort=medium`                                | `reasoning_effort=none`     | [ZenMux Chat API 的 reasoning_effort 定义](https://zenmux.ai/docs/api/openai/create-chat-completion.html)                                                            |

[ZenMux reasoning 参数文档](https://zenmux.ai/docs/guide/advanced/reasoning.html) 是网关 wire 映射依据。DeepSeek 文档仅支持 high/max，本次没有伪造 medium 映射；另加 Luna Chat medium 样本覆盖这一协议的 medium 请求。实网配置显式选择 medium/high；缺少配置时自动选择默认 on/medium 由固定 unit/integration 验证，不能用此显式配置矩阵代替默认初始化测试。

所有 profile 省略 temperature，`maxTokens=4096`，SDK retries=0，单次 HTTP 超时 90 秒。Responses 使用 `store=false`。基础预算每 profile 四次 HTTP，失败诊断与 native wire 对照另经主任务放行；Luna Responses 总五次，Luna Chat generic 总六次，native wire 对照四次，其他各四次。追加对照用于验证关闭语义，不用于追求非零 cache；23 次后停止。测试 profile 没有修改用户的生产配置。真实测试期间未提交；完成后的本地提交安排见 05，未 merge/push。

## 6.3 23 次请求明细

“工具”是本次响应触发的真实执行次数。`R` 为供应商的 reasoning/thinking 子量，已包含于输出；cache read 单列。`—` 表示该失败请求未取得可信最终用量，不能填 0。所有下表 HTTP 状态均为 200。

| #   | 组合/模式                 | 阶段         | accepted | 输入 | 输出 | 总量 | R   | cache read | 工具 | 结果                            |
| --- | ------------------------- | ------------ | -------- | ---- | ---- | ---- | --- | ---------- | ---- | ------------------------------- |
| 1   | Luna Responses / ON       | 初次失败     | 0        | —    | —    | —    | —   | —          | 0    | terminal ciphertext 冲突        |
| 2   | Luna Responses / ON       | 工具         | 1        | 135  | 69   | 204  | 50  | 0          | 1    | 通过                            |
| 3   | Luna Responses / ON       | 重启续接     | 1        | 254  | 20   | 274  | 9   | 0          | 0    | 通过                            |
| 4   | Luna Responses / OFF      | 工具         | 1        | 135  | 17   | 152  | 0   | 0          | 1    | 通过                            |
| 5   | Luna Responses / OFF      | 重启续接     | 1        | 202  | 9    | 211  | 0   | 0          | 0    | 通过                            |
| 6   | Claude Anthropic / ON     | 工具         | 1        | 569  | 173  | 742  | 141 | 0          | 1    | 通过                            |
| 7   | Claude Anthropic / ON     | 重启续接     | 1        | 811  | 20   | 831  | 0   | 0          | 0    | 通过                            |
| 8   | Claude Anthropic / OFF    | 工具         | 1        | 569  | 31   | 600  | 0   | 0          | 1    | 通过                            |
| 9   | Claude Anthropic / OFF    | 重启续接     | 1        | 669  | 20   | 689  | 0   | 0          | 0    | 通过                            |
| 10  | DeepSeek Chat / ON high   | 工具         | 1        | 438  | 131  | 569  | 99  | 0          | 1    | 通过                            |
| 11  | DeepSeek Chat / ON high   | 重启续接     | 1        | 616  | 51   | 667  | 43  | 0          | 0    | 通过                            |
| 12  | DeepSeek Chat / OFF       | 工具         | 1        | 359  | 31   | 390  | 0   | 0          | 1    | 通过                            |
| 13  | DeepSeek Chat / OFF       | 重启续接     | 1        | 436  | 7    | 443  | 0   | 0          | 0    | 通过                            |
| 14  | Luna Chat / ON            | 初次失败     | 0        | —    | —    | —    | —   | —          | 0    | reasoning detail index 类型被拒 |
| 15  | Luna Chat / ON            | 单次结构诊断 | 0        | —    | —    | —    | —   | —          | 0    | 确认 index 为 string            |
| 16  | Luna Chat / ON medium     | 工具         | 1        | 135  | 51   | 186  | 32  | 0          | 1    | 通过                            |
| 17  | Luna Chat / ON medium     | 重启续接     | 1        | 236  | 20   | 256  | 9   | 0          | 0    | 通过                            |
| 18  | Luna Chat / OFF 请求      | 工具         | 1        | 135  | 75   | 210  | 56  | 0          | 1    | 续接通过；仍有推理              |
| 19  | Luna Chat / OFF 请求      | 重启续接     | 1        | 260  | 28   | 288  | 17  | 0          | 0    | 续接通过；仍有推理              |
| 20  | Luna Chat native / medium | 工具         | 1        | 135  | 76   | 211  | 57  | 0          | 1    | 通过                            |
| 21  | Luna Chat native / medium | 重启续接     | 1        | 261  | 21   | 282  | 10  | 0          | 0    | 通过                            |
| 22  | Luna Chat native / none   | 工具         | 1        | 135  | 17   | 152  | 0   | 0          | 1    | 通过；无新增推理                |
| 23  | Luna Chat native / none   | 重启续接     | 1        | 202  | 9    | 211  | 0   | 0          | 0    | 通过；无新增推理                |

## 6.4 原生状态与统计对账

| 完整矩阵         | accepted 输入/输出/总量 | ON 原生状态                   | 重启后回放                                            | 四步测试 cache read |
| ---------------- | ----------------------- | ----------------------------- | ----------------------------------------------------- | ------------------- |
| Luna Responses   | 726 / 115 / 841         | reasoning + encrypted content | 整项 SHA-256 一致                                     | 0 / 726 = 0%        |
| Claude Anthropic | 2618 / 244 / 2862       | thinking + signature          | 整块 SHA-256 一致                                     | 0 / 2618 = 0%       |
| DeepSeek Chat    | 1849 / 220 / 2069       | `reasoning` 字段              | 字段内容 SHA-256 一致                                 | 0 / 1849 = 0%       |
| Luna Chat        | 766 / 174 / 940         | reasoning.encrypted detail    | detail SHA-256 一致；OFF 也保真回传上游实际返回的状态 | 0 / 766 = 0%        |
| Luna Chat native | 733 / 123 / 856         | reasoning.encrypted detail    | detail SHA-256 一致；OFF 无新增原生状态               | 0 / 733 = 0%        |

原生状态保存在模型专用状态中，不把密文或签名转成用户正文。五组均核对每个被接受 assistant 的唯一 usage carrier、工具 call/result ID 关联、重启前后持久化状态一致，以及下一次实际 HTTP body 中的状态顺序/指纹。初始空工具对象通过生产 adapter 解析后实际执行。

每步独立核对原始 usage 与 accepted Step 的输入、输出、总量和 cache 明细。Anthropic message_start 的初始输出计数不再与 message_delta 的最终计数相加。Chat 没有 cache write 明细，`observed.cacheWrite=false`，不是已观察到写入量 0。

生产 tracker 的重启前/后值分别如下。每格为 accounted input / cache read；所有比例 0%。后列只含重启后的第二个 accepted Step，不是整个 session 的持久累计。

| 组合             | ON 重启前 | ON 重启后 | OFF 重启前 | OFF 重启后 |
| ---------------- | --------- | --------- | ---------- | ---------- |
| Luna Responses   | 135 / 0   | 254 / 0   | 135 / 0    | 202 / 0    |
| Claude Anthropic | 569 / 0   | 811 / 0   | 569 / 0    | 669 / 0    |
| DeepSeek Chat    | 438 / 0   | 616 / 0   | 359 / 0    | 436 / 0    |
| Luna Chat        | 135 / 0   | 236 / 0   | 135 / 0    | 260 / 0    |
| Luna Chat native | 135 / 0   | 261 / 0   | 135 / 0    | 202 / 0    |

## 6.5 真实失败、修复与证据

1. Luna Responses 首次流中 `output_item.done` 与 `response.completed` 的 encrypted content 不同。原 parser 将密文当内容身份而拒绝。依据已安装 OpenAI SDK 7.13.0 对 replay 使用 completed `output_item.done` 内容的声明，修复后保留 done 密文，缺少时才允许 terminal 补全；身份、文本、顺序与重复 done 冲突检查仍保留。重跑两个 ON 响应均实际观察到同 id/projection、不同 done/terminal 密文 hash，完整续接通过。
2. Luna Chat 首次及单次诊断因 string index 被拒。诊断只保留类型，确认不是 null；随后只读找到 [官方 Chat 示例](https://zenmux.ai/docs/api/openai/create-chat-completion.html) 的 `index:"0"`。生产修复有界接受规范非负十进制字符串，保留原始 wire 值，并允许同一 reasoning index 下不同 summary/encrypted 类型。最终实网记录 string、length=1、canonicalDecimal=true、value=0，也观察到同 index 的 summary 与 encrypted。任意字符串、null 和歧义 partial delta 未被泛化放开。

八份证据在仓库内保留，便于独立审阅：

| 请求范围 | 脱敏 JSON                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------ |
| 1        | [Luna Responses 初次失败](./evidence/real-native/zenmux-gpt56-luna-responses-1789461039257.json)       |
| 2–5      | [Luna Responses 完整矩阵](./evidence/real-native/zenmux-gpt56-luna-responses-1789461309055.json)       |
| 6–9      | [Claude Anthropic 完整矩阵](./evidence/real-native/zenmux-claude-sonnet5-anthropic-1789461372744.json) |
| 10–13    | [DeepSeek Chat 完整矩阵](./evidence/real-native/zenmux-deepseek-v4-chat-1789461469256.json)            |
| 14       | [Luna Chat 初次失败](./evidence/real-native/zenmux-gpt56-luna-chat-1789461549710.json)                 |
| 15       | [Luna Chat 单次诊断](./evidence/real-native/zenmux-gpt56-luna-chat-1789461837831.json)                 |
| 16–19    | [Luna Chat 完整矩阵](./evidence/real-native/zenmux-gpt56-luna-chat-1789462027473.json)                 |
| 20–23    | [Luna Chat native wire 对照](./evidence/real-native/zenmux-gpt56-luna-chat-native-1789462331443.json)  |

复制前检查了实际环境/.env 中配置的敏感值、Authorization/apiKey/message 等私有字段及 payload 结构；未发现泄露。报告仅保留参数、状态、数字 usage、受控错误、字段类型/长度/hash。原始密文、签名、推理文本、请求提示、密钥和 SQLite 数据库未复制。早期失败流未取到最终 usage，其空证据不被补写为供应商 0 用量。

## 6.6 可重放命令与验收界限

```bash
# 不调用真实 LLM：
node scripts/run-real-native-reasoning.mjs --list
pnpm exec vitest run tests/integration/reasoning-native-harness.integration.test.ts
pnpm exec tsc -p tests/smoke/reasoning-native.tsconfig.json --pretty false

# 显式真实请求：每个命令是独立的四次 HTTP 矩阵
node scripts/run-real-native-reasoning.mjs --run --profile=zenmux-gpt56-luna-responses
node scripts/run-real-native-reasoning.mjs --run --profile=zenmux-claude-sonnet5-anthropic
node scripts/run-real-native-reasoning.mjs --run --profile=zenmux-deepseek-v4-chat
node scripts/run-real-native-reasoning.mjs --run --profile=zenmux-gpt56-luna-chat
node scripts/run-real-native-reasoning.mjs --run --profile=zenmux-gpt56-luna-chat-native

# 只有明确诊断授权才调用；最多一次 HTTP，不代表矩阵通过
node scripts/run-real-native-reasoning.mjs --run --diagnose --profile=zenmux-gpt56-luna-chat
```

最后本地 harness fake smoke 12/12，通过真实 SDK + 生产 runtime/store/context/tracker；包括 native wire medium/none 请求断言，以及 runtime 成功但 OFF 仍报推理时整体判失败的保护。专属 TypeScript/ESLint 验证通过。添加最后对照前，修复后的 provider + harness 联合测试 14 files / 399 tests 通过，实网测试入口始终独立 opt-in。以上不替代 05 中的 T27 全仓结果。

T28 由 Luna Responses medium/none、Claude Anthropic adaptive medium/disabled、Luna Chat native medium/none 取得三协议完整证据，包括真实目标状态回传与 OFF 子量 0；DeepSeek high 是额外第三方兼容样本。Luna Chat generic wire 的关闭语义失败保留，不称所有网关映射都关闭成功。

两种 Chat wire 使用同一模型、同一生产流程和同一合成任务，但独立 session、顺序运行，因此只能得出本次 `reasoning_effort=none` 有有效关闭证据，而 `reasoning.enabled=false` 没有；不能据此推断所有网关/模型的通用策略。对照未修改生产 resolver 默认，只在显式测试 profile 选择已存在的 `wire:"openai"` 映射。

本次不声称覆盖实网压缩、同一会话 on→off→on 或 medium→high、第三个独立用户 Run、百炼 Qwen/智谱 GLM、原厂直连和非零 cache；这些与既有固定测试或未执行候选分别记录。
