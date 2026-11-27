# 1. 现状与问题

> 时间口径：`main` 分支 `f20eaada`，2026-11-26。本文只描述现状，方案见 [02](02-optimization-plan-and-change-scope.md)，Web 的设计见 [frontend/](frontend/00-goal-duty.md)。
>
> 路径省略前缀：后端代码在 `packages/ohbaby-agent/src/` 下，Web 在 `apps/ohbaby-web/src/` 下，TUI 在 `packages/ohbaby-cli/src/tui/` 下。

## 1.1 问题陈述

| # | 用户看到的 | 技术原因 |
|---|---|---|
| P1 | 用 `/code-review 帮我看看` 调用 skill 后，气泡里是几百行 SKILL.md，后面才是自己的那句话 | skill 正文和用户原话拼成一段文字，存进同一个 text part，界面没法只显示原话 |
| P2 | 粘一大段日志或长需求，用户消息占满一屏 | Web 用户气泡没有折叠能力 |
| P3 | slash 调用的 skill 让模型读 `references/` 时弹审批，模型自己调 `skill` 工具时却不弹 | slash 路径没有登记 skill 目录为可信目录 |
| P4 | 编辑带 skill 的消息，编辑框里是展开后的全文；改完重发，skill 身份没了 | 提交记录存的是展开后的全文；重发走纯文本路径，不识别 slash |

P1 和 P4 是同一个根因：**展开得太早**。skill 正文在提交那一刻就和原话揉在一起，后面所有环节（存储、排队、显示、编辑）拿到的都是揉过的文字。

## 1.2 现在的数据流

```
用户输入 /code-review 帮我看看
   │
   ▼
commands/service.ts  executeSkillCommand
   │  skills.loadPrompt(name)            ← adapters/ui-inprocess.ts，只读 SKILL.md 并格式化
   │  formatSkillPrompt(正文, 参数)       → "正文\n\nUser request:\n帮我看看"
   │  namingSource = { skillName, request }
   ▼
submitPromptAccepted(展开后的全文, { namingSource })
   │  namingSource 被 expandedSkillNamingSource 打上 skillBodyExpanded: true
   ▼
prompt_submission.text = 展开后的全文          ← 排队、编辑预填、TUI 回退都读它
   │
   ├─ 空闲：开新 run ──► core/agents/runner.ts  writeInitialUserMessage
   │                      一个 text part：text = 全文，metadata.skillUsage = { name, source:"slash" }
   │
   └─ 运行中：steer ──► runtime/prompt-scheduler/current-run-inputs.ts
                          同步事务里用 prompt.text 拼一个 text part，同样挂 skillUsage
```

序列化给模型时，同一条 user 消息的多个 text part 用 `.join("")` 直接拼接（`core/context/serializer.ts` 的 `textContentFromParts`），不会拆成多块。

## 1.3 后端现状

### 1.3.1 消息结构（data-model）

- 一条 slash 消息只有一个 text part。`text` 是全文，`metadata.skillUsage` 标明来源。
- `core/message/origin.ts` 已经有"模型能看到、界面不显示"的机制：`synthetic: true` 加 `metadata.kind`，比如 `model-context:runtime:v1`、`system-reminder:v1`，由 `isTranscriptPart` 过滤掉。slash 消息没有用这套机制。
- 界面拿到的文字来自 `transcriptText`：有 `metadata.displayText` 用它，否则用 `text`。slash 消息没有 `displayText`，所以界面显示全文。
- `adapters/ui-state/persistent-store.ts` 的 `partToUiParts` 会把 part 的 `metadata` 原样带给界面，新增显示字段不需要改 SDK 的投影代码。

### 1.3.2 提交记录与身份标记

- `skill/usage.ts`：
  - `expandedSkillNamingSource` 给内部 slash 提交打上 `skillBodyExpanded: true`；
  - `slashSkillUsage` 只在这个标记为真时生成 `skillUsage`；
  - `publicNamingSource` 在公共提交入口剥掉外部传进来的 `skillBodyExpanded`，防止外部伪造 skill 身份（契约测试在 `adapters/ui-inprocess.contract.test.ts`）。
