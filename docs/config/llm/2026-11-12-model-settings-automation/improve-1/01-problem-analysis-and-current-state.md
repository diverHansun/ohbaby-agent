# 现状、证据与问题

调查日期：2026-11-12。源码基线：`b8d5fc67a0bf61a62a398bcd511b2aef670c4621`。以下路径相对于仓库根目录，行号为本次调查快照；定位优先使用符号。产品代码未改动。

## 1. 核心问题

| ID | 已证实问题 | 对应方案 |
| --- | --- | --- |
| P1 | 8192 输出默认值与 128000 上下文默认值散布在配置投影和模型预算层 | 02 §2、§3 |
| P2 | 后端有效值、用户填写值和探测值混用；已填数字不能清空 | 02 §3、§4 |
| P3 | Save 只做 metadata GET，缺少必要时的主动 effort 探测 | 02 §5、§6 |
| P4 | Context 手动覆盖没有持久优先级，旧探测结果与新配置可能竞争 | 02 §3、§5 |
| P5 | Settings 与 composer 状态投影不一致，部分失败路径不发布结束通知 | 02 §5、§7 |
| P6 | 旧数字缺少来源信息，分不清是默认值、检测值还是手填值，只能按约定规则一次性迁移 | 02 §8 |
| P7 | Responses 的 `max`、Anthropic 的 `minimal` 可进入探测能力结果，正式请求序列化却拒绝，存在“可选但不能发送”的档位 | 02 §6.4；Responses 已确认 D9，Anthropic 已确认 D10 |

## 2. 配置与运行层

### 职责与结构

`config/llm` 管理模型条目、凭证引用、持久化和发现任务；`services/llm-model` 计算能力视图与上下文预算；`ohbaby-llm` 负责解析后的请求配置与协议序列化。主、子代理消费同一运行模型快照。

- `packages/ohbaby-agent/src/agents/subagent-host.ts:576`、`:620`：子代理继承父执行的 RunModel。
- `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:1026`：优先使用父执行捕获的模型。
- `packages/ohbaby-llm/src/client/streaming.ts:348`：单次请求覆盖优先于 prepared settings 和 client 配置。

因此输出上限是每次请求的限制，并不是整项任务的累计额度。设置改变不保证影响已经开始的 run。

### 数据与预算

`services/llm-model/modelProfiles.ts:1`、`:2` 默认使用 128000 和 8192；`config/llm/model-document.ts:17`、`:70` 也分别定义或补齐默认值。`writer.ts:569`、`apply-active-model-config.ts:540` 等路径还有相同补值。

`ModelEntry` 目前继承 `ModelJsonModelProfile`，其 `contextWindowTokens` 必填；`LLMConfig.maxTokens` 和 provider request 的 maxTokens 也必填。现有模型文档只存一个 context 数字，没有长期的 user/detected/default 来源。

`services/llm-model/modelProfiles.ts:126` 的预算公式是：

```text
输入预算 = max(0, contextWindowTokens - reservedOutputTokens - safetyMarginTokens)
```

其中普通输出预留来自实际配置的 max output。提高输出默认值会改变压缩阈值，不能只改表单或 HTTP 参数。

### 接口与使用路径

- `writer.ts:129`：创建、修改中的两个数字可省略，但 Patch 不接受 null 清除。
- `writer.ts:375`：创建时立即为未填 context 写入 128000。
- `writer.ts:383`、`:415`：保存后启动 discovery，但没有开启 allowActiveProbe。
- `writer.ts:435`、`:444`：手动 Detect again 开启 allowActiveProbe。
- `ohbaby-server/src/protocols/web/routes/global-settings.ts:117`：设为默认时也允许主动探测。

已保存表单的空值缺少“恢复自动”表达；前端不能仅靠删除输入框文字实现它。

## 3. 探测与并发

`context-window-probe.ts:43` 读取模型列表元数据，整体超时 15 秒。它识别 `context_length`、`context_window` 等固定字段，且允许 context 模糊匹配；reasoning 则要求更精确的模型身份。它不是通过大量 token 试探真实上限。

`apply-active-model-config.ts:564` 总会尝试元数据；`:576` 在允许主动探测且没有已知能力时才继续 POST。`reasoning-active-probe.ts` 最多请求非法档位、六种候选档位与 off，整体超时 30 秒，输出限制为 32 tokens。

