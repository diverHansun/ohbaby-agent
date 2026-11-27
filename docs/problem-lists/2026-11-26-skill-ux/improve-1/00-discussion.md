# Skill 交互优化：讨论记录

本文记录 skill 交互优化的讨论结论，2026-11-26 定稿，2026-11-27 按 Pi 交叉评审和第二轮讨论修订。后端和 TUI 的正式方案见 01 到 04，Web 见 [frontend/](frontend/00-goal-duty.md)。两者冲突时以本文为准。

## 1. 要解决的问题

1. 用户用 `/技能名 原话` 调用 skill 后，气泡里显示的是 SKILL.md 全文加 `User request:` 加原话，而不是用户自己输入的内容。
2. 用户消息较长时会占满屏幕，需要默认折叠。
3. 通过 slash 调用的 skill 没有登记目录信任，模型读取 `references/` 时会弹出审批。
4. 编辑重发带 skill 的消息时，编辑框预填的是展开后的全文；重发走纯文本路径，skill 身份会丢失。

## 2. 现状摘要

- `executeSkillCommand`（`packages/ohbaby-agent/src/commands/service.ts`）把 SKILL.md 格式化全文和用户参数拼成一段文字提交，`prompt_submission.text` 存的也是这段全文。
- 模型调用 `skill` 工具时，`activateSkillRuntime`（`src/skill/tool.ts`）会登记 `active-skill` 和 `skill-output` 两个可信目录；slash 路径的 `skills.loadPrompt`（`src/adapters/ui-inprocess.ts`）没有调用它。
- read 工具读工作区和可信目录以外的路径需要审批，full-access 模式除外。
- 编辑重发调用 `rewindSession`：先截断历史，再用 `submitPromptAcceptedWork` 提交纯文本，不解析 slash。
- 序列化时，同一条 user 消息的多个 text part 用 `.join("")` 直接拼接（`src/core/context/serializer.ts`）。
- skill 列表放在 `skill` 工具的描述里，只包含模型可调用的 skill，不包含 `disableModelInvocation` 为真的 skill。skill 有变化时会重新注册这个工具（`adapters/ui-runtime/composition.ts` 的 `refreshSkillTools`），下一个 run 的工具描述随之变化，前缀缓存在这一次会失效。这是现有行为，本方案不改变。
- slash 命令解析不区分大小写（`ohbaby-sdk/src/slash-command/resolve.ts`）。和内置命令或保留名（`cancel`、`mode`、`model` 等）重名的 skill 不会进入 slash 命令目录（`commands/service.ts`）。
- steer 消息在 prompt-scheduler 的同步事务里生成，直接用 `prompt.text` 拼成一个 text part（`runtime/prompt-scheduler/current-run-inputs.ts`），事务里不能读磁盘。

## 3. 已确认的决定

### 3.1 后端

#### B1：消息结构采用"同一条消息，两个 part"

- 同一条 user 消息拆成两个 part，参考 kimi-code 和 opencode。
  - **隐藏 part**：`synthetic: true`，`metadata.kind: "skill-body:v1"`。文字是 `<skill name="…">SKILL.md 格式化全文</skill>`，末尾带 `\n\n`，这样序列化代码不用改。`name` 用 registry 里的标准名，schema 限定只有小写字母、数字和连字符（`skill/loader.ts`），不需要转义。`skillUsage` 只挂在这个 part 上。
  - **可见 part**：给模型的文字只有用户参数，没有参数时为空字符串。`metadata.displayText` 存规范化后的 `/${name}` 加用户原话，`name` 是解析出来的标准技能名。用户敲 `/Code-Review` 也会存成 `/code-review`，前端可以按精确前缀识别。`metadata.skillMarker: { name }` 只供前端显示，不使用 `skillUsage` 这个键，以免 `skill-usage.ts` 把它当成"正文还在上下文里"的证据。
- 隐藏 part 放在可见 part 前面。
- 只在对话尾部追加新消息，不改动 system prompt 和历史消息，不影响 prompt cache 命中。
- 旧会话不迁移，旧消息按原样显示。
- 不采用"拆成两条消息"（deepseek-harness、codex 的做法），因为 rewind 切点、steer、标题、搜索、复制历史等按"一条用户消息为一轮"处理的地方都要跟着改。

#### B2：提交记录只存用户原样输入，开跑时再展开

