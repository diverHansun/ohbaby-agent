# 讨论记录与已确认要点

> 2026-11-09 与用户逐项讨论，讨论中随时更新。

## 1. 背景与动机

模型用 `select_tools` 加载 MCP 工具后，“这个会话加载了哪些工具”只记在内存里，按 `(sessionId, contextScopeId)` 分开存：

- `McpToolMenu.loadedByScope`（`packages/ohbaby-agent/src/mcp/integration/dynamic-tool-menu.ts:215`）记加载了哪些，工具列表和 `accessGuard` 都读它；
- `ScopeToolSequence.states`（`packages/ohbaby-agent/src/mcp/integration/tool-sequence.ts:50`）记工具在请求里的顺序。

两者都在 `adapters/ui-runtime/composition.ts:334-335` 新建，没有任何地方从历史重建。所以出现三个问题：

1. daemon 重启、会话恢复后，已加载的工具全部消失。模型照着历史去调用，会被 `accessGuard` 拒绝：“MCP tool is not loaded. Use select_tools to search or load it first.”
2. MCP 刷新失败时 `setAvailable([])` 会清掉所有会话的已加载记录，服务重新连上后这些工具也不会回来。
3. side chat 和 fork 新建会话时拿不到源会话的已加载工具，只能另加 `copyScope` 复制内存状态。

## 2. 已确认的决定

| 编号 | 决策项 | 结论 |
|---|---|---|
| D1 | 数据从哪来 | 从历史重建，不另外存表。只读状态为 completed 的 `select_tools` 工具片段里的 `state.metadata.mcpSelection.loaded`，按时间顺序合并。`alreadyLoaded`、`limitReached`、`unknown`、`candidates` 不读。参考的 codex、kimi-code、ZCode、claude-code 都从历史推导，没有一个另外存 |
| D2 | 压缩后保不保留 | 保留。压缩后的工具列表照样包含已加载的 MCP 工具，学 pi 和 dsh。重建时把已压缩（带 `time.compacted`）的 `select_tools` 片段也算进去，不另存快照 |
| D3 | 改动范围 | 只改“已加载 MCP 工具”的来源。内置工具、skills 清单与正文的加载方式、`mcp-catalog` 提醒、`skill-usage` 提醒都不动。后来 D5（去掉累计上限）、D7（删掉 `ScopeToolSequence`）各多出一项 |
| D4 | 工具暂时不可用 | 学 ZCode：从历史算出的名单不因工具不可用而删减，每次和当前可用工具取交集。MCP 断开时工具从列表里消失，重新连上后自动回来，不用模型重新选。去掉 `setAvailable` 里永久删除已加载记录的逻辑 |
| D5 | 8 个上限 | 去掉会话累计上限 `MAX_MCP_TOOLS_PER_SESSION`，`select_tools` 输出不再有“limit reached”。单次上限 `MAX_MCP_TOOLS_PER_SELECTION` 不动。D3 的改动范围因此多出这一项 |
| D6 | 什么时候算、怎么缓存 | 以历史为准，内存里放的是推导结果（学 dsh、ohbaby 自己的 `TodoService`）。每个 `(sessionId, contextScopeId)` 第一次用到时从历史重建一次，之后缓存；`select` 成功时直接更新缓存。重建复用现有的 `listBySession`，不写专门的查询 |
| D7 | 工具顺序 | 顺序必须和原来一致，否则缓存失效。工具列表每次按固定规则算出：内置工具按注册顺序，后接已加载的 MCP 工具，按它们在历史里第一次被加载的顺序，去掉当前不可用的。删掉 `ScopeToolSequence`。MCP 断开再连上时工具回到原位置，重启、side chat、fork 的顺序与源会话逐字节一致 |
| D8 | 实施顺序 | 本议题独立于 side chat、fork、撤销重发，优先实施。side chat、fork 不再需要 `copyScope` |
| D9 | 作用域 | 缓存按 `(sessionId, contextScopeId)` 分开，和现在一样。主上下文只读 `contextScopeId` 为空的消息，每个子代理只读自己作用域的消息，子代理不继承父会话的已加载工具（kimi-code、ZCode、codex 相同） |
| D10 | 关联文档 | 本会话同步修改 side chat、fork、撤销重发三个议题的文档，并在旧设计文档里把被取代的段落标出来（清单见 02 Stage 3） |

