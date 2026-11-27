# 06 数据与状态

> 后端字段的定义以 [../02](../02-optimization-plan-and-change-scope.md) 第 2.5 节为准，本文不重复。状态和表现见 [04](04-interaction-and-states.md)，组件见 [05](05-components.md)。代码路径省略前缀 `apps/ohbaby-web/src/`。

## 1. 后端接口到界面的映射

本次不新增接口，只用现有接口里新增的字段，外加一处行为变化。

| 接口或数据 | 界面上谁用 | 怎么用 |
|---|---|---|
| 用户消息可见 part 的 `text`（即 `displayText`）和 `metadata.skillMarker` | 用户消息气泡 | `skillMarker` 存在且 `text` 以 `/${name}` 开头时，拆成标记加原话（05 的 2.7）；原话按纯文字显示 |
| 同上 | 编辑框 | 打开时拆成 `initialSkill` 和 `initialText` |
| 隐藏 part（`metadata.kind: "skill-body:v1"`，`synthetic: true`） | 无 | 界面拿不到。后端投影 `partToUiParts` 先过 `isTranscriptPart`，02 Stage 1 第 5 条把 `isSkillBodyPart` 并进这个判断，前端不需要改 |
| `prompt_submission.text` | 排队列表、失败行、排队编辑、编辑框预填、发送后的占位行 | 新记录是 `/技能名 原话`，原样当纯文字用 |
| 排队期间 skill 被删的消息 | 用户消息气泡 | 只有一个普通 text part，没有 `skillMarker`，按普通消息显示 |
| `listCommands` 里 `executionKind: "skill"` 的条目 | 命令面板 | 选中后生成标记，不再直接提交 |
| 主输入框发送的现有链路 | 主输入框发送、排队、steer | 提交的文字由前端拼成 `/技能名 原话`。以 `/` 开头的文字走 `ui/session/usePromptSubmission.ts` 的 `submitText` → `submitSlashCommand` → `runtime/index.ts` 的 `executeSlashCommand`（先在前端用命令目录解析）→ `executeCommand`，不走 `submitPrompt`。链路不变 |
| `rewindSession`（编辑重发） | 编辑框发送 | 提交的文字同上；后端新增"skill 不可用"错误码（400，文字原样透传），见第 4 节 |

## 2. 数据转换

转换只在两个地方发生，组件里不重复写：

**读：消息文字拆成标记和原话。** 在 `ui/conversation/` 下放一个纯函数 `splitSkillText(text, skillMarker)`：

- `skillMarker` 存在，且 `text === "/" + name`，或以 `"/" + name + " "`、`"/" + name + "\n"` 开头 → 返回 `{ skill: name, text: 去掉开头和这一个分隔符后剩下的部分 }`。
- 其他情况 → 返回 `{ skill: null, text }`，按原样显示。
- 气泡和编辑框都调它。不按文字开头猜 skill，没有 `skillMarker` 就是纯文字（00 F3）。

**写：标记和原话拼成提交文字。** 在 `ui/composer/` 下放一个纯函数 `composeSkillText(skill, text)`：

- `skill` 为 `null` → 原样返回 `text`。
- 否则返回 `"/" + skill`，`text` 去掉首尾空白后不为空时，再加一个空格和 `text`。和现在一样只去首尾空白，中间的换行、缩进、空行一字不动。
- 主输入框发送、排队、steer、编辑框发送都调它，保证四处拼法一致。

## 3. 前端状态

### 3.1 主输入框

`ComposerDraftState`（`ui/composer/useComposerDraft.ts`）新增一项：

| 字段 | 类型 | 含义 |
|---|---|---|
| `skillName` | `string \| null` | 当前的技能标记 |
| `setSkillName` | setter | 选中 skill、删除标记、清空草稿时调用 |

现有的 `draft` 含义改为"原话"，也就是 textarea 里的文字。这样：

