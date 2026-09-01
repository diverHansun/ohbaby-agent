# 1. 问题分析与当前状态

> 时间口径：2026-09-01；规划基线 `origin/main@7cec6ba`（v0.1.12），工作分支 `codex/slash-commands-improve-1`。本文记录可复现现状与根因，不把目标方案伪装成已实施能力。

## 1.1 问题清单

1. **鼠标悬停与真实选中态脱节。** `/skills` 弹窗初始选中第一行；鼠标移到第二行不会更新 `selectedIndex` / `aria-selected`，随后按 `Tab` 仍落入第一行。单击落入本身已经存在。
2. **键盘选中项可能滚出可视区。** `↑/↓`、`PageUp/PageDown` 只改变 index，没有把对应行滚入 modal body 的可见区域。
3. **skill 行对长内容与 metadata 的约束不完整。** 当前常规名称/描述可以显示，浏览器计算样式也证明描述没有命中 MCP 状态点规则；真正缺口是过长 `strong` 名称与 metadata 没有完整的有界截断约束，且 Web 用 `source ?? scope`，同时有两个字段时会丢掉 scope。重复的 `.ohb-list-skill span` / `> span` 规则是维护债，但不是本次显示异常的已证实根因。
4. **浮层 `/skills` 行被空参数列拉出大空洞。** slash 行固定四列，第三列给 `argsHint` 至少 136px；`/skills` 没有参数提示，描述仍落在第四列，命令名与描述之间出现显著空白。
5. **`/skill` 还不是 `/skills` 的真实 alias。** catalog 中 builtin `skills` 的 `aliases` 为空。输入 `/skill` 时 palette 会因 canonical `skills` 的前缀匹配而出现 `/skills`；在 palette 打开时按 Enter 又会提交选中项的 canonical label `/skills`。这两种现象都不能证明 direct `/skill` resolve 成功。关闭 palette 后直接提交 `/skill` 才会得到 unknown command。
6. **catalog 注册与 `/skills` 输出使用了不同的可调用性口径。** `service.ts` 只预过滤了 `cancel` / `mode` / `model` roots 和两个 permission exact paths；`handleSkills` 却仍原样输出 registry。`validateUniqueAliases` 还会对全部 builtin canonical/aliases、显式 extra commands 与动态 skills 做大小写不敏感判重，因此 `status`、`mcp`、`quit`、`q` 等合法 skill 名同样可能使 catalog 构建失败。只局部补 `skill` / `skills` 会掩盖而不是解决问题。
7. **权威规格混合了当前能力与历史实施计划。** `skill-invocation.md` 的 §2 仍把已经落地的 Web skill 执行链写成“当前缺口”，§6 也仍以待实施口吻描述 `b5e00f4` 已完成的工作，容易让后续实施重复改动正确链路。

## 1.2 已确认的产品边界

详见 [00-discussion.md](./00-discussion.md)。本批保持既有发现模型：顶层 `/` 不铺开全部 skill，统一从 `/skills` 弹窗发现；指针悬停建立真实选中、单击落入，键盘选中后 `Tab` / `Enter` 落入；字面量 `/skill` 仅为 builtin `/skills` 的 input-only alias；注入协议不变。

```text
composer `/` 或 `/ski…`
  → palette 只展示 web-safe 命令（含 canonical /skills，不含单个 skill）
  → /skills 或 direct /skill resolve 为 builtin skills
  → CommandResultModal(skills)
  → 悬停选中 / 单击落入，或键盘选中 + Tab/Enter 落入
  → composer `/<skill-name> `
  → Enter → skill.<name> → executeSkillCommand → 既有 prompt 注入
```

## 1.3 七维现状审查

### 1.3.1 goals-duty

[`docs/ohbaby-web/goals-duty.md`](../../../goals-duty.md) D6 要求 Web 能执行 web-safe slash command，包含 `/skills`；Layer 2 的发现弹窗已经落地。当前缺口属于该职责的交互可靠性和呈现鲁棒性，不是新建第二套 skill 系统。

