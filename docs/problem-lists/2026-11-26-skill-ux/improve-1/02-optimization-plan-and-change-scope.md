# 2. 方案与改动面

> 本文是交给实施会话的执行契约，覆盖后端和 TUI。Web 的界面行为见 [frontend/](frontend/00-goal-duty.md)，它依赖本文 2.5 节定义的消息字段。决策来源见 [00](00-discussion.md)，现状见 [01](01-problem-analysis-and-current-state.md)。
>
> 路径省略前缀：后端在 `packages/ohbaby-agent/src/` 下，TUI 在 `packages/ohbaby-cli/src/tui/` 下。其他包写全名。

## 2.1 方案总览

一句话：**提交时只存用户原样输入，写进消息历史的那一刻才展开 skill，展开结果是一条消息里的两个 part。**

```
用户输入 /Code-Review 帮我看看
   │
   ▼
executeSkillCommand：只校验 skill 存在、允许用户调用，不读正文
   │
   ▼
prompt_submission.text = "/code-review 帮我看看"     ← 技能名换成标准名，原话一字不动
namingSource = { skillName, request, skillBodyExpanded: true }   ← 后端校验过的 slash 调用
   │
   ▼  写消息历史时（新 run / steer / 编辑重发 / 各种重发）调用同一个展开函数
expandSlashSkill
   │
   ├─ skill 还在 ──┬─ part 1（隐藏）synthetic: true, kind: "skill-body:v1"
   │               │     text: <skill name="code-review">…SKILL.md…</skill>\n\n
   │               │     metadata.skillUsage: { name, source: "slash" }
   │               │
   │               └─ part 2（可见）text: "帮我看看"
   │                     metadata.displayText: "/code-review 帮我看看"
   │                     metadata.skillMarker: { name: "code-review" }
   │
   └─ skill 已被删、改名或不再允许用户调用
                   └─ 一个普通 text part："/code-review 帮我看看"，不带标记
   │
   ▼
run 拿到 sandbox 租约后：扫描当前上下文的历史，登记已加载 skill 的可信目录
```

模型看到的文字是 `<skill …>正文</skill>\n\n帮我看看`，和现在的信息量相同，只是去掉了 `User request:` 前缀、加了标签包裹。界面看到的是 `displayText` 和 `skillMarker`。

## 2.2 设计决策

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 消息结构 | 同一条消息两个 part（00 B1） | 复用已有的 synthetic 机制；rewind、steer、标题、搜索都按"一条用户消息一轮"处理，不用改 | 拆成两条消息（deepseek-harness、codex） | 每个读消息的地方要认识新 kind，见 Stage 1 的过滤清单 |
| 隐藏 part 的结尾 | 末尾带 `\n\n` | 序列化用 `.join("")`，靠 part 自带分隔，不改序列化代码，不影响老会话缓存 | 改序列化为 `.join("\n\n")` | 无 |
| `skillUsage` 挂在哪 | 只挂在隐藏 part 上 | 它的含义是"正文在上下文里"，隐藏 part 永远非空 | 挂在可见 part | 无 |
| 界面标记 | 可见 part 新增 `metadata.skillMarker` | 和 `skillUsage` 分开，`skill-usage.ts` 不会把它误当证据 | 复用 `skillUsage` | 多一个字段 |
| 展开时机 | 写消息历史时（00 B2） | 上游全部拿到原样输入，不用到处反拼 | 提交时展开 | 开跑时 skill 可能已经不在 |
| 开跑时 skill 不在了 | 按普通文字发送，不另外提示（00 B2） | 和 codex、deepseek-harness、Step-Code、minimax-code 一致；不产生失败行，也就不需要失败行重发入口 | 让这条 prompt 失败（kimi-code、opencode） | 用户只能从"气泡没有魔杖"看出没触发 |
| 展开触发条件 | 只看 `namingSource.skillBodyExpanded === true` | 公共 submit 发 `/foo` 不能被展开 | 解析 `text` 开头 | 无 |
| `skillBodyExpanded` 改不改名 | **不改名，只补注释** | 它存在排队记录里，改名要迁移旧记录 | 改名 | 名字和含义有点偏，靠注释说明 |
| steer 展开位置 | 在 `PromptScheduler` 调 `inputs.steerQueued` 之前，通过注入的端口异步展开（00 B2.1） | 手动和自动 steer 都经过 `PromptScheduler`，一处覆盖两条路径；runtime 不依赖 skill 模块 | 在事务里读磁盘 | 端口多一个参数；展开和事务之间要处理记录被改的情况 |
| 信任登记位置 | run 拿到租约后扫描当前上下文的历史（00 B3） | 首轮、重启、fork 一次覆盖 | `initialTrustedRoots` | 有 skill 历史时每个 run 刷新一次 registry |
| 编辑重发识别 slash | 复用 `resolveSlashCommand` 和命令目录，只认 `source: "skill"`（00 B4） | 和新消息的规则一致 | 自己写前缀匹配 | 无 |
| 编辑重发的报错 | 新错误码，服务端映射 400，SDK 原样透传 | 现在未知错误会变成 500 加 `Something went wrong:` 前缀，用户看不懂 | 复用通用错误 | 服务端和 SDK 各改一处 |