- `skillBodyExpanded` 现在的意思是"text 已经是展开后的全文"。
- 排队文本被编辑时，`runtime/prompt-scheduler/in-memory-store.ts` 会在文字变化时把 `namingSource` 清空（DB store 同理），skill 身份随之丢失。
- 多行原话会丢：`ohbaby-sdk` 的 `parseSlashCommandInput`（`slash-command/parse.ts`）把第一行的参数放进 `rawArgs`，第二行起放进 `body`；`executeSkillCommand` 只用 `invocation.rawArgs`，第二行以后的内容现在就进不了 prompt。
- 编辑重发、排队编辑、保留项重发（`rewindSessionInternal`、`editQueuedPromptForOwner`、`resubmitRetainedPromptForOwner`）都把用户的文字原样落库，不做技能名的大小写规范化。
- 旁聊禁用 slash：在旁聊里执行命令，`executeCommand` 会抛 `SideChatUnsupportedError`，所以旁聊里发出的 `/code-review x` 是按字面发给模型的普通文字。
- `core/agents/runner.ts` 的 `writeInitialUserMessage` 先 `createMessage`，再逐个 `appendPart`。现有的清理（`removeMessage`）只覆盖 run 创建失败；现在只有一个 part，问题不明显。
- `commands` 的 `executeSkillCommand` 在调用方没传 `submitPromptAccepted` 时，退回去返回 markdown 全文。这个回调在类型上是可选的，`createCommandService` 从包根导出。

### 1.3.3 steer 路径

- `current-run-inputs.ts` 的 steer 处理在一个同步事务里直接用 `prompt.text` 生成消息，事务里不能读磁盘。
- 未处理 steer 的重发（`adapters/ui-inprocess.ts` 的 `resendSteerInputForOwner`）把所有 text part 用 `.join("")` 拼起来重发，再拿结果和 `original.text` 比较，决定要不要带上 `namingSource`。
- 未处理 steer 的预览（`adapters/ui-inprocess/steer-recovery.ts` 的 `projectUnconsumedSteers`）同样把所有 text part 的 `part.text` 拼起来，不过 `isTranscriptPart`，也不读 `displayText`。Web 的 `ui/composer/UnconsumedSteers.tsx` 和 TUI 直接显示这段文字。
- steer 和保留项重发在重试时都先认已提交的回执（`current-run-inputs.ts` 的 steer 处理、`scheduler.ts` 的保留项重发），同一个操作不会做两遍。保留项重发认回执时会比较文字：同一个操作 ID 带了不同文字，报冲突（`runtime/prompt-scheduler/database-store.ts` 的重发分支）。
- steer 在接收时就写进了消息表，但要等下一次模型请求才真正被模型读到。run 在这中间结束，这条 steer 就留在表里却从没进过模型请求。模型实际看到的历史要经过 `currentRunInputStore.filterModelHistory` 过滤。
- scheduler 的会话锁（`adapters/ui-state/session-view.ts`）只在同一个后端实例里生效，锁里的代码约定只做短的数据库操作。两个后端共用一个 SQLite 时，互相拦不住。

### 1.3.4 信任与权限

| 场景 | 模型调 `skill` 工具 | 用户用 slash 调用 |
|---|---|---|
| 登记可信目录 | `skill/tool.ts` 的 `activateSkillRuntime` 登记 `active-skill`（skill 目录）和 `skill-output`（`.ohbaby/skill-output/<name>`） | 不登记 |
| read 读 skill 目录 | 不弹审批 | 弹外部目录读取审批 |
| write/edit 改 skill 目录 | 弹审批（`active-skill` 不在写可信列表里） | 弹审批 |
| bash 跑 skill 脚本 | 命令本身要审批；路径不算外部路径 | 命令要审批；路径算外部路径 |

相关代码：

- read 和 write 的判断：`core/tool-scheduler/scheduler.ts` 的 `isOutsideTrustedEnvironment` 和 `isWriteTrustedRootKind`。写可信的只有 session-scratch、workspace、skill-output、external-write-approved。
- bash 的判断：`sandbox/trusted-roots.ts` 的 `isShellTrustedRootKind` 包含 `active-skill`。
- full-access 模式下全部放行：`permission/evaluator.ts`。
- 可信目录存在内存里的 sandbox context。`adapters/ui-runtime/composition.ts` 的 `initialTrustedRoots` 只在 context 创建时运行一次，只加 session-storage 和 scratch。进程重启后，工具路径登记过的 skill 目录也会丢。
- sandbox 租约在 `runtime/run-manager/manager.ts` 的 `startRun` 里才拿到。`runner.ts` 写初始消息时还没有租约，在那里登记是空操作。

### 1.3.5 编辑重发

