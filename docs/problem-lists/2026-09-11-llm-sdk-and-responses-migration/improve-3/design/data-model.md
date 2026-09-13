# LLM 契约 · 数据语义与字段表

> 这是命名与语义的唯一表。2026-09-13用户已批准§5–6精确结构与有限估算等价；决策索引见../02 §2.10。不允许用unknown/any扩充批准范围。

## 1. 核心概念

- ModelMessage：一次模型请求的消息；不是存储消息。按角色区分字段。
- ModelToolDefinition：模型可以调用的本地工具描述。
- ModelToolCall：收齐的调用描述；参数未必合法，不等于执行授权。
- ParsedToolCall：已解析的调用参数；继续由既有执行链校验权限/工具/schema。
- ModelResponseSnapshot：流截至当前的累计结果，允许未完成；不是可直接回发的 ModelMessage。
- StreamingResponse：保留既有容器名称，不另造同义类型。

## 2. 唯一替换表

| ID | 旧表达 | 目标 | 语义/边界 |
| --- | --- | --- | --- |
| F01 | ChatCompletionMessage / Chat SDK request alias | ModelMessage | 自有role-specific请求类型；精确联合见§5.1–5.2 |
| F02 | messages、role、content | 保留 | system 不提顶层；不统一角色能力 |
| F03 | tools[].type=function + function 外壳 | ModelToolDefinition，无固定 type | 只有当前本地函数工具；wire type 由 adapter 生成 |
| F04 | function.name / description / parameters | name / description / inputSchema | schema 原样，不新增 strict 化 |
| F05 | tool_calls | toolCalls | assistant 专属，有序；不塞 content |
| F06 | 调用 id / 工具结果 tool_call_id | callId | 调用关联，不是消息 ID 或流 index；不改 SQLite ToolPart |
| F07 | function.arguments | argumentsJson | 原始参数文本；历史重建仍可能由已有 input 再序列化，不承诺原始字节持久化 |
| F08 | ParsedToolCall.id | callId | 保留 ParsedToolCall 名称；arguments 仍是解析后对象 |
| F09 | completeMessage（LLM 结果） | messageSnapshot | 唯一累计正文来源；请求/快照类型分开；事件暴露见 01a |
| F10 | ChatFinishReason | ModelFinishReason | 保留 stop/tool_calls/length/content_filter 的既有值与映射 |
| F11 | isComplete / finishReason / streamStopReason / rawFinishReason | 保留 | 流结束不是成功授权；取消也可能 isComplete=true |
| F12 | reasoning（LLM 累计文本）/ reasoningDelta | reasoningText / reasoningTextDelta | 纯文本，不是native reasoning state；只在StreamingResponse外层，见§5.5 |
| F13 | assistant.reasoning_content | reasoningText | adapter 按既有规则映射，不默认跨模型/协议通用 |
| F14 | 内容块 cache_control | cacheControl | 请求控制提示，不是命中事实；精确结构与透传边界见§5.1/5.3 |
| F15 | streamChatCompletion | streamResponse | 已批准；无新增非流式入口 |
| F16 | PreparedModelRequest / InterfaceProviderRequest | 保留 | messages/tools 类型替换；现有请求参数名称保留 |
| F17 | inputTokens/outputTokens/totalTokens/inputBreakdown | 保留 | inclusive usage，不改统计或所有权 |
| F18 | StreamingTokenUsage 的 prompt_tokens/completion_tokens/total_tokens | B批删除旧公开别名 | 不改变canonical usage、持久metadata或统计数值 |
| F19 | 消息 name | 保留 name | 已确认，仅在旧有适用角色；不是为工具结果新增工具名称 |

## 3. 内容与角色规则

以下是主流程目标骨架，完整批准输入联合见§5；保留旧输入已有的name等能力不等于为主流程新增工具结果名称。未登记的兼容冲突仍须显式报告，不以此骨架自动删除能力。