当前主动探测的局限：

- 非 OpenAI 官方的 Chat 端点只发 `reasoning: {enabled, effort}`，不尝试 OpenAI 标准的 `reasoning_effort`。
- 档位两个一批地串行验证，30 秒总期限对慢速推理模型不够，超时后已拿到的结果也全部丢弃。
- 验证档位时，非 2xx 一律记为“不支持”，429、5xx 等临时错误会让档位被悄悄漏掉。
- 没有工具定义，不能代表真实 agent 的 tools + reasoning 请求组合。

这些局限都由 §5 的实测证实。

现有调度已具备 AbortController、配置 generation、routeKey 和串行配置发布锁，值得复用。`writer.ts:604` 的写回仅在 context 等于启动快照时覆盖；这能保护探测期间的修改，但不能保护探测启动前已存在的用户覆盖。

`apply-active-model-config.ts:621` 只有写回或 allowActiveProbe 时才发完成通知；异常路径仅更新内存状态。`writer.ts:239` 的 Settings reasoning 投影没有带 discovery state，而 `adapters/ui-inprocess.ts:3078` 的 composer 投影会带入。因此两处显示不一致，部分失败可能让界面等待下一次刷新。

## 4. Web 与 SDK

`ohbaby-sdk/src/contract/settings.ts:146` 定义 create/patch；`:171` 起的读取模型结构（`:183`）要求 context 为 number，没有单独的用户覆盖值或探测值。

`apps/ohbaby-web/src/ui/settings/model-form.ts:65` 把 context/max output 列为不可清空字段，`:105` 在清空时阻止 Save。`ModelEditor.tsx:518` 的配置标签仍为 Thinking；更多菜单也有相同文案。桌面 reasoning 控件已有探测动效。

未来前端必须区分“显示自动探测值”和“用户编辑了这个值”。否则仅修改 label 并保存，就可能把展示的探测值误存为手动覆盖。

本轮源码复核另发现 Responses 档位不一致：`reasoning-active-probe.ts:8` 会探测 `max`，`ohbaby-llm/src/providers/reasoning.ts:170` 附近的 Zenmux luna Responses 内置能力也含 `max`，但 `openai-responses.ts:147-157` 的正式请求白名单只允许到 `xhigh`。本地无网络复现中，`resolveRequestReasoning` 接受内置能力的 `max`，随后正式 provider 抛出 `Responses request: unsupported Responses reasoning effort max`，网络请求数为 0。处理方式需要同时保证可选档位与正式发送一致，不能只检查 probe 返回的 wire 名称。

