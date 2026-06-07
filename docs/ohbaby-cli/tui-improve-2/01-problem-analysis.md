# 01 · 问题分析（root cause）

逐项给出**现象 → 代码根因（file:line）→ 参考项目怎么做**。修复方案在 [02-implementation-plan.md](./02-implementation-plan.md)。

> 颜色相关根因（问题 1 渐变、5 spinner 紫金、4a 边框色）共享一个前提：当前 [theme.ts](../../../packages/ohbaby-cli/src/tui/theme.ts) 仍是 `cyan/yellow` 命名色扁平版，**无 truecolor 调色板**。tui-improve-1 02a 设计的紫金蓝 `colors.ts/tokens.ts` 尚未实现。故 02 的 **Phase 0 主题系统**是这些修复的地基。

---

## 框架层共性根因

opencode / kimi-code 都用自定义渲染器，按 cell/行做 diff，只重绘变化部分。ohbaby 用 Ink：

- Ink 在非 TTY-CI 路径用 `log-update` 渲染**动态区**——每帧 `eraseLines` 后整体重写（[ink.js:178-198](../../../node_modules/.pnpm/ink@6.6.0_@types+react@19.2.8_react@19.2.3/node_modules/ink/build/ink.js)）。
- ohbaby 的 `tui/` 下**零处使用 `<Static>`**（已全局确认）。于是每次按键，整棵树（Header/Logo + 全部历史消息 + Prompt）都进动态区被擦除重写 → 高转录时肉眼可见闪烁。
- spinner 帧若依赖时间推进，也只能靠重渲染触发；但当前 spinner 根本没有定时器（见问题 5）。

这条共性是问题 4、5 的底座。

---

## 问题 1 · OHBABY 大字渲染不好看

**现象**：截图里大字每个字母上半 cyan、下半 yellow，斑驳割裂。

**根因**：
- Logo 是手敲的 6 行 standard-figlet ASCII，最后一行还硬塞了字面量 `OHBABY` 标签：[render/logo.ts:1-12](../../../packages/ohbaby-cli/src/tui/render/logo.ts)。
- 上色按**行号奇偶**在 accent(cyan)/warning(yellow) 间切换：[components/logo.tsx:11-18](../../../packages/ohbaby-cli/src/tui/components/logo.tsx)。同一字形跨两行 → 上下异色，就是斑驳来源。
- 颜色取自 [theme.ts](../../../packages/ohbaby-cli/src/tui/theme.ts) 的命名色（`cyan`/`yellow`），非 truecolor，渐变能力有限。

**参考**：
- **kimi-code** [welcome.ts:30-52](../../../../kimi-code/apps/kimi-code/src/tui/components/chrome/welcome.ts)：半块字符 `▐█▛█▛█▌` 两行小 logo，`chalk.hex(primary)` **单色**，配圆角边框面板，干净统一。
- **opencode** [logo.tsx](../../../../opencode/packages/opencode/src/cli/cmd/tui/component/logo.tsx)：`▀▄█` 半块 + 逐 cell RGBA shimmer 渐变（依赖 opentui，Ink 无法直接复刻，但"整体渐变而非逐行换色"的思路可借鉴）。

**结论**：去掉「奇偶行换色」。改用 `figlet` 固定 FIGfont 生成 OHBABY 大字，再用 `ink-gradient` 做 **gold→purple→skyBlue** 三停渐变（= `brandTitle.primary/secondary/tertiary`，取自 Phase 0 的 `colors.ts`），整体平滑渐变而非逐行换色。覆盖 tui-improve-1 决策 #4。详见 02。

---

## 问题 2 · Permission 默认高亮 Reject

**现象**：权限弹窗回车默认落在 `Reject`，用户每次都要手动上移到 `Allow once`。

**根因**：初始高亮索引由 [permission-dialog.tsx:122-136](../../../packages/ohbaby-cli/src/tui/dialogs/permission-dialog.tsx) 的 `findSafeDefaultChoiceIndex` 决定，它**显式优先选 `intent === "deny"`**，其次 `abort`，最后 0：

```ts
const denyIndex = request.choices.findIndex((c) => c.intent === "deny");
if (denyIndex >= 0) return denyIndex;            // ← 默认就落在 Reject
```

同一函数同时被用于：
- 初始 `selectedIndex`（[:16-21](../../../packages/ohbaby-cli/src/tui/dialogs/permission-dialog.tsx)）——**这是要改的**。
- `Esc` 的「安全默认」（[:56-65](../../../packages/ohbaby-cli/src/tui/dialogs/permission-dialog.tsx)）——**这是要保留的**（Esc 仍应取 deny，避免误触自动同意）。

**风险点**：必须把「初始高亮」与「Esc 安全默认」拆成两个语义，不能一并改，否则 Esc 会变成自动 allow（危险）。

**参考**：kimi-code 的 `ChoicePickerComponent` 用 `currentValue` 决定初始高亮（[permission-selector.ts:39-51](../../../../kimi-code/apps/kimi-code/src/tui/components/dialogs/permission-selector.ts)），默认指向"当前值/推荐项"而非最保守项。

---

## 问题 3 · `notic Skill warning` 永久占据转录顶部

**现象**：每次启动，3 条 `Skill "x" overrides ...` 一直钉在转录最上方，跨 session 重复出现（截图两个 session 都有）。