全部决策都可逆：没有数据迁移，新字段只是追加。唯一的行为变化是 `prompt_submission.text` 的含义，用 2.5 节的兼容规则处理。

## 2.3 分阶段实施

五个 Stage 都在本轮。Stage 1 是承重切片，Stage 2 到 4 依赖它。Stage 3 要扫 Stage 1 才有的 `skill-body:v1`，其中只有"旧版 slash 消息和工具调用的登记"可以和 Stage 1 并行。Web（Stage 5）依赖 Stage 1 的字段。

### Stage 1：消息结构和新消息路径

**目标**：新发的 slash 消息变成两个 part；提交记录只存原样输入；所有读消息的地方正确对待隐藏 part。

1. 新增展开函数 `expandSlashSkill`（放在 `skill/` 下，比如 `skill/slash-expansion.ts`）：
   - 输入：提交记录的 `text` 和 `namingSource`，以及 skill registry。
   - 只调一次 `registry.load(name)`，不先 `get`，也不显式 `refresh`：`get` 每次都会刷新，`load` 内部又调 `get`，叠起来就是两次。
   - `load` 抛 `SkillNotFoundError` 或 `SkillLoadError`（查到条目后、读正文前文件被删会抛后者），或 `content.info.userInvocable` 不为真（`load` 自己不查这一项），返回"不可用"，由调用方按普通文字写一个 part，不带 `skillMarker`。
   - 用 `formatSkillToolOutput(content)` 拿正文，和现在 `loadPrompt` 的格式一致。
   - 生成 2.1 节的两个 part。`name` 用标准名，schema 只允许小写字母、数字和连字符，直接写进属性，不用转义。
   - 原话从 `text` 里去掉开头的 `/${skillName}` 和紧跟的一个空格或换行得到，可能有多行。
   - 旧记录兼容：`text` 不以 `/` 开头时（旧全文固定以 `## Skill: name` 开头），说明是升级前就展开好的全文，按旧格式写一个 part，不再展开。"是不是旧记录"写成一个判断函数，展开函数和第 7 条的预填 helper 共用，不各写一份。
   - 另外提供一个共用的"解析加规范化"函数：输入用户文字和命令目录，输出是不是 skill、标准名、规范化后的 `text` 和后端标记的 `namingSource`。commands（新消息）、编辑重发、排队编辑、保留项重发都调它（Stage 2 第 2、3 条）。
2. `commands/service.ts` 的 `executeSkillCommand`：
   - 不再调 `loadPrompt` 和 `formatSkillPrompt`，改为只校验，然后提交规范化后的 `/${skillName}` 加原话。`formatSkillPrompt` 删除。
   - 原话取 `rawArgs` 和 `body` 合起来，不能只取 `rawArgs`，否则第二行以后的内容会丢。`/code-review` 后面直接换行的写法也要支持。`namingSource.request`（现在是 `invocation.rawArgs`）也改成同样的原话。
   - 规范化公式：`/name` + (`rawArgs` 非空时加一个空格和 `rawArgs`) + (`body` 非空时加一个换行和 `body`)。第一行首尾空白已被 `parseSlashCommandInput` 去掉，第二行起一字不动。
   - `commands/types.ts` 的 `CommandServiceOptions.skills` 现在提供 `loadPrompt` 和 `listUserInvocable`，把 `loadPrompt` 换成一个只校验的方法（比如返回标准名，不可用时报错），由 `adapters/ui-inprocess.ts` 提供实现。
   - 没有 `submitPromptAccepted` 时的 markdown 输出分支改成显式报错，commands 层不调展开函数。仓库里只有 `ui-inprocess` 调用 `createCommandService`，但它从包根导出，`submitPromptAccepted` 在类型上是可选的，不能证明外部没人用这个分支。所以这是公共 API 的行为变化，要写进变更说明。