- Web 编辑框预填 `editablePrompt(message)?.text`，也就是 `prompt_submission.text`，所以是全文（`ui/conversation/ConversationStream.tsx`）。
- 重发调用 `rewindSession`（`adapters/ui-inprocess.ts` 的 `rewindSessionInternal`），顺序是：`readRewindCut` 找到切点 → `markRewoundShellRuns` 和 `stopForRewind`（停掉正在跑的 run、暂停 goal、逐条取消排队项，见 `ui-inprocess/session-rewind.ts`）→ `commitRewind` 截断历史 → 用 `submitPromptAcceptedWork(text, …, { rewindReplacement: true })` 提交纯文本，不解析 slash。返回的 `restoredText` 也是全文，TUI 的 RewindPanel 用它回填。
- 截断后提交被拒，会通过 `sendError` 返回；Web 把文字拼到已有草稿后面（`ui/session/SessionScreen.tsx` 的 `sendEdit`）。`submitPromptAcceptedWork` 在 scheduler 接收后就返回回执，之后开跑时出的错不经过 `sendError`，而是把 prompt 标成 `failed`。
- 失败的 prompt 在 Web 上画成一行纯文字加错误（`ConversationStream.tsx` 的 `PromptProjectionRow`），没有编辑按钮；`readRewindCut` 也要求消息表里有对应的用户消息，所以失败行没法走编辑重发。
- 编辑重发的错误到界面会走样：未登记的错误码在服务端映射成 500（`ohbaby-server` 的 `globalSessionErrorStatus`），SDK 再加上 `Something went wrong:` 前缀（`ohbaby-sdk/src/util/session-action-errors.ts`）。
- `skill/registry.ts` 的 `load(name)` 不检查 `userInvocable`。slash 命令目录只列允许用户调用的 skill，所以新消息路径没问题；编辑重发如果自己调 `load`，就得自己检查。
- slash 命令解析不区分大小写（`ohbaby-sdk` 的 `slash-command/resolve.ts`）。和内置命令或保留名（`cancel`、`mode`、`model`）重名的 skill 不进命令目录（`commands/service.ts` 的 `RESERVED_EXTERNAL_COMMAND_ROOTS`）。

### 1.3.6 依赖"可见文字"或"skill 身份"的其他地方

| 位置 | 现在怎么做 | 拆成两个 part 后的风险 |
|---|---|---|
| `services/reminder/skill-usage.ts` | 判断 skill 正文是否还在上下文里：找带 `skillUsage` 且文字非空的 user text part | 身份挂错 part，或参数为空，会误判成"没加载过" |
| `services/session/title-fallback.ts` | 只排除 `isModelContextPart`，读 `part.text` | 不排除新的隐藏 part，会把 SKILL.md 截成会话标题；不带原话时可见 part 的 `text` 为空，会被跳过 |
| `adapters/ui-inprocess/steer-recovery.ts` | `projectUnconsumedSteers` 拼所有 text part | 未处理 steer 的预览会显示 SKILL.md 全文 |
| `core/message/origin.ts` 的 `escapeReminderValue` | 只转义 `&`、`<`、`>` | 本轮不用：技能名受 schema 限制（`skill/loader.ts`，只有小写字母、数字和连字符），写进 `name="…"` 不需要转义 |
| `services/session-export/collect.ts`、`agents/subagents/monitor.ts` | 各自排除已知的隐藏 kind | 要一起排除新 kind |
| `core/context/token-estimation.ts` | 已有 skills 统计桶 | 隐藏 part 应计入 skills，不计入对话 |
| `services/session/search-visibility.ts` | SQL 已排除 `synthetic` 为真的 part | 不需要改 |
| 乐观消息（`ui-inprocess.ts` 的 `submitPromptWork` 里构造的 `userMessage`） | 用 `displayText ?? text` | 要和正式消息的可见部分一致，否则发送瞬间会闪一下全文 |

## 1.4 Web 现状

- `ui/conversation/MessageRow.tsx` 按 part 渲染文字，用户消息也走 `MarkdownBlock`（`dangerouslySetInnerHTML` 生成块级 HTML），没有技能标记，也没有折叠。长单词断行（`overflow-wrap: anywhere`）挂在 `.ohb-markdown` 上。子代理页面的"From parent"提示（`SubagentConversationBody.tsx` 传 `fromParent`）也走用户分支。
- 主输入框是普通 textarea（`ui/composer/ComposerInput.tsx`），命令面板由 `ui/composer/useSlashPalette.ts` 提供，和 `ComposerDraftState` 绑定在一起。选中 skill 后会立刻把 `/技能名` 发出去（`runSlashCommand`）。
- `Composer.send()` 一发送就清空 `draft`，把整串存进 `pendingText`，失败时再写回；输入框不是只读，用户可以接着写下一条。
- 输入框写满后，`ui/composer/composerTextarea.ts` 会把 textarea 改成内部滚动（`overflowY: auto`）。
- 编辑框 `ui/conversation/UserMessageEditor.tsx` 是普通 textarea，没有命令面板，`onSend` 只回传一整串文字。
- Web 发送以 `/` 开头的文字时，`ui/session/usePromptSubmission.ts` 的 `submitText` 转给 `submitSlashCommand`，再由 `runtime/index.ts` 的 `executeSlashCommand` 先在前端用命令目录解析，最后走 `executeCommand`（`POST /v1/commands`）到 `executeSkillCommand`（见 `docs/ohbaby-web/ui/slash-commands/skill-invocation.md`）。目录里没有这个 skill 时，前端直接报错。
- 旁聊页 `ui/side-chat/SideChatPage.tsx` 复用 `ComposerInput` 和 `.ohb-send-button`、`.ohb-stop-button` 两个样式。

