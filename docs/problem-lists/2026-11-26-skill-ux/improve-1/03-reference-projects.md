# 3. 参考项目

> 本文整理同类项目在"用户主动调用 skill"这件事上的做法，以及 ohbaby 取哪些、不取哪些。结论已经写进 [00](00-discussion.md) 和 [02](02-optimization-plan-and-change-scope.md)，这里给出出处。代码路径相对于各项目根目录，行号是 2026-11-26 的快照。

## 3.1 参考来源

所有项目都在本地 `code-cli/` 目录下。

| 项目 | 本地路径 | 看了什么 |
|---|---|---|
| kimi-code | `code-cli/kimi-code` | 消息结构、Web 气泡、编辑回填、信任、长消息折叠、skill 不见了怎么办 |
| deepseek-harness | `code-cli/deepseek-harness` | 消息结构、界面怎么认出 skill 调用、skill 不见了怎么办 |
| codex | `code-cli/codex` | 消息结构、回退、正文何时读取、审批、skill 不见了怎么办 |
| opencode | `code-cli/opencode` | 消息结构、气泡徽标、回退还原、权限、skill 不见了怎么办 |
| Step-Code | `code-cli/Step-Code` | 消息结构、编辑回填（反例）、skill 不见了怎么办 |
| minimax-code | `code-cli/minimax-code` | 编辑时是否保留 slash 命令、skill 不见了怎么办 |
| ZCode | `code-cli/ZCode` | slash 调用的另一种实现 |

### 各项目做法摘要

**kimi-code**（做得最完整，和我们的方案最接近）

- 消息结构：slash 调用生成一条用户消息。第一个文字块是 skill 正文，外面包一层 `<skill-loaded name trigger="user-slash" …>`，用户自己的话排在后面（`packages/agent-core-v2/src/features/skill/prompt.ts` 的 `renderUserSlashSkillPrompt`，L29–55）。
- 气泡：Web 显示技能徽标加原话，不显示正文（`packages/app-components/src/chat/ChatPane.vue` 的 `userTextContent`）。TUI 显示 `/skill:name 原话`（`apps/kimi-code/src/tui/utils/message-replay.ts`）。
- 编辑：Web 编辑框回填 `/skill:name 原话` 或徽标（`app-composer/src/features/mention/skillActivation.ts` 的 `skillActivationEditText`），TUI 的 undo 回填 `/name 原话`。不会回填展开后的正文。
- 信任：skill 根目录无论怎么调用，都加入 Read、Edit、Write、Grep、Glob 的工作区目录（`agent/tools/os/read/readTool.ts` L267 等）。
- 折叠：用户消息超过 10 行收起（`ChatPane.vue` L1092 的 `USER_TEXT_CLAMP_LINES = 10`），开关文案是 `Show more` / `Show less`。

**deepseek-harness**

- 消息结构：用户原话作为一条普通用户消息原样保存，文字里保留 `/name`。每轮开始前（`agent/pre-step`），再为每个被点名的 skill 追加一条单独的用户消息，内容是 `<skill_content>` 正文，来源标为 `{kind: 'skill-invocation', name}`（`packages/skill/tool-skill/src/index.ts` L182–208，`packages/skill/skill/src/index.ts` L142–160）。
- 识别：文字里任何位置的 `/name` 都会被识别，一条消息可以调用多个 skill（`invokedSkillNames`，L430–455）。只扫描 `source.kind === 'user'` 的消息，外部文字没法冒充。
- 界面：源码注释写明，界面按来源 metadata 展示注入内容，不去解析给模型看的文字。

**codex**

- 用 `$name` 提及调用，不走 slash。先记录用户消息，再为每个 skill 记录一条单独的用户消息 `<skill><name>…</name><path>…</path>正文</skill>`（`ext/skills/src/fragments.rs` L73–139，`core/src/session/turn.rs` L475、L517–523）。
- 这些 skill 消息在界面上作为上下文片段隐藏（`core/src/event_mapping.rs` L116–117）。
- 回退时还原原话和提及绑定。每轮都重新读 SKILL.md（`host_prompt.rs` 的 `load_skill_prompts`）。
- 审批只有 `skill_approval`，管的是 skill 脚本执行，没看到按调用方式放行读取。

**opencode**

- 用 `@skill` 提及调用。一条用户消息里 skill 正文排在前面、用户原话在后（`core/src/session/runner/to-llm-message.ts` L260–273）。
- 气泡显示原话加 `skill` 徽标，不显示正文（`tui/src/routes/session/index.tsx`）。
- 回退还原原话和 skill id，不还原正文；重发时重新展开。
- skill 目录没有读取豁免。没有用户消息折叠。