3. 新 run 写消息：
   - `adapters/ui-inprocess.ts` 在 `runtime.startSession` 之前调用展开函数，把 part 列表作为 `initialUserParts` 一路传给 runner，替换现在沿这条链传的 `skillUsage` 参数。途经 `agents/service.ts`、`agents/types.ts`、`core/agents/instance.ts`、`core/agents/types.ts`，`core/agents/runner.ts` 的 `writeInitialUserMessage` 按传入的 part 写入。
   - `writeInitialUserMessage` 现在先 `createMessage` 再逐个 `appendPart`，清理只覆盖 run 创建失败。第二个 part 写失败会留下一条只有隐藏正文的用户消息。改成在一个事务里写完，或者把 append 失败也纳入现有的 `removeMessage` 清理，二选一由实施会话定。
   - 展开结果是"不可用"时，按普通文字写一个 part，这条 prompt 照常开跑。
4. 乐观消息（`ui-inprocess.ts` 的 `submitPromptWork` 里构造的 `userMessage`）：用同一次展开的结果构造，只放可见 part（`displayText` 加 `skillMarker`），不放隐藏的正文 part。
5. 新增 `isSkillBodyPart`（`core/message/origin.ts`），并入下面这些地方已有的隐藏 part 判断，不要每处单独写：
   - `origin.ts` 的 `isTranscriptPart`；
   - `services/session/title-fallback.ts`：改成 `isTranscriptPart` 加 `transcriptText`。只排除隐藏 part 不够，不带原话的 `/code-review` 可见 part `text` 为空，会被跳过；
   - `adapters/ui-inprocess/steer-recovery.ts` 的 `projectUnconsumedSteers`：改成读原提交记录，经过第 7 条的预填 helper，显示 `/技能名 原话`；
   - `services/session-export/collect.ts`；
   - `agents/subagents/monitor.ts`；
   - `core/context/token-estimation.ts`，计入 skills 统计。

   搜索 SQL 已经排除 synthetic，不用改。
6. `services/reminder/skill-usage.ts`：判断 skill 是否加载过，只认 `skill-body:v1` part 和旧版消息（带 `skillUsage` 的非空 user text part），去掉"可见文字必须非空"对新消息的依赖。
7. 预填 helper：在后端新增一个函数，把提交记录转成"给用户看的原样输入"。规则：
   - `skillBodyExpanded === true` 且 `text` 以 `/${skillName}` 开头：直接用 `text`；
   - `skillBodyExpanded === true` 但 `text` 是旧全文：用 `/${skillName}` 加 `request`；
   - 其他：用 `text`。

   `adapters/ui-inprocess/prompt-mapper.ts` 的 `promptRecordToUi`、`rewindSession` 返回的 `restoredText`、第 5 条的 `projectUnconsumedSteers` 都改用它。
8. `skill/usage.ts`：给 `skillBodyExpanded` 补注释，说明含义是"后端已校验的 slash 调用"；`publicNamingSource` 的过滤保持不变。

**完成定义**：新发 `/skill 原话`（包括多行原话），消息历史里是两个 part；界面拿到 `displayText` 和 `skillMarker`；模型请求体里能看到 `<skill …>` 包裹的正文和完整原话；标题、导出、子代理监控、token 统计、未处理 steer 的预览都不出现 SKILL.md 全文；旧会话显示不变。

### Stage 2：steer、编辑重发和其他入口

**目标**：所有会写出 slash 消息的入口都走同一个展开函数。

1. **steer**（00 B2.1）：
   - `runtime/prompt-scheduler/scheduler.ts` 的 options 新增一个展开端口。scheduler 在 `adapters/ui-inprocess.ts` 里创建（`new WorkspacePromptScheduler`），端口在那里注入 `expandSlashSkill`。
   - 展开放在会话锁外面。`commit(sessionId)` 的锁只管同一个后端实例，锁里约定只做短的数据库操作，不读磁盘；两个后端共用 SQLite 时，锁拦不住另一个实例的编辑。
   - `steerQueued`（手动 steer）按这个顺序做：
     1. 进锁前读一次记录。状态不是 `queued`（比如已经提交过、只是回包丢了），不展开，走现有逻辑返回原回执；
     2. 是 `queued` 且带后端标记，在锁外展开，记下展开时用的 `text` 和 `namingSource`；
     3. 进锁后把 part 列表和这两个期望值一起通过 `SteerQueuedPromptInput` 传给 `inputs.steerQueued`，由 `current-run-inputs.ts` 在事务里重读记录核对。对得上就写入；对不上时返回一个新的内部结果（`SteerQueuedPromptOutcome` 加一个 reason），scheduler 的重试循环接住它，按新记录重新展开，最多重试 2 次，仍对不上就按普通文字 steer。这个内部结果不能从 scheduler 往外传（现在 scheduler 会把 reason 原样传出去），否则 SDK 的 steer 结果枚举就变了。
     4. 不比 `updatedAt`：编辑租约续期也会改它，会白白触发重试。
   - `steerAccepted`（自动 steer）不用核对：记录是 `store.accept` 在同一个 `commit` 回调里刚插进去的，进锁前还不存在。在 `persist()` 之前用 `input.text` 和后端标记先展开，结果带进锁里交给 `steerAccepted`。`!inserted` 时照旧走 `existingAcceptance`。
   - 没有传入 part 时和现在一样，用 `prompt.text` 生成一个 part。
   - 展开结果是"不可用"时，按普通文字 steer 进去，不返回 not-steered，不改 SDK 的 steer 结果枚举。
