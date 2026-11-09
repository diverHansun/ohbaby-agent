# 2. 方案与改动面

> 给实施会话的契约。决定的来由见 [00](00-discussion.md)，现状见 [01](01-problem-analysis-and-current-state.md)，验收见 [04](04-test-and-acceptance.md)。代码路径省略 `packages/ohbaby-agent/src/` 前缀。本议题没有要求关键改动清单，只写到文件一级。

## 2.1 方案总览

已加载的 MCP 工具以历史为准：从 `select_tools` 片段的 `mcpSelection.loaded` 推导，内存里只放推导结果。工具顺序每次按固定规则算出，不再记在内存里。

```
历史（数据库）                                    内存缓存（McpToolMenu）
select_tools 片段 ──collectLoadedMcpToolNames──▶ 每个 (sessionId, contextScopeId)
  state.metadata.mcpSelection.loaded              一份有序名单
  （已压缩的也算）                                  第一次用到时重建，select 时追加
                                                          │
                              loadedNames(scope) = 名单 ∩ 当前可用 MCP 工具
                                                          │
          ┌───────────────────────────┬───────────────────┴───────────────┐
     accessGuard                resolvePromptTools                resolveMcpToolNames
   不在名单里就拒绝     [内置工具（注册顺序）, 已加载 MCP（名单顺序）]   mcp-catalog 提醒
```

改完后：

| 场景 | 已加载工具 | 工具顺序 |
|---|---|---|
| daemon 重启、会话恢复 | 从历史重建，不丢 | 与重启前一致 |
| 压缩 | 保留（已压缩的片段也算） | 不变 |
| MCP 断开 | 暂时不在列表里，名单不删 | 去掉这个工具，其余不动 |
| MCP 连回来 | 自动回来，不用重新选 | 回到原位置 |
| side chat、fork | 从复制过来的历史重建 | 与源会话一致 |
| 子代理 | 只看自己作用域的历史，不继承父会话 | 各自计算 |

## 2.2 设计决策表

| 决策 | 结论 | 依据 |
|---|---|---|
| 数据来源 | 历史里状态为 completed 的 `select_tools` 片段的 `state.metadata.mcpSelection.loaded` | 00 D1 |
| 压缩 | 保留；收集时不过滤 `time.compacted` | 00 D2 |
| 范围 | 只改已加载 MCP 工具的来源，外加去掉累计上限、删掉 `ScopeToolSequence` | 00 D3、D5、D7 |
| 不可用的工具 | 名单不删，读取时和当前可用工具取交集 | 00 D4 |
| 累计上限 | 删除 `MAX_MCP_TOOLS_PER_SESSION`；单次上限不动 | 00 D5 |
| 缓存 | 每个作用域第一次用到时用 `listBySession` 重建一次，之后缓存；同一作用域同时只跑一次加载 | 00 D6 |
| 顺序 | 内置工具按注册顺序，后接已加载 MCP 工具，按历史里第一次加载的顺序 | 00 D7 |
| 实施顺序 | 先于 side chat、fork、撤销重发实施 | 00 D8 |
| 作用域 | 按 `(sessionId, contextScopeId)` 分开 | 00 D9 |

## 2.3 分阶段实施

三个 Stage 在同一轮内完成，可以合成一个 PR。

### Stage 1：已加载名单从历史重建

1. **收集函数**：在 `mcp/integration/dynamic-tool-menu.ts`（或旁边新文件）新增纯函数 `collectLoadedMcpToolNames(messages: readonly MessageWithParts[]): string[]`：
   - 按消息顺序、每条消息内按片段顺序遍历；
   - 只看 `type === "tool"`、`tool === "select_tools"`、`state.status === "completed"` 的片段；
   - 读 `state.metadata.mcpSelection.loaded`，只取字符串，按第一次出现的顺序去重；
   - **不**过滤 `time.compacted`；不读 `alreadyLoaded`、`limitReached`、`unknown`、`candidates`；
   - 字段缺失或形状不对时跳过这个片段，不抛异常。