Web 顶层 `/` 不展示单个 skill 是经确认的产品例外，不能为了修 `/skill` alias 而移除 `isWebPaletteCommand` 对 `executionKind:"skill"` 的过滤。

### 1.3.2 architecture

- catalog：`catalog.ts` 定义 builtin `/skills`；`service.ts` 将可调用 skill 转为动态 command。
- 输出：`builtin.ts` 的 `handleSkills` 从 registry 生成 `data.skills`。
- Web 解析：`client.ts` 从 Web catalog resolve 后 POST canonical invocation。
- 视图：`createCommandResultModel → CommandResultModal → SkillsCommandResult`；落入通过 `composerPrefill` 回到 Composer。

执行和投影已经位于正确层。新增策略应是 commands 域内的纯 policy + eligibility projection：policy 只接收 command/path 数据，`service.ts` 从 builtin-only catalog 机械收集 canonical/aliases，按 builtin > 已接受 extra command > registry skill 的优先级形成 catalog 与 `slashInvocableSkills`；`builtin.ts` 通过 helper 消费后者。这样不反向依赖 `service.ts` 私有实现，也不在两处复制名单。

### 1.3.3 data-model

`data.skills[]` 现有字段足够：`name`、`description`、`path`、`commandId`、`scope`、可选 `source`。选中态是易失 UI 状态，无需服务端字段。

Web 当前 metadata 使用 `source ?? scope`，而 TUI `formatSkillRow` 的口径是 `scope · source`。这不是缺数据，而是投影丢失信息。目标应为：有两项时组合显示，缺 source 时只显示 scope；名称、描述、metadata 都单行有界。

alias 的信息模型也已经具备：SDK resolve 可匹配 `aliases`，命中后 invocation 仍返回 canonical `command.path`，并额外记录 `usedAlias`。因此显示层只需继续使用 path，不需要 Web 特判 `/skill`。

### 1.3.4 dfd-interface

```text
GET /v1/commands?surface=web
  → filterWebCommandCatalog
  → createSlashPaletteItems
  → isWebPaletteCommand 排除单个 executionKind:skill
  → 用户执行 builtin /skills（alias /skill 也应 canonical resolve）
  → POST /v1/commands
  → command.result.delivered { subject:"skills", data.skills }
  → SkillsCommandResult
  → onInsertSkill → composerPrefill.nonce
  → Composer draft `/<name> `
  → resolveSlashCommand → POST skill.<name>
```

边界缺口有两个：builtin alias 未进入 catalog；external skill 是否能成为 slash command与是否出现在 `/skills` output 没有共用 eligibility projection。两者都应在命令域解决，不应在 Web UI 增加名称黑名单。

### 1.3.5 use-case

| 用户故事 | 当前结果 | 缺口 |
|----------|----------|------|
| `/` 中看到 `/skills`，看不到单个 skill | 成立 | 保持 |
| direct 输入 `/skill` 执行列表命令 | palette 打开时可能被 canonical 候选“纠正”；绕过 palette 则失败 | 缺真实 alias |
| 鼠标移到第二行后按 Tab | 仍落入第一行 | hover 未更新真实选中态 |
| 单击一行落入 composer | 成立 | 保持 |
| 长列表键盘翻页 | index 会移动 | 选中行可能不可见 |
| 读取 skill 来源信息 | 只显示 source 或 scope 之一 | 应显示 `scope · source` |
| 名为 `status` / `mcp` / `model` / `skill` 的 registry skill 出现在 `/skills` | 当前可能出现；有的不可调用，有的会触发 duplicate catalog error | 输出承诺与实际可调用性不一致 |

### 1.3.6 non-functional

- **可观察/可预测**：现有 `aria-selected` 必须代表 hover 与键盘共享的真实选中态；选中行应使用 `scrollIntoView({ block:"nearest" })` 保持可见。由于 row 是普通 button、外层没有 listbox/option 语义且焦点由 window keydown 管理，本批不把该属性断言包装成“完整无障碍已完成”。
- **布局稳定**：有参数命令维持现有四列；无参数命令使用显式 modifier 三列，避免无界 `max-content` 让 `/connect` 等长参数反向挤压描述。
- **兼容性**：新增 alias 只扩展输入，不改变 canonical path、POST shape 或 daemon handler。
- **一致性**：catalog 与 `/skills` 输出必须共用一个大小写不敏感的 eligibility projection，而非各自重算 policy。
- **范围控制**：不引入新请求、搜索、参数表单或 TUI 视觉改版。