2. **编辑重发**（00 B4），在 `adapters/ui-inprocess.ts` 的 `rewindSessionInternal` 里：
   - 校验放在 `readRewindCut` 拿到原消息之后、`markRewoundShellRuns` 和 `stopForRewind` 之前，和那里现有的 `assertModelEntrySelectable` 放在一起。用 `resolveSlashCommand` 和命令目录解析新文字开头，只认 `source: "skill"`。
   - 是允许用户调用的 skill：按 Stage 1 的规范化规则写 `text`，生成后端标记的 `namingSource`，截断后按 Stage 1 的路径提交。
   - 是原消息的 skill，但现在解析不到或不允许用户调用：返回新错误码，历史、正在跑的 run、goal 和排队区都不动。错误文字是给用户看的英文句子，带上技能名（比如 `Skill "code-review" is not available`）。
   - 新错误码的常量和 `REWIND_TARGET_INVALID_ERROR_CODE` 放在一起（`ohbaby-sdk/src/contract/global-sessions.ts`）。`ohbaby-server/src/protocols/global-sessions.ts` 的 `globalSessionErrorStatus` 把它映射成 400。`ohbaby-sdk/src/util/session-action-errors.ts` 的 `sessionActionErrorText` 是"错误码对固定文案"的表，要为它加一个分支，原样透传后端文字，不加 `Something went wrong:` 前缀。Web 编辑框原样显示（frontend/06 第 4 节）。
   - 其他以 `/` 开头的文字：按普通文字提交。
   - 旁聊不支持编辑重发（`readRewindCut` 遇到旁聊直接抛 `SideChatUnsupportedError`），这里不用处理旁聊。
   - 提交被拒的，走现有的 `sendError`；提交已被接收、开跑时 skill 不见了的，按 Stage 1 当普通文字发送。
3. **排队项编辑和保留项重发**：编辑排队文字时，store 会清空 `namingSource`（`runtime/prompt-scheduler/in-memory-store.ts` 和 `database-store.ts`）。改为由 adapter 调 Stage 1 第 1 条的共用解析函数重新解析（技能名同样换成标准名），把新的 `namingSource` 传给 store。`resubmitRetainedPrompt` 同理，用这次编辑后的 `input.text`，不用原记录的文字。
   - 和编辑重发不同，这两个入口遇到 skill 不可用不报错，按普通文字处理（00 B2）。
   - 旁聊里的记录不解析 slash，按普通文字处理。
   - 保留项重发不在展开前单独认回执，沿用 store 现有的冲突检查（同一个操作 ID 带了不同文字就报冲突）。已知边界：回包丢了重试、这次敲的是大小写不同的技能名、重试前 skill 又刚好被删，三者同时出现时，重试的文字规范化不了，会报冲突。本轮接受。
4. **未处理 steer 的重发**：`ui-inprocess.ts` 的 `resendSteerInputForOwner` 里拼 text part 的分支，改为直接用 `original.text` 和 `original.namingSource` 重发，经过 Stage 1 的展开路径。旧记录由预填 helper 和展开函数的兼容规则处理。

**完成定义**：运行中 steer `/skill 原话`，以及编辑重发、排队编辑、保留项重发、未处理 steer 重发之后，消息历史和界面的结果都和新消息一样；skill 被删后编辑重发，返回 400 和可读的错误文字，历史、run、goal、排队区都不变；排队期间 skill 被删，消息按普通文字发出。

### Stage 3：slash 路径的信任登记

**目标**：slash 调用的 skill 和工具调用一样，读 skill 目录不弹审批。

