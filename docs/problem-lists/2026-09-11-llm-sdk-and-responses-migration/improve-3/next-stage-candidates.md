# improve-4 候选范围与后续顺序

> 2026-09-13用户接受后续方向，仍不是improve-4实施授权。此处improve-4指本LLM迁移议题，不是已有docs/core/context/improve-4。improve-3尚未实施；下一轮正式方案须在其验收后用实际代码核对，并在improve-3合并前交用户确认。

## 1. 推荐解决什么

推荐improve-4先解决：**请求前到底估算了什么，以及它与实际发出的模型输入是否一致。**

improve-3只替换内部请求/结果接口，为保持旧数字，临时保留旧估算序列化。improve-4可以开始替换这层过渡代码，但不能将“按实际请求估算”写成“token精确计数已完成”。例如system在Responses出站时进入instructions，工具从嵌套结构变成扁平结构；仅对内部ModelMessage JSON计数，不能证明覆盖了转换后的模型输入。

| 候选 | 收益 | 代价 / 建议 |
| --- | --- | --- |
| 请求投影与计量依据先对齐 | 直接处理improve-3留下的估算兼容层，改动可测试 | 推荐；token算法、统计扩展继续按证据拆分 |
| 原生状态续接先做 | 优先解锁受限推理模型工具多轮 | 涉及保存、重放、压缩、恢复，改动更大；除非用户把此能力改为最高优先级 |
| 计量、缓存、续接一起做 | 同时覆盖更多迁移目标 | 不推荐；很难区分数字变化来自请求转换、算法还是续接历史 |

## 2. 必须继承的既有合同

依据[context improve-5职责收口](../../../core/context/improve-5/06-token-responsibility-review-and-follow-up.md)、[context improve-6](../../../core/context/improve-6/README.md)及[session cache](../../2026-08-27-session-cache-hit/README.md)：

- PreparedModelRequest仍是同一步的冻结输入；不重回独立拼messages、tools的平行调用链。
- token-estimation决定“估算哪些材料”；tokenCounting负责“如何近似换成token及窗口预算”；provider usage是返回后的观测事实；三者不合并成万能计数模块。
- inputTokens包含缓存输入。命中缓存不减少context占用，不把cacheRead从分母扣掉。
- 七桶composition与cache统计是分开的通道。缺失usage/breakdown仍是未知，不伪装成0；不完整聚合仍保留原partial规则。
- 主/子代理按scope隔离，summary/title保持既有purpose；不绕开冻结工具快照、校准或辅助请求隔离。
- SQLite、旧usage metadata读兼容、UI已有展示不因计量改造顺带改名。

## 3. 候选实施顺序（批准后才细化）

### 第一段：确定计量材料，锁定对照样例

调查三个adapter真实投影函数及context调用时机，选择最小接入点。优先复用各adapter已有纯请求构造逻辑，发送与计量采用同一套转换规则；避免context导入具体SDK类型，也不缓存第二份长期请求。是否调整现有provider接口，必须在下一轮设计里根据代码决定，本页不预建服务、注册表或新字段。

样例覆盖system/instructions、工具schema、工具结果、reasoningText、tail directives、MCP及多模态。明确哪些字段是模型输入，哪些是传输控制。不要直接把整个HTTP请求JSON的字节数称为模型token；图片或音频也不能靠其URL/base64字符串长度冒充真实成本。

完成标准：每个样例能解释计量材料从哪来；对照实际出站请求证明没有漏掉主要输入或重复加上旧Chat外壳；计量不修改发送对象、不引入额外网络请求。

### 第二段：接入估算与context，并评估算法

先用既有启发式方法测量新材料，记录旧值、新值及变化原因；批准后的这轮允许数字因计量材料改变而变化，不能继续沿用improve-3“旧数值不变”的验收口号。总量和七桶必须用同一依据；不可归属材料的表达方式先讨论，不擅自加第八桶或硬塞某桶。

同时审查校准是否仍有可比的基线及scope隔离。压缩阈值不改，但输入估值改变仍可能改变触发时机，必须跑临界预算与压缩回归，不能称之为“纯统计无行为影响”。

精确tokenizer/供应商计数能力仅在确认模型、支持内容、延迟、成本与误差标准后选择性接入。不支持时保留明确的估算结果；不承诺一套算法精确覆盖全部网关和多模态。本轮先不要锁定新的公开计数字段名称。

完成标准：新计量覆盖生产调用链，旧新差异有可复现样例，七桶与总量关系可解释，预算边界/校准/主子代理/辅助请求测试通过。相应范围完全迁出旧口径后才删除legacy-estimation helper，不为删除文件放弃仍依赖的兼容合同。

### 第三段：定向统计回归与阶段验收

对三协议请求、provider实际usage、context估值做同请求对照。缓存方面先验证已有inclusive、observed、跨步/会话归属和partial规则没有被新计量破坏；不改cache key、命中率公式、前缀稳定策略或主动控制字段。发现统计缺口单独登记，决定是否另起小批次，不能借回归扩大成全套cache重写。

