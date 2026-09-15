# 2. 方案、职责与分批实施合同

> 状态：规划草案，待用户审阅；并非已实现行为。需求以 [00](./00-discussion.md) 为准，验收按 [04](./04-test-and-acceptance.md)。本次只写文档，后续开发按 A–F 推进。

## 2.1 目标与设计取舍

默认开启、默认 medium 是本产品选择；模型能力解析决定这个意图如何合法落到当前平台，而不是让平台默认悄悄覆盖它。需要完整贯通“配置 → wire → 最终状态 → 消息 → 历史回放 → 用量与估算”。

| 决策       | 选择                                                                            | 原因与代价                                                            |
| ---------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 配置形态   | 一个 reasoning 配置对象，包含 enabled 与 effort；外部可省略，进入请求前完整解析 | 兼容旧配置，避免 none/off/disabled 同时作为三种内部开关               |
| 模型差异   | 在配置/模型能力层解析，在 adapter 层翻译                                        | 不把厂商字段写进 Lifecycle；少量精确能力规则需要维护                  |
| 原生状态   | 自有、带协议判别的内部 model-state Part，关联所属 assistant                     | 复用现有有序 Part/SQLite JSON；需要处理所有 Part 分支及外部投影       |
| 回放       | 原生状态与文字/工具投影一起保序，保留来源约束                                   | 多轮工具可靠；不可简单拼接 visible reasoningText                      |
| 估算       | 新状态贡献进入同一请求估算，opaque 采用明确保守代理值                           | 不是精确 tokenizer，可能提前压缩；不能零计或按密文长度冒充实际 tokens |
| 用量/cache | 继续消费供应商总量和 accepted Step                                              | 不新建计费系统；仍无法获知上游未返回的用量                            |
| 辅助请求   | 单独按现有 purpose 选择配置                                                     | 防止共享 client 被临时改写；策略取舍见 2.2                            |

放弃两个方案：只传开关不接续状态，会在工具第二轮/恢复时失败；把所有 SDK 原始响应直接塞通用 metadata，会让存储、前端和 core 依赖随 SDK 变化。也不建设包含所有厂商能力的通用路由框架。

## 2.2 请求配置、默认与继承

### 2.2.1 最小输入与解析顺序

建议后端配置/调用使用 `reasoning: { enabled?: boolean, effort?: string }` 的意图结构。持久配置与请求覆盖复用一个验证入口；内部解析后的结构必须能区分 enabled 与 disabled，enabled 状态必有有效 effort 或明确的二态模型策略。字符串必须是目标模型允许的值，不能任意透传。

解析顺序：当前模型配置 → 当前 Run 的显式请求覆盖 → 调用目的策略 → 目标平台/模型能力校验 → 不可变请求快照。reasoning 逐字段合并，省略字段不覆盖低优先级值，合并完成才补产品默认；例如模型 off/high、调用只改 effort=low，结果仍为 off，不能因替换整个对象而开启。省略 enabled 按 true，省略 effort 按 medium；关闭时保留用户偏好可以用于下次开启，但 wire 不发送开启专用的 effort/budget。`effort=none/off/disabled` 不作为内部合法强度，关闭统一用 enabled=false，由 adapter 转换。

合并与继承须保留最少的内部字段来源（用户显式设置或产品默认），直到目标模型能力校验完成；父子换模型时仍保留此语义。否则默认 on/medium 和用户显式 on/medium 无法执行2.2.2中的不同兼容分支。该来源不新增用户配置字段或公开DTO。关闭时不验证暂存偏好是否适用于开启，只验证关闭能力。

Run 开始时冻结快照，父配置中途变化不改已在执行的请求；下一个 Run 读取新值。子代理任务在入队时取得对应父 Run 的有效快照，避免排队期间全局模型变化导致漂移。复用同一个子代理再发新任务时取新任务所属父 Run 的快照；旧请求及它已保存的原生来源不被改写。