1. 从 `skill/tool.ts` 的 `activateSkillRuntime` 里抽出"给一个 skill 登记 `active-skill` 和 `skill-output`"的核心逻辑，工具路径和新路径共用。
2. 新增"扫描历史登记信任"的函数（放在 `skill/` 下）：
   - 只扫当前租约对应的 `sessionId` 加 `contextScopeId` 那段未 rewind 的历史，子上下文不继承别的上下文登记过的目录。还在排队的消息不算。steer 接收时就写进了消息表，可能还没被模型读到，所以读历史时显式传 `{ contextScopeId }`（主上下文也传），再过一遍 `currentRunInputStore.filterModelHistory`，只认模型真正看到过的消息。
   - 收集 skill 名：`skill-body:v1` part、旧版 slash 消息（`slashSkillName`）、已完成的 `skill` 和 `skill_resource` 工具调用。
   - 先去重；有候选才 `registry.refresh()` 一次，再用 `registry.all()` 按名字查 `baseDir`。不逐个 `get`，因为 `get` 每次都会刷新。没有候选时不碰 registry。
   - 路径一律取当前的 `baseDir`，不用工具调用 metadata 里存的旧 `dir`。已被删除的 skill 跳过。
3. `runtime/run-manager/manager.ts` 的 `startRun`：拿到 `sandboxLease` 之后调用这个函数。函数以 deps 的形式注入，run-manager 不直接依赖 skill 模块。
4. steer 带进来的 skill：run 消费 steer 消息时补登记一次。`manager.ts` 调 `createCurrentRunInputPort` 时传的是整个 `context`，运行时已经带着 `sandboxLease`，只是 `runtime/run-manager/types.ts` 里这个参数的类型没写这个字段，补上类型即可。每个 run 用一个 `Set` 记下已经登记过的 steer messageId，同一条不重复登记。
5. 改 skill 文件的权限保持现状，不新增规则（00 B3）。

**完成定义**：非 full-access 模式下，slash 调用 skill 后让模型读它的 `references/`，不弹审批；进程重启后继续同一会话，仍不弹；另一个 `contextScopeId` 里不会因此放行；写 skill 目录仍弹审批；写 `.ohbaby/skill-output/<name>` 不弹；没有 skill 历史的会话不刷新 registry。

### Stage 4：TUI

1. **T1**：不改代码，按 04 验证消息行、排队列表、排队编辑、RewindPanel 显示的都是 `/技能名 原话`。
2. **T2**：`components/prompt/index.tsx` 的 `renderEditorLines`：
   - 只在编辑器第一条逻辑行、起始偏移为 0 的那一行判断开头是否为 `/技能名`，不能用视口的 `index === 0`。`components/prompt/editor-viewport.ts` 的 `EditorDisplayRow` 现在不带逻辑行号和起始偏移，要补上。
   - "已知 skill"取命令目录里 `source: "skill"` 的条目，名字比较不区分大小写，和后端解析一致。
   - 命中时把技能名那一段用主题的 `accent` 色渲染；光标落在技能名里时，光标那一格仍按光标样式渲染，其余部分保持 accent。
   - 内置命令不上色。

消息行里的 `/技能名` 不上色（00 3.3）。

**完成定义**：见 04 的 TUI 验收项。

### Stage 5：Web

按 [frontend/](frontend/00-goal-duty.md) 实施，依赖 Stage 1 的字段和 Stage 2 的错误码。后端这边只需保证 2.5 节的契约。

## 2.4 按包和目录的改动面