system/developer/user/tool 的 content 必填，可表达字符串或本角色受支持的内容块；assistant 可结合合法工具调用表达无文本。允许空字符串，不自动将 null、缺失、空数组等价化。数组为空可以被类型表达，但具体 adapter 合法性不能绕过。工具结果空字符串不等于缺失结果。

基础文本块使用type=text、text；不trim、不合并、不重排。工具结果继续role=tool、callId、content，不新增name/status/isError。公开旧SDK的多模态及扩展按§5逐项保留/拒绝/明确收窄，不承诺SDK任意输入等价。

## 4. 生命周期与归属

消息没有新数据库 ID、时间戳或 UI 状态。完整请求冻结后只读。快照不得与外层维护两份正文；工具片段可继续用局部 index，不能作为 durable callId。reasoningText 不等于可重放原生状态；cacheControl 不作为 cache 命中统计来源。

## 5. 精确契约 v1（2026-09-13已批准）

用户已接受本节结构、旧能力删除及§6计量匹配边界。§2是旧新命名索引，以下是其精确形状，不建立第二套命名。未列入的能力变更仍需另行讨论。

### 5.1 内容闭集

建议保留现有Chat公开请求的窄输入能力，不新增上传、播放、多模态持久化或模型输出解析。为了KISS，少用的多模态字段本轮保留原拼写/嵌套，但类型由ohbaby自有定义，不导入SDK。接口去耦不要求重命名每个协议时代字段。

| 内容种类 | 精确字段 | 允许角色 |
| --- | --- | --- |
| text | `type: "text"; text: string; cacheControl?: {type:"ephemeral"; ttl?:"5m"|"1h"}; prompt_cache_breakpoint?: {mode:"explicit"}` | system/developer/user/assistant/tool |
| image_url | `type:"image_url"; image_url:{url:string; detail?:"auto"|"low"|"high"}; prompt_cache_breakpoint?:{mode:"explicit"}` | user |
| input_audio | `type:"input_audio"; input_audio:{data:string; format:"wav"|"mp3"}; prompt_cache_breakpoint?:{mode:"explicit"}` | user |
| file | `type:"file"; file:{file_data?:string; file_id?:string; filename?:string}; prompt_cache_breakpoint?:{mode:"explicit"}` | user |
| refusal | `type:"refusal"; refusal:string` | assistant |

`prompt_cache_breakpoint`来自已安装OpenAI 7.13声明，与cacheControl不等价；只保留显式输入透传，不自动生成，不新增对应请求配置。保留原名以免再引入一套缓存命名。cacheControl的ttl闭集已批准，现有5m合同必须覆盖；旧unknown扩展不承诺通用透传。

所有字段只读；不clone成另一个长期状态对象。undefined在序列化时省略，null仅在明确允许处存在；file不新增“至少一个/互斥”校验，image detail不加入original。此闭集描述合法类型，不引入通用递归运行时schema框架；不可信输入仍由具体边界做必要检查。

### 5.2 消息联合

| role | 必填 | 可选 | content数组种类 |
| --- | --- | --- | --- |
| system | role, content:string或数组 | name:string | text |
| developer | role, content:string或数组 | name:string | text |
| user | role, content:string或数组 | name:string | text/image_url/input_audio/file |
| assistant | role | content:string或数组或null；name:string；toolCalls:ModelToolCall[]；reasoningText:string；refusal:string或null；audio:{id:string}或null | text/refusal |
| tool | role, callId:string, content:string或数组 | 无新增消息name | text |

assistant无content只允许既有合法情况（例如有普通toolCalls）；不把audio/refusal输入保留宣传为任意模型都接受该组合。toolCalls若有元素则每个callId/name/argumentsJson均为字符串；自有类型不为所有provider新加通用非空校验，既有adapter及执行链的标识/JSON合法性检查保留。普通输入字符串不trim，不替非法调用补标识。

删除旧function角色、assistant.function_call和历史custom tool call表达：这是已批准的显式API收窄；当前没有完整legacy生成/解析闭环不等于无外部透传用户。保留Chat finish_reason=function_call兼容映射以及Responses的合法同名item。拒绝旧字段时不得悄悄当成普通文本。