- `prompt_submission.text` 只存规范化后的 `/技能名 原话`。提交时只校验 skill 是否存在、是否允许用户调用；skill 原文到写入消息历史时才展开。
- **规范化**只改两处：技能名换成标准名（用户敲 `/Code-Review` 存成 `/code-review`），命令名和原话之间的分隔统一。写成公式是 `/name` + (`rawArgs` 非空时加一个空格和 `rawArgs`) + (`body` 非空时加一个换行和 `body`)。第一行的首尾空白会被 `parseSlashCommandInput` 去掉，第二行起一字不动，换行、缩进、空行都保留。Web 发出的永远是空格分隔，换行分隔只来自 TUI 或手敲。新消息、编辑重发、排队编辑、保留项重发四个入口都按这条规则写 `text`，否则大小写不同的记录会被误当成升级前的旧记录。
- **原话要取完整**：SDK 的 `parseSlashCommandInput` 把第一行的参数放在 `rawArgs`，第二行起放在 `body`，现在 `executeSkillCommand` 只取了 `rawArgs`，多行原话会丢掉第二行以后的内容。原话改为 `rawArgs` 和 `body` 合起来，`/code-review` 后面直接换行的写法也要支持。
- 这样排队区、排队编辑、失败行、编辑框预填、TUI、`restoredText` 拿到的都是用户的原样输入，不需要各处反向拼接。
- **展开的触发条件只看后端标记**：只有 `namingSource.skillBodyExpanded === true` 的记录才展开，不解析 `prompt.text` 的开头，否则公共 submit 发一句 `/foo` 也会被展开。这个字段的含义从"已展开"变成"后端已校验的 slash 调用"，实施时改名或补注释（`src/skill/usage.ts`）。
- **排队期间 skill 被删，就不触发这个 skill**：轮到这条消息时，如果 skill 已被删除、改名或不再允许用户调用，就把 `/技能名 原话` 当普通文字发给模型，不展开正文，不带 `skillMarker`，也不另外提示。气泡里没有魔杖标记，本身就说明没触发。codex、deepseek-harness、Step-Code、minimax-code 都是这么做的（见 03）。这样不会产生失败行，也就不需要"失败行可以编辑重发"这个入口。
- 用户就在跟前的两种情况仍然当场报错：在输入框里发一个不存在的 skill（提交时校验），以及在编辑框里重发（B4）。
- **升级前已在排队或保留中的旧记录**：它们的 text 已经是全文，标记也在。旧全文的开头固定是 `## Skill: name`（`skill/tool.ts` 的格式），新记录永远以 `/` 开头，所以只看 text 是不是以 `/` 开头就能区分，不会展开两次，也不受大小写影响。

#### B2.1：steer 在进事务前异步展开

- 手动 steer 和自动 steer（goal run，发生在 `promptScheduler.accept` 的提交里）都要在调用 `inputs.steerQueued` 之前异步展开 skill，再把两个 part 作为参数传进事务。
- 展开放在会话锁外面做。scheduler 的会话锁（`commit(sessionId)`）只管同一个后端实例；锁里的代码约定"只做短的数据库操作"，不读磁盘。两个后端共用一个 SQLite 时，A 在展开，B 照样能拿到租约改掉这条记录，所以锁本身不能保证"展开到写入之间记录没变"。
- 手动 steer 的做法是"锁外展开，锁里核对内容"：
  1. 进锁前先读一次记录，状态已经不是 `queued`（比如这个操作已经提交过，只是回包丢了），就不展开，直接走现有逻辑返回原回执；
  2. 是 `queued` 且带后端标记时，在锁外调展开函数，记下展开时用的 `text` 和 `namingSource`；
  3. 进锁后在事务里重读记录，`text` 和 `namingSource` 都没变就把两个 part 写进去；变了就退出事务，按新记录重新展开，最多重试 2 次，还对不上就按普通文字 steer 进去。不比 `updatedAt`，因为编辑租约续期也会改它，会白白触发重试。
- 自动 steer 不用核对：它的记录是 `promptScheduler.accept` 在同一把锁里刚插进去的，进锁前还不存在，别人也改不到。做法是在进锁（`persist()`）之前用 `input.text` 和后端标记先展开，把结果带进锁里交给 `steerAccepted`。记录已经存在（`!inserted`）时照旧返回原回执。
- 展开函数以端口的形式注入 prompt-scheduler，避免 runtime 层反过来依赖 skill 模块。scheduler 在 `adapters/ui-inprocess.ts` 里创建，端口就在那里注入。
- 展开失败时和 B2 一样，按普通文字 steer 进去，不返回 not-steered，也不改 SDK 的 steer 结果枚举。事务里发现内容变了，用的是一个只在 scheduler 内部使用的结果，由重试循环自己消化，不往外传。

