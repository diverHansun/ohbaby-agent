# GPT-6.2 Responses 缓存验收

2026-11-26。官方和 Magpie auto 的 GPT-6.2 Sol 都复现了修复前的零命中。调整后，同一模型、同一 effort、只改最后一个问题，两端均从 0 提升到 3,778 / 3,799（99.45%）。下表的百分数表示某一次请求从缓存读取的输入 token 占比。

## Responses 对照

每组使用独立的合成目录，组内复用同一前缀。六轮依次为 medium A、medium A、medium B、high B、high B、medium B。通过生产适配器及 SDK 发送流式请求，捕获最终 HTTP 请求并核对原始 SSE usage 和 ohbaby 的计数。修复前后的组各自从新前缀开始。

| 路径和模型 | 同档重发 | 同档换题 | 首次 high | 重发 high | 切回 medium |
| --- | ---: | ---: | ---: | ---: | ---: |
| 官方 GPT-6.2 Sol | 99.92% | 99.45% | 0% | 99.92% | 99.92% |
| Magpie auto GPT-6.2 Sol | 99.92% | 99.45% | 0% | 99.92% | 99.92% |
| 官方 / Magpie auto GPT-6.2 Astra | 99.92% | 99.45% | — | — | — |
| 官方 GPT-6.1 Sol | 99.92% | 99.45% | 0% | 99.92% | 99.92% |
| 官方 GPT-6.1 Terra / GPT-6 Astra | 99.92% | 99.45% | — | — | — |

保留实际历史、逐次追加 A 到 F 六个问题再测。官方及 Magpie auto Sol 首次切高档都读到 0；下一轮分别读到 3,878 / 3,909 和 3,879 / 3,910。切回 medium 后，两端都复用了 97.79% 的输入。顶层 effort 确实随请求改变。[官方切档规则](https://developers.openai.com/api/docs/guides/prompt-caching#change-reasoning-effort-without-rewriting-the-prefix)

单独指定 Magpie 的 codex/GPT-6.2 Sol 路由，修复后两组同档换题分别读到 0 / 8,157 和 4,224 / 8,160，原布局对照为 4,224 / 8,157。完整重发最高读到 8,064，追加历史实验切到 high 后连续三轮读到 0（含最后一次切回 medium）。该路由上游读数波动，样本无法确定原因，也无法证明这一路由的收益。

## Chat Completions 与 Anthropic Messages

| 路径和模型 | 同档重发 | 同档换题 | 新档首次 | 新档重发 |
| --- | ---: | ---: | ---: | ---: |
| Magpie GPT-6.2 Sol Chat | 99.92% | 99.45% | 0% | 99.92% |
| Magpie Claude Sonnet 5.5 Messages | 92.01% | 89.58% | 91.99% | 92.04% |
| 官方 GPT-6.1 Sol Chat（纯文本） | 99.92% | 99.45% | 0% | 99.92% |
| Zenmux Luna Chat / Responses | 99.94% | 99.66% | 0% | 99.94% |
| DeepSeek Flash Chat / Responses / Messages | 95.75%–95.90% | 95.75%–95.90% | 0% | 95.75%–95.90% |
| Zenmux Sonnet 5 Messages | 99.98% | 0% | 0% | 99.98% |
| 智谱 GLM-5.3 Flash Chat | 99.86% | 0% | — | — |
| 阿里云 Qwen3.8 Flash Chat | 91.44% | 91.44% | — | — |
| 阿里云 Qwen3.8 Flash Messages | 92.12% | 92.12% | 91.49% | 91.49% |

智谱与阿里云的 Chat 测试配置使用二元 thinking。DeepSeek 从 low 切到 high，其余有档位的组从 medium 切到 high。表中档位取自实际请求字段。阿里云 Messages 从首轮就上报 5,120 个缓存 token，不能把每组第一轮都当成零命中。Anthropic 的总输入量包含缓存读取、写入和未缓存三部分。

Zenmux Sonnet 和智谱 GLM 在替换末问时均读到 0。保留模型的真实回答并追加新问题后，Sonnet 连续两轮都达到 99.70%，智谱分别达到 99.45% 和 99.14%。这两种操作在实际会话中会产生不同的缓存结果。

## 工具往返与自动化

官方和 Magpie auto Sol 都完成了两轮真实工具调用。第一轮请求 lookup，第二轮提交对应 call ID、随机工具结果及临时 system 指令，模型准确返回该结果。第二轮两端均读到 3,918 / 3,968（98.74%）。初版验收脚本把可选的 nativeOutput 当成必有字段，在两次第一轮调用后提前退出。修正脚本后用工具流事件完成验收。带加密 reasoning 的原生回放由 SDK SSE 回归测试单独覆盖。

原实现运行新的投影用例，两个规范模型的断言失败。修复后 Responses 单测 237 项通过。项目全量测试 9,183 项通过，28 项按配置跳过。针对最终补充的去重断言另行重跑了 Responses 单测。类型检查、完整构建、改动文件 ESLint 和 Prettier 检查通过。代码变更集中在 Responses 序列化器，无数据库迁移。

[147 次缓存对照请求的逐轮数据](cache-requests.csv) 包含改前对照、重复、换尾、切档和自然多轮；另有上文的四次正式工具往返请求。缓存样本均为 HTTP 200 且返回预期答案。缺失计数留空。CSV 的 layout 在官方和 Magpie Responses 行记录首条输入角色，清单兼容端点记录其指令布局。实验覆盖请求链路，未测试浏览器界面。

## 审查结论

方案和代码均由 Magpie 上的 Claude Opus 5.5 high 与 Gemini 4 Neon high 审查。已补入连续 system、只含一条基础指令时顶层字段省略、原生工具回放及实际换尾的检查。两位评审均同意合并。模型适用范围为 GPT-6.2 Sol、Astra 的规范名称和带路由前缀的规范名称。日期快照、私有别名和未来模型继续使用既有投影。