已知可访问性债务：完整复合控件语义、roving focus / `aria-activedescendant` 取舍、modal 关闭后的焦点恢复和屏幕阅读器专项验证另立议题；本批只修当前交互模型下可观察的 selected/insert 一致性。

### 1.3.7 test

规划前基线定向测试均通过：5 个文件、148 个测试（`catalog`、`service`、`slashCommands`、`App`、`styles`）。现有覆盖锁住顶层 `/` 不含单个 skill、PgDn+Tab 落入、单击落入等已实现能力。

当前测试缺口：

- 未用真实 catalog direct resolve `/skill`；只测 palette 前缀会产生假阳性。
- 未验证 catalog 与 `/skills` output 共用 builtin/extra/skill eligibility projection，并保留 legacy roots/exact paths。
- 未验证 hover 第二行后 `aria-selected` / Tab 都切到第二行。
- 未验证选中精确行调用 `scrollIntoView({ block:"nearest" })`。
- 未验证 `scope · source`、长名称/metadata 截断。
- 样式静态断言无法证明 no-args 行浏览器布局，仍需真实浏览器验收。

## 1.4 浏览器复现证据

使用规划基线的真实本地 Web 服务复现：

1. 输入 `/skill` 时，palette 只显示 `/skills`，该行在命令名与描述间存在明显空参数区。
2. 打开 `/skills` 弹窗，把鼠标移到第二行，第二行的 `aria-selected` 不变；按 `Tab` 落入第一行。
3. 检查 skill 描述元素的计算样式：背景透明、`border-radius: 0`，并有正确的 `overflow: hidden` / ellipsis。说明 `.ohb-list-row > span:first-child` 没有命中它，因为该行第一个子元素是 `strong`。
4. 在 palette 开着时输入 `/skill` 后按 Enter，会执行选中项的 canonical `/skills`；先按 Esc 关闭 palette，再 direct 提交 `/skill`，才暴露 `Unknown command "/skill"`。因此手工 alias 验收必须绕过 palette。

由此否定两条旧假设：卡片问题不是 MCP 圆点 selector 的功能冲突；“输入 `/skill` 后直接 Enter 打开弹窗”不是 alias 已工作的证据。

## 1.5 commands / catalog 根因

`catalog.ts` 中 builtin `skills` 当前 `path:["skills"]`、`aliases:[]`。`service.ts` 的 `RESERVED_EXTERNAL_COMMAND_ROOTS` 现有 `cancel` / `mode` / `model`，`RESERVED_EXTERNAL_COMMAND_PATHS` 还有 `permission/default` / `permission/full-access`。这些保护会过滤 external commands，但没有覆盖真实 builtin-only catalog 的全部 canonical/aliases。

`handleSkills` 当前输出 registry 全量，不检查相同政策。因此：

- 现有 reserved skill 可能在 `/skills` 中被展示，却没有同名 slash command 可执行；
- `status`、`help`、`exit`、`quit`、`q`、`mcps`、`mcp` 等 builtin path/alias 同名 skill 可通过 loader，但会让 `validateUniqueAliases` 抛错；
- 显式 `options.extraCommands` 的 path/alias 也可能与 registry skill 冲突；
- 增加 alias `skill` 和 canonical `skills` 的保护后，若只补这两个名字，旧 policy 与全部占用路径仍不完整；
- 分别维护 catalog 黑名单与 handler 黑名单会继续漂移。

