# 目录档位与三种协议的实机验收

2026-11-24，ohbaby 0.1.20 工作树，本机 Magpie 0.1.4758，273 个模型。隔离测试使用独立目录、数据库和端口。凭据取自本机配置。下面的 HTTP 成功均另核对了模型答案。

## Magpie 的配置与结果

用 Computer Use 逐项查看原生客户端「网关 → 接入」。Chat Completions 与 Responses 给出的 Base URL 都是 `http://127.0.0.1:3425/v1`，Anthropic 给出 `http://127.0.0.1:3425`。三者都读取 `/v1/models`。初测误将 Anthropic 的 Base URL 也填为带 `/v1` 的地址，SDK 实发 `/v1/v1/messages` 收到 404。用面板给的根地址重测成功，产品沿用 SDK 的地址拼接。

在隔离配置中用设置服务创建每个入口，再用内置浏览器为独立会话选模型、选档和发送。以下为带工具声明的 agent-step 真实出站请求。标题请求另计。

| 模型 | 实际路径 | Web 所选及实际发送 | 结果 |
| --- | --- | --- | --- |
| auto/gpt-6.1-sol | /v1/chat/completions | ultra → reasoning_effort=ultra | 两次 HTTP 200，读取随机文件，再回答文件内容 |
| auto/gpt-6.1-sol | /v1/responses | ultra → reasoning.effort=ultra | 工具与续答均为 200。两次 response.completed 均回报 max，Web 返回正确文件内容 |
| auto/gpt-6.1-sol | /v1/messages | ultra → output_config.effort=ultra | 工具与续答均为 200，Web 返回正确文件内容 |
| auto/gemini-4-carbon | /v1/chat/completions | high → reasoning_effort=high | 返回 391，设置页 Detect again 后仍可选 low、medium、high |
| auto/gemini-4-neon | /v1/responses | xhigh → reasoning.effort=xhigh | 返回 391，目录为 low、medium、high、xhigh |
| auto/deepseek-v4.1-flash | /v1/messages | max → output_config.effort=max | 返回 391，目录仅 low、high、max |

GPT 三个入口均发现六个档位。各入口的来源均为 model-metadata。保存和重测时，测试观察器只收到目录 GET。三个 GPT 会话各产生一条工具结果，读取同一份临时文件，最终回答均为 `CHECK-2f0b7af9`。刷新后仍显示 ultra。HTTP 出站时未降档；这次 Chat 和 Messages 响应没有提供可核对的上游档位。载入同一隔离配置重启后仍可选择目录档位。打包后的 CLI 也在独立配置下复跑这六组，均取得相同答案。GPT Chat 和 Messages 的第一次 CLI 补测触发了日常环境中的技能许可，重跑时隔离了旧配置的 home 回退路径。

## Thinking 的观察

- Chat Carbon 的 auto 路由在发出请求后约 13.0 秒返回 reasoning，14.3 秒返回答案。另一次高档 `agy-cli/gemini-4-carbon` 会话中，内置浏览器两次观测到可见 reasoning 段增长，相隔约 13.8 秒，两次均有 Stop run，均尚无最终答案。这条长题的检查在后续 bash 工具申请许可时结束；另一次短题已核对最终答案 43。截图侧栏的历史列表加载提示来自隔离验收环境；会话刷新和回答单独核对。[运行中截图](web-thinking.jpg)
- Responses Neon 本次只观察到答案文本。GPT Responses 的工具请求观察到 reasoning 事件，DeepSeek Messages 的回答观察到 13 个 thinking 增量。当前这两个协议适配器处理原生推理状态，但没有将这些增量投递为 Web 使用的 `reasoningTextDelta`。因此，上游发出 thinking、客户端可选 effort 和页面显示 reasoning 是三个可分别验证的行为。本次只观察展示。后续若要支持，可从协议适配器按已公开文本生成展示增量，再验证签名、密文和重放状态不会进入 UI。

## 清单中的直连端点

从 `tests/models-4-tests.md` 和仓库现有 smoke 配置取 18 个模型/协议组合，用本机 .env 凭据走元数据发现、已有内置能力或主动探针，再通过 ohbaby 的 SDK 适配器真实流式发送算题，检查最终答案 42。直连这里验证 provider 的请求与解码，完整 Web/工具循环见上表。

| 供应商 | 清单模型和入口 | 结果 |
| --- | --- | --- |
| Zenmux | DeepSeek V4.1 Flash 三入口、Claude Sonnet 5 Messages、GPT 5.6 Luna Chat / Responses | 6/6。DeepSeek Responses 接受无效探针，按既有规则使用服务默认；省略空 annotations 的文本能完整解码 |
| 智谱 | GLM 5.3 Flash Chat | 1/1。探针发现 low/high/max，发送 low。第一次 200 无最终答案，明确要求心算并放宽输出预算后返回 42 |
| DeepSeek | deepseek-flash、deepseek-v4-pro 各三入口 | 6/6。Messages 的模型目录请求返回 HTTP 错误，主动探针仍取得档位，正式请求成功 |
| OpenAI | GPT 6.1 Terra、6.1 Sol、6 Astra 的 Responses | 3/3。均主动发现档位，发出 medium，返回 42 |
| 阿里云 DashScope | Qwen 3.8 Flash Chat / Messages | 0/2。本机直连与系统代理复试均未取得 HTTP 响应，出现连接重置或超时。四个当时的 DNS 地址分别测试也未建立可用连接，未验证模型侧结果 |

## 回归及评审

Pi 使用 magpie/auto/gemini-4-neon、high 参与 LLM 层实现，并审查完整 diff。按评审精简了序列化测试，保留同路由已确认的 Off。简写只能提供正向强度，完整能力明确修改 Off 或连接变化时才更新这一结论。映射只读取自有属性，扩展档名可与 Object 原型成员同名。

真实往返曾暴露两个接收侧错误。Responses 续答中网关明确回报 store=false 并附上自身的 previous_response_id，ohbaby 仍发送完整历史，接收方可以读取结果。Messages 可能给出没有签名的 thinking 块，允许普通文本或工具块完成，续接只重放可用块。仅有无签名思考、签名块与残缺块混杂、重复或冲突签名仍有失败保护。

最终全量 `pnpm test` 通过 9135 项，跳过 30 项。`pnpm typecheck`、`pnpm lint` 和 `pnpm build` 成功。全库 lint 仍有 272 条警告。本次变更的 TS/TSX 通过 Prettier 检查。全库 `format:check` 另报告三个未改文件（prompt-assets.unit.test.ts、openapi.ts、activity-mark.ts）的既有格式差异。
