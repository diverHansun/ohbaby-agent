# 2. 迁移方案与关键改动

> 2026-09-13用户已批准精确契约与命名。字段定义唯一来源为design/data-model.md；真实矩阵见04 §4.6。实施仍以前置improve-2验收及合入集成分支为条件，improve-3完成后不自动合并。

## 2.1 总览

保持历史模型和各 adapter，改 LLM 边界；不把消息 SDK alias 换名后继续传递。公开旧入口删除，仓库调用方全部迁移。新旧能力差异必须显式批准。

## 2.2 决策与取舍

| 决策 | 理由 | 放弃 / 代价 |
| --- | --- | --- |
| system 留有序 messages，内容不统一数组 | 减少顺序/空值变化 | adapter 继续维护自身差异 |
| tool 定义扁平、调用独立 | 消除协议外壳 | 不承诺原生 item 交错回放 |
| 快照和请求语义分开 | 部分参数不是有效请求 | 只做必要类型，不造阶段对象家族 |
| 估算旧口径局部还原 | 防止重命名改变压缩 | 有限过渡债；下一轮统计对齐后移除 |
| 删除旧公开 API | 避免永久双轨 | 外部用户须迁移；记录 release 说明，不自动发布 |

## 2.3 三批实施

### A 请求与 adapter

修改 provider 契约、三个 adapter、context serializer、message converter、工具投影及 summary/title 请求入口；同步必要 estimator/缓存读取适配，不能把类型改坏留到 C。多轮调用存在将回复直接加入下一次请求的消费者，必要assistant回复结构和消费适配必须随A完成；不是“输入改完、输出全留B”。外层结果字段改名仍在B。详见 [跨模块依赖清单](./02a-cross-module-interface-migration.md)。

DoD：该批仓库可编译运行；三协议 wire 与接受/拒绝矩阵保持；估算与缓存不回归；单元+集成+只读子代理审查后 commit。生产估算桥如随请求变更需要，在 A 最小落地，C 做完整收口。

### B 结果与消费者

完成 F09–F12 的外层结果/命名、lifecycle/AgentRun 暴露、反向桥构造、辅助响应读取；F13请求侧reasoning映射随A，不能误留B。A已完成的内层结构不重复迁移。保留流状态机及授权条件，按 U4 决定观察快照缺失表达。

DoD：取消/重试/错误/工具闭环、真实与观察两条消费路径通过；SQLite JSON/SDK wire 不变；单元+集成+审查后 commit。

### C 兼容与导出收口

完成公开入口删除、间接调用和发布包消费者测试、全量估算/分类等价、模块文档同步。不能将 A/B 的必要适配推迟到 C 使前两批不可运行。

DoD：全部本轮测试和独立审查通过；全量 preflight、真实/可控 LLM E2E 分开记录；然后本轮验收。不是整体 Responses 迁移完成。

## 2.4 目录改动面

`services/interface-providers`、`core/llm-client` 是核心；`core/context`、`core/message` 的模型投影、`core/agents`、`core/lifecycle`、`adapters/ui-runtime`、`services/session`、runtime 类型为连带适配。不修改 database migrations/schema、UI 展示、模型配置默认值。不新增 package/service/manager。

## 2.5 兼容与协议

SQLite Message/Part JSON、usage metadata、scope/order/compact 标记不改。旧会话读入新投影、新回复写回旧格式并 reopen。API 删除不授权数据迁移。

Chat 原 SDK 输入允许 image/input_audio/file、name、audio/refusal、legacy function/function_call 等；Chat adapter 当前透传。不得称文本/普通工具子集为完整等价，先 U1。Anthropic 的文本过滤、缓存重建和 Responses 严格拒绝保持现状；发现旧缺陷登记，不顺手修。

## 2.6 风险与回滚

改名影响 JSON 估算、工具授权、公开消费者、观察快照；分别由 T3/T4/T6/T7 防护。分批本地提交，回滚应回退完整相依批次；不执行破坏性 reset，不触碰用户未提交文件。无计划内数据库 migration。真实 E2E 只用无副作用工具；缺凭据记未执行，不当通过。