## 1.5 TUI 现状

- 消息行 `components/message/message-row.tsx` 的 `renderTextPart` 用户分支逐行渲染文字。文字来自投影，现在就是全文。
- 输入框 `components/prompt/index.tsx` 的 `renderEditorLines` 每行按光标拆成三段渲染，没有给 `/技能名` 上色。视口行 `EditorDisplayRow`（`components/prompt/editor-viewport.ts`）不带逻辑行号和起始偏移。
- 排队列表、排队编辑、RewindPanel 都读 `prompt.text` 或 `restoredText`，现在都是全文。
- 主题里有 `accent` 色（`theme/tokens.ts`，深浅两套）。

## 1.6 改动影响面

- **后端**：`commands`（展开入口）、`skill`（展开函数、身份标记）、`core/message`（新 part 类型判断）、`core/agents/runner.ts`（写消息）、`runtime/prompt-scheduler`（steer、排队编辑）、`runtime/run-manager`（拿到租约后登记信任）、`adapters/ui-inprocess.ts`（编辑重发、steer 重发、乐观消息、预填 helper）、几个读消息的服务。
- **Web**：消息气泡（改成原样显示）、主输入框、编辑框、编辑失败回填、发送类按钮颜色（包括旁聊页）。
- **TUI**：输入框。消息行和排队列表不改代码，只验证。
- **服务端和 SDK**：编辑重发新增一个错误码，映射成 400，错误文字原样透传。
- **对外协议**：不加新接口。可见 part 的 `metadata` 多两个字段（`displayText`、`skillMarker`），界面已经能透传。`prompt_submission.text` 的含义从"全文"变成"原样输入"，这是行为变化，需要兼容升级前已在排队的旧记录。
- **缓存**：新消息只追加在对话尾部，不改 system prompt 和历史，不影响前缀缓存命中。

## 1.7 SWE 原则审视

- **偶然复杂度来自"展开太早"**（00 哲学：本质复杂度和偶然复杂度）。"显示原话、给模型全文"是本质需求；但现在在提交那一刻就把两者揉在一起，后面每个消费方要么显示全文，要么得反向拆字符串。把展开推迟到写消息那一刻，所有上游自然拿到原样输入。这是减法，不是加层。
- **信息隐藏做得不够**（02 基础受力）。"这条消息是不是 slash 调用"本该是一个明确的字段，现在却要靠 `skillBodyExpanded` 加文字内容一起推断。steer 重发里"拼回去再比较字符串"就是这个问题的症状。
- **同一件事两条路径不一致**（03 DRY 的正当用法）。工具路径和 slash 路径都是"加载 skill"，信任登记却只有一条路径做了。这里该共用同一个登记函数；而展开函数被新消息、编辑重发、steer 等多条路径共用，也该只有一份。
- **不该抽象的地方**（03 KISS/YAGNI）。一条消息只允许一个 skill，不为多 skill 预留结构；不做硬拒绝改 skill 文件的规则；不迁移旧数据。
- **依赖方向**（02 耦合）。prompt-scheduler 属于 runtime 层，不应直接依赖 skill 模块。steer 的提前展开要以注入的形式交给它，而不是让它 import skill 代码。

## 1.8 与既有文档的关系

| 文档 | 现在写的 | 和本方案的关系 |
|---|---|---|
| `docs/ohbaby-web/ui/slash-commands/skill-invocation.md` §1 | skill 命令由 `executeSkillCommand` 用 `User request:` 拼进 prompt | 本方案改变这一行为，实施后同步更新 |
| `docs/skill/dfd-interface.md` | 没有描述 slash 路径的消息结构和信任登记 | 实施后补一节 |
| `docs/skill/data-model.md` | `user-invocable` 和 `disable-model-invocation` 是两条独立开关 | 一致，本方案沿用：slash 只认允许用户调用的 skill |
| `docs/problem-lists/2026-10-18-system-reminder/` | 定义了 `system-reminder:v1` 这类隐藏 part 和 skill 使用提醒 | 一致，新 kind 沿用同一套机制 |