#### B3：slash 路径补上信任登记

- slash 路径和工具路径一样登记 `active-skill` 和 `skill-output` 两个可信目录。读取 skill 目录不再弹审批，写入只放开到 `.ohbaby/skill-output/<name>`，scripts 照常走命令审批。
- 登记时机：run 拿到 sandbox 租约后扫描一遍历史，把已加载的 skill 都登记上（包括 `skill-body:v1`、旧版 slash 消息，以及已完成的 `skill`、`skill_resource` 工具调用），这样首轮、进程重启和 fork 都能覆盖到。已被删除的 skill 直接跳过。steer 消费时再补一次登记。
- 只扫当前租约对应的那段历史：租约按 `sessionId` 加 `contextScopeId` 区分，子上下文不继承别的上下文登记过的目录。还在排队的消息不算；steer 在接收时就写进了消息表，但可能还没被模型读到，所以扫描要先过 `currentRunInputStore.filterModelHistory`，只认模型真正看到过的消息。主上下文也要显式传 `{ contextScopeId }`。
- 可信路径一律取当前的 `registry.get(name).baseDir`，不用工具调用 metadata 里存的 `dir`，那个路径可能已经过时。
- 扫描时先把 skill 名去重，有候选才刷新一次 registry，然后逐个取目录，不按调用次数重复刷新。历史里没有 skill 调用时不碰 registry。
- 已知边界：同名 skill 换了来源（比如项目级的新装了一个，覆盖了用户级的同名 skill），扫描会登记新来源的目录。这和工具路径现在的行为一样，本轮不处理。
- 不放在 `initialTrustedRoots` 里做，是因为那个钩子只在 sandbox context 创建时运行一次，同一进程里后续的 run 拿不到新登记。
- ohbaby 修改 skill 文件时保持现状，不新增规则：
  - 工作区外的 skill 弹外部写审批；
  - 工作区内的项目级 skill（`.ohbaby/skills/`）按普通工作区写入处理，用户允许写工作区后就能改。这一点作为已知边界记录。
  - full-access 模式下全部放行，这是现有的统一约定。

#### B4：编辑重发可以再次引用 skill

- 编辑框预填用户的原样输入，重发时和新消息走同一个展开函数，每次都从磁盘重新读取 SKILL.md。回填原话和 skill 引用是 kimi、codex、opencode、minimax 的共同做法；每次重读 SKILL.md 在 codex、Step-Code 里核实过。我们自己的理由是：用户改完重发，用的应该是当前的 skill 内容。
- 校验要放在 rewind 做任何事之前：`rewindSessionInternal` 在截断历史（`commitRewind`）之前，已经会调用 `markRewoundShellRuns` 和 `stopForRewind`，停掉正在跑的 run、暂停 goal、取消排队项。所以校验放在 `readRewindCut` 拿到原消息之后、这两步之前。校验失败时，历史、正在跑的 run、goal 和排队区都保持原样。
- 校验通过之后的两种失败分开处理：
  - 提交被拒（比如 scheduler 不接受）：走现有的 `sendError`，Web 回填到主输入框。
  - 提交已被接收、开跑时 skill 又不见了：按 B2 不触发 skill，当普通文字发送。
- 开头 `/名字` 的识别复用新消息的 `resolveSlashCommand` 和命令目录，只认 `source: "skill"` 的结果。这样和内置命令或保留名重名的 skill，在新消息和编辑重发里的表现一致。编辑重发和排队编辑都按这个规则处理。
- 开头 `/名字` 的判断规则：
  - 是允许用户调用的 skill：展开后发送；
  - 是原消息的 skill，但已被删除、改名或不再允许用户调用：在编辑框下方报错，不截断历史。错误用一个新的错误码，服务端映射成 400，SDK 原样透传错误文字，不加 `Something went wrong:` 前缀；
  - 其他以 `/` 开头的文字（如 `/compact`、`/api/v1`）：按普通文字发送。