- 命令面板仍然看 `draft.startsWith("/")` 决定开不开；`skillName` 不为空时只列 skill（05 的 2.6）。
- "输入框里有内容"统一改成 `skillName !== null || draft.trim().length > 0`。`Composer.tsx` 里所有看 `draft.trim().length` 的地方都换成它，包括能不能发送，以及运行中显示 Send 还是 Stop：运行中只有一个标记时，按钮是 Send（排队），不是 Stop。
- 发送时（`Composer.tsx` 取 `draft.trim()` 的地方）改成 `composeSkillText(skillName, draft)`。
- `Composer.send()` 现在一点发送就清空 `draft`，失败时用闭包里的 `text` 写回。改成同时清空 `skillName`，失败时把闭包里的 skill 和原话一起写回。
- `pendingText` 不是用来回填的，它是防重复提交的身份：`useComposerDraft.updateDraft` 用它判断要不要沿用同一个 `clientRequestId`，它还存进 `StoredComposerDraft.pendingText`，并复制到 `QueuedEditState.originalPendingText`。所以 `pendingText` 继续存拼好的 `/技能名 原话`；`updateDraft` 的比较改成 `composeSkillText(skillName, nextDraft) === pendingText`。这样换了标记、原话没变时，会换一个新的 `clientRequestId`，不会拿到旧 skill 的回执。
- 另加 `pendingSkill`，只用于回填，也存进 `sessionStorage`。
- `send()` 里 generation 对不上的那个分支现在只写回 `text`，也要带上 skill。
- 失败回填的条件 `draftRef.current.length === 0` 改成"原话为空且 `skillName === null`"，避免把旧标记盖到用户新写的内容上。
- `setSkillName` 和 `setDraft` 一样推进 `editRevision`。

为什么不把 `draft` 保持成 `/技能名 原话` 整串：那样 textarea 显示的和 `draft` 不一致，每次输入都要拆了再拼；而且 `draft` 永远以 `/` 开头，命令面板会一直弹出来。分开存只有发送这一处要拼。

### 3.2 填入入口

谁能设上 `skillName`，和 00 F3 的表一一对应：

| 入口 | 做法 |
|---|---|
| 命令面板选中 skill | `setSkillName(name)`，`draft` 去掉开头刚敲的 `/xxx` |
| `/skills` 弹窗 Insert | `onInsertSkill` 改为传技能名；预填时 `skillName = name`，`draft = ""` |
| 编辑重发失败回填 | 预填时 `skillName` 是编辑那条消息的 skill，`draft` 是原话加原草稿（中间空一行）。原草稿里有标记的话，先用 `composeSkillText` 拼成纯文字再接 |
| 草稿恢复 | 见 3.3 |

预填数据 `ComposerPrefill`（`useComposerDraft.ts`）新增可选的 `skill?: string`；`prefillComposer` 相应多一个参数。没传 `skill` 的调用方行为不变。

排队编辑（`useSteerQueue.ts`）进入时会直接 `setDraft(lease.prompt.text)`，这时要先把 `skillName` 清空，否则标记会盖在排队文字前面。`QueuedEditState` 新增可选的 `originalSkill?: string`，和 `originalDraft`、`originalPendingText` 一起保存，Esc 或编辑结束时一起还原。排队项本身的文字仍是纯文字，不生成标记（01 第 4 节）。

### 3.3 草稿保存

草稿存在 `sessionStorage`（`draft-storage.ts`），按会话分开，只在同一个浏览器标签页里有效。

- `StoredComposerDraft` 新增可选的 `skill?: string`，`text` 存原话。
- 恢复时有 `skill` 就恢复成标记，不检查 skill 是否还在（01 UC-SKILL-04）。
- 升级前存下的草稿没有 `skill`，`text` 原样恢复成纯文字。
- 只有标记、原话为空的草稿也要保存，不能因为 `text` 为空就当成空草稿删掉。

### 3.4 编辑框