根因是“可注册为 external slash command”没有共享 projection。应提取纯 `external-command-policy.ts` 负责 normalized path key、reserved roots / exact paths 与占用检查；`service.ts` 从 `buildCommandCatalog()` 的 builtin-only 结果机械收集 path/aliases，先接受不与 builtin/legacy policy 冲突的显式 extra commands，再按 registry 顺序接受不冲突的动态 skills。优先级固定为 builtin > explicit extra > skill；显式 extra commands 彼此冲突仍 fail-fast，动态 skill 冲突则跳过，不能让安装一个 skill 破坏整个 catalog。projection 同时返回 catalog 与 `slashInvocableSkills`，`handleSkills` 通过 helper 输出后者。

所有比较必须大小写不敏感；policy 必须同时保留 root 规则与完整 path 规则，且用 `permission/custom` 对照防止误封整个 permission root。builtin 占用路径不能在 policy 中手抄第二份名单。

## 1.6 Web UI 根因

### skill 卡片

`.ohb-list-row` 只是共享基础行壳，本身不是错误 DRY；skill 行可以在 modifier 上定义适合 `strong + span + small` 的三段 grid。真实问题是：

- `strong` 没有明确 `min-width:0` / ellipsis；
- metadata 没有与名称、描述一起受到稳定列约束；
- `source ?? scope` 丢字段；
- `.ohb-list-skill span` 与 `.ohb-list-skill > span` 重复，增加误判和维护成本。

### slash no-args 行

base `.ohb-slash-row` 的四列适用于有 `argsHint` 的命令。把第三列全局改成 `minmax(0,max-content)` 会让 `/connect` 等最长参数文本决定列宽，并有挤压描述风险。目标应由 DOM 状态显式表达：空 `argsHint` 加 `ohb-slash-row-no-args`，modifier 切换为点 / 命令 / 描述三列并隐藏空 args 节点；有参数 base 完全保留四列。

## 1.7 跨模块与文档一致性

| 表面 | 当前行为 | 本批契约 |
|------|----------|----------|
| TUI | 顶层可见单个 skill；`/skills` 行显示 `scope · source` | 视觉不改；共享 alias 与输出过滤 |
| Web palette | 不含单个 skill；含 `/skills` | 保持；`/skill` 仅输入 alias，无第二行 |
| Web modal | 可键盘/单击落入；hover/滚动/metadata 有缺口 | 修交互和三段显示 |
| headless/stdout | 使用同一 catalog | 同步接受 `/skill` alias |
| `skill-invocation.md` | 已落地能力仍写成待实施 | 当前契约与历史计划分层 |

权威文档需要明确：Layer 1/2 已由 `b5e00f4` 落地；§1–§5 写当前契约；旧 §6 保留为已完成的历史实施记录，不再作为待办。字面量 alias `/skill` 必须与泛指某个 skill 的 `/<skill-name>` 分写。

## 1.8 改动影响面

- **新增**：`packages/ohbaby-agent/src/commands/external-command-policy.ts`（纯 path/占用政策）与 service eligibility projection 及必要测试覆盖。
- **修改**：`catalog.ts`、`service.ts`、`builtin.ts`；`App.tsx`、`styles.css` 及相关测试；`skill-invocation.md` 与 slash UI README 的列布局措辞。
- **锁定不动**：`executeSkillCommand`、Web POST 网关语义、`slashCommandLabel` 的 canonical path 显示、`isWebPaletteCommand` 的 skill flood 护栏、`docs/skill/` 注入规格。

## 1.9 SWE 原则审视

- **单一事实源**：legacy reserved path 由纯 policy 持有，builtin 占用从真实 catalog 机械派生；共享 projection 同时驱动 catalog 与 handler output，消除手抄名单与循环依赖。
- **信息隐藏**：alias 是输入兼容细节；canonical path 才是 UI/协议名称。resolve 已提供这个边界。
- **最小充分改动**：保留共享 `.ohb-list-row` 基础壳，只给两种信息结构各自 modifier；不复制整个组件。
- **显式状态优于 CSS 猜测**：no-args 由 React class 表达，不依赖 `:empty` 或全局压缩参数列。
- **YAGNI**：不做搜索、表单、收藏，不把全部 skill 放进顶层 `/`。

这些变化技术上均可回滚；“reserved 名称不能作为 slash skill”是用户可见的兼容政策，需要文档和测试锁定，但不是不可逆的一扇门。