- 旧消息只有在 `namingSource.skillBodyExpanded === true` 时，才预填 `/技能名 原话`，否则预填原全文。只看有没有 `namingSource` 不够，因为公共 API 也能传入并持久化它。这个映射写成一个后端 helper，`promptRecordToUi`（Web 编辑预填）和 `restoredText`（TUI 回退预填）都用它。
- **旁聊不解析 slash**：旁聊本来就禁用 slash（`executeCommand` 会抛 `SideChatUnsupportedError`），旁聊里发出的 `/code-review x` 是按字面发给模型的。排队编辑和保留项重发按原记录所属的会话判断，旁聊里的记录一律不解析开头的 `/名字`，原话照样当普通文字，也不会报 skill 不可用的错。否则用户只改一个字，原本按字面发送的消息就会变成调用 skill。旁聊本来就不支持编辑重发（`readRewindCut` 遇到旁聊直接抛 `SideChatUnsupportedError`），这条路径不用处理。
- **三个入口遇到 skill 不可用时的表现不同**（主会话）：编辑重发按上面的规则报错，因为用户正盯着编辑框；排队编辑和保留项重发不报错，按普通文字处理，和 B2 排队期间 skill 被删的规则一致。

#### B5：一条消息最多一个 skill

- skill 标记只能有一个，且只能放在最前面。
- 用户想用其他 skill 时，可以在原话里提一句，模型会根据 `skill` 工具描述里的列表自己加载。只允许用户调用（`disableModelInvocation`）的 skill 不在这个列表里，只能通过 slash 调用。

### 3.2 前端排版

#### F1：气泡里的技能标记采用行内前缀

- 技能标记放在气泡最前面，原话紧接在后面，换行后从最左边开始。
- 样式是蓝色的图标加技能名，没有底色、边框和阴影。颜色用新增的语义变量 `--skill-ink`，不用 `--accent`：Web 浅色主题下 `--accent` 是接近黑色的 `#18181b`，和正文分不开。
- 没有参数时，气泡里只显示标记。
- 显示规则：可见 part 带 `skillMarker` 时，去掉 `displayText` 开头的 `/${skillMarker.name}`，换成标记，后面接剩下的原话。原话按 F5 原样显示。复制消息时仍然得到 `/技能名 原话`。
- 气泡里永远不显示 SKILL.md 的正文，哪怕一行也不显示。
- 图标用 lucide 的 `WandSparkles`（魔杖加小星星），不用单独的 `Sparkles`。单独的星星常被用来表示"AI 生成"，魔杖则表示"调用一项能力"，和 skill 的含义更贴近。图标尺寸和技能名字号一致（约 14px），描边用默认粗细；Web 目前只有浅色主题，实现时在浅色下看一次实际效果即可。

#### F2：长用户消息默认折叠

- 只折叠用户消息，助手回复不折叠。
- 按实际渲染高度判断：超过约 12 行才折叠，折叠后露出前 8 行。
- 折叠时，正文截断处显示 `…`，左下角显示 `Show more` 加向下的箭头；展开后显示 `Show less` 加向上的箭头。
- 开关就是一行文字加箭头，不包卡片，不加阴影，hover 时没有变化，点击切换，没有动效。
- 点气泡正文不会触发展开。
- 搜索跳到这条消息时自动展开（搜索按消息定位，不定位到消息内部的位置）。点"编辑"时气泡整个换成编辑框，不涉及折叠。折叠状态不保存。

#### F3：主输入框和编辑框里的技能标记

- 主输入框和编辑框都改，两处用同一个小组件。
- 在命令面板里选中 skill 后，输入框里显示和气泡一样的技能标记，放在最前面。
- 只在确定是 skill 的入口生成标记，前端不拿命令目录去猜开头的 `/xxx`（命令目录只在输入以 `/` 开头时才去拉，靠它判断要处理异步加载，还要区分程序填入和手敲）：

  | 入口 | 怎么知道是 skill |
  |---|---|
  | 命令面板选中 | 选中的就是 skill |
  | `/skills` 弹窗的 Insert | 同上 |
  | 编辑框打开 | 消息自带 `skillMarker` |
  | 编辑重发失败后回填主输入框 | 同上 |
  | 草稿恢复 | 草稿里单独存技能名；旧草稿是纯文字，照常读成纯文字 |