本轮不让模型通过工具参数擅自覆盖用户推理开关；用户调整走后端配置/调用入口。不同 session、兄弟子代理、标题任务不得 mutate 共享 client.config。子模型如现有配置允许不同，继承的是 enabled/effort 意图，不是父平台 wire JSON。

### 2.2.2 能力信息与不支持时的确定行为

能力按实际 `interfaceProvider + endpoint/provider + model` 解析，不能只按模型名或 URL 猜协议。来源优先级：明确的本地模型能力配置 → 该平台实际返回的能力信息 → 精确匹配、带来源的内置规则。离线确定性测试使用固定能力表；正常生成不新增一次逐请求 models 网络调用。模型连接/刷新时可读取该平台已支持的元数据，失败时沿用已验证配置，不把未知当全支持。

OpenRouter/Anthropic 元数据只能作为对应平台证据；OpenAI Models API 缺少同等矩阵，必须有本地规则入口。第一批交付无需新增 OpenRouter 路由服务，也不要求接入六个参考项目的全部能力表。

| 情况                               | 行为                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 支持 medium 的推理模型，未指定配置 | 明确开启并发送 medium 的协议等价参数                                                                                              |
| 用户指定支持的 low/high 等         | 精确发送所选档位，不自动降级                                                                                                      |
| 默认 medium 或显式档位不受支持     | 使用事先显式配置的模型档位映射；无映射则在请求前给出支持集合与配置错误，不自动挑 high/max                                         |
| 只有开关、没有可调强度             | 模型能力明确标为二态；默认开启可合法开启，但诊断报告写“仅支持开关，无 medium 档”。不得报告实际 medium；显式指定具体档位应报不支持 |
| 明确非推理模型                     | 缺省产品配置允许普通文本/工具请求，不发 reasoning 字段；用户显式要求开启/强度时明确报不支持，保持旧非推理模型可用                 |
| 模型或路由能力未知                 | 不猜参数；要求补充该模型能力配置。不能因 HTTP 200 就登记参数有效                                                                  |
| 明确关闭，但模型不支持关闭         | 在模型请求前明确失败；不省略后假称关闭，也不自动换模型                                                                            |

“二态默认可开启”和“非推理模型缺省普通运行”按 00 K13 冻结为本批兼容策略；不能冒充所有模型都能实现用户选择的 medium。最终报告分别记录请求意图、实际 wire 及能力来源，不增加前端状态字段。

### 2.2.3 主子代理与辅助请求策略

子代理同时继承父任务的开关和强度：父 high → 同模型子 high；父 off → 子 off。换子模型后重新验证目标能力，不能无声回 medium。暂不新增子代理独立开关或多层 profile 优先级。若后续需要某角色降强度，应单独扩展，不在这次隐式加入。

| 调用                                 | 本批确定策略                                                | 是否随父 high 提高    |
| ------------------------------------ | ------------------------------------------------------------- | --------------------- |
| 主 agent-step                        | 默认 on/medium，用户可调整                                    | 用户决定              |
| 子 agent-step                        | 继承父 Run 快照，按子模型校验                                 | 是                    |
| session-title                        | 明确关闭；不支持关闭时沿用已有标题失败处理，不偷偷改模型/开启 | 否                    |
| context-summary（现有手动/自动压缩） | 直接沿用触发压缩的所属 agent 当前配置快照                     | 是，不额外覆盖 effort |

主默认、子开关/强度继承、压缩继承已确认（见00 §0.6/K11）。标题关闭已由用户明确确认（00 K12）。之前“压缩固定 medium”建议被用户明确否决，不保留该分支或配置注入逻辑。

当前 createContextSummaryClient.generateSummary 虽然名称含 summary，实际服务手动/自动压缩；调用 purpose=context-summary，必须继承所属 agent 配置。用户最新要求进一步简化：不新增独立摘要专用 medium 逻辑。本基线未定位到第三个生产摘要入口，不新增该功能；不能按函数名字含 summary 就覆盖强度。当前摘要是在手动压缩、达到自动压缩条件或溢出补救时生成，不是每个 Run 结束后的额外调用。