| 包或目录 | 新增 | 修改 | 删除 | 说明 |
|---|---|---|---|---|
| `ohbaby-agent/src/skill/` | 展开函数、扫描历史登记信任的函数 | `tool.ts`（抽出登记核心）、`usage.ts`（注释） | — | skill 相关逻辑都放这里 |
| `ohbaby-agent/src/commands/` | — | `service.ts`、`types.ts` | `formatSkillPrompt` | 只校验不展开；原话取完整 |
| `ohbaby-agent/src/core/message/` | `isSkillBodyPart` | `origin.ts` | — | |
| `ohbaby-agent/src/agents/`、`core/agents/` | — | `agents/service.ts`、`agents/types.ts`、`core/agents/instance.ts`、`core/agents/types.ts`、`core/agents/runner.ts` | — | 把 part 列表传到初始消息 |
| `ohbaby-agent/src/runtime/prompt-scheduler/` | — | `scheduler.ts`、`current-run-inputs.ts`、两个 store | — | steer 展开端口；排队编辑接受新的 `namingSource` |
| `ohbaby-agent/src/runtime/run-manager/` | — | `manager.ts`、`types.ts` | — | 拿到租约后登记信任；端口参数类型补上 `sandboxLease` |
| `ohbaby-agent/src/adapters/` | 预填 helper | `ui-inprocess.ts`、`ui-inprocess/prompt-mapper.ts`、`ui-inprocess/steer-recovery.ts`、`ui-runtime/composition.ts` | — | 编辑重发、各种重发、乐观消息、预填、steer 展开端口注入（scheduler 在 `ui-inprocess.ts` 创建）、信任登记注入 |
| `ohbaby-agent/src/services/` | — | `reminder/skill-usage.ts`、`session/title-fallback.ts`、`session-export/collect.ts` | — | |
| `ohbaby-agent/src/agents/subagents/` | — | `monitor.ts` | — | |
| `ohbaby-agent/src/core/context/` | — | `token-estimation.ts` | — | |
| `ohbaby-server/src/` | — | `protocols/global-sessions.ts` | — | 新错误码映射 400 |
| `ohbaby-sdk/src/` | — | `contract/global-sessions.ts`、`util/session-action-errors.ts` | — | 新错误码常量；不加前缀 |
| `ohbaby-cli/src/tui/` | — | `components/prompt/index.tsx`、`components/prompt/editor-viewport.ts` | — | 只改输入框 |
| `docs/` | — | `ohbaby-web/ui/slash-commands/skill-invocation.md`、`skill/dfd-interface.md` | — | 实施完成后同步 |

## 2.5 协议、兼容与迁移

### 消息字段契约（前端依赖）

| 字段 | 位置 | 含义 | 谁写 |
|---|---|---|---|
| `metadata.displayText` | 可见 part | 规范化后的 `/${name}` 加原话，没有原话时只有 `/${name}`；`name` 是标准技能名，不随用户输入的大小写变化；原话可以有多行 | 展开函数 |
| `metadata.skillMarker` | 可见 part | `{ name }`，只用于界面显示 | 展开函数 |
| `metadata.skillUsage` | 隐藏 part | `{ name, source: "slash" }`，表示正文在上下文里 | 展开函数 |
| `metadata.kind` | 隐藏 part | `"skill-body:v1"` | 展开函数 |

界面拿到的可见 part 文字是 `displayText`（`transcriptText` 已有此逻辑），`metadata` 原样透传，不需要改 SDK 投影。

开跑时 skill 不在了的消息只有一个普通 text part，没有上面任何字段，界面按普通消息显示。

### `prompt_submission.text` 的含义变化

| 记录 | `text` | `skillBodyExpanded` | 展开函数怎么做 | 预填 helper 返回 |
|---|---|---|---|---|
| 新记录 | `/name 原话` | true | skill 还在：展开成两个 part；不在：一个普通 part | `text` |
| 升级前排队的旧记录 | 全文 | true | 按旧格式写一个 part | `/name` 加 `request` |
| 普通消息 | 原话 | 无 | 不展开 | `text` |
| 公共 API 传进来的 `namingSource` | 任意 | 被 `publicNamingSource` 剥掉 | 不展开 | `text` |

已存的旧消息历史不迁移，界面按原样显示全文。

### 新错误码

编辑重发时原消息的 skill 已不可用，返回一个新错误码。服务端映射成 400，SDK 原样透传错误文字。错误码的具体名字由实施会话按现有命名习惯定。

### 安全约束

`skillBodyExpanded` 和 `skillUsage` 只能由后端在校验之后打上。公共 `submitPromptAccepted` 不信任外部传入的 `namingSource`，这一点保持不变，并保留对应的契约测试。

