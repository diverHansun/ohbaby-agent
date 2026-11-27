# 05 组件

> 状态和交互以 [04](04-interaction-and-states.md) 为准，样式变量见 [03](03-ui-layout-and-style.md) 第 3 节。代码路径省略前缀 `apps/ohbaby-web/src/`。

## 1. 组件索引

本次新增三个组件和几个小函数（这里的 `shouldRemoveSkillToken`，以及 06 的 `splitSkillText`、`composeSkillText`），其余是在现有组件上加参数。

| 组件 | 位置 | 新增或修改 | 用在哪 |
|---|---|---|---|
| `SkillToken` | `ui/shared/SkillToken.tsx` | 新增 | 气泡、主输入框、编辑框 |
| `SkillTokenField` 和 `shouldRemoveSkillToken` | `ui/shared/SkillTokenField.tsx` | 新增 | 主输入框、编辑框 |
| `CollapsibleUserText` | `ui/conversation/CollapsibleUserText.tsx` | 新增 | 用户消息气泡（主对话和旁聊） |
| `ComposerInput` | `ui/composer/ComposerInput.tsx` | 修改 | 主输入框；旁聊页也用它，但不传技能名 |
| `UserMessageEditor` | `ui/conversation/UserMessageEditor.tsx` | 修改 | 编辑框 |
| 用户消息气泡（`MessageRow` 里的 user 分支） | `ui/conversation/MessageRow.tsx` | 修改 | 对话流、旁聊页、子代理页面 |
| `useSlashPalette` 和 `SlashPalette` | `ui/composer/useSlashPalette.ts`、`ui/commands/SlashPalette.tsx` | 修改 | 主输入框、编辑框 |

不新建"富文本输入框"。输入区仍是原来的 `<textarea>`，标记是叠在上面的一个显示元素（见 2.2）。这样现有的自动高度、输入法、撤销、粘贴都不受影响。

## 2. 组件契约

### 2.1 `SkillToken`

**职责**：显示魔杖图标加技能名。只管长相，不管行为。

| 参数 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | skill 的标准名，不带 `/` |

- 渲染一个行内元素：`WandSparkles` 图标（`aria-hidden`）加 `name` 文字，整体 `aria-label="Skill: ${name}"`。
- 颜色用 `--skill-ink`；字号继承父元素，图标大小跟着字号走。
- 不换行（`white-space: nowrap`），不可选中（`user-select: none`），不可聚焦，没有点击事件。
- **不负责**：删除、跳转、tooltip、校验 skill 是否存在。

### 2.2 `SkillTokenField` 和 `shouldRemoveSkillToken`

**职责**：让一个现有的 `<textarea>` 在左上角显示技能标记，第一行文字让出标记的宽度。

| 参数 | 类型 | 说明 |
|---|---|---|
| `skillName` | `string \| null` | 有值时显示标记，`null` 时和没包一样 |
| `children` | `ReactNode` | 原来的 `<textarea>`，调用方照旧传它自己的 props 和 ref |

- 外层是一个相对定位的容器；`SkillToken` 绝对定位在第一行文字的位置。
- 用 `ResizeObserver` 量出标记宽度，加上约 6px 间距，写到容器的 CSS 变量上；textarea 用 `text-indent` 读这个变量。第一行从标记后开始，换行后自然回到最左边。
- 有标记时，textarea 不显示占位文字（由调用方传空 `placeholder`）。
- 标记要跟着第一行滚动：textarea 写满后会内部滚动（`composerTextarea.ts` 把它设成 `overflowY: auto`），标记按 textarea 的 `scrollTop` 往上移，滚出可视区时被容器裁掉。具体写法由实现决定，效果要和 04 的"写满后内部滚动"一致。
- 编辑框发送中只读时，整个容器跟着变淡，沿用现有只读样式。

`shouldRemoveSkillToken(event, textarea): boolean` 是一个纯函数，调用方在自己的 `onKeyDown` 里先调它：

- 返回 `true` 的条件：按的是 Backspace，`selectionStart === selectionEnd === 0`，`event.nativeEvent.isComposing` 为 `false`。
- 返回 `true` 时，调用方清掉技能名并 `preventDefault`。

**不负责**：保存技能名（状态在调用方）、打开命令面板、拼提交文字。

### 2.3 `CollapsibleUserText`

**职责**：用户消息超过约 12 行时收起，提供 `Show more` / `Show less` 开关。

| 参数 | 类型 | 说明 |
|---|---|---|
| `children` | `ReactNode` | 气泡正文（技能标记加纯文字；"From parent"提示是 markdown） |
| `expandSignal` | `string \| undefined` | 搜索跳转时传本次的 `anchorToken`；值变化且属于这条消息时展开 |

- 内部状态只有一个 `expanded`，默认 `false`，不持久化。
- 渲染后量正文实际高度。超过阈值（约 12 行，按行高算，初值约 286px）才进入可折叠状态；收起时只露出约 8 行。
- 收起用 `-webkit-line-clamp: 8` 出 `…`。用户消息改成纯文字以后，正文就是一段行内文字，line-clamp 能直接用。只有"From parent"提示还是 markdown，遇到代码块、表格等不能按行截断的内容时，退回固定高度加 `overflow: hidden`，不强求 `…`。
- 用 `ResizeObserver` 在宽度变化时重新判断（04 的 2.1"窗口变宽/变窄"两行）。
- 开关是 `<button type="button">`，带 `aria-expanded` 和指向正文的 `aria-controls`；样式见 03 第 3 节。
- **不负责**：复制（复制取消息文字，和折叠无关）、滚动定位（搜索跳转已有的逻辑负责）。