- 其他情况都按纯文字处理：手敲的 `/code-review `、粘贴进来的文字、排队编辑。后端照样按 skill 处理这些文字，气泡照常显示标记。
- 草稿恢复时不检查 skill 是否还在。skill 在这期间被删了，草稿照样恢复成标记，发送时报错（Web 发 slash 时先在前端用命令目录解析，找不到就直接报错）。
- 发送失败时，标记和原话都要还回输入框。现在 `Composer.send()` 一发送就清空输入框，失败时用闭包里的文字写回；`pendingText` 另有用途，它是防重复提交的身份，决定要不要沿用同一个 `clientRequestId`。所以 `pendingText` 继续存拼好的 `/技能名 原话`，另加一份 `pendingSkill`，只用来回填标记（frontend/06 第 3.1 节）。
- 编辑重发失败时，现在会把文字拼到已有草稿后面（`SessionScreen.tsx`）。带 skill 的文字改为放在最前面，保证 skill 还在开头。回填用的是**点发送那一刻**编辑框里的标记，所以编辑框的 `onSend` 要把技能名和原话分开传，不能只传拼好的字符串。
- 编辑框里的命令面板只列 skill，不列 `/compact` 这类命令，因为编辑重发时它们会被当成普通文字发出去。
- 主输入框里已经有标记时，在原话开头敲 `/`，命令面板也只列 skill，选中后替换原来的标记（一条消息最多一个 skill）。
- 只有标记、没写原话时也可以发送。
- 编辑框里命令面板打开时，Esc 先关面板，再按一次才取消编辑；回车选中面板里的 skill，不发送。
- 提交时把标记和原话拼成 `/技能名 原话` 发给后端，和 B2 的提交格式一致。
- 光标在原话最前面、没有选中文字时按一次退格，整个标记一起删除；正在用输入法输入时不响应。
- 标记上不放 ×。
- 不小心删掉标记后，再敲一次 `/` 从命令面板选回来即可，不做额外的恢复功能。因此编辑框也接入命令面板。
- 实现思路：标记是单独的一小块，压在输入框左上角；输入框第一行缩进出标记的宽度，输入框本身仍是普通 textarea。输入框的状态从一串文字拆成"技能名加原话"两份，否则面板会因为文字以 `/` 开头一直弹出。不换成富文本输入框，那是另一个议题。
- 输入框写满、开始内部滚动时，标记要跟着第一行一起滚走、滚回来，不能一直停在左上角盖住别的文字。

#### F4：发送和停止按钮改成亮蓝色

- 改这几个按钮：主输入框的 Send、Stop，编辑框的 Send，以及旁聊页的 Send、Stop。旁聊页和主输入框用的是同一组样式（`.ohb-send-button`、`.ohb-stop-button`），本来就会一起变。审批的 Allow、弹窗主按钮、加载圈、上下文用量条等其他用 `--accent` 的地方不改。
- 新增语义变量 `--signal`（加 hover 和按钮上文字的颜色），初值是亮蓝 `#3b82f6`，从三档对比里选的。hover 时稍微加深；禁用时仍是现在的灰色。
- 按钮上的图标和文字是白色。Stop 中间的方块是实心白色，和现在的写法一样（`<Square fill="currentColor">`，跟着文字色走），换了底色也不用另改。
- `--skill-ink` 不再引用 `--signal`，单独取 `#2459b8`。原因是技能名是文字，要达到 4.5:1，而亮蓝在气泡底色 `#f4f4f5` 上只有 3.4:1。两个蓝是同一色系，深浅不同。
- 编辑框的 Send 默认用深一档的蓝 `#2563eb`（也就是其他按钮 hover 时的颜色），hover 时再深一档。原因是它上面写着文字 "Send"，白字在 `#3b82f6` 上只有约 3.7:1，不到普通文字 4.5:1 的要求；换成 `#2563eb` 后约 5.2:1。主输入框和旁聊页的 Send、Stop 只有图标，满足 3:1 即可，仍用亮蓝。

#### F5：用户气泡原样显示

- 用户自己输入的消息按纯文字显示，保留换行和空格（`white-space: pre-wrap`），不按 markdown 渲染。用户打的是什么，气泡里就是什么，复制出来也一样。
- 只管用户输入的消息。子代理页面里的"From parent"提示虽然也用用户气泡的样式，但它是模型写的 markdown，继续按 markdown 渲染。
- 旁聊引用选中文字时会在前面加 `> `，气泡里会直接看到 `>`，这就是实际发出去的内容。
- 裸网址不再变成可点的链接。这是已知的退化，本轮不补。
- 长网址、长路径要能自动断行（`overflow-wrap: anywhere`），现在这条规则挂在 markdown 的样式上，改了以后要补到新的元素上。
- 这样一来，魔杖标记放在第一行开头、后面接纯文字就很自然，折叠用 `-webkit-line-clamp` 出 `…` 也不会和 markdown 的块级结构打架。
- kimi-code 也是这么做的：用户文字原样显示，`pre-wrap` 加 10 行收起。