主代理 high 时，其子代理默认 high，其上下文压缩也为 high；用户随后把主代理改为 low，后续 Run 及其触发的压缩取 low，已运行的请求不被修改。子代理压缩使用该子任务快照，不读取主代理其他 Run 的新值。辅助请求保持原 usage 归属，不进入主 cache；配置继承不改变统计范围。

### 2.2.4 三协议映射与温度

| 协议/能力                | 开启                                                                      | 关闭                                       | 验证点                                                        |
| ------------------------ | ------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| OpenAI Chat 原生 effort  | reasoning_effort=已校验档位                                               | 模型支持的 none 或明确关闭方式             | 不把 Responses 的 reasoning 对象套给所有 Chat                 |
| Responses                | reasoning.effort=已校验档位；需要无服务端状态续接时请求 encrypted_content | 支持时 reasoning.effort=none               | store/输入策略保持本地历史，不依赖 previous_response_id       |
| Anthropic adaptive       | thinking.type=adaptive + output_config.effort                             | thinking.type=disabled，移除仅开启所需参数 | 不把 output_config.effort 单独视作 thinking 开关              |
| Anthropic 旧 budget 模式 | thinking.enabled + 模型配置中的显式档位→budget 映射                       | thinking.disabled                          | budget 满足模型最小值、严格小于总输出额度；不临时随意猜数字   |
| 第三方 Chat 扩展         | 按已确认平台规则映射，如 thinking/enable_thinking/reasoning 对象          | 同平台关闭参数                             | 不将上述字段同时撒给所有平台；逐模型 fixture 与真实 wire 验证 |

temperature 改为可省略，贯通 config validation/writer、LLMConfig、client、InterfaceProviderRequest。writer 不再无条件补 0.2；未给值时不发送，也不改成 1。旧配置显式数值继续读取：支持该采样组合时发送；已知不支持时请求前明确配置错误，提供删除该项的说明；不要 silent drop 掩盖用户配置，也不要使用宽泛 400 自动删参数重试。测试 profile 应显式使用合法配置。

## 2.3 原生状态、消息与完成边界

### 2.3.1 所有权

| 层                | 负责                                                      | 不负责                             |
| ----------------- | --------------------------------------------------------- | ---------------------------------- |
| config/model 能力 | 意图默认、档位验证、purpose 策略、快照                    | SSE 解析、cache 记账               |
| provider adapter  | wire 映射、完整原生 item/block 校验、最终快照             | 数据库、agent 调度                 |
| llm-client        | 本次尝试的增量与最终快照合并、错误/重试隔离               | 将原生状态拼成正文、工具执行授权   |
| Lifecycle         | 接受最终 Step 后保存状态、交给上下文，沿用一次 usage 观察 | 解析 SDK 字段、选择厂商参数        |
| Message/Context   | 保存、来源检查、活动性、保序回放、压缩关联、估算          | 解密 opaque 数据、生成虚构用量     |
| UI/API 投影       | 继续输出既有正文/工具/统计                                | 暴露内部 model-state 或实现推理 UI |

### 2.3.2 最小承载方案

新增内部 `model-state` Part，而不是复用 ReasoningPart.text。载荷包含版本、来源及有序自有协议数据：

- 来源：实际 provider/endpoint 身份、interfaceProvider、model；不含 apiKey，身份必须由实际 client 填写。
- Responses：支持集合内的 reasoning item（包括 encrypted_content 等必要字段）、assistant phase，以及与文字/函数调用的顺序关联；保留 item id 与 call_id 的不同语义。
- Anthropic：有序 thinking/redacted thinking、signature，以及与 text/tool_use 块的关系；签名不可重写。
- Chat：已有 reasoning_content/reasoning 及经平台确认的 reasoning_details；不能只保留可见文本后丢弃加密/签名内容。ZenMux 文档与实网确认的规范非负十进制字符串 index 保留原值；同 index 下 summary/encrypted 是不同有序项，按 index 与 type 区分；缺 type 的增量只有能唯一归属时才合并，不猜测、不接受任意字符串。