2. **`McpToolMenu` 接入历史**：构造时注入只读的历史接口，参照 `TodoService`（`tools/todo.ts`）的写法：
   - 构造参数 `{ history?: McpToolMenuHistory; onError?: (error: unknown) => void }`，在 `adapters/ui-runtime/composition.ts:334` 传入 `options.messageManager`，`onError` 接到 `options.onNotice` 发警告。不传 `history` 时当作历史为空，单元测试可以继续 `new McpToolMenu()`；
   - `loadedByScope` 的值保持 `Set`（它保留插入顺序），语义改为“历史里出现过的全部名字”，不再删减；
   - 新增 `ensureLoaded(scope): Promise<void>`：缓存里没有这个作用域时，调用 `history.listBySession(scope.sessionId, { contextScopeId: scope.contextScopeId })` 读历史，再用收集函数算出名单写进缓存。主上下文必须传 `{ contextScopeId: undefined }` 这个对象，整个参数不传会读到所有作用域；
   - 同一作用域同时只跑一次加载（保存进行中的 Promise）。加载期间如果这个作用域被 `disposeScope` 或 `disposeSession` 清掉，加载结果不写回缓存（用代数或比对 Promise 判断）；
   - 读历史出错时学 `TodoService.loadFromHistory`：调用 `onError` 发警告，这一次按空名单处理，**不写缓存**，下次再读历史重试。不能把空名单缓存下来，否则一次偶发错误会让这个进程里的已加载工具全部丢失。
3. **读取方先确保已加载**：
   - `accessGuard`（`composition.ts:414-425`）现在是同步函数，改成 `async`（类型 `core/tool-scheduler/types.ts:383-386` 允许返回 Promise），调用 `loadedNames` 前 `await mcpToolMenu.ensureLoaded(scope)`；
   - `resolvePromptTools`（`:569-603`）、`resolveMcpToolNames`（`:634-655`）已经是异步函数，同样先 `await ensureLoaded`；
   - `select` 改成异步，自己先 `await this.ensureLoaded(scope)`，之后的判断和写缓存是同步的，并发的两次 `select_tools` 不会互相覆盖。等待期间作用域被清掉（会话被删、子代理作用域释放）时，`select` 抛出“作用域已释放”的错误，这次调用记为失败；
   - `select_tools` 的 `execute` 改成异步：`await menu.select(...)` 之前先检查 `context.signal.aborted`，已中断就抛错，不再改缓存。
4. **`loadedNames`** 返回 `名单 ∩ available ∩ candidates`，按名单顺序。和现在的签名一样，只是名单不再被删减。
5. **`setAvailable`** 删掉“从各作用域的名单里删除不可用名字”那段（`dynamic-tool-menu.ts:228-234`）。`clearMcpTools` 调用 `setAvailable([])` 时只清 available，名单不动。
6. **去掉累计上限**：删除 `MAX_MCP_TOOLS_PER_SESSION`（含 `mcp/index.ts:23` 的导出）及 `select()` 里的检查（:277-288）。`McpToolSelection.limitReached` 字段和输出里的“Session/context scope tool limit reached”一并删除。`tool-metadata-projection.ts` **不改**：它用 `stringArray` 读 `limitReached`，新数据没有这个字段时投影出 `limitReached: []`，和现在发给模型的字节相同，历史投影因此不变。
7. **清缓存的入口**：`disposeScope`、`disposeSession` 保持现有调用点（`composition.ts:891`、`:1025`）。撤销重发议题在撤销完成后调用 `mcpToolMenu.disposeSession(sessionId)`，下一次读取会从撤销后的历史重建（写进撤销议题 02，见 Stage 3）。

### Stage 2：工具顺序按规则计算，删除 `ScopeToolSequence`

1. `resolvePromptTools`（`composition.ts:569-603`）直接返回 `[...staticTools, ...loadedDefinitions]`：
   - `staticTools` 是 `toolScheduler.getAvailableTools` 的结果去掉 `registeredMcpToolNames` 里的工具（和现在 `composition.ts:588` 一样），保持注册顺序。不要按 `source === "mcp"` 过滤，`mcp_resource`、`mcp_prompt` 的 `source` 也是 `"mcp"`，它们属于固定工具；
   - `loadedDefinitions` 按 `loadedNames` 的顺序（历史里第一次加载的顺序）取工具定义。