### 3.3 TUI

范围：F1 至 F5 只在 Web 上做，TUI 只做下面两项，不做长消息折叠，不做标记的整体删除，消息行里的 `/技能名` 也不上色。

#### T1：用户消息里不显示 skill 原文

- 按 B1 和 B2 的方案，TUI 收到的用户消息文字就是 `displayText`，也就是 `/技能名 原话`，TUI 这边不用改代码，只需验证。
- 需要验证的地方：TUI 消息行、排队列表、排队编辑、RewindPanel 的预填。

#### T2：输入框里的 `/技能名` 用蓝色显示

- 不加图标。输入框开头的 `/技能名` 是已知 skill 时显示为蓝色，其余文字颜色不变。
- 只给 skill 上色。`/compact`、`/model` 这类内置命令回车就执行，不会作为消息发出，不上色。
- 颜色使用 TUI 主题里的 `accent`（`theme/tokens.ts`，深色、浅色模式都有定义）。
- 改动在 `components/prompt/index.tsx` 的 `renderEditorLines`：每行现在按光标拆成三段渲染，需要再按 `/技能名` 的范围拆分，并处理光标正好落在技能名里面的情况。只在编辑器第一行逻辑行、起始偏移为 0 的那一行上色，不能用视口里的 `index === 0` 判断，否则输入框滚动或第一行换行后，上色位置会错。视口行（`editor-viewport.ts` 的 `EditorDisplayRow`）现在不带逻辑行号和起始偏移，要一起补上。

## 4. 后续议题

以下内容不在本次范围内：

1. 主输入框支持更多字体和样式（比如之前提过的斜体），单独开一个议题讨论。F3 的标记组件要和输入框解耦，以后换成富文本输入框时只需替换渲染部分。

## 5. 实施时要一起改的地方

这部分来自 Pi（Gemini 4 Neon、GPT-6.2 Astra）的两轮审查和子代理的文档审查，已抽查核实：

- **隐藏 part 的过滤**：新增一个 `isSkillBodyPart` 判断函数，并入 `isTranscriptPart` 和各处已有的 `isModelContextPart || isSystemReminderPart` 判断，不要每处单独写一遍。涉及：
  - `origin.ts` 的 `isTranscriptPart`；
  - `title-fallback.ts`，现在没有排除隐藏 part，不改的话会把 SKILL.md 当成标题。它读的是 `part.text`，不带原话的 `/code-review` 可见 part 文字为空，会被跳过，所以要改成 `isTranscriptPart` 加 `transcriptText`；
  - `adapters/ui-inprocess/steer-recovery.ts` 的 `projectUnconsumedSteers`：它把所有 text part 的文字直接拼起来给界面看"未处理的 steer"，不改的话 Web 和 TUI 的恢复区会显示 SKILL.md 全文。改成读原提交记录，经过预填 helper，显示 `/技能名 原话`；
  - `session-export/collect.ts`；
  - `subagents/monitor.ts`；
  - `token-estimation.ts`，把隐藏 part 计入 skills 统计；
  - 搜索 SQL 已经排除了 `synthetic`，不用再改。
- **`skill-usage.ts`**：判断 skill 是否已加载时，只认 synthetic 的 `skill-body:v1` part 和旧版消息，不再依赖可见文字非空。
- **共用同一个展开函数的路径**：
  - 新消息；
  - 编辑重发；
  - steer（见 B2.1）；
  - 未处理 steer 的重发：现在用 `.join("")` 拼所有 text part。改为直接用 `original.text`（即规范化后的原样输入）重发，再走同一个展开函数。不能只排除隐藏 part，那样拿到的只有用户参数，和 `original.text` 比较会失败，`namingSource` 就丢了；
  - 排队项编辑和保留项重发：编辑排队文本时 `namingSource` 会被清空，需要重新计算。保留项重发用这次编辑后的 `input.text`，不用原记录的文字；
  - 乐观消息（`submitPromptWork` 里构造）：只放可见 part，和正式消息的可见部分一致，避免发送瞬间闪烁。隐藏的正文 part 不进乐观消息。