### D1 补充说明

- 失败的调用天然不算数：参数错误时 `select_tools` 直接抛异常，不写 `mcpSelection`；崩溃恢复把未完成的片段改成 error 时，`state.metadata` 已被丢掉。
- 代价：`mcpSelection` 的结构从此是持久化契约，以后改结构要兼容旧数据。`core/context/tool-metadata-projection.ts` 已经在读这个字段。

### D2、D3 补充说明

- 压缩请求本来就能命中缓存：它是正常请求末尾追加一条总结指令，系统提示词和工具列表都不变（`core/context/context-manager.ts:669-692`），实测读缓存 98.95%（[压缩缓存议题 06](../../2026-10-10-compact-cache-and-tool-output/06-overall-acceptance.md) 第 79 行）。要讨论的只是压缩之后。
- kimi-code、codex 压缩时丢掉已加载工具，是因为它们把工具定义放在历史里，顶层工具列表不变，丢了不影响缓存。ohbaby 把已加载工具放在顶层工具列表里，压缩时丢掉会让压缩后的第一次请求从工具列表开始全部失配；模型再选回来，工具列表又变一次。pi、dsh 和 ohbaby 一样把它们放在当前工具集里，压缩后都保留。
- ohbaby 的压缩只打标记、不删历史，所以不用像 pi、ZCode 那样在压缩记录里另存名单。
- 压缩后模型怎么知道哪些工具已加载：看工具列表里的定义，不另加提醒，pi、dsh 也是这样。`mcp-catalog` 提醒照旧只列未加载的工具，压缩把它压掉后会重发。
- `skill-usage` 提醒保留。参考项目都没有这个提醒，但它每次压缩只发一次、放在请求末尾，不影响缓存，而且已经实现并有测试。
- 顺带的好处：重启后工具列表和重启前一致，缓存没过期时可以继续命中。

### D5 补充说明

- 参考的 7 个项目（kimi-code、ZCode、codex、pi、claude-code、dsh、opencode）都没有会话累计上限。codex、pi 的“8”是单次搜索的默认返回数，可以调大；ZCode、claude-code 默认 5，按名字精确选时不截断；kimi-code 不限。claude-code 只在 MCP 工具描述超过一定 token 数时提示，不硬拦。
- ohbaby 的累计上限来自提交 `bcd6492b`（2026-07-14），设计文档（`docs/core/system-prompt/improve-3/02-optimization-plan-and-change-scope.md:90`）只写了数值，没写理由。`docs/mcp/improve-1/01-problem-analysis-and-current-state.md:13` 已把“槽位紧张且不可释放”列为问题。
- 它和“没有卸载”叠在一起，装错几个工具名额就被永久占掉；改成从历史重建后还得定“怎么数”“重连后超了怎么办”。去掉后这些问题都不存在。
- 旧历史里的 `limitReached` 字段照常能读，重建只读 `loaded`。
- 单次上限指一次 `select_tools` 调用最多加载几个工具（`tools` 最多 8 个名字，`query` 的 `limit` 最大 8），不是一次模型请求里能调用几个 MCP 工具。

### D6 补充说明

- 不选“每次请求都扫一遍历史”（kimi-code、ZCode 的做法）：ohbaby 读一次历史要逐条消息查片段再解析 JSON，`resolvePromptTools` 又在读历史之前就要用名单，等于每一步多读一遍完整历史。
- 不写专门的 SQL：每个作用域在进程生命周期内只重建一次，`listBySession` 够用；`part` 表没有作用域列，专门查询还要关联 `message` 表。
- 收集名单是一个纯函数：输入消息列表，按第一次出现的顺序输出已加载的名字，已压缩的片段也算。写法参照 `recoverTodosFromMessages`（`tools/todo.ts`）。
- 缓存清除沿用 `disposeScope`（子代理作用域关闭）、`disposeSession`（会话被删除）。撤销议题在撤销后也调用 `disposeSession`，下次读取时从撤销后的历史重建，不另加入口。
- side chat、fork 的新会话 ID 不在缓存里，第一次用到时从复制过来的历史重建，所以不再需要 `copyScope`。fork 得到的是切点那一刻的名单。
- `select` 先更新缓存、片段后入库。中间崩溃时两者一起丢，重启后从历史重建，仍然一致。`select` 前先检查中断信号；仍有一个小窗口（`execute` 已返回、调度器随后判定中断），片段存成 aborted，本进程里工具仍算已加载、重启后消失，接受（02 §2.6）。
- 读历史出错时发警告、这一次按空名单处理、不写缓存，学 `TodoService`。