core 定义自有判别联合；SDK 类型只在 adapter 内转换。载荷只能保存本轮支持且验证过的字段，不能用任意 SDK Response/unknown 整包穿透。可见正文和可执行工具仍由原有 Part/ParsedToolCall 提供；原生回放序列使用这些内容时必须只产生一份 wire 输出，禁止原生 envelope 与普通 serializer 双发同一 assistant/tool。

A 批固定数据合同和回放样例：以原生有序输出项为回放真相源，正文/工具 Part 是它的可见/执行投影；回放该 assistant 时使用原生输出序列一次，不再追加一份扁平 assistant。多个 message/text/phase item 即使合并为一个可见 text Part，原生载荷也保留各自边界、原始文本和顺序；工具项通过 call_id 与工具 Part 对应，后继 tool result 从工具 Part 产生一次。原生全文与可见投影需一致性校验，不能各自修改后双轨漂移。每个原生序列项可对应自己的原生块或既有正文/工具项；对应项缺失、被编辑或顺序无法还原时拒绝该原生回放，不能猜造签名/工具参数。保存必要原始 JSON 字符串是保真需求，不得把 SDK 类型扩散到 core。

新增 Part 需同步 MessageSchema/bus 内部 schema、SQLite JSON reader、in-memory store、converter、serializer、active filter、持久 UI/API 投影中的穷举分支。所有“非 text/reasoning 就按 tool 处理”的分支必须检查。model-state 不进入公开 snapshot、正文、reasoning UI 事件或普通日志；脱敏测试证据单独记录。

### 2.3.3 最终接受与重试

adapter 先累积本次流，terminal payload 可以补全此前 item.done 未给的必要字段。Responses 的 encrypted_content 若在 output_item.done 已提供，则按安装的 OpenAI SDK 7.13.0 回放说明优先保留该值；仅在 done 缺失时使用 terminal 补值。同一 item 的密文在 terminal 重新封装而变化不单独判冲突，id/type/顺序/status/summary/正文等冲突仍失败；重复 item.done 的冲突仍失败。只有正常流耗尽且最终结构一致，才能输出可回放的最终状态。中间 llm:complete、reasoning.done、tool delta 不授权执行或持久化有效状态。

Lifecycle 在 runModelStep 正常耗尽返回、最终结果有效且经过 overflow 尝试选择后，先保持现有顺序接受 usage：aggregateTokenUsage → onStepUsage → 同请求校准 → abort/length 检查。模型流本身失败的尝试不到这个入口；state 后续落盘失败不改变这个接受口径。length/abort 可以保留已接受的可信 usage，但不能执行截断工具或提交半成品原生集合。

通过上述检查后，再提交本 Step 可回放状态与工具调用描述。必须增加现有 MessageManager/MessageStore 内一个最小 commitModelStep 操作：以现有 SQLite 同步事务一次写入 model-state、待执行工具 Part、单份 usage metadata 与 assistant 完成标记；in-memory store 对应同样的全有/全无合同，bus事件只在提交成功后发布。流式正文可以先保存，但没有最终提交标记的原生集合不可回放。新操作只管理数据提交，不执行工具、不写统计、不包网络请求。

当前 runModelStep 内约1060行提前写 finish/time.completed 与text usage的代码，原生路径必须迁到这个提交操作；不能沿用旧的提前完成标记。约750行后置 appendToolParts 的原生路径也由同一次提交产生，返回 Part ID 供既有scheduler更新，不能二次创建。普通流完成事件仍表示模型流状态；数据库完成标记用于该assistant已完整提交，不等于工具已经执行结束。无原生状态的旧路径保留既有合同并做回归。

usage 只放一个承载 Part，顺序为已有 text → 首个 tool → 必要 model-state；最后一项只在确有必要状态时使用，不为了usage创建空state。必要签名/密文随原生数据保存，不把私有字段放text metadata的公开投影。新提交失败时：Run失败、工具0执行、事务无有效原生集合；此前已接受的usage/cache不撤销、不重记，报告runtime与持久覆盖不同。不得通过重试整次生成来掩盖存储失败。