## 2.7 对齐检查

全部已确认语义在字段 F01–F19 与 design 中登记。当前命名候选不等于 U 项已关闭。KISS 不等于少写验证，也不等于对外默默丢字段。

## 2.8 本轮不做

精确计数/实际 wire 统计投影、校准算法、cache 请求/统计策略、原生 reasoning/phase/签名/服务端续接、hosted tools、压缩/调度重写、SQLite schema、默认翻转、UI 新功能。未来候选仅登记，不在本轮预建实现。

## 2.9 关键改动条目

> 路径前缀 packages/ohbaby-agent/src；行号是 a18290f3 快照，以符号为准；非进度表。

| ID | 文件 / 符号 | 行号 | 改动与约束 |
| --- | --- | --- | --- |
| C1 | services/interface-providers/types.ts InterfaceProviderRequest | 90 | F01–F08/F16；无 SDK alias |
| C2 | core/llm-client/types.ts、streaming.ts、index.ts | 29/155；252 | F09–F15；唯一快照、既有中断/授权 |
| C3 | core/context/serializer.ts serializeForLlm/serializeAssistantMessage | 50/127 | system顺序、null/tool-only、active reasoning保持 |
| C4 | core/context/token-estimation.ts 两个 estimator | 43/56 | 总量、七桶及缺失条件保持；U5 |
| C5 | core/lifecycle/types.ts、lifecycle.ts | 167；1004 | 事件/落库/工具调用映射；不改数据库JSON |
| C6 | adapters/ui-runtime/stream-bridge-run-event-source.ts | 131 | 观察源缺失字段按 U4，不伪造真实结果 |
| C7 | core/llm-client/prompt-cache.ts；provider wire converters | 274 | cache target/标记和strict行为不变 |
| C8 | index.ts；core/agents/types.ts | 94；53 | 根导出与间接公开类型，构建消费者测试 |
| D1 | docs/core/llm-client/{goals-duty,architecture,data-model,dfd-interface,test}.md | 当前全文 | 实施后同步真实契约和retry职责 |

连带：core/agents/runner.ts 的工具投影、core/message converter/manager接口、context types/manager、ui-runtime composition/prompt-context、title-generator、run-manager worker/types、相关 fixtures。只改必要接口，不机械移动文件。

## 2.10 已批准的精确决策

| ID | 未决 | 推荐下一步 |
| --- | --- | --- |
| U1 | 已批准：§5.1–5.2保留name、多模态及refusal/audio窄输入；删除legacy function/function_call及历史custom tool call | 角色闭集明确；不得删除Responses同名item或Chat结束原因映射 |
| U2 | §5.1/5.3提出cacheControl ephemeral、ttl可省略或5m/1h；prompt_cache_breakpoint保留原名和闭集 | 不统一三adapter策略；特别保留Anthropic tool-result空文本JSON fallback的旧字段拼写 |
| U3 | §5.5提出content与可选toolCalls的最小快照，reasoning仅在StreamingResponse外层 | 部分callId/name可缺失，正文只一份；A完成内层，B改外层，不以快照完整度替代授权 |
| U4 | 已批准：观察桥complete无正文/调用 | 仅观察LifecycleEvent可缺snapshot；StreamingResponse仍必有 |
| U5 | 已批准：§6私有legacy-estimation.ts及有限等价边界；类型落点见§5.6 | 保持生产基线数值/七桶/缺失；仅键插入顺序导致的旧匹配失败不保证保留；不维护原对象副本 |
| U6 | 已批准：streamResponse、toModelTools及B删除公开usage旧别名；ZenMux矩阵见04 §4.6 | 只删除StreamingTokenUsage旧别名，不改变canonical usage数值与旧数据库codec；真实结果仍待执行，不把配置完成当通过 |

以上§5/§6均指design/data-model.md。2026-09-13精确提案经子代理复核后获用户批准，包括U2控制字段闭集和U3快照布局。此表记录批准的设计，不是实施进度表。

本轮残余及移交条件见next-stage-candidates.md §7；improve-3独立验收后，仍须用户审查并确认improve-4计划才可合入集成分支。