Anthropic 的同类边界由源码确认：`providers/anthropic.ts:445-451` 拒绝 `minimal`，但 probe 候选包含它。这里尚未发出新的真实请求；D10 已确定同时处理新探测、旧能力和不兼容偏好。当前安装的 Anthropic SDK 0.124.0 的 effort 类型同样没有 minimal；本轮查阅的 [官方 effort 文档](https://platform.claude.com/docs/en/build-with-claude/effort) 列出 low/medium/high/xhigh/max，未列出 minimal。问题是探测与正式请求的支持范围不一致，不是无法读取该字符串；第三方网关接受请求也不能证明该值具有独立、等效的推理语义。

## 5. 真实证据及其边界

### 输出与协议

上一轮对测试清单中的 18 个模型／协议组合发出短文本请求：16 个接受省略输出参数，Zenmux Claude 和通义 Anthropic 不接受，补 8192 后成功。成功的 16 个组合附带工具定义也成功。这不等同于流式工具闭环验收。

### 元数据

当前 `probeContextWindow` 的真实 GET 结果为：context 识别 10/18，reasoning metadata 识别 0/18。其余 context 结果分别是缺字段 5 项、metadata HTTP 错误 3 项。内置 reasoning 能力表仍可能识别其中部分模型，0/18 不代表这些模型都无法推理。

### 主动 reasoning probe

2026-11-12 用现有 `probeReasoningCapabilities` 对同样 18 条路由做了实测，并记录每个请求的状态码和上游错误摘要。识别出 12 条，档位和是否支持关闭都与官方说明一致，例如 OpenAI gpt-6.1-terra 可关闭、gpt-6-astra 不可关闭。未识别的 6 条如下：

| 路由 | 原因 | 补充实验 |
| --- | --- | --- |
| 智谱 glm-5.3-flash Chat | 编造档位的 `reasoning` 对象返回 200，字段被忽略 | 改用 `reasoning_effort` 后，编造档位被 400 拒绝；只接受 low、high、max，不能关闭 |
| 通义 qwen3.8-flash Chat | 同上 | `reasoning_effort` 被校验，7 个值都接受，可关闭 |
| DeepSeek flash / v4-pro Chat | 同上 | `reasoning_effort` 被 422 校验，7 个值都接受，可关闭 |
| OpenAI gpt-6.1-sol Responses | 两个一批串行，30 秒内只测完 4 个档位，超时后整体作废 | 单个请求 1.6 到 6.3 秒 |
| Zenmux deepseek-v4.1-flash Responses | 网关忽略 reasoning 字段 | 未识别是正确结果 |

另外两点观察：

- DeepSeek（官方和经 Zenmux）对 7 个值都返回 200，但 Zenmux 文档只列出 high 和 max，推理 token 数也不随档位单调变化。“接受”不等于“有区别”，HTTP 状态码分不出这一点。
- 内置能力表中 Zenmux luna Chat 只写了 low、medium、high，实测支持到 max；内置表命中时会跳过 probe。

附带工具定义的请求在这 18 条路由上都没有出错；OpenAI 官方 Chat 接口在“工具 + reasoning_effort”同时出现时返回 400，见 `tests/models-4-tests.md` 的 2026-11-08 记录。实验只用 32 到 64 tokens 的短请求，原始结果在记录结论后已删除。

### 历史失败

指定会话中的 xueyuanlu 在第 42 次请求输出 8192 tokens，其中 reasoning 1680，随后被标记 `OUTPUT_LENGTH`，不可重试。对应父 run 最终 succeeded。历史请求体未保存，不能把当前配置当作历史 wire 参数快照。

源码 `core/lifecycle/lifecycle.ts:1015` 明确把 length 变成失败。这是单独的运行时问题，提高到 32768 不能保证不再发生。

脱敏原始证据位于本地 Git 忽略目录 `.ohbaby/max-output-investigation/`：`results.json`、`metadata-results.json`、`runtime-evidence.json`。文档只保存结论，不收录 API key、完整会话正文或带鉴权头的请求。

## 6. 测试基线与缺口

前一轮已运行配置探测相关四个测试文件，29 项通过；输出 length 的 lifecycle 窄测试和三协议终态集成测试共 7 项通过。现有测试把“Save 不发主动 POST”和“length 立即终止”作为当前契约。

本轮方案需改变前者；后者不属于本方案。新增验收必须覆盖清空、来源、旧配置迁移、保存中探测回包、重启读取、失败结束通知，不能只检查最终数字。

## 7. 工程判断

优点：配置写入集中、运行层消费已解析配置、主子模型继承已有一致路径、探测调度已有竞态防护。

主要债务是“数值与来源混在一起”以及“保存与主动探测契约分离”。增加少量来源数据和集中解析能直接解决当前需求；不需要引入通用供应商插件框架或按 effort 输出预算引擎。

## 8. 与现有文档的关系

| 现有说明 | 当前代码 | 本方案拟变更 |
| --- | --- | --- |
| `docs/config/llm/data-model.md:36`：省略输出时使用 8192 | 与投影一致 | 默认改 32768，保留覆盖语义 |
| 同文档记录条目直接保存 context 数字 | 与 ModelEntry 一致 | 区分用户覆盖与检测值，再解析为运行数字 |
| `docs/ohbaby-web/test.md:75`：检测优先，失败用用户值或 128K | 属于旧 connect 路径契约 | 手动覆盖优先，兜底 300000；所有配置入口一致 |
| 早期 `docs/config/llm/improve-1/02-design.md` 描述单活动模型结构 | 当前已经是模型库文档与单条运行投影 | 作为历史保留，不照抄旧结构 |

实施时同步现行设计文档；本次只新增方案，不把待实施内容写成当前能力。