只有原子提交成功并通过现有工具权限/执行检查后，才允许工具执行。进程在事务任一写入点中断，重开数据库均不得得到半套可回放状态；提交后崩溃、工具尚未执行时保留pending描述但不能自动声称工具成功或无授权重放副作用。被放弃尝试、尾部错误、乱序/冲突状态不进入有效原生历史。

### 2.3.4 回放、切换与压缩

- 同源、有效、活动中的状态按协议顺序回放；下一用户 Run 与 SQLite reopen 使用同一规则。
- 切模型/协议/endpoint：不发送不兼容签名/密文；普通文字和已完成工具结果按既有通用投影保留。不得把 private thinking 转成正文。未完成的原生工具往返不能切源继续，须明确结束/报错，不能拼出孤立 tool result。
- 开关/强度变化不直接清历史；adapter 按该平台已验证的历史回放规则处理。若当前模式无法合法回放未结束序列，先明确失败，不偷偷丢必要状态。已完成历史是否携带 thinking 由协议规则与固定样本证明。
- model-state 与所属 assistant/tool 往返组成压缩关联单元。最小保守策略：prune 跳过所有带 native 依赖的工具单元（包括已完成的旧往返），其余普通工具仍走原 prune；native 单元交给 summary 整体替换。不得只跳过未完成工具。这样可能保留更多旧工具内容、提前进入summary，是必要完整性约束的代价，不改阈值或引入新压缩算法。summary 选段边界必须扩展/退回到完整且已结束单元，成功同事务提交后，相关state/text/tool同步compacted；失败、空摘要或截断不得改变旧历史。
- summary 输入为既有可读正文/工具文本投影，不包含 opaque/signature；压缩后的请求只包含新摘要与仍活动的完整序列，不把旧 state 再塞回来。
- 子代理使用同一算法、各自 session/contextScope。不得把其私有状态或用量归到主代理。

## 2.4 用量、估算与 cache 合同

### 真实用量

供应商 outputTokens 已含 reasoning。保留现有 normalizer；如新增细分仅用于状态估算/诊断，不把它再加到 output/total。缺总量不由 reasoning 子项补造。每 Step 至多一份持久 usage，恢复消息不重新调用 onStepUsage；cache 仍是进程内累计。

maxTokens/max_output_tokens 是包含思考与回答的总输出上限。不要将 reasoning budget 再加到输出额度，也不在 context 中双重预留。强度提高可能消耗更多时间/输出预算，本轮不自动扩大额度。

### 估算材料与未知状态

新增自有请求状态后，prepare 的 sentHeuristic、composition 和压缩选段必须使用同一套投影规则，避免主请求算了、压缩选段仍忽略。原有 Chat 文本/tools 投影在无原生状态时保持回归兼容；不趁机整体重写 tokenizer。

可读原生内容只估算一次；密文/签名字符不按明文 token 计。对实际回传、不可展开的 reasoning 内容，随 state 保存一个内部估算代理值：优先采用该响应明确提供的 reasoning token 子量，否则采用该响应总输出量；均缺失时采用该次请求的 max output 上限。这是保守的估算输入，不是实际 context 数量、费用或 cache 数据；总输出替代值可能包含已计正文，允许保守高估并在测试/报告中明确，不假称精确上界。

纯签名是已有 thinking 的校验材料，不再给该 thinking 加第二份代理值。多个 opaque 块共享该响应的一份代理额度，不逐块重复添加。仅本次实际回传的活动状态参与估算；压缩/切源不回传时不加。代理值有来源标记，保存在内部 state，不能增加公开状态 DTO。

保留 EMA/clamp 公式及 session/contextScope 隔离；actual input 只与同一次请求的完整 sentHeuristic 配对。模型实际是否计入历史 reasoning 由平台决定，初次估算仍可能偏差；F 报告记录估算/actual/误差与压缩触发，不要求凭空达到统一误差百分比，也不引入每请求额外 token counting 网络请求。