- **解析和规范化写成一个共用函数**：新消息、编辑重发、排队编辑、保留项重发四个入口都调它，拿到"是不是 skill、标准名、规范化后的 `text`、`namingSource`"，不要各写一份。
- **parts 换掉 `skillUsage` 参数**：现在 `skillUsage` 沿 `agents/service.ts` 一路传到 runner。改成传 `initialUserParts`（展开函数的结果），乐观消息和 runner 共用同一次展开，不再单独传 `skillUsage`。
- **runner 两个 part 要一起落库**：`writeInitialUserMessage` 现在先 `createMessage` 再逐个 `appendPart`，现有的清理（`removeMessage`）只在 run 创建失败后生效。第二个 part 写失败时，会留下一条只有隐藏正文的用户消息。实施时要么在一个事务里写完，要么把 append 失败也纳入清理。
- **commands 的 markdown 回退改成显式失败**：现在 `executeSkillCommand` 在没有 `submitPromptAccepted` 时会退回去返回 markdown。改成直接报错。`createCommandService` 从包根导出，`submitPromptAccepted` 在类型上是可选的，仓库里只有一个生产调用方，不能证明外部没人依赖，所以把这条记为公共 API 的行为变化，写进变更说明。
- **保留项重发不先认回执**：保留项重发沿用现有的冲突检查（`database-store.ts` 里同一个操作 ID 带了不同文字就报冲突），不在展开前单独查回执。已知边界见下面。
- **安全约束**：公共 `submitPromptAccepted` 已经不信任外部传入的 `namingSource`（`src/skill/usage.ts` 的 `publicNamingSource`），实施时保持这一点：`skillBodyExpanded` 和 `skillUsage` 只能由后端在校验之后打上。
- **`registry.load` 不检查 `userInvocable`**：展开函数里要显式检查。
- **展开函数里不要重复刷新**：`registry.get` 每次都会先 `refresh`，`registry.load` 又会调 `get`。展开函数只调一次 `load`：捕获 `SkillNotFoundError` 和 `SkillLoadError` 都当作不可用（查到条目后、读正文前文件被删，会抛后者），再看 `content.info.userInvocable`。信任扫描要一次查多个名字，先 `refresh` 一次再用 `all()` 查，不逐个 `get`。
- **已知边界**：
  - Web 的 slash 路径（`usePromptSubmission.ts` 的 `submitText` 遇到 `/` 开头时调 `submitSlashCommand`）不带推理强度和模型选择，`executeSkillCommand` 也不带。这是现有行为，本轮不改；有了标记之后 skill 会更常用，这个限制会更显眼。
  - rewind 不会清理内存里已登记的 skill 可信目录，残留到进程结束，风险较低。
  - 保留项重发的回包丢了再重试，而且用户这次敲的是大小写不同的技能名（`/Code-Review`），重试前 skill 又刚好被删：第一次存的是 `/code-review x`，重试时规范化不了，文字变成 `/Code-Review x`，和已提交的记录对不上，会报冲突错误。三个条件同时满足才会出现，本轮接受。
  - `loadContent` 重读了正文，但返回的 `info` 来自之前的扫描。查到条目和读正文之间 skill 被改名或改成不允许用户调用，这一次可能沿用旧身份。窗口很短，本轮不处理。
  - skill 有变化时，下一个 run 的工具描述会变，前缀缓存失效一次（见第 2 节）。B3 在历史里有 skill 调用时会刷新一次 registry。刷新要遍历 skill 目录、读 SKILL.md 的文件状态，有少量文件系统开销，但只要 skill 文件没变，就不会重新注册工具。
  - Web 发送后、正式消息到达前，有一个很短的占位行（`PromptProjectionRow`，读 `prompt.text`）会显示纯文字 `/技能名 原话`，然后才变成带标记的气泡。本轮接受这一下闪动，不为它改提交记录的投影。

## 6. 文档安排

- 后端和 TUI 用 plan-code-improvement 写 01 到 04；Web 用 plan-frontend-design 的精简模式写在 `frontend/` 下，省略 02 和 07。
- 02 写关键改动清单，写到文件和符号这一级，不标行号。
- 不写模块级改进文档。`docs/skill/` 没有描述 slash 路径，和本方案不冲突；实施后同步 `docs/ohbaby-web/ui/slash-commands/skill-invocation.md` 和 `docs/skill/dfd-interface.md`。
