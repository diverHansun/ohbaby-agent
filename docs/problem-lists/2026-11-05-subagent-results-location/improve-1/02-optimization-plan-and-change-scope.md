# 2. 方案与改动面

> 本文是给实施会话的执行契约。决策来源见 [00](00-discussion.md)，现状证据见 [01](01-problem-analysis-and-current-state.md)，验收见 [04](04-test-and-acceptance.md)。路径缩写：`A/` = `packages/ohbaby-agent/src/`，`S/` = `packages/ohbaby-server/src/`。

## 2.1 方案总览

换的只是导出位置和读取方式，送达格式不变。

```
子代理执行结束，正文写进 subagent_execution.output（不变）
        │
父会话下一步开始前，续接协调器调用 prepare()（不变）
        ├─ 不超过 50KiB：消息里给全文（不变）
        └─ 超过 50KiB：导出文件
              旧：<数据目录>/storage/subagent-results/<parentSessionId>/<subagentId>/<executionId>.output
              新：~/.ohbaby/sessions/<rootSessionId>/subagents/<subagentId>/<executionId>.output
              消息里给 Complete result: <新路径>、sizeBytes、estimatedTokens（格式不变）
        │
父代理（或同一根会话的子代理、side chat）用 read 去读
        旧：sandbox 先问专用通道 authorizeInternalRead，只放行发起调用的作用域
        新：路径在存储区登记的只读可信路径里，直接放行；专用通道删除
        │
会话永久删除：存储区第一期删掉 sessions/<id>，报告随之删除；旧的 subagent-results 清理删除
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 位置 | `sessions/<rootSessionId>/subagents/<subagentId>/<executionId>.output` | 一个根会话的文件放在一处；参考项目都把子代理结果挂在会话名下（03） | 留在数据目录（两处分开）；按类型分顶层目录（ZCode 的做法，清理时容易漏） | 无 |
| 会话 ID | 执行记录的 `rootSessionId` | 和存储区的归属一致；现在与 `parentSessionId` 同值 | `parentSessionId`（以后如果允许嵌套子代理，归属会对不上） | 无 |
| 存储根 | 固定用 `resolveSessionStorageRoot()`，删掉 `resultStorageRoot` 选项 | 和存储区登记可信路径用的是同一个函数，不会对不上 | 改名保留一个可覆盖的选项（两处可能指向不同位置） | 测试只能用 `OHBABY_HOME` 隔离，这本来就是仓库约定 |
| 读取授权 | 存储区的只读可信路径 `session-storage` | 一套机制管所有会话文件；整个根会话都能读 | 保留专用通道（8 个文件里的特殊逻辑） | 兄弟子代理、side chat 也能读，这是想要的结果 |
| 写入保护 | 保留导出时的符号链接检查和真实路径核对 | Bash 仍可能在别处造符号链接，这两项检查兜底 | 删掉（以为只读权限就够了） | 无 |
| 旧数据 | 不兼容、不迁移 | 没有发布版本；数据库是权威数据，路径不一致时会自动重新导出 | 迁移脚本；保留旧目录的清理代码 | 开发机上旧会话历史里的旧路径，读取时要确认 |
| 子代理提示词 | 长日志写进 scratch 目录 | 不弄脏用户的工作区 | 不改（继续写进工作区） | 无 |
| `forceFile` | 删除 | 没有调用方 | 保留给以后（YAGNI） | 无 |

## 2.3 分阶段实施

全部 Stage 都属于 improve-1。每个 Stage 结束时 `pnpm typecheck`、`pnpm lint` 和相关测试保持通过。

### Stage 0：前置条件

会话存储区第一期已经落地，并满足：

- 会话运行时，`initialTrustedRoots` 回调登记了两档可信路径：`session-storage`（整个会话目录，只读）和 `session-scratch`（`scratch/`，可写）。子代理上下文登记的是根会话的目录。
- `cleanupDeletedSessionFiles` 已经会删 `sessions/<id>`。
- 环境提醒里有 scratch 路径，子代理看到的是根会话的路径。

做不到时，本议题不开始。

### Stage 1：换导出位置

**目标**：超过 50KiB 的报告导出到新位置；父代理免确认就能读；永久删除会话后文件不在了。

**改动**：

1. **`A/paths/session-storage.ts`**：加常量 `SUBAGENTS_DIR = "subagents"`，加 `resolveSessionStorageRoot(options?: OhbabyPathOptions)`，返回 `<OHBABY_HOME>/sessions`。`resolveSessionStorageDir` 可以改为基于它来算。
2. **`A/agents/subagents/result-artifacts.ts`**：
   - `keyFor` 改为 `[record.rootSessionId, SUBAGENTS_DIR, record.subagentId, "<executionId>.output"]`。
   - 导出时建目录：`resolver.ensureParent(path)` 改为 `mkdir(dirname(path), { recursive: true, mode: 0o700 })`。
   - 其余不动：父目录重定向检查、写后真实路径核对、三次重试、墓碑、`deleteSession`。
   - 数据库里旧记录的 `artifact.path` 指向旧位置时，`:153-157` 的比较不成立，会自然重新导出到新位置，不需要额外代码。
3. **`A/adapters/ui-runtime/composition.ts`**：删掉选项 `resultStorageRoot`（`:213`）；`createStorage` 和 `rootDir` 都用 `resolveSessionStorageRoot()`（`:372-373`）。
4. **`A/services/session/archive-files.ts`**：删掉对每个会话 ID 删 `subagent-results/<id>` 的那一段（`:31-39`），以及 `resultStorageRoot` 依赖和 `PathResolver` 的引用。
5. **测试**：`A/services/session/archive-files.integration.test.ts`、`A/adapters/ui-runtime/custom-instructions.integration.test.ts:365`、`A/agents/subagents/result-artifacts.integration.test.ts`、`S/runtime/daemon/archive-server.integration.test.ts` 里用到旧路径或 `resultStorageRoot` 的地方，改成新路径，并通过临时 `OHBABY_HOME` 隔离。

这一步做完后，旧的专用通道还在，但它只认 `subagent-results` 开头的路径，新路径不会命中，读取改由只读可信路径放行。所以 Stage 1 单独上线也能正常工作。

### Stage 2：删除专用读取通道

**目标**：sandbox 里不再有只为子代理结果服务的回调。

**改动**（按 01 §1.4 的清单）：

1. `result-artifacts.ts`：删掉 `authorizeRead` 和类型 `InternalResultAccess`，`SubagentResultArtifacts` 接口相应收窄。
2. `composition.ts:472-476`：`createHostLocalSandboxManager` 不再传 `authorizeInternalRead`。
3. `A/sandbox/types.ts:137`、`:178`，`A/sandbox/manager.ts:170`，`A/sandbox/lease.ts:52-80`、`:102`，`A/runtime/run-manager/worker.ts:114`，`A/adapters/ui-runtime/host-local-environment.ts:127`，`A/core/tool-scheduler/types.ts:73`：删掉这个选项和方法的声明与传递。
4. `A/core/tool-scheduler/scheduler.ts`：删掉 `internalRead` 字段（`:121`）以及用到它的四处（`:1459`、`:1474`、`:1904-1907`、`:1981`）。删掉以后，读取只看可信路径；不在可信路径里的读请求照现有的外部读取流程走。
5. 测试：只有 `result-artifacts.integration.test.ts` 测了专用通道（`:138`、`:195`、`:220` 附近），sandbox 和 scheduler 的单元测试没有引用它。删掉这几个用例，改成 04 的 T3 至 T5：直接测“路径在只读可信路径里时，`read` 不弹确认，写入要确认”。

完成后，`grep -rn "authorizeInternalRead\|internalRead" packages` 应该没有结果。

### Stage 3：提示词和清理

1. **子代理提示词** `A/core/system-prompt/prompts/subagents/base.md:27`，把这句改为（英文，和现有提示词一致）：

   > Write full logs or lengthy analysis to a file in the session scratch directory listed in your environment reminder (not in the working directory). Other agents share that directory, so name the file after your task. Return its path. If no scratch directory is listed, keep the essentials in your report.

   最后一句是兜底：环境提醒里的 scratch 那一行是可选的，算路径失败时会省略（存储区 dfd §2.2）。`explore.md` 不改：它要求只读，比通用规则更具体，`explore` 子代理仍然不写文件。
2. **重新生成提示词资源**：`base.md` 会被编译进 `A/core/system-prompt/prompts/templates.generated.ts`，改完要运行 `pnpm -C packages/ohbaby-agent prompt:generate`，否则 `prompt:check` 和构建会失败。`A/core/system-prompt/__tests__/prompt-assets.unit.test.ts:104` 逐字断言了旧句子，同步改成新句子。
3. **`forceFile`**：从 `prepare()` 的选项类型和判断里删掉（`result-artifacts.ts:30`、`:228`）。`result-artifacts.integration.test.ts` 里有 11 处用它把短正文强制导出（:94、:122、:127、:165、:185、:299、:326、:330、:373、:384 附近），这些用例改成直接构造超过 51,200 字节的正文。

## 2.4 接口变化

```ts
// A/paths/session-storage.ts（本议题新增）
export const SUBAGENTS_DIR = "subagents";
resolveSessionStorageRoot(options?: OhbabyPathOptions): string   // <OHBABY_HOME>/sessions