### 5.3 各adapter的对应行为

| 内容/扩展 | Chat | Anthropic现状保持 | 受限Responses |
| --- | --- | --- | --- |
| 普通字符串角色 | 原角色发送 | system/developer合并system；tool合成tool_result | 只允许system/user/assistant/tool，developer拒绝 |
| name | 原位置发送 | 当前不传name，保持 | 拒绝额外字段 |
| system/developer/user/assistant的text数组 | 原形状发送 | 按normalizeTextBlocks重建/折叠；无text块拒绝；不新增空字符串检查 | 拒绝 |
| tool的text数组 | 原形状发送 | normalizeToolResultContent拼接text；拼接为空时JSON.stringify原数组，空数组发送字符串"[]" | 拒绝 |
| user多模态数组 | 原形状发送 | 维持已有过滤行为；混合文本不因此新增多模态支持 | 拒绝 |
| assistant audio/refusal等 | 保留显式输入 | 维持当前忽略/内容处理，不新增输出支持 | 拒绝 |
| reasoningText | 映射reasoning_content；返回仍读取原reasoning_content/reasoning | 保持当前不回传该文本的行为 | 显式存在即拒绝，不当空正文处理 |
| text.cacheControl | 映射cache_control，值与附着位置保持 | 普通输入块重建后按原策略生成标记，不统一透传；tool空文本fallback见下 | 拒绝 |
| prompt_cache_breakpoint | 原样发送，仅显式输入 | 普通文本重建不保留；tool空文本fallback仍进入正文，见下 | 拒绝 |

这里的“保持忽略/过滤”是本轮不修历史行为，不是认可其作为长期正确策略。新消息不能不经adapter就承诺跨协议语义等价。字段组合需由T2矩阵逐项验证。

Anthropic tool-result的JSON fallback是另一个必须保持旧拼写的边界：仅在该分支局部将cacheControl恢复cache_control，再生成原数组JSON正文，保留prompt_cache_breakpoint及原字段顺序，不把新命名写进模型看到的工具结果。此处属于真实wire适配，不能调用仅供计量的legacy-estimation helper，也不建整个消息的通用Chat桥。空数组、单个空text、空text携两个缓存控制字段均要有wire回归。

### 5.4 工具精确结构

`ModelToolDefinition = {name:string; description?:string; inputSchema:Record<string,unknown>}`；三个adapter各自恢复原schema外壳与strict行为。仅允许JSON值schema；不改变schema属性顺序、required或额外参数策略。

`ModelToolCall = {callId:string; name:string; argumentsJson:string}`；`ParsedToolCall = {callId:string; name:string; arguments:Record<string,unknown>}`。tool结果就是§5.2对应消息。不为scheduler重命名ResolvedToolCall.id。

### 5.5 最小流结果建议

```ts
interface ModelResponseSnapshot {
  readonly content: string | null;
  readonly toolCalls?: readonly ToolCallSnapshot[];
}
interface ToolCallSnapshot {
  readonly index: number;
  readonly callId?: string;
  readonly name?: string;
  readonly argumentsJson: string;
}
```

这里只新增一个必要的ToolCallSnapshot，避免将缺ID/缺名称的片段冒充完整调用。不新增snapshot ID、phase、版本号、成功布尔值。index是当前流的关联序号，不进入请求或SQLite；数组沿现有排序逻辑。argumentsJson可为未完成字符串，缺片段时为当前累积空串。可选callId/name的缺失与空值按累积器原值映射，不把非法空标识修好后执行。

StreamingResponse保持原容器及retry/tokenUsage/parsedToolCalls/结束字段，唯一累计正文在messageSnapshot.content；reasoningText和reasoningTextDelta只放StreamingResponse外层，不再放快照内重复一份。snapshot是已知assistant输出，不再重复role字段。快照不接收任意多模态请求块，因为当前输出累积器并无这项能力。