**Step-Code**（反例）

- `/skill:name 原话` 展开成一整段文字 `<skill …>正文</skill>\n\n原话` 存进历史（`packages/coding-agent/src/core/agent-session.ts` 的 `_expandSkillCommand`，L2715–2739）。
- 界面显示前再用 `parseSkillBlock` 把这段文字拆开。
- 编辑回填的是展开后的整段正文，不是 `/skill:name 原话`（L4817–4826）。这正是 ohbaby 现在的 P4。

**minimax-code**：TUI 把 skill 注册成 `/name` 命令，编辑消息时保留命令（`packages/tui/src/tui/controller/product/command-flow.ts` L310–314）。没找到展开正文的位置。

**ZCode**：CLI 把 `/skill 名字 任务` 改写成一段提示"先调用 Skill 工具"，让模型自己去加载（`apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts` 的 `buildManualSkillPrompt`）。

### 3.1.1 skill 在展开时已经不见了

这一节回答"排队期间 skill 被删了怎么办"。2026-11-27 由子代理在代码里逐个核对，行号是近似值（前后差两行以内）。

| 项目 | 在哪里解析 skill | skill 不见了时 | 提示用户吗 | 原文还发吗 |
|---|---|---|---|---|
| kimi-code | 服务端 `skillService.ts` 的 `prepareBundled`，抛 `SKILL_NOT_FOUND`（L232–241）；TUI 自己的队列出队时才交给服务端（`kimi-tui.ts` 的 `sendQueuedMessage`，L2155–2177） | 整条拒绝 | 是，`Skill activation failed: Skill "x" was not found` | 不发 |
| opencode | 服务端 `core/src/session/prompt.ts` 的 `prepare`，L67–68 抛 `SkillNotFoundError`；入队前就渲染好正文 | 整条拒绝，返回 InvalidRequest | 是，toast 提示发送失败，输入框还原 | 不发 |
| codex | `codex-rs/skills/src/selection.rs` 的 `collect_explicit_skill_mentions`，找不到或已禁用时 `continue`（L81–89）；每轮开始时都重新解析 | 跳过这个 skill | 否；只有读 SKILL.md 出错时发 Warning | 原样发 |
| deepseek-harness | `packages/skill/tool-skill/src/index.ts` 的 `agent/pre-step` 监听，约 L197：未知名字和不允许用户调用的 skill "stay plain prose" | 跳过，什么都不注入 | 否 | 原样发，包括 `/name` |
| Step-Code | `agent-session.ts` 的 `_expandSkillCommand`，L2723 `if (!skill) return text` | 原文直通 | 否；读文件出错时才报错 | 原样发 |
| minimax-code | 不展开正文，`local-turn-input-preparation.ts` 的 `buildSlashSkillReminder` 只加一句提醒，找不到时返回空字符串（L854–878） | 不加提醒 | 否 | 原样发 |

两种做法的分界很清楚：kimi-code 和 opencode 报错，另外四个项目都是不触发 skill、原文照发。ohbaby 选后一种，理由见 3.2。opencode 在入队那一刻就把正文渲染好存进队列，所以它的队列里 skill 不会"中途消失"；kimi-code 的服务端队列也是这样。ohbaby 选的是开跑时才展开（00 B2），排队期间 skill 确实可能被删，必须有个处理办法。

## 3.2 借鉴点和取舍