### 2.4 `ComposerInput`（修改）

新增一个参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `skillName` | `string \| null`，可选 | 当前标记；交给 `SkillTokenField`。旁聊页不传，等于 `null` |

- textarea 外面包一层 `SkillTokenField`。`draft` 参数的含义改为"原话"，即标记后面的文字。
- 有标记时 `placeholder` 传空。
- 键盘处理顺序：面板按键 → `shouldRemoveSkillToken` → 现有的发送逻辑。
- 发送按钮、停止按钮的颜色改动只在 CSS（03 第 3 节），组件代码不变。

`draft` 和 `skillName` 存在哪、怎么拼成 `/技能名 原话`、怎么存草稿，见 06。

### 2.5 `UserMessageEditor`（修改）

| 参数 | 变化 | 说明 |
|---|---|---|
| `initialSkill` | 新增，`string \| null` | 来自消息的 `skillMarker.name` |
| `initialText` | 含义变化 | 有 `initialSkill` 时只是原话；没有时和现在一样 |
| `onSend` | 改成 `({ skill, text })` | 技能名和原话分开传，由调用方拼成 `/技能名 原话` 提交。编辑重发失败回填主输入框时要用点发送那一刻的标记，只传拼好的字符串就拿不到 |

- 内部状态从 `text` 变成 `text` 加 `skill`。
- textarea 外面包 `SkillTokenField`，接一个只列 skill 的命令面板（见 2.6）。
- Esc：面板开着先关面板，关着才取消编辑。回车：面板开着先选 skill，关着才发送。
- 只有标记、原话为空时，Send 也可用。
- 后端返回的错误文字照旧显示在提示行。

### 2.6 `useSlashPalette` 和 `SlashPalette`（修改）

- `SlashPalette` 是纯展示组件，不改，编辑框直接复用。
- skill 条目（`executionKind === "skill"`）被选中时，不再调用 `onSubmit`，而是调用新的回调 `onSelectSkill(name)`。调用方把刚才敲的 `/xxx` 去掉，设上技能名。命令条目的行为不变。
- 新增"只列 skill"模式，用在两处：已有标记时在原话开头敲 `/`，以及编辑框。没有匹配的 skill 时面板不出现。
- 编辑框里是给 `useSlashPalette` 加参数复用它，还是另写一个薄的 hook，由实现决定。约束是：匹配和排序规则只写一份，两处共用；编辑框打开时才去拉命令目录，和主输入框一样懒加载。

### 2.7 用户消息气泡（修改）

- 用户消息的 text part 不再走 `MarkdownBlock` 和 `StreamingMarkdown`（`MessageRow.tsx` 里 `MessagePart` 的 text 分支），改成一个纯文字元素，`white-space: pre-wrap` 加 `overflow-wrap: anywhere`（03 第 3 节）。助手消息不变。
- "From parent"提示（`presentation.fromParent`）继续走 markdown。`messages.css` 里 `.ohb-message-user-bubble p:last-child`、`.ohb-message-user-bubble .ohb-markdown > :last-child` 和 `.ohb-message-user-bubble .ohb-code-block` 这几条规则还在给它用，不要删。
- 消息带 `skillMarker` 且文字以 `/${name}` 开头时：去掉这一段（连同后面一个空格或换行），在正文前放 `SkillToken`，剩下的原样显示。
- 文字开头对不上时：不放标记，原样显示全文（04 的 2.1 防御那一行）。
- 标记和正文在同一行：标记是行内元素，直接放在纯文字前面，不另起一个块。截图要和 03 线框 ① 一致。
- 阅读位置恢复：`ConversationStream.tsx` 的 `readingBlocks` 找的是 `.ohb-markdown > *`，纯文字气泡里找不到块，会退回按整行定位。用户消息不长，可以接受，不用改。
- 正文整体交给 `CollapsibleUserText`；搜索跳转命中这条消息时，把本次 `anchorToken` 作为 `expandSignal` 传进去。
- 复制按钮仍用 `messageBodyText`，结果是 `/技能名 原话`。

## 3. 组件之间的关系

```
ConversationStream
├── MessageRow (user)
│   └── CollapsibleUserText
│       ├── SkillToken
│       └── 纯文字（From parent 提示仍是 MarkdownBlock）
└── UserMessageEditor
    ├── SlashPalette (skills only)
    └── SkillTokenField
        ├── SkillToken
        └── <textarea>

Composer
└── ComposerInput
    ├── SlashPalette
    └── SkillTokenField
        ├── SkillToken
        └── <textarea>
```

依赖方向只有一种：`conversation/` 和 `composer/` 用 `shared/`，`shared/` 不反过来引用它们。

## 4. 不做的组件

- 不做带 × 的标记，不做可点击的标记。
- 不做排队列表、失败行里的标记（00 的 Non-goals）。
- 不做 contenteditable 富文本输入框（README 的不在范围内）。
- 不做通用的折叠组件给别的地方用。`CollapsibleUserText` 只服务用户消息，以后别处需要再提出来。