### D7 补充说明

- ohbaby 一次请求的发送顺序是工具列表 → 系统提示词 → 消息。Anthropic 按这个顺序缓存，哪一段字节变了，从那里往后全部失效。系统提示词每轮 run 固定，里面没有日期、目录、MCP、skills 清单；会变的内容都以提醒的形式放在消息末尾。
- 参考项目保缓存有两类做法：
  - 工具列表不动，变化作为“新增工具”记录追加在历史末尾：codex（默认模式）、pi、dsh、kimi-code。工具定义不在顶层工具列表里时，只有服务商认这种声明方式，模型才能调用：Anthropic 的 `defer_loading` 与对话中途改工具的 beta、OpenAI Responses 的 `additional_tools`、Kimi 的带 `tools` 的 system 消息，各家格式不同，普通 OpenAI 兼容接口不支持，pi 对不支持的服务商退回发送完整列表。ohbaby 要做就得给每个服务商适配层加新的消息类型、能力开关和退路，[improve-5 02](../../../core/context/improve-5/02-optimization-plan-and-change-scope.md) 第 303 行已定本批不做。本议题不做。
  - 工具列表顺序由固定规则决定，和连接时机无关：claude-code（内置、MCP 各自按名字排序）、ZCode（MCP 按 en-US 名字排序放最后，注释写明“顺序与 server 连接顺序无关”）、codex 普通模式（MCP 按身份排序）。本议题学这一类。
- ohbaby 会话中途不会出现新的内置工具：内置工具、`select_tools`、`skill`、`skill_resource`、`mcp_resource`、`mcp_prompt` 都在启动时注册（`adapters/ui-runtime/composition.ts:1093-1127`、`:1251-1254`）；`skill` 描述变化时重新注册，位置不变。
- MCP 工具按加载顺序而不是按名字排：两种都固定，按加载顺序时新工具总在最后，前面已有工具的字节不变；这也是 [improve-5 00](../../../core/context/improve-5/00-discussion.md) 第 155-163 行原来定的规则。
- 删 `ScopeToolSequence` 的理由：重启、重连后顺序对不上，正是它“新出现的追加到末尾”造成的；它的 `epoch` 生产代码从没读过；内置工具的注册顺序在进程内本来就稳定。

### D9 补充说明

- 主上下文读历史要传 `{ contextScopeId: undefined }`，对应 SQL `context_scope_id IS NULL`；整个参数不传表示“全部作用域”（`core/message/types.ts` 的 `MessageScopeFilter` 注释）。
- 子代理放在同一个子会话里，各自的 `contextScopeId` 等于子代理 ID（`agents/subagent-host.ts:1381-1415`）。子代理作用域关闭时 `disposeScope` 清缓存，之后被继续使用时从历史重建。
- 两个进程同时操作同一个会话时，各自的缓存看不到对方新加载的工具。现在纯内存也是这样，不算倒退，不在本议题处理。

## 3. 边界

| 项 | 处理 |
|---|---|
| 工具列表不动、变化写进历史末尾（`defer_loading`、`additional_tools` 一类） | 不做，要改每个服务商适配层（D7 补充说明） |
| 卸载已加载的工具 | 不做，和现在一样 |
| 单次上限 `MAX_MCP_TOOLS_PER_SELECTION` | 不动 |
| skills、内置工具、`mcp-catalog`、`skill-usage` 提醒 | 不动（D3） |
| 多进程共享同一会话的缓存一致 | 不做（D9） |