### cache

继续 `sum(observed cacheRead) / sum(对应可信 inputTokens)`；不平均百分比，不把 reasoning 输出加分母，不因缺明细撤销历史。切模型、开关/强度变化、压缩不清累计；主子与辅助 scope 保持。请求设置可能真实改变缓存复用，不能把 hit 下降直接判成统计错误。

## 2.5 A–F 分批目标、方案和完成定义

### A · 合同与可复现基线

目标：把能力边界、状态所有权和已知失败固定下来，回应 P1–P8。

方案：读取安装 SDK 声明和目标平台文档；脱敏固化 phase、created queued、reasoning、terminal 补状态、Anthropic 初始 input/空 delta 样本。写配置解析与 native-state contract 测试，区分当前基线失败与已有保护通过。2.2 的辅助策略与模型能力取舍见 00 K12/K13；本地 RED 测试入库后实施依赖项。

改动面：`tests/fixtures/`、adapter 同目录 contract/unit；`core/llm-client/types.ts`、`services/interface-providers/types.ts`、`core/message/types.ts` 的合同设计。

完成定义：T01–T04 有确定输入和期望；每个已知故障至少一个在旧代码变红的正式测试；不运行计费请求完成本批。声明类型不表示生产已支持。

### B · 请求参数与继承

目标：用户意图合法抵达三协议 wire，回应 P1/P7。

方案：补 config reader/writer/validation、运行配置和 per-call override；按 2.2 解析模型能力/purpose/父子快照；temperature 可省略；对支持/不支持组合给出确定行为。移除所有构造链中意外补温度、丢 reasoning 的中间对象。

改动面：`config/llm/{types,validation,manager,writer,apply-active-model-config}.ts`；`core/llm-client/{types,index,streaming}.ts`；`services/interface-providers/{types,openai-compatible,openai-responses,anthropic}.ts`；`core/agents/`、`agents/subagent-host.ts`；title-generator、prompt-context 调用入口。

完成定义：T05–T09 通过。捕获生产 adapter 的真实序列化请求，不以 mock 调用入参替代 wire 验证。B 完成仅为开发分支能力，不单独发布默认开启，因为 D/E 尚未保证续接。

### C · 已确认协议解析修复

目标：修复参数之后实际遇到的解析失败，回应 P2/P3。

方案：Anthropic 初始 input 与后续增量分别累积，有非空增量时解析增量，无非空增量时保留合法初始对象；同时校验空/冲突/截断。Responses 验证生命周期允许的 created queued 组合，不放宽 terminal status/ID/顺序检查；phase/reasoning 有类型承载后才接入 mapper，不通过丢字段规避拒绝。

完成定义：T10–T13 通过；非法 JSON、EOF 前错误、未知 item 等既有负向测试仍失败。C 可验证 adapter 快照，原生推理的生产可用性仍由 D/E 完成定义约束。

### D · 同 Run 原生续接与一次接受

目标：文本、reasoning、工具结果连续往返，回应 P2/P4/P6。

方案：按 2.3 接通 adapter 最终状态、llm-client 累积、Lifecycle 接受点、MessagePart 与同 Run context；terminal 补全覆盖早期快照但冲突应失败。未支持的 hosted/refusal/annotation 等能力保持现有明确失败，只有本轮允许集合放开。

改动面：`openai-responses-stream.ts`、三协议 adapter、`core/llm-client/`、`core/lifecycle/`、`core/message/`、`core/context/serializer.ts`。

完成定义：T14–T18、T24 通过。至少两次工具执行再得到正文；overflow 两次不同 usage/state 只收成功尝试；尾部错误不能执行工具或留下有效原生状态。

### E · 持久化、上下文、隔离与估算

目标：不把“同 Run 成功”误当“会话完整支持”，回应 P4–P7。

方案：完成 JSON reader/版本兼容、数据库重开、模型来源、私有 Part 投影、压缩关联和估算代理值；子代理任务与 summary 均使用所属快照。reasoning-only 有必要状态时允许真实 Part，不造虚假 text/tool；其 usage 仍至多一份。

