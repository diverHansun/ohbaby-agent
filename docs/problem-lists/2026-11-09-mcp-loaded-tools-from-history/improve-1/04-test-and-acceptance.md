# 4. 测试与验收

> 对应 [02](02-optimization-plan-and-change-scope.md) 的 Stage 1 至 3。测试和源码放在同一目录，`*.unit.test.ts`、`*.integration.test.ts`。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| unit | 收集函数；`McpToolMenu` 的重建、缓存、取交集、并发、清缓存 |
| integration | 用真实 SQLite 库和 composition：重启后重建、压缩后保留、断开再连上、工具顺序逐字节一致、子代理作用域 |
| 手工 | 真实 daemon 上加载一个 MCP 工具，重启 daemon 后继续调用 |

## 4.2 关键场景

### Stage 1：从历史重建

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T1 | 收集规则 | unit | 输入若干消息：completed 的 `select_tools` 片段按出现顺序收集 `loaded`，重复的名字只记第一次；error、aborted 片段，`mcpSelection` 缺失或形状不对的片段，`alreadyLoaded`、`limitReached`、`unknown`、`candidates` 里的名字都不算；带 `time.compacted` 的片段照样算 |
| T2 | 重启后重建 | integration | 会话里加载两个 MCP 工具并调用过；用同一个数据库新建 composition（模拟重启），等 MCP 刷新完成后：第一次请求的工具列表里有这两个工具；调用它们不被 `accessGuard` 拒绝；`mcp-catalog` 提醒不列它们 |
| T3 | 压缩后保留 | integration | 加载工具后触发压缩，`select_tools` 片段被标记为已压缩；再模拟重启：已加载工具还在，工具列表与压缩前相同 |
| T4 | 断开再连上 | unit + integration | 加载 A、B 后 `setAvailable` 去掉 A：工具列表只有 B，名单仍含 A；再把 A 加回 available：A 回来，不用重新 `select_tools`。`setAvailable([])`（刷新失败）后再恢复，同样回来 |
| T5 | 并发加载 | unit | 作用域还没加载时，同时发两次 `select_tools`（4 个和 5 个名字）：历史只读一次；9 个名字都加载成功；输出里没有“limit reached” |
| T6 | 加载中途清缓存 | unit | `ensureLoaded` 的读历史还没返回时调用 `disposeSession`：读历史返回后结果不写回缓存，下一次 `ensureLoaded` 重新读历史 |
| T7 | 没有累计上限 | unit | 同一作用域分几次加载超过 8 个工具：全部加载成功；单次传 9 个名字仍然报错（单次上限不变） |
| T8 | 作用域隔离 | integration | 主上下文加载 A，子代理作用域加载 B；重启后主上下文只有 A，子代理只有 B；主上下文读历史只读 `context_scope_id IS NULL` 的消息 |
| T9 | 旧数据 | unit | 历史里是旧版本写入的 `mcpSelection`（带 `limitReached`）：照常收集 `loaded`；`tool-metadata-projection.unit.test.ts` 不改仍通过 |
| T10 | 清缓存后重建 | unit | `disposeSession` 后再读：从当前历史重建。模拟撤销：删掉后半段历史再 `disposeSession`，名单只剩前半段加载的工具 |
| T15 | 读历史出错 | unit | `listBySession` 第一次抛错：发出警告，这一步按空名单处理，不写缓存；第二次正常返回时名单恢复 |
| T16 | 中断的 `select_tools` | unit | `execute` 等待 `ensureLoaded` 时中断信号触发：抛错，缓存里没有新名字。等待期间作用域被 `disposeSession` 清掉：`select` 报“作用域已释放”，缓存不变 |