**根因链**：
1. skill loader 发现同名 skill 跨目录覆盖时 `logger.warn("Skill \"x\" ... overrides ...")`：[skill/loader.ts:572-580](../../../packages/ohbaby-agent/src/skill/loader.ts)。这是**预期行为**（用户在 `.claude` 和 `.codex` 都放了同名 skill）。
2. UI 适配层 `createSkillLogger` 把这个 logger 适配成**持久 UI notice**（`level:"warning"`, `title:"Skill warning"`, `key:skill:warning:...`）。**生产路径**是 [ui-inprocess.ts:384-396](../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts)（它 `new SkillLoader({logger})` 并把 registry 注入 composition，[:534-535](../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts) / [:578](../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts)）；composition.ts 也有一个同名函数（[:156-164](../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts)），但注入 registry 时**被绕过**。
3. notice 进 store `state.notices`（按 key 去重、上限 10）：[store/events.ts:1025-1038](../../../packages/ohbaby-cli/src/tui/store/events.ts)。
4. MessageList **把 notices 当转录内容永久渲染**：[message-list.tsx:52-61](../../../packages/ohbaby-cli/src/tui/components/message/message-list.tsx)。没有"已读/老化/折叠"机制。

**为什么不能在 loader 改**：loader 的 override warning 有单测锁定（[loader.unit.test.ts:94](../../../packages/ohbaby-agent/src/skill/loader.unit.test.ts) 断言 warnings 含 `"overrides"`）。loader 层的告警是 agent 契约，应保留；问题出在**把"覆盖"这种正常事件也升级成用户可见的持久 warning**。

**参考**：kimi-code / opencode 把 startup 类提示当 **toast/一次性 startup log**，不进 transcript。ohbaby 没有 toast 概念，转录是 append-only print。

**结论**：在 **UI 适配层**（`createSkillLogger`）判定"覆盖"属正常事件、不升级为 notice；保留真正可操作的告警（"Invalid skill"、"ignored because higher precedence"）。详见 02。

---

## 问题 4 · 输入框无边框 + 打字闪烁

### 4a 无边框
**现象**：输入区只有 `> `，没有用户期望的"框/双横线"。

**根因**：每行只 print `"> "` / `"  "` 前缀，无任何 border：[prompt/index.tsx:208-223](../../../packages/ohbaby-cli/src/tui/components/prompt/index.tsx)（`renderEditorLines`）。外层 `<Box>` 也没有 `borderStyle`：[:185-205](../../../packages/ohbaby-cli/src/tui/components/prompt/index.tsx)。

**参考**：
- opencode [border.tsx](../../../../opencode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx)（`SplitBorder`，竖线 `┃`）+ prompt 用 `border={["left"]}` 自定义边框字符做**左竖线锚**。
- kimi-code 编辑器以左/上下竖线为视觉锚（[rendering.ts:1-8](../../../../kimi-code/apps/kimi-code/src/tui/constant/rendering.ts) 注释明确"editor 的 vertical borders 是对齐锚"）。

### 4b 打字闪烁
**现象**：每次输入字符，终端整体闪一下。

**根因**：见"框架层共性根因"。Prompt 的 editor state 是局部 state，按键 → Prompt re-render → Ink 重渲染**整个动态区**（含上方全部历史消息）→ `log-update` 擦除重写动态区 → 闪。因为转录没进 `<Static>`，它每帧都被重画。

**验证依据**：Ink 动态区走 `this.log`/`throttledLog`（[ink.js:189-198](../../../node_modules/.pnpm/ink@6.6.0_@types+react@19.2.8_react@19.2.3/node_modules/ink/build/ink.js)）；`<Static>` 内容只写一次进 `fullStaticOutput`、随后滚入终端原生 scrollback，不参与每帧擦写（[ink.js:178-192](../../../node_modules/.pnpm/ink@6.6.0_@types+react@19.2.8_react@19.2.3/node_modules/ink/build/ink.js)）。所以把已完成转录移入 `<Static>` 能从机制上消除闪烁。

---

## 问题 5 · Spinner 工具调用时不转

**现象**：工具运行时左侧的 `⠋` 是静止的，不旋转。

**根因**：spinner 字符是**写死的字符串**，没有任何定时器/帧推进：[tool-part.tsx:19-20](../../../packages/ohbaby-cli/src/tui/components/message/parts/tool-part.tsx)：

```ts
const leading = call.status === "running" || call.status === "pending" ? "⠋ " : "  ";
```

而且 tool 行整体是**纯字符串拼接**（`renderToolCallLine` 返回 `string`），在 [message-list.tsx:101](../../../packages/ohbaby-cli/src/tui/components/message/message-list.tsx) 被 `wrapAnsi(...).join("\n")` 塞进 `<Text>`。字符串里没法"动"。

**参考**（两家同一组 braille 帧 @80ms）：
- kimi-code [moon-loader.ts:37-43](../../../../kimi-code/apps/kimi-code/src/tui/components/chrome/moon-loader.ts) + 帧表 [rendering.ts:15-16](../../../../kimi-code/apps/kimi-code/src/tui/constant/rendering.ts)：`setInterval` 切帧 + `requestRender`。
- opencode [spinner.tsx:8-23](../../../../opencode/packages/opencode/src/cli/cmd/tui/component/spinner.tsx)：`frames=["⠋","⠙","⠹",...]`，opentui `<spinner interval={80}>`；并有 `animations_enabled` 开关，关时回退静态 `⋯`。

**结论**：running/pending 的 tool 行必须渲染成一个**React 组件 `<Spinner/>`**（`useState`+`useEffect`+`setInterval`），而非把帧拼进字符串。需要把 MessageList 里"running 工具行"这一支从字符串渲染改为组件渲染。注意与 `<Static>`（问题 4）配合：running 工具属当前流式消息，落在动态区，spinner 能正常驱动重渲染。