2. 删除 `mcp/integration/tool-sequence.ts`、`tool-sequence.unit.test.ts`；删除 `mcp/index.ts:32-33` 的导出；删除 `composition.ts` 里 `scopeToolSequence` 的创建（:335）、`disposeScope`（:892）、`disposeSession`（:1026）三处调用。
3. `composition.unit.test.ts`：删掉 `:36` 的导入、`:835-838` 和 `:1166-1169` 对 `ScopeToolSequence.prototype` 的 spy、`:890` 和 `:1255` 对应的断言。
4. 删掉 `ScopeToolSequence` 后，工具定义不再被复制和冻结，`parameters` 对象与注册表共用。确认各服务商适配层只读不改工具 schema（04 §4.6）。

### Stage 3：关联文档同步

| 文档 | 改动 |
|---|---|
| [side chat 02](../../2026-11-04-side-chat/improve-1/02-optimization-plan-and-change-scope.md) Stage 1 第 5a 步“工具定义” | 删掉两个 `copyScope`，改为依赖本议题：side chat 第一次用到时从复制来的历史重建 |
| [side chat 04](../../2026-11-04-side-chat/improve-1/04-test-and-acceptance.md) T13b | 保留“逐字节一致”，前置条件改成本议题已落地 |
| [fork 00](../../2026-11-04-session-fork/improve-1/00-discussion.md)、[02](../../2026-11-04-session-fork/improve-1/02-optimization-plan-and-change-scope.md) 第 38、61、159 行、[04](../../2026-11-04-session-fork/improve-1/04-test-and-acceptance.md) T12b | 删掉 `copyScope`；§2.8 的“另立议题”指向本议题；T12b 改为验证“从复制来的历史重建出切点时的名单和顺序” |
| [撤销重发 02](../../2026-11-04-conversation-undo/improve-1/02-optimization-plan-and-change-scope.md) | 撤销完成后，除了 `todoService.release`，再调用 `mcpToolMenu.disposeSession(sessionId)` |
| `docs/core/system-prompt/improve-3/02-optimization-plan-and-change-scope.md` 第 90、93、183 行 | 标注“已被本议题取代”：没有累计上限；已加载名单以历史为准，重启不清空 |
| `docs/core/context/improve-5/` 00 第 155-163 行、01 §1.7、02 §2.7.1、README | 标注：`ScopeToolSequence` 已删，顺序按注册顺序和历史计算，重启后顺序不变 |
| `docs/mcp/` data-model（第 35、164 行）、architecture、dfd-interface、improve-1 README | 已加载名单以历史为准；没有累计上限；`mcpSelection` 没有 `limitReached`（旧数据可能有） |

规划会话已按上表改好 side chat、fork、撤销重发三个议题和旧设计文档的标注（00 D10），实施会话只需在代码落地后核对一遍。

## 2.4 按包的改动面

| 包 / 文件 | 改动 |
|---|---|
| `mcp/integration/dynamic-tool-menu.ts` | 收集函数；`McpToolMenu` 注入历史、`ensureLoaded`、名单不删减；删累计上限和 `limitReached`；`select_tools` 执行改异步 |
| `mcp/integration/tool-sequence.ts` 及测试 | 删除 |
| `mcp/index.ts` | 删 `ScopeToolSequence` 导出 |
| `adapters/ui-runtime/composition.ts` | 构造 `McpToolMenu` 时传历史；三个读取方先 `ensureLoaded`；`resolvePromptTools` 不再经过 `ScopeToolSequence` |
| `mcp/integration/dynamic-tool-menu.unit.test.ts`、`adapters/ui-runtime/composition.unit.test.ts` | 按 04 调整 |
| 其他包 | 不动。`ohbaby-llm`、服务商适配层、提醒、skills 都不改 |

## 2.5 接口