### Stage 2：工具顺序

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T11 | 重启后顺序一致 | integration | 依次加载 C、A、B（每次一个 `select_tools`）；记录工具列表；模拟重启并等 MCP 刷新完成后，第一次请求的工具列表与之**逐字节一致**（内置工具在前、按注册顺序，后接 C、A、B） |
| T12 | 重连后回到原位 | integration | 加载 A、B、C 后 B 断开再连上：工具列表回到 `…A、B、C`，与断开前逐字节一致 |
| T13 | 新加载追加在最后 | integration | 已有 A、B 时加载 C：C 在最后，A、B 之前的字节不变 |
| T14 | `ScopeToolSequence` 已删 | 检查 | 源码里没有 `ScopeToolSequence`、`tool-sequence`；`composition.unit.test.ts` 不再 spy 它 |

### Stage 3：关联文档

| ID | 检查 |
|---|---|
| DOC1 | side chat 02、04 和 fork 00、02、04 里没有 `copyScope`；它们写明依赖本议题 |
| DOC2 | 撤销重发 02 写明撤销后调用 `mcpToolMenu.disposeSession` |
| DOC3 | improve-3、improve-5、`docs/mcp/` 里讲累计上限、重启清空、`ScopeToolSequence` 的段落都标注了已被本议题取代 |

## 4.3 集成边界

| 边界 | 验证 |
|---|---|
| `McpToolMenu` ↔ 消息存储 | 只用 `listBySession`，主上下文传 `{ contextScopeId: undefined }`（T8） |
| `McpToolMenu` ↔ composition 三个读取方 | 读名单前都已 `ensureLoaded`（T2、T5） |
| 压缩 | 压缩不碰 `McpToolMenu`；已压缩片段计入名单（T3） |
| 提示词缓存 | 工具列表逐字节一致（T11、T12） |

## 4.4 回归清单

- `dynamic-tool-menu.unit.test.ts`：准入、搜索、精确加载、作用域隔离、清缓存的原有用例保留，按新接口调整：`select` 改成 `await`；`:216`、`:401` 里同步的 `expect(() => tool.execute(...)).toThrow` 改成 `await expect(...).rejects`；`new McpToolMenu()` 不传参数仍可用（历史为空）。`:179` 累计上限用例删除，`:405` 改成 T5。
- `composition.unit.test.ts`：“announces unloaded MCP names, then exposes schemas only after selection”（:2216）、“refreshes the bounded catalog…”（:2297）等 `select_tools` 用例通过。
- `core/context` 的提示词缓存合约测试（`prompt-cache-wire.contract.test.ts`）和压缩请求测试（`summary-request.integration.test.ts`）通过：摘要请求的工具列表仍等于正常请求的。
- `TodoService`、`skill-usage`、`mcp-catalog` 提醒的测试通过。

## 4.5 发布门

- `pnpm test`、`pnpm test:integration`、`pnpm test:contract` 全部通过；类型检查、lint 通过。
- T1 至 T16 通过。
- 手工：真实 daemon 上加载一个 MCP 工具并调用，重启 daemon，同一会话继续调用这个工具成功，不需要再 `select_tools`。

## 4.6 对抗性审查要点

- **名单和历史不一致**：`select` 更新缓存，片段稍后入库。中途崩溃时两者一起丢；重启后以历史为准。审查时确认没有其他路径只改缓存不写历史。
- **主上下文读成全部作用域**：`listBySession(sessionId)` 不传参数会把子代理的 `select_tools` 也算进主上下文。T8 必须覆盖。
- **顺序悄悄变化**：任何让工具列表顺序依赖内存状态或注册时机的改动，都会破坏 T11、T12。
- **重连判断**：名单不删减后，断开期间 `loadedNames` 必须取交集，否则工具列表里会出现不存在的工具。
- **单次上限误删**：只删累计上限，单次上限和它的报错保留（T7）。
- **工具 schema 被改写**：删掉 `ScopeToolSequence` 后工具定义不再复制、冻结，确认 `ohbaby-llm` 各服务商适配层只读不改 `parameters`。
- **固定工具被当成 MCP 过滤掉**：`mcp_resource`、`mcp_prompt` 的 `source` 也是 `"mcp"`，固定工具按 `registeredMcpToolNames` 区分。
- **撤销**：撤销议题落地时，若漏掉 `disposeSession`，撤销前加载的工具还会留在列表里。撤销议题的测试要覆盖。