## 2.6 风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| 漏掉某个读消息的地方，把隐藏 part 当成可见文字 | 标题、导出、steer 预览等处出现 SKILL.md 全文 | 统一走 `isSkillBodyPart`；04 对每个消费方有验收项 |
| 漏掉某个写消息的入口，没走展开函数 | 模型收到字面的 `/技能名 原话`，没有 skill 正文 | 展开函数是唯一出口；04 对每个入口有验收项 |
| 排队期间 skill 被删 | 这条消息不触发 skill，用户只能从气泡没有魔杖看出来 | 00 B2 的取舍，和多数同类项目一致；04 有验收项 |
| 某个入口没做技能名规范化 | 大小写不同的新记录被误当成升级前的旧记录，不展开 | 四个入口共用同一个规范化函数；04 对编辑重发和排队编辑有大小写用例 |
| 升级时有排队中的旧记录 | 可能被展开两次 | 用 `text` 是否以 `/` 开头来区分，旧全文固定以 `## Skill:` 开头 |
| steer 展开和写入之间记录被改（包括另一个后端实例改的） | 用旧内容 steer 进去 | 手动 steer 锁外展开，事务里核对 `text` 和 `namingSource`，变了就重新展开，最多重试 2 次；自动 steer 的记录在锁里新插，不用核对 |
| 初始消息的第二个 part 写失败 | 留下一条只有隐藏正文的用户消息 | 两个 part 一起落库，或者 append 失败也清理；04 有验收项 |
| 旁聊里排队编辑或重发后开始解析 slash | 原本按字面发送的消息变成调用 skill | 旁聊记录不解析 slash；04 有旁聊用例 |
| commands 的 markdown 回退被删 | 外部直接用 `createCommandService` 且不传 `submitPromptAccepted` 的调用方会报错 | 显式报错并写进变更说明 |
| 有 skill 历史时每个 run 刷新一次 registry | 遍历 skill 目录、读 SKILL.md 文件状态，有少量文件系统开销 | 先去重、只刷新一次；没有 skill 历史时不刷新；skill 文件没变时不会重新注册工具 |
| rewind 之后已登记的可信目录不清理 | 被 rewind 掉的 skill 目录在进程结束前仍可读 | 已知边界，风险低，本轮不处理 |
| skill 变化时工具描述变化 | 下一个 run 前缀缓存失效一次 | 现有行为，本方案不改变 |

回滚：各 Stage 可以独立回退。回退 Stage 1 后，新记录里的 `/name 原话` 会被旧代码当普通文字发给模型，所以回滚前要确认排队区为空，或者同时回退 Stage 1 和 2。

## 2.7 和 00 的对齐检查

| 00 的决定 | 本文位置 |
|---|---|
| B1 两个 part、标记字段、尾部追加 | 2.1、2.5、Stage 1 第 1 条 |
| B2 原样输入、规范化、原话取完整、只看后端标记、排队期间被删按普通文字、旧记录兼容 | Stage 1 第 1 到 3 条、2.5 |
| B2.1 手动 steer 锁外展开、内容核对和重试，自动 steer 进锁前展开、端口注入、失败按普通文字、已提交的直接返回回执 | Stage 2 第 1 条 |
| B3 信任登记时机、只扫当前上下文、去重刷新、路径来源、权限保持现状 | Stage 3 |
| B4 编辑重发校验前置、复用解析、新错误码、预填 helper、旁聊排队编辑和保留项重发不解析、三个入口的不可用表现 | Stage 1 第 7 条、Stage 2 第 2 条、2.5 |
| B5 一条消息一个 skill | 展开函数只认开头一个 `/name` |
| T1、T2 | Stage 4 |
| 第 5 节"实施时要一起改的地方" | Stage 1 第 1 到 6 条、Stage 2 第 3 到 4 条、2.6 |

F1 到 F5 由 frontend 文档承接。

## 2.8 不在本轮

- 旧会话迁移。
- 一条消息引用多个 skill。
- 禁止 ohbaby 修改 skill 文件的新规则。
- rewind 时清理已登记的可信目录。
- 主输入框支持更多字体和样式（另开议题）。
- TUI 的长消息折叠、标记整体删除，以及消息行里的 `/技能名` 上色。
- Web 用户气泡里的裸网址自动变链接。
- Web 的 slash 路径透传推理强度和模型选择（现有行为是不带，见 00 第 5 节）。
- Web 发送后占位行（`PromptProjectionRow`）短暂显示纯文字的闪动。
- 保留项重发的回包丢了重试、技能名大小写不同、重试前 skill 刚好被删，三者同时出现时报冲突（Stage 2 第 3 条）。
- `loadContent` 返回的 `info` 来自之前的扫描，查到条目和读正文之间 skill 被改名或改成不允许用户调用，这一次可能沿用旧身份。

以上没有构成新一轮的触发事件，只作记录。

## 2.9 关键改动清单

> 定位以符号为准，不记行号。本表不是进度表，实施中不勾选、不回写。