| 话题 | 参考做法 | ohbaby 取舍 | 理由 |
|---|---|---|---|
| 正文和原话放在哪 | kimi-code、opencode：同一条消息，正文在前、原话在后 | **采用**：同一条消息两个 part（00 B1） | 一条用户消息就是一轮，rewind、steer、标题、搜索都不用改 |
| 界面怎么认出 skill 调用 | deepseek-harness：按来源 metadata 展示，不解析文字；codex：skill 消息作为上下文片段隐藏 | **采用**：隐藏 part 打 `skill-body:v1`，可见 part 带 `skillMarker`，界面只认字段 | 解析文字开头靠不住，用户原话也可能以 `/` 开头 |
| 历史里存什么 | Step-Code：存展开后的整段文字，显示时再拆 | **不采用** | 显示要反解析，编辑只能拿到正文，就是现在的 P1 和 P4 |
| 编辑回填 | kimi-code、opencode、codex、minimax-code：回填原话加 skill 引用；deepseek-harness 历史里本来就存着带 `/name` 的原话（编辑入口未核查） | **采用**：编辑框回填 `/技能名 原话`（00 B4） | 几个项目一致，用户改的是自己写的话 |
| 重发时正文从哪来 | codex、Step-Code：每次重新读 SKILL.md；opencode：重新展开 | **采用**：编辑重发时重新展开，从磁盘读最新正文 | skill 改了以后重发能用上新内容 |
| skill 目录的读取信任 | kimi-code：skill 根目录对读写搜索全部放行，不分调用方式 | **调整后采用**：slash 路径也走一遍 `activateSkillRuntime`，和工具路径一致；写入仍然审批（00 B3） | 用户要求先不让 ohbaby 自己改 skill 文件，所以只补齐读取，不放开写入 |
| 气泡里的 skill 标识 | kimi-code 是徽标，opencode 是 `skill` 徽标 | **调整后采用**：魔杖图标加技能名，行内前缀，没有底色和边框 | 项目的 Web 风格不用卡片和胶囊 |
| 长消息折叠 | kimi-code：超过 10 行收起，`Show more` / `Show less` | **调整后采用**：超过约 12 行收起，露出 8 行，文案相同 | 阈值留一点余量，避免只多一两行也被折叠 |
| TUI 显示 | kimi-code：TUI 显示 `/skill:name 原话` | **采用**：TUI 显示 `/技能名 原话`；只有输入框里的技能名用 accent 色，消息行不上色 | 终端里不放图标，文字最直接 |
| 排队期间 skill 不见了 | kimi-code、opencode：整条拒绝并报错；codex、deepseek-harness、Step-Code、minimax-code：不触发 skill，原文照发（见 3.1.1） | **采用后一种**：按普通文字发送，不另外提示（00 B2） | 用户已经不在跟前，报错也没人看；不产生失败行，就不用给失败行做重发入口 |
| 用户气泡怎么渲染 | kimi-code：用户文字原样显示（`white-space: pre-wrap`），超过 10 行收起（`ChatPane.vue`）；opencode：用户文字按纯文本显示 | **采用**：用户气泡原样显示，不按 markdown 渲染（00 F5） | 用户打的是什么就显示什么，复制出来也一样；折叠和魔杖前缀都更简单 |
| 一条消息几个 skill | deepseek-harness：文字里任意位置、可以多个 | **不采用**：只认开头一个（00 B5） | 多个 skill 要处理顺序、冲突和标记排版，眼下没有需求 |

## 3.3 明确不借鉴

- **拆成两条消息**（deepseek-harness、codex）。这两个项目本来就按消息来源组织上下文，加一条注入消息很自然。ohbaby 里 rewind 切点、steer、会话标题、搜索、复制历史都按"一条用户消息为一轮"处理，拆开以后这些地方都要改。同一条消息两个 part 已经能把正文藏起来，没必要多改。
- **注入时机放在每轮开始前**（deepseek-harness 的 `pre-step`）。它每轮都重新扫描并注入，正文不进历史。ohbaby 写历史时就展开，一次写入，后面的前缀缓存、压缩提醒、导出都能直接用。
- **改写成"请调用 Skill 工具"**（ZCode）。多一次工具调用，而且模型可能不照做。用户已经明确点名了 skill，直接给正文更可靠。
- **展开后整段存储**（Step-Code）。见 3.2。
- **skill 目录读写全部放行**（kimi-code）。见 3.2，本轮只补读取。
- **在正文前加一句提示**（kimi-code 的 `User activated the skill "X". Follow the loaded skill instructions.`）。`<skill name="…">` 标签已经说明了这是什么，先不加。实测发现模型不遵守 skill 指令时再考虑。

## 3.4 对 02 的影响

| 02 中的决定 | 来自哪里 |
|---|---|
| 消息结构：同一条消息两个 part，正文在前（2.2、Stage 1） | kimi-code、opencode 的结构；不采用 deepseek-harness、codex 的两条消息 |
| 界面只认 `skillMarker` 和 `kind`，不解析文字（2.5） | deepseek-harness 的"按来源 metadata 展示" |
| 编辑重发回填 `/技能名 原话`，重新展开（Stage 2） | kimi-code、opencode、codex 的回填方式；Step-Code 作为反例 |
| slash 路径登记信任，只放开读取（Stage 3） | kimi-code 的方向，按用户约束缩小范围 |
| Web 折叠阈值和文案（frontend/） | kimi-code 的 10 行和 `Show more` / `Show less` |
| 排队期间 skill 不见了按普通文字发送（2.2、Stage 1） | codex、deepseek-harness、Step-Code、minimax-code 的做法；不采用 kimi-code、opencode 的整条拒绝 |
| 用户气泡原样显示（frontend/） | kimi-code 的 `pre-wrap` 加收起 |