| 场景 | snapshot示例 | 外层状态 / 下一轮请求 |
| --- | --- | --- |
| 文本接收中 | `{content:"正在检查"}` | isComplete=false；不得当最终回复续跑 |
| tool-only接收中 | `{content:null,toolCalls:[{index:0,name:"lookup",argumentsJson:"{\"q\":"}]}` | 无callId仍可展示；不能执行或直接回发 |
| 普通工具完成 | `{content:null,toolCalls:[{index:0,callId:"call_1",name:"lookup",argumentsJson:"{\"q\":\"x\"}"}]}` | 仅既有成功/解析门满足时，消费方生成role=assistant、完整toolCalls请求并附工具结果 |
| 用户取消 | 同上任意部分快照 | isComplete=true、streamStopReason=user_aborted，不产生可执行调用，不自动重试 |
| 空文本完成 | `{content:"(Empty response)"}` | 保留现有占位；取消无文本无工具保留(Interrupted)，不顺手清理 |

下一轮请求转换在已有历史serializer或直接多轮调用消费者中完成：加role，丢局部index，仅取已完整校验的调用；保留当前参数文本，不借parsed对象重写它。禁止提供“任意快照转合法请求”的通用自动修复器。lifecycle继续走Message/Part落库与下一次serializer，不直接把snapshot持久化。

观察源：StreamingResponse快照必有；LifecycleEvent的观察投影允许messageSnapshot缺失。delta可用wire已有content构造text快照，complete无正文则省略，不伪造空文本。缺失不代表模型空回复。对应消费者处理可选值，但不新增wire字段。此项已批准。

### 5.6 精确批次截面与命名建议

A即落地§5.5最终快照内层、必要读取适配和安全多轮回传；外层仍可暂叫completeMessage，ParsedToolCall.id暂留。B仅将外层改messageSnapshot、reasoning名称、ParsedToolCall.callId、函数streamResponse及相关事件，不再次改变内层布局。C检查发布入口和全链路。

请求/工具值类型放现有services/interface-providers/types.ts，结果快照放core/llm-client/types.ts，不新增包。toOpenAiTools改toModelTools，streamChatCompletion改streamResponse；StreamingTokenUsage旧公开蛇形别名在B一并删除，归一化TokenUsage与旧数据库codec不动。以上精确命名已获用户批准。

## 6. 旧估算兼容建议（有限且可验证）

在core/context/token-estimation.ts相邻新增私有纯helper文件 `legacy-estimation.ts`（不从公开index导出）。输入自有消息/工具，输出仅供计量的旧形状；不导入SDK，不缓存原对象/wire副本，不参与发送，不新建第二份PreparedModelRequest。

明确映射：toolCalls→tool_calls，callId→id/tool_call_id，name/argumentsJson→function.name/arguments，工具定义还原type=function与function外壳，reasoningText→reasoning_content，cacheControl→cache_control；其余批准字段原值保留。undefined省略、null保留、空串/数组保留、空tools总量不追加JSON、数组/schema/参数内容不改。

主流程旧键顺序：普通消息role/content；工具assistant为role/content/tool_calls/reasoning_content?；调用id/type/function，函数内name/arguments；tool消息role/tool_call_id/content；工具定义type/function，内部name/description/parameters。readonly对象不要求运行期额外复制多份；只生成短命计量材料。

同一helper用于总量、system/history七桶、tail、按来源分组工具和单独reasoning材料。composition重建匹配建议比较两侧还原结果，仍对内容、消息数组顺序、工具定义对应失配返回undefined。键序本身不改字符权重总量，但会影响现有JSON等值比较。

**已批准的有限边界**：保证仓库生产者和批准输入基线的旧数值、七桶及composition有无；不保证任意外部对象仅因键插入顺序不同导致的旧匹配失败继续失败。采用固定字段顺序会使仅键序不同的对象匹配，这是匹配边界收口，不冒充完全无行为变化。不支持prototype/getter/toJSON/任意扩展的兼容承诺。不加隐藏原始对象副本；若实施发现此边界之外的数值变化，仍须停并报告。

退出条件：后续统计轮建立实际provider投影计量后，通过对应回归再删除此私有helper；本轮禁止把它扩展为通用Chat转换器。