| ID | 类型 | 路径 | 符号或小节 | 要改什么 | 为何承重 |
|---|---|---|---|---|---|
| C1 | 代码 | `skill/`（新文件） | `expandSlashSkill` | 唯一的展开函数：校验、读正文、生成两个 part、不可用时按普通文字、旧记录兼容 | 所有写入口都靠它 |
| C2 | 代码 | `commands/service.ts`、`commands/types.ts` | `executeSkillCommand`、`formatSkillPrompt`、`CommandServiceOptions.skills` | 只校验，提交规范化后的原样输入（`rawArgs` 加 `body`）；删掉拼接函数；没有 `submitPromptAccepted` 时显式报错 | 改变 `prompt_submission.text` 的含义 |
| C3 | 代码 | `core/agents/runner.ts` 及途经的 `agents/service.ts`、`core/agents/instance.ts` | `writeInitialUserMessage`、`skillUsage` 参数链 | 用 `initialUserParts` 替换 `skillUsage`；按传入的 part 写初始消息，两个 part 一起落库或失败时清理 | 新消息路径 |
| C4 | 代码 | `adapters/ui-inprocess.ts` | `submitPromptWork` 里调用 `runtime.startSession` 之前、乐观 `userMessage` | 展开并传 part；乐观消息只放可见 part | 新消息路径和发送瞬间的显示 |
| C5 | 代码 | `core/message/origin.ts` | `isTranscriptPart`、新增 `isSkillBodyPart` | 过滤隐藏 part | 所有读方的统一入口 |
| C6 | 代码 | `services/reminder/skill-usage.ts` | `recentlyUsed` 及同文件的加载判断 | 只认隐藏 part 和旧版消息 | 压缩后的 skill 提醒 |
| C7 | 代码 | `runtime/prompt-scheduler/scheduler.ts`、`current-run-inputs.ts` | `steerQueued`、`steerAccepted`、`SteerQueuedPromptInput`、`SteerQueuedPromptOutcome` | 手动 steer：进锁前看状态，锁外展开，事务里核对内容，变了重试，内部 reason 不外传；自动 steer：进锁前展开 | 手动和自动 steer |
| C8 | 代码 | `adapters/ui-inprocess.ts` | `rewindSessionInternal`（`markRewoundShellRuns` 之前）、`resendSteerInputForOwner`、排队编辑、`resubmitRetainedPrompt` | 调共用解析函数；规范化技能名；steer 重发用 `original.text`，保留项重发用 `input.text`；旁聊的排队编辑和保留项重发不解析 | 编辑重发和各种重发 |
| C9 | 代码 | `adapters/ui-inprocess/prompt-mapper.ts`、`adapters/ui-inprocess/steer-recovery.ts`、`adapters/ui-inprocess.ts` | `promptRecordToUi`、`projectUnconsumedSteers`、`restoredText` | 改用预填 helper | 编辑框、steer 预览和 TUI 回填 |
| C10 | 代码 | `skill/tool.ts` | `activateSkillRuntime` | 抽出登记核心，供扫描历史复用 | 两条路径一致 |
| C11 | 代码 | `runtime/run-manager/manager.ts`、`types.ts` | `startRun` 里 `sandboxManager.acquire` 之后、`createCurrentRunInputPort` 的参数类型 | 登记当前上下文里模型看到过的 skill；端口参数类型补上 `sandboxLease`；steer 按 messageId 去重 | 信任登记的时机 |
| C12 | 代码 | `ohbaby-cli/src/tui/components/prompt/index.tsx`、`editor-viewport.ts` | `renderEditorLines`、`EditorDisplayRow` | 第一条逻辑行的 `/技能名` 上色；视口行补逻辑行号和起始偏移 | T2 |
| C13 | 代码 | `ohbaby-server/src/protocols/global-sessions.ts`、`ohbaby-sdk/src/contract/global-sessions.ts`、`ohbaby-sdk/src/util/session-action-errors.ts` | `globalSessionErrorStatus`、新错误码常量、`sessionActionErrorText` | 新错误码映射 400，文字原样透传 | 编辑重发报错能被用户看懂 |
| D1 | 文档 | `docs/ohbaby-web/ui/slash-commands/skill-invocation.md` | §1 当前合同 | 删掉 `User request:` 拼接的描述，改为两个 part | Web 的权威规格 |
| D2 | 文档 | `docs/skill/dfd-interface.md` | 新增一节 | slash 路径的消息结构和信任登记 | skill 模块的权威文档 |

### 连带影响面（不逐行列出）

- `services/session/title-fallback.ts`、`services/session-export/collect.ts`、`agents/subagents/monitor.ts`、`core/context/token-estimation.ts`：并入 `isSkillBodyPart`。
- `runtime/prompt-scheduler/in-memory-store.ts`、`database-store.ts`：排队编辑接受 adapter 传入的 `namingSource`。
- `adapters/ui-runtime/composition.ts`：注入信任登记函数。
- `skill/usage.ts`：补注释。
- 相关测试文件，见 04。