每个实施切片都做unit、integration、相关contract、子代理审查和独立commit；最终preflight及定向真实请求验收。真实结果与本地fixture分开记录。具体模型/端点、预算、允许误差和测试命令必须在正式improve-4/04中冻结，本页不是可直接执行的测试合同。

## 4. 不纳入推荐的improve-4最小范围

原生reasoning/phase/签名等状态的保存与回放、previous_response_id/Conversations、hosted tools、默认切换Responses、UI协议开关、SQLite重建、cache主动策略和命中提升优化。本页也不宣称完成全迁移链路验收。

原生状态接入后，计量需要再次覆盖新增状态；先对齐当前受限子集不等于此后不用再改。保留adapter的能力边界，不提前吞掉不支持输出。

## 5. 开工及合并顺序

1. improve-2按用户修订用ZenMux补T12；2026-09-13本地preflight与生产lifecycle Grok T12均已通过（05 §5.12）。收尾审查提交后按用户授权合入openai-responses-migration。
2. improve-3精确契约已批准，前置门通过后从集成分支建立临时实施分支；按A/B/C完成本轮单元、集成、审查、commit及LLM请求E2E。验收后先停下，用户审查且确认improve-4计划、明确同意后才合回集成分支。
3. 用improve-3实际结果正式规划improve-4；本页只作为候选输入。另建临时分支，阶段验收后合回集成分支。
4. 独立排原生状态续接、确有缺口的缓存统计对齐，再做跨协议/主子代理/恢复/压缩/统计/UI的完整迁移验收。后续编号待立项，避免把依赖不明的任务编号当承诺。
5. 只有Responses后端及token、cache、context、lifecycle整体达到用户要求，才讨论将集成分支合入main。每一轮合入集成分支不等于可以上线或翻转默认值。

## 6. 方向批准与正式方案边界

用户接受“实际请求计量依据 + context必要对齐”的后续建议，精确算法按证据选用，cache策略和原生续接另排。正式improve-4方案仍须用improve-3实际实施结果及下面移交清单复核；不得把本页方向批准当作下一轮字段/算法/验收阈值全部定稿。

## 7. improve-3未解决事项与移交标准

| 项 | improve-3做到哪里 | 接续阶段 / 完成条件 |
| --- | --- | --- |
| 旧估算序列化 | 私有helper维持批准的旧数值，调用方使用新类型 | improve-4：建立实际请求计量依据及回归后删除helper，不能提前删除 |
| tokenCounting准确度 | 保持现有文本启发式、预算与类型合同 | improve-4评估：按模型/协议明确计数支持与误差；不支持项继续标估算，禁止承诺统一精确 |
| context总量/七桶 | 只适配新字段，保持旧口径 | improve-4：总量、分类和校准同源；包括边界压缩回归，不顺手改阈值 |
| cache命中统计 | 维持inclusive/observed/partial及scope，不改公式 | improve-4定向回归；新增统计缺口另立后续小批次，具备单请求到session的证据才关闭 |
| cache控制策略 | 控制字段必要重命名，Responses仍observe-only | 独立后续：能力与实际命中证据齐备后再讨论key/retention/breakpoint等策略 |
| 原生reasoning/phase/状态续接 | 仅reasoningText明文字段；不保存原生状态，不解除Responses拒绝 | 独立后续：持久化/回放/重启/压缩与工具授权联合验证后才开放 |
| 多模态及其他低频请求字段 | 保留已批准的窄输入与各adapter既有能力，不统一输出/存储 | 后续按实际需求立项；尤其Anthropic现存过滤与tool JSON fallback本轮只保持，不宣称长期设计已修复 |
| 全迁移链路与默认入口 | 本轮只验接口迁移和指定矩阵，不翻默认、不改UI开关 | 后续跨模块整体验收后，用户另行批准集成分支到main；默认翻转另决策 |

已有improve-2真实预检失败不能作为“后续已登记”就算本轮验收通过。用户已批准另选模型，当前Grok已完成生产lifecycle T12（05 §5.12）；原Luna/DeepSeek Responses的temperature及reasoning/phase问题保持未解决，improve-3字段更名不会自然修复它们。

最小参数验证补充（improve-2/05 §5.10）：Luna省略温度且effort=none仍带final_answer phase；DeepSeek请求none仍返回有加密内容的reasoning及推理token。两者不能通过丢弃字段处理，也不能只登记为本表延期项就关闭improve-2门。若因此决定提前原生状态工作，必须重新明确范围及顺序，不自动塞进improve-3。

替代矩阵的覆盖限制（同文§5.11）：Grok通过不代表OpenAI原生模型已经兼容。原Luna与DeepSeek Responses路径的复验放在后续原生状态能力阶段，须包含参数兼容、状态无损保存/重放及真实工具多轮；不纳入improve-4当前推荐的最小计量范围。阶段顺序不因本次选模型而变化。