改动面：`core/message/{types,events,manager,database-store,store,converter}.ts`、`core/context/{serializer,serialization,legacy-estimation,token-estimation,compaction-policy,context-manager}.ts`、`adapters/ui-state/`、`core/agents/`。

完成定义：T19–T26 全部通过；下一 Run、重启、压缩、切模型均有实际生产组件测试；opaque 不出现在公开消息；新增状态不再被估算投影静默忽略。

### F · 全链回归、真实 E2E 与报告

目标：在实际链路证明三协议支持，回应 P8，并守住 improve-1～5 合同。

方案：先跑全部本地门，再按 04 有界矩阵执行真实请求；复用生产 Lifecycle、onStepUsage 与 tracker，不用独立脚本手算冒充应用结果。对 on/medium、用户调整、off、工具续接、缓存未知/零与平台限制分别留证。文档/代码独立审查后编写 05 实际验收。

改动面：`tests/smoke/responses-migration.real.e2e.test.ts`、`tests/helpers/`、相关 runtime integration 和真实测试 runner。新增 profile 走生产配置，不在测试 wrapper 偷删 temperature、phase 或 reasoning。

完成定义：T27–T30 及 04 发布门通过；报告逐行列通过/失败/未覆盖，非零 cache 不作强制门槛。F 不包含前端开发，不自动 merge/push。

## 2.6 迁移、风险与回退

旧配置不含 reasoning：在完整功能交付时按产品新默认 on/medium 解析，不回写所有用户配置。旧的显式温度若与当前模型冲突，需要用户删除或选择合法设置；错误要定位具体模型与字段。不能同时宣称“保留显式温度”又悄悄丢弃。

SQLite 优先只扩展 JSON Part 类型，不新增表。reader 支持旧无状态记录；未知 state 版本不猜测回放。写新 state 后回退旧二进制可能无法理解新 Part：本地验证先用隔离数据库；正式回退使用升级前备份，或新 reader 提供明确不可续接错误，不能承诺旧版本无损续接新历史。本轮不批量删除或转换用户数据库。

主要风险：默认开启提前发布、模型能力过期、partial 状态落盘、压缩破坏依赖、估算代理偏差、公开投影泄漏。对应测试见 04。不要靠增加多套全局状态、自动降档/重试、双轨 usage 或无限 live 请求掩盖问题。

## 2.7 关联文档与非目标

实现完成时同步权威模块文档：`docs/config/llm/`、`docs/core/llm-client/`、`docs/core/context/`、`docs/core/message/`、`docs/services/providers/` 的对应合同。前序 improve-1～5 的验收留存不重写；本轮 05 单独说明哪些限制已解除。

不做前端开关/文字、全功能 Responses IR、跨模型私有思考转正文、服务端状态、hosted tools、缓存控制优化、账本重建、子代理独立开关、辅助请求多层配置系统。辅助策略按 00 K11/K12 执行，不增加新的调用例外。

## 2.8 已登记、明确不在本批的后续能力

用户确认方向：主代理未来可以为子代理选择推理强度。建议接口为子代理工具的可选 reasoningEffort：省略继承父快照，提供则覆盖该次子任务强度，目标模型不支持时返回明确错误；开关仍遵循用户确定的父开关策略。父 high、简单检索子 low 是该能力的典型用例。

此处是后续需求登记，不授权本批增加 tool schema/参数、agent role覆盖层、状态字段或动态调档。任务排队/重试/续聊时的覆盖生命周期和用户配置上限，留到该能力正式立项时一并确定。现有 A–F 验收只验证默认继承，不验证尚未实现的显式覆盖。

后续前端方向（用户补充确认）：采用推理开关＋强度选择条，开启后可选择推理强度，默认开启、medium。复用本轮后端的开关/强度语义；具体档位展示与模型能力衔接留到前端阶段设计。截图是交互参考，不将其中的“高”或模型名称固定为产品默认。本批不增加控件、前端状态或相应验收项。