`UserMessageEditor` 内部状态是 `skill` 和 `text`，打开时由 `splitSkillText` 给出初值；发送时把两者分开交给 `onSend({ skill, text })`，由 `SessionScreen.tsx` 的 `sendEdit` 用 `composeSkillText` 拼好提交。失败回填主输入框时直接用这两份，不用再拆。这部分状态不保存，关掉编辑框就没了，和现在一样。

### 3.5 折叠

`CollapsibleUserText` 自己管 `expanded`，不进全局状态，不保存（01 T-03）。搜索跳转已有的 `anchorMessageId` / `anchorToken` 不用改，只是多传一层给这个组件。

### 3.6 命令目录

命令目录的加载和缓存沿用 `useSlashPalette` 现在的做法：敲 `/` 时才加载，按 `commandCatalogVersion` 判断是否重新拉取。编辑框共用同一份缓存，不另外请求。

## 4. 错误到界面的映射

| 错误 | 从哪来 | 界面表现（04 对应位置） |
|---|---|---|
| 发送时 skill 不存在或不允许用户调用 | `executeSlashCommand` 在命令目录里找不到，前端直接报错；或后端校验失败 | 主输入框现有的发送错误表现，标记和原话从 `pendingSkill`、`pendingText` 写回（04 的 2.2） |
| 排队期间 skill 被删 | 不是错误 | 后端按普通文字发送，气泡没有标记（01 T-01） |
| 编辑重发时 skill 不可用 | `rewindSession` 返回新错误码，HTTP 400，历史、run、goal、排队区都没动 | 编辑框提示行原样显示后端的错误文字，没有 `Something went wrong:` 前缀，编辑框不关（04 的 2.3） |
| 提交被拒（截断已经发生） | 现有的 `sendError` | 编辑框关闭，回填到主输入框（3.2） |
| 命令目录加载失败 | `listCommands` 失败 | 现有的面板错误表现；编辑框里面板不出现 |
| 其他未知错误 | — | 沿用各处现有的兜底，不新增 |

编辑重发的错误文字由后端写成面向用户的英文句子，前端原样显示（03 第 6 节）。这条错误的文字带上技能名，比如 `Skill "code-review" is not available`，已写进 02 Stage 2 第 2 条。

## 5. Mock 场景

Web 已有 mock 机制：`vite dev` 下用 `?mock=<场景名>` 切换（`bootstrap.ts`，场景在 `dev/mock-scenarios.ts`，接口桩在 `dev/mock-runtime.ts`），`&delay=<毫秒>` 放慢请求。本次在这套机制上补：

| 场景或开关 | 内容 | 用来看 04 的哪些状态 |
|---|---|---|
| `MOCK_COMMANDS` 加 skill 条目 | 至少三个 skill：`code-review`、一个很长的名字、一个和命令同前缀的名字 | 面板列出 skill、只列 skill、长技能名换行 |
| `skill-messages` | 一个会话里放：带标记有原话、只有标记、带标记的多行原话、带标记的长消息、普通长消息、升级前的旧 slash 消息（全文、无标记）、排队期间 skill 被删后按普通文字发出的消息（`/code-review x`、无标记）、`skillMarker` 和文字开头对不上的消息、满是 markdown 符号的消息、带超长网址的消息 | 气泡的全部行、原样显示、折叠、复制、编辑入口 |
| 草稿里的 skill 已不在目录 | `sessionStorage` 里预置一个带标记的草稿，技能名不在 `MOCK_COMMANDS` 里 | 草稿恢复成标记；发送时前端报错，标记和原话写回 |
| `&skillError=rewind` | `rewindSession` 返回"skill 不可用"错误码和文字 | 编辑框提示行显示错误 |
| `&delay=` | 已有 | 发送后输入框清空、失败回填，编辑框 Send 转圈 |

旁聊用现有旁聊场景，加一条长用户消息和一条带 `> ` 引用的消息，顺便看 Send、Stop 的颜色。子代理页面用现有场景看"From parent"仍按 markdown 渲染。单元测试和组件测试直接用 `dev/mock-scenarios.ts` 里的同一批消息数据，不另外编。