// A/agents/subagents/result-artifacts.ts
interface SubagentResultArtifacts {
  prepare(input: ExecutionLookup, options?: { signal?: AbortSignal }): Promise<PreparedSubagentResult>;
  deleteSession(sessionId: string): Promise<void>;
  // 删除：authorizeRead
}
// 删除：InternalResultAccess

// A/sandbox/types.ts、lease.ts、manager.ts；A/core/tool-scheduler/types.ts
// 删除：authorizeInternalRead 选项与方法

// A/services/session/archive-files.ts
cleanupDeletedSessionFiles(result, deps: { snapshotRoot?; sessionStorageRoot?; log })
// 删除：resultStorageRoot（sessionStorageRoot 由存储区第一期加入）
```

父代理看到的消息格式不变，只有路径变了。

## 2.5 受影响的模块与文档

| 模块 | 影响 | 文档 |
|---|---|---|
| 会话存储区 | 提供目录、只读权限和 `resolveSessionStorageRoot` | `docs/services/session-storage/` 已在本议题规划时更新：两档权限、`subagents/` 目录、`tool-results/` 改名 |
| 子代理（agents） | 结果导出位置、提示词 | `docs/agents/` 只笼统写了“结果或结果文件路径”，不用改 |
| sandbox | 删掉一个回调 | `docs/sandbox/improve-2/integration-plan.md` 由存储区第一期补上两种可信路径；本议题不另改 |
| 执行可靠性 improve-3 | §2.7 的位置和读取方式被本议题取代 | 历史文档不改，取代关系记在本议题 00 §4 |

不需要另写模块级改进文档：改动集中在一个文件加一串删除，和原设计不冲突。

## 2.6 风险与回滚

| 风险 | 表现 | 处理 |
|---|---|---|
| 存储区的回调没登记上只读可信路径（例如归属 ID 不合法） | 读报告时弹外部读取确认 | 和存储区 S10 的处理一致：功能不坏，只是多一次确认。04 的 T8 覆盖 |
| 用户对外部读取选了“始终允许” | 现有逻辑有个反直觉的地方：批准外部**读取**时登记的是可写的 `external-write-approved`（`A/core/tool-scheduler/scheduler.ts:1458-1464`），批准外部**写入**时登记的反而是不可写的 `external-approved`（`:1541-1547`）；“始终允许”还会加一条整个会话都生效的规则（`A/permission/manager.ts:288-296`）。正常情况下读 `subagents/` 不是外部读取，不会走到这里；但 fork 出来的会话读源会话的报告（T11）、或读旧路径时，选一次“始终允许”，那个目录在这个会话里就变成免确认可写 | 本议题不改。这是外部目录授权的既有行为，所有外部目录都一样；要修应该在权限模块单独处理（两种类型登记反了） |
| 用户批准了一次对 `subagents/` 的写入 | 写入批准登记的是 `external-approved`，不算可写；如果选了“始终允许”，会话级规则之后会放行同类写入 | 用户明确批准的结果，和其他外部目录一致，不特殊处理 |
| 用户把 `~` 或 `~/.ohbaby` 选作工作区 | 运行目录内的写入本来就不确认（`scheduler.ts:226-232`），Bash 预检也总是信任运行目录（`A/sandbox/preflight.ts:88-93`），只读那一档在这种情况下不起作用 | 接受，记为残余风险。专门为它改判断顺序属于过度设计 |
| 模型用 Bash `cat` 读报告 | 要确认 | 送达消息和主提示词都让模型用 `read`；接受 |
| 旧会话历史里的旧路径 | 读取时要确认 | 只影响开发机上的旧数据，接受 |

回滚：按 Stage 逆序回退代码即可。数据库里的正文和导出状态不受影响，回退后路径不一致会再次触发重新导出。

## 2.7 实施后需要同步的文档

- `docs/services/session-storage/architecture.md` §1.2 第 1 点把 `authorizeInternalRead` 当作“注入回调”的先例。Stage 2 删掉它之后，这句改成“照 sandbox 现有的注入写法”，不再点名。
- 其余存储区文档已在规划时更新。验收时核对 `docs/services/session-storage/` 的描述与实现一致。

## 2.8 切出本轮的议题（下一轮候选）

| 候选 | 说明 |
|---|---|
| 失败、超时、被停止的执行保存部分结果 | 现在只有 `completed` 才保存正文（`A/agents/subagent-host.ts:1736`），父代理拿不到做了一半的内容。claude-code 停掉子代理时会带回部分结果，kimi-code 失败时也给部分输出。和存储位置无关，需要单独讨论保存哪些内容、怎么标注“不完整” |
