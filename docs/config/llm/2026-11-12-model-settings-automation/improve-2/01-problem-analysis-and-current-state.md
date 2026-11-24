# 现状与复现证据

代码基线 `bf1cd163`。首轮已经交付保存后自动探测、主动兜底和设置页刷新。此次漏识别发生在获取模型目录之后、决定是否发送生成探针之前。

| 环节 | 当前实现与结果 |
| --- | --- |
| 获取目录 | `packages/ohbaby-agent/src/config/llm/context-window-probe.ts` 的 `probeContextWindow` 按协议构造 URL 和认证头，支持翻页，以完整模型 ID 匹配条目。上下文和 reasoning 共用一次读取。 |
| 解释条目 | 当前识别通过校验的 `reasoningCapabilities` 或 `reasoning_capabilities`，也处理 `reasoning: false`。本机目录的两种档位数组被跳过。Carbon 的上下文被正确识别为 1,048,576。 |
| 决定兜底 | `apply-active-model-config.ts` 的发现流程处理手动/内置来源、已缓存结果、强制重测及失效请求。缺少有效能力时，`reasoning-active-probe.ts` 会带工具和非法档位发送请求。两条 Gemini Chat 路由均返回 200，探针提前报告 `ignored-reasoning`。 |
| 设置和发包 | `reasoningCapabilityView` 向设置与会话菜单提供有效档位。缺能力时 `resolveRequestReasoning` 走 service-default，Chat 序列化时省略 effort。原请求成功与设置中无档位并存。 |
| 真实表现 | 两条路由在显式 high 下均完成 Chat 请求并在 Magpie 用量记录留下 high。Carbon 原回复保存了 1,137 字符的推理摘要，可由 Web 的 Total 28s → Thought 展开。实时分批到达取决于网关调度，与发现档位是两个独立观测。 |

**三种协议的约束。** `packages/ohbaby-llm/src/providers/reasoning.ts` 管理来源、有效能力、排序和序列化。Chat 使用开放字符串，现有默认菜单排序识别六档；`openai-responses.ts` 在最终发包前检查固定枚举；`anthropic.ts` 的 adaptive 分支支持五档。目录描述同一个模型，三个入口能发送的集合可以不同。已有手动配置还能表达自定义排序、预算、开关和 wire，这些信息在两个简写数组里都不存在。

**已有测试的边界。** `reasoning-discovery.unit.test.ts` 覆盖精确匹配、完整能力对象、翻页、布尔值和异常。`model-entry-probe.integration.test.ts` 覆盖主动发现及状态。已有真实模型集验证了特定端点，未覆盖「目录明确列档 + 非法值也返回成功」的网关组合。详见[本轮验收](04-test-and-acceptance.md)。

**扩展档位有第二处阻断。** 本机网关目录明确列出 ultra，三种入口都接受它。绕过发现流程，直接向 ohbaby 提供带 ultra 的完整能力后，解析器能选中它，但 Responses 的 `buildRequestParams` 在发包前拒绝，HTTP 请求计数为零。仅改目录解析会把这个错误推迟到用户按下发送之后。详见[真实对照](03-reference-projects.md)。

外部字段由探测器解释，有效档位由配置和协议层裁定。设置与会话可以复用同一能力，发送器只负责把已获准的值放到对应字段。关联[首轮契约](../improve-1/02-optimization-plan-and-change-scope.md)与[配置数据模型](../../data-model.md)。
