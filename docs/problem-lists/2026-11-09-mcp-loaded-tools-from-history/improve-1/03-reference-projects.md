# 3. 参考项目

> 2026-11-09 至 11-10 调研，项目都在 `code-cli/` 下。行号是调研时的快照。

## 3.1 调研范围

| 项目 | 看了什么 |
|---|---|
| codex（`codex-rs`） | `tool_search`、压缩（remote v2、本地）、world state、工具列表组装、skills |
| kimi-code（`packages/agent-core-v2/src`） | `select_tools`、`collectLoadedDynamicTools`、压缩交接、工具快照、skills |
| ZCode（`apps/zcode-cli`） | `ToolSearch`、`tool/search/history.ts` 与 `CONTRACT.md`、压缩检查点、工具排序 |
| deepseek-harness（dsh） | `ToolHistoryProjection`、动态工具更新、压缩请求、系统提示词替换 |
| pi（`packages/coding-agent`、`ai`、`agent`） | `tool_search` 扩展、压缩快照、工具增减的传输方式 |
| claude-code（fork） | `SearchExtraTools`、`preCompactDiscoveredTools`、工具排序 |
| opencode | 只确认没有这套机制 |

## 3.2 已加载工具从哪来

| 项目 | 来源 | 内存里有没有权威副本 |
|---|---|---|
| codex | 不单独记。`tool_search` 的结果（带完整定义）留在历史里，服务端看到就当已加载（`core/tests/suite/search_tool.rs:813`） | 没有 |
| kimi-code | 每次请求扫历史：带 `tools` 的 system 消息减去“已移除”公告（`agent/toolSelect/dynamicTools.ts:102-134`）。设计笔记写明“不提前计算或缓存工具列表”（`todo.md:64-82`） | 没有 |
| ZCode | 每次请求扫历史：非错误工具结果里的 `tool_reference`，加上压缩检查点（`tool/search/history.ts:30-46`）。`CONTRACT.md:6-7`：原始历史及压缩元数据是唯一来源，投影不增加共享状态 | 没有 |
| claude-code | 按需扫历史：`extractDiscoveredToolNames`（`src/utils/searchExtraTools.ts:489-555`） | 没有 |
| dsh | 事件日志为准，`ToolHistoryProjection` 是增量推导出的缓存（`packages/core/session/src/index.ts:958-972`） | 有缓存，不权威 |
| pi | 工具增减作为 system 消息记在对话里，重放即得当前工具集（`ai/src/types.ts:559-585`） | 没有 |

**借鉴**：以历史为准（00 D1）。像 dsh、ohbaby 自己的 `TodoService` 那样缓存推导结果（00 D6）。
**不借鉴**：kimi、ZCode 每次请求都扫一遍。ohbaby 读历史要逐条消息查片段，而且工具列表在读历史之前就要用。

## 3.3 压缩

| 项目 | 压缩请求 | 压缩后已加载工具 |
|---|---|---|
| codex | remote v2：上次请求 + 一条触发项，工具不变（`compact_remote_v2_attempt.rs:172-188`）；本地压缩不带工具 | 丢掉，模型重新搜索 |
| kimi-code | 完整历史 + 末尾指令，和正常请求走同一个组装点（提交 #4410、#4456） | 丢掉，重新公告可加载名单（提交 9b76e5bff） |
| dsh | 回放前缀 + 末尾指令（`compaction-basic/src/summarizer.ts:24-31`） | 当前所有工具重新作为基线声明 |
| pi | 单独的小请求，不带工具、不写缓存（`compaction.ts:626-632`） | 保留，压缩记录里存一份系统提示词和工具集快照 |
| ZCode | 工具段与主循环相同 | 保留，压缩检查点 `preCompactDiscoveredTools` |
| claude-code | — | 保留，压缩标记里存一份 |

几家压缩时都会丢掉旧历史，区别是之后怎么让模型知道有哪些工具：存快照或检查点，或者公告后让模型重选。kimi、codex 能直接丢，是因为已加载工具的定义在历史里，顶层工具列表不变，丢了不影响缓存。

**借鉴**：pi、dsh 的保留（00 D2）。ohbaby 的已加载工具在顶层工具列表里，丢掉会让压缩后的请求从工具列表开始失配。ohbaby 压缩不删历史，不用另存快照。

## 3.4 工具不可用、上限

| 项目 | 断开再连上 | 会话累计上限 |
|---|---|---|
| ZCode | 名单不删，每次和当前可用工具取交集，自动回来 | 无 |
| kimi-code | 发“已移除”公告并从名单删掉，连上后要重选（`dynamicTools.test.ts:198-212`） | 无 |
| codex | 定义留在历史，调用不存在的工具报错 | 无；单次默认 8，可调大 |
| pi | 不注册改为隐藏，回来时重新声明 | 无；单次默认 8，可调大 |
| claude-code | 状态里追加，组装时重新按名字排序 | 无；只在 MCP 工具描述过多时提示 |
| dsh、opencode | 没有让模型选的工具 | 无 |

**借鉴**：ZCode 的取交集（00 D4）；去掉累计上限（00 D5）。
**不借鉴**：kimi 的“断开即删、回来重选”。它这样做是为了和公告保持一致，ohbaby 没有这套公告。

## 3.5 工具顺序与缓存

| 项目 | 做法 |
|---|---|
| codex 默认模式、pi、dsh、kimi-code | 顶层工具列表不动，工具增减作为记录追加在历史末尾。依赖服务商支持在对话中途声明工具：Anthropic `defer_loading` 与 `mid-conversation-tool-changes` beta、OpenAI Responses `additional_tools`、Kimi 带 `tools` 的 system 消息；普通 OpenAI 兼容接口不支持，pi 只能退回发送完整列表 |
| claude-code | 内置工具按名字排序，后接 MCP 工具按名字排序，注释写明为了缓存稳定（`src/tools.ts:387-399`）；重连后回到原位 |
| ZCode | 规定名单按名字排，其他按注册顺序，MCP 工具按 en-US 名字排序放最后，“顺序与 server 连接顺序无关”（`tool/provider-visible-order.ts:39-66`） |
| codex 普通模式 | MCP 工具按身份排序（`codex-mcp/src/tools.rs:197`） |

**借鉴**：顺序由固定规则算出、与连接时机无关（00 D7）。MCP 工具按历史里的加载顺序，而不是按名字：两者都固定，按加载顺序时新工具总在最后。
**不借鉴**：工具列表不动、变化写进历史。要改每个服务商适配层，范围太大。

## 3.6 skills 与提醒

| 项目 | skills 清单 | 压缩后的 skill 正文 |
|---|---|---|
| codex | developer 消息，压缩后完整重发 | 丢，不提醒 |
| pi | 系统提示词的一节，压缩不影响 | 丢，不提醒；摘要里列出读过的文件 |
| kimi-code | 系统提示词，冻结 | 模型调用的丢，用户斜杠命令的保留；不提醒 |
| dsh | 存入历史的提醒，压缩后重新发布 | 丢，不提醒 |
| ohbaby | `skill` 工具描述，压缩不影响 | 丢；`skill-usage` 提醒列出正文已不在的 skill |

**结论**：skills 的加载方式不用改（00 D3）。`skill-usage` 提醒是 ohbaby 独有的，保留。

## 3.7 子代理与 fork

所有项目里，全新启动的子代理都不继承父会话的已加载工具；fork 靠复制历史继承。ohbaby 做法相同（00 D9）。