```ts
// dynamic-tool-menu.ts
export function collectLoadedMcpToolNames(
  messages: readonly MessageWithParts[],
): string[];

export interface McpToolMenuHistory {
  listBySession(
    sessionId: string,
    filter?: MessageScopeFilter,
  ): Promise<MessageWithParts[]>;
}

export class McpToolMenu {
  constructor(options?: {
    readonly history?: McpToolMenuHistory; // 不传当作历史为空
    readonly onError?: (error: unknown) => void;
  });
  ensureLoaded(scope: McpToolMenuScope): Promise<void>;
  loadedNames(scope, candidates?): ReadonlySet<string>; // 按名单顺序，签名不变；调用前先 ensureLoaded
  select(scope, names): Promise<McpToolSelection>; // 自己先 ensureLoaded
  // setAvailable / search / selectableNames / disposeScope / disposeSession 签名不变
}

export interface McpToolSelection {
  readonly alreadyLoaded: readonly string[];
  readonly loaded: readonly string[];
  readonly unknown: readonly string[];
}
```


## 2.6 风险与回滚

| 风险 | 应对 |
|---|---|
| 每个作用域第一次读名单要读一遍完整历史 | 每个作用域在进程生命周期内只读一次；之后都走缓存。`TodoService` 已经是同样的代价 |
| 加载中途作用域被清掉，旧结果写回缓存 | Stage 1 第 2 步的代数判断；04 T6 |
| 两个 `select_tools` 并发 | `ensureLoaded` 共用同一个 Promise，之后的 `select` 是同步的；04 T5 |
| `mcpSelection` 结构以后要改 | 它已是持久化契约：只能加字段，不能改 `loaded` 的含义 |
| 没有累计上限后模型加载很多工具 | 每加载一次工具列表就变一次，模型按需加载；参考项目都不设上限。真出问题时再加按 token 的提示，不恢复硬上限 |
| 断开期间模型调用这个工具 | 工具不在注册表里，返回 `Tool not found`，和现在一样 |
| 读历史出错 | 发警告，这一次按空名单处理，不写缓存，下次重试（Stage 1 第 2 步）；04 T15 |
| `select` 改了缓存，片段却记成中断 | `select` 前检查中断信号（Stage 1 第 3 步）。剩下的窗口：`execute` 已返回、调度器随后才判定中断，片段存成 aborted、没有 `mcpSelection`。这时本进程里工具仍算已加载，重启后消失，只是多一个可用工具，接受 |
| 同一步并发两个 `select_tools` | 进程内按执行完成的先后追加，重建时按片段在回答里的顺序。两者不一致时，重启后工具顺序变一次，缓存错过一次。少见，接受 |
| 重启后 MCP 还没连上 | 第一次请求时已加载工具不在列表里（取交集），连上后恢复。属预期，不算顺序错误 |
| 回滚 | 改动集中在 `dynamic-tool-menu.ts` 和 `composition.ts`，回退这次提交即可；不改数据库结构，旧数据和新代码、新数据和旧代码都能读 |

不可逆点：无。

## 2.7 与 00 对齐

| 00 | 02 落点 |
|---|---|
| D1 数据来源 | Stage 1 第 1 步 |
| D2 压缩后保留 | Stage 1 第 1 步“不过滤 `time.compacted`” |
| D3 范围 | 2.4 “其他包不动” |
| D4 不可用工具 | Stage 1 第 4、5 步 |
| D5 累计上限 | Stage 1 第 6 步 |
| D6 缓存 | Stage 1 第 2、3 步 |
| D7 顺序 | Stage 2 |
| D8 实施顺序 | Stage 3 |
| D9 作用域 | Stage 1 第 2 步的 `listBySession` 参数 |
| D10 关联文档 | Stage 3 |

## 2.8 不在本轮

| 项 | 去向 |
|---|---|
| 工具列表不动、变化写进历史末尾（`defer_loading`、`additional_tools`） | 不做。要改每个服务商适配层，[improve-5 02](../../../core/context/improve-5/02-optimization-plan-and-change-scope.md) 第 303 行已定不做 |
| 卸载已加载的工具 | 不做 |
| 放宽单次上限 | 不做，以后需要时单独改 |
| 多进程共享同一会话时的缓存一致 | 不做，现状也是这样 |
