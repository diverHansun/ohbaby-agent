# 02 · 实施方案（Phase 0 主题 + Phase 1 五修复）

代码草图为示意，实施以仓库现有风格为准（命名、注释密度与周边一致）。

**实施顺序（依赖锁）**：
1. **Phase 0 主题**：先建 `theme/`，**把全部 7 个读色文件一次性迁到语义 token**（含 `permission-dialog.tsx`、`message-list.tsx`、`prompt/index.tsx`、`logo.tsx`）。
2. **Phase 0.5 拆 message-list**（见下「message-list 拆分」）：在 4b/5 落地前先把 [message-list.tsx](../../../packages/ohbaby-cli/src/tui/components/message/message-list.tsx) 拆成子组件——它现在同时承担转录/notice/工具/流式四职，本轮又被问题 3*(notice)*、4b*(prompt/transcript)*、5*(spinner)* 三处同时改，必须先降耦合。
3. **Phase 1 行为修复**：`2 → 5 → 3 → 1 → 4`。因共享文件已在 P0 迁 token、P0.5 已拆分，**行为修复落在已迁好的小组件上，不产生二次迁移**（回应评审 2.1 的依赖倒置担忧）。

每步跑该模块测试。

---

## Phase 0 · 主题系统（地基）

落地 [tui-improve-1 02a](../tui-improve-1/02a-theme-and-colors.md) 的紫金蓝调色板。新建 `tui/theme/` 取代扁平 [theme.ts](../../../packages/ohbaby-cli/src/tui/theme.ts)。

### 文件结构
```
tui/theme/
  colors.ts    raw palette：dark + light 两套裸 hex（值见 02a，唯一改色入口）
  tokens.ts    语义层 Theme 接口 + dark/light 映射（语义表见 02a）
  detect.ts    终端亮暗检测（默认暗）；按 chalk.level 决定 truecolor / 16 色降级
  index.ts     ThemeProvider + useTheme()
```

### colors.ts（摘要，权威表见 02a）
```ts
// dark（默认）
export const darkPalette = {
  gold: "#D4A24F", goldBright: "#E0B463",
  purple: "#B9A3E3", purpleBright: "#C9B8EC",
  skyBlue: "#6E9FCE",
  green: "#8FCB9B", red: "#E8857D", yellow: "#E0C06B",
  text: "#E8E4DC", textStrong: "#F5F2EC", textDim: "#9A938A", textMuted: "#6E675F",
  border: "#3E3A34",
} as const;
// light：见 02a 表
```

### tokens.ts（语义层，组件唯一引用面）
按 02a 的 `Theme` 接口与 dark/light 映射实现。本轮**必用**的 token：
- `brandTitle.{primary:gold, secondary:purple, tertiary:skyBlue}` → logo 渐变停
- `spinner.{frames, palette:[goldBright, purple]}` → 问题 5
- `tool.{name:skyBlue, arg:textDim, running:purple, failed:red}`、`status.*`、`reasoning:textMuted`
- `border` → 输入框边框（问题 4a）
- `text.*`、`role.assistant`、`cursor`

### detect.ts / index.ts
- `detectTheme()`：默认 dark；探测不到/不确定回退 dark。色深按 `chalk.level`：`level<2` 时 tokens 解析为最近 16 色名（gradient 由 `ink-gradient`/chalk 链路降级；`figlet` 只负责字形字符串）。
- `<ThemeProvider>` 包在 [app.tsx](../../../packages/ohbaby-cli/src/tui/app.tsx) 顶层；`useTheme()` 返回当前 `Theme`。
- **初始化顺序 / 无闪（回应评审 2.5）**：`detectTheme()` **同步**（只读 env + `chalk.level`，无异步 IO），故 `ThemeProvider` 首帧即算好主题，**无需 `ready` gate、无首帧 flash**。`useTheme()` 在 Provider 之外调用时返回 **dark 默认**（dev 下可 `console.warn`），不抛错——避免测试/边角渲染崩。

### tokens 集合范围（回应评审 YAGNI / risk #3）
本轮**有意实现 02a 的完整 `Theme` 语义集**（非投机）：它就是「把主题系统做完」的交付物，是后续组件逐步迁入的稳定面。当前仅 ~7 文件引用属正常——token 是为「单一改色入口 + 未来迁移」而设，不按当前引用数裁剪。值全部来自 02a 表，单文件维护、成本可控。

### 迁移（7 个读色文件）
把以下从 `tuiTheme.colors.*` 改为 `useTheme()` 语义 token，删除旧 `theme.ts`：
`message-list.tsx`、`prompt/index.tsx`、`prompt/completion.tsx`、`logo.tsx`、`dialogs/{permission-dialog,confirm,select-one}.tsx`。

**借鉴**：opencode `useTheme()`/`tint()` 上下文模型；kimi `ColorPalette` + `chalk.hex`。
**取舍/风险**：
- ⚠️ 组件 contract 测试里写死颜色断言需对齐（多为 `not.toContain`，小改；清单见 03）。
- ⚠️ `render/` 层目前不读色（已确认 grep 无 color/chalk），故主题迁移**只动组件层**，范围可控。
- ✅ 严格语义层：组件不再出现裸色名/hex。

---

## Phase 1 · 五个修复

### 问题 2 · Permission 默认改为 Allow once（最小、最确定）
拆「初始高亮」与「Esc 安全默认」：
```ts
function findEscapeDefaultChoiceIndex(request): number { /* 原 deny→abort→0 逻辑，改名保留 */ }
function findInitialChoiceIndex(request): number {
  const allow = request.choices.findIndex((c) => c.intent === "allow");
  return allow >= 0 ? allow : findEscapeDefaultChoiceIndex(request); // 无 allow 回退安全默认，非裸 0
}
```
- 初始用**惰性 `useState`**：`useState(() => findInitialChoiceIndex(request))`（[:16-21](../../../packages/ohbaby-cli/src/tui/dialogs/permission-dialog.tsx)）。**不用 `useMemo([request])`**——`request` 是对象引用，上层每帧新建会让 memo 失效（回应评审 2.8）；初始值只需算一次，惰性 useState 正合适。
- `key.escape` 用 `findEscapeDefaultChoiceIndex`（[:56-65](../../../packages/ohbaby-cli/src/tui/dialogs/permission-dialog.tsx)）。

**借鉴**：kimi `ChoicePickerComponent` 用 `currentValue` 定位初始项。
**取舍**：✅ Esc 仍 deny、Ctrl+C 仍 abort；⚠️ 改现有测试（见 03）。

### 问题 5 · Spinner 动起来（用 tokens 紫金）
新建自驱动 `tui/components/spinner.tsx`：
```tsx
export function Spinner({ label }: { label?: string }): ReactElement {
  const { spinner } = useTheme();
  const animate = process.env.OHBABY_TUI_NO_ANIM !== "1";
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!animate) return;
    const id = setInterval(() => setI((n) => (n + 1) % spinner.frames.length), 80);
    return () => clearInterval(id);
  }, [animate, spinner.frames.length]);
  const color = spinner.palette[i % spinner.palette.length]; // 金/紫交替
  return <Text color={color}>{spinner.frames[i]}{label ? ` ${label}` : ""}</Text>;
}
```
**接入**（拆分后的 `MessageRow`/工具子组件）：把「leading 标记」与「标签」彻底解耦。
- `renderToolLabel(call, result)`：**纯函数，只返回工具名+主参摘要**（如 `"Bash pnpm test"`），**不含任何 leading 标记、不分支 running/completed**（回应评审 2.4 命名误导：它真的只产标签）。
- 「leading 用 `<Spinner>` 还是两空格」的**分支放在组件层**（按 `call.status`）：running/pending → `<Spinner label={renderToolLabel(...)} />`；completed/failed → `<Text>{"  " + renderToolLabel(...)}</Text>`（保 `"  Bash pwd"` 等断言）。

**借鉴**：kimi `MoonLoader`、opencode `Spinner`（同 braille 帧 @80ms + 动画开关回退）。
**取舍**：⚠️ `useEffect` cleanup 必清 `setInterval`；测试用 `OHBABY_TUI_NO_ANIM=1` 或 `vi.useFakeTimers()` 稳定首帧。

### 问题 3 · 抑制 skill-override 噪声 notice
loader 在 override 分支加结构化判别（文案不变，保 loader 单测）：
```ts
// skill/loader.ts:572
this.logger.warn(`Skill "${info.name}" from ${info.location} overrides ${previous.location}`,
  { kind: "skill-override", /* ...原字段... */ });
```
**两处** `createSkillLogger` 都跳过它：
```ts
warn(message, context): void {
  if (context?.kind === "skill-override") return; // 覆盖属正常优先级裁决，不打扰
  /* ...原 publishNotice/onNotice... */
}
```
> 🔴 **生产路径在 [ui-inprocess.ts:384-396](../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts)**（注入 registry 时 composition.ts 的 logger 被绕过）。**必须改 ui-inprocess.ts**；composition.ts（[:156-164](../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts)）对称改。只改 composition 无效。

保留 `Invalid skill skipped`（[loader.ts:546](../../../packages/ohbaby-agent/src/skill/loader.ts)）、`ignored because higher precedence`（[loader.ts:561](../../../packages/ohbaby-agent/src/skill/loader.ts)）的 notice。`ui-inprocess.contract.test.ts:3070` 已断言 invalid→notice，改后须保持其绿。

### 问题 1 · figlet + ink-gradient（紫金蓝渐变）
```tsx
// render/logo.ts
import figlet from "figlet";
import ansiShadow from "figlet/importable-fonts/ANSI Shadow.js";

let parsed = false;
export function renderOhbabyLogo(options: { readonly maxWidth?: number } = {}): readonly string[] {
  if (!parsed) {
    figlet.parseFont("ANSI Shadow", ansiShadow);
    parsed = true;
  }
  const lines = figlet
    .textSync("OHBABY", { font: "ANSI Shadow", horizontalLayout: "fitted" })
    .split("\n")
    .filter((line) => line.trim() !== "");
  return options.maxWidth !== undefined && options.maxWidth < 64 ? ["OHBABY"] : lines;
}
```

```tsx
// components/logo.tsx
import Gradient from "ink-gradient";
import { Text } from "ink";
import { useTuiLayout } from "../layout/context.js";
import { renderOhbabyLogo } from "../render/logo.js";

export function Logo(): ReactElement {
  const { brandTitle } = useTheme();
  const layout = useTuiLayout();
  const lines = renderOhbabyLogo({ maxWidth: layout.contentWidth });
  return (
    <Box marginBottom={1}>
      <Gradient colors={[brandTitle.primary, brandTitle.secondary, brandTitle.tertiary]}>
        <Text>{lines.join("\n")}</Text>
      </Gradient>
    </Box>
  );
}
```
- 渐变停 = `brandTitle.{primary:gold, secondary:purple, tertiary:skyBlue}`。
- `render/logo.ts`：**删掉现有 6 行手写 standard ASCII**，改成固定 `ANSI Shadow` FIGfont + `maxWidth` 窄屏回退；主字形只在这里生成，`components/logo.tsx` 只负责传入布局宽度与渐变（回应评审 2.3 DRY）。
- 删除 [components/logo.tsx:11-18](../../../packages/ohbaby-cli/src/tui/components/logo.tsx) 的 `index % 2` 奇偶换色。

**借鉴**：gemini-cli（ink-gradient + 宽度自适应 logo）、claude-code（填充字+渐变）、figlet importable font 避免运行时字体文件探测。
**取舍/风险**：
- ⚠️ 新依赖 `figlet`(+commander)、`ink-gradient`(+gradient-string)。不引入 `ink-big-text/cfonts`，避开 GPL-3.0-or-later 传递依赖。
- ⚠️ `ink-gradient` 每行同向左→右渐变 → FIGfont 字母呈竖向色带，观感整齐。
- ⚠️ 破坏 logo 字面量测试（[app.contract.test.tsx:110-111](../../../packages/ohbaby-cli/src/tui/app.contract.test.tsx)、[logo.unit.test.ts:9](../../../packages/ohbaby-cli/src/tui/render/logo.unit.test.ts)）——见 03。
- 保留一行小写 tagline（如 `ohbaby · agent`）作品牌 + 测试锚。

### message-list 拆分（Phase 0.5，先于 4b/5）—— 回应评审 2.3/2.6/risk #2

[message-list.tsx](../../../packages/ohbaby-cli/src/tui/components/message/message-list.tsx) 现承担转录/notice/工具配对/流式四职，本轮被问题 3/4b/5 同时改，是技术债最密集点。先按 SRP 拆：

```
components/message/
  message-list.tsx     仅编排：messages→MessageRow、notices→NoticeBanner
  message-row.tsx      单条消息渲染（纯按 message 渲染）
  notice-banner.tsx    notices / commandNotices 渲染（留动态区）
```
- 把 [message-list.tsx:96-109](../../../packages/ohbaby-cli/src/tui/components/message/message-list.tsx) 的「tool-call + tool-result 配对」内联逻辑抽成**命名函数** `pairToolCallResult(parts)`（回应评审 2.6）。
- 拆完后：5 的 `<Spinner>` 只动 `message-row.tsx`/工具子组件；3 的 notice 只动 `notice-banner.tsx`；transcript 替换语义由 `message-list.tsx` 单测守住——三处改动**落在不同小文件**，不再叠加在一个巨组件上。

### 问题 4 · 输入框边框 + transcript 防 stale

**4a 圆角边框**（覆盖 tui-improve-1 背景块设计）：
```tsx
// prompt/index.tsx
<Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
  {renderEditorLines(editor, disabled)}
</Box>
```
dock 状态行 / context 用量行放框**外下方**（保现布局 [:188-195](../../../packages/ohbaby-cli/src/tui/components/prompt/index.tsx)）。
**风险**：边框各占 1 列，须与 [AppShell](../../../packages/ohbaby-cli/src/tui/layout/app-shell.tsx) `metrics.contentWidth` 对齐，80 列下不溢出（验收项）。

**4b transcript `<Static>` 暂缓**：
- Spike 结论分两半：`<Static>` 的确能把历史输出移出动态区；但它是 append-only，集成测试证明 `/resume`、`/sessions` 切换后上一 session 的 committed 行会残留在 `lastFrame()`。
- v1 保留 `message-list.tsx` 拆分，但 transcript 使用 `messages.map(...)` 动态渲染，保证 active session 视图可替换。
- 新增 `MessageList` 单测：替换 transcript 后不得保留旧 committed message。
- 真机闪烁优化本批次先依赖 prompt 固定边框/宽度、消息渲染拆分、后续窄 selector；真正的 append-only scrollback 方案需要独立设计“会话视图清屏/虚拟列表”后再做。

### 4c · 收窄 store selector（性能，回应评审 risk #1「最大定时炸弹」）
[app.tsx:47](../../../packages/ohbaby-cli/src/tui/app.tsx) 现为 `useTuiStoreSelector(store, (current) => current)`——**订阅整个 state**，任何 store 事件（含流式高频 delta）都触发整树重算。
- 后续可借 Phase 0.5 拆分之势，给各子组件**各自窄 selector**：`MessageList` 选 active session messages、`NoticeBanner` 选 notices、`Prompt` 选 `activeSessionId/permission/usage/runtimeLabel`。
- 这样流式 delta 的 React 重算面会收窄；v1 不做静态 transcript，避免跨 session stale。
- **取舍**：与拆分同批做，增量小、收益大；若拆分未做则本项顺延（不强行在巨组件上收窄）。

---

## 性能预期（回应评审 2.2）

- **spinner**：`setInterval` @80ms（12.5fps）**仅在 running/pending 工具行挂载**，工具结束即卸载；同时通常只有 0–1 个在跑，CPU 可忽略。`OHBABY_TUI_NO_ANIM=1` 完全关闭。
- **transcript**：v1 不使用 `<Static>` 承载可切换会话历史，避免 stale session；闪烁优化留给后续“虚拟列表/viewport shell”而不是 Ink append-only Static。
- **React 重算**：4c 窄 selector 后，流式 delta 尽量只波及消息区，不波及 Prompt/Logo。
- 不引入新的每帧定时器/轮询；不做全局动画循环（opencode 式 shimmer 明确不做）。

## 改动文件清单（预估）

| 文件 | 改动 | 关联 |
|---|---|---|
| `tui/theme/colors.ts` | **新建** dark/light raw palette | P0 |
| `tui/theme/tokens.ts` | **新建** 语义 Theme + 映射 | P0 |
| `tui/theme/detect.ts` | **新建** 亮暗检测 + 降级 | P0 |
| `tui/theme/index.ts` | **新建** ThemeProvider/useTheme | P0 |
| `tui/theme.ts` | **删除**（被 theme/ 取代） | P0 |
| `tui/app.tsx` | 包 `<ThemeProvider>`；后续窄 selector | P0,4c |
| `message-list.tsx` | 迁 token；拆为编排层；保持 transcript 可替换 | P0,4b,0.5 |
| `message/message-row.tsx` | **新建** 单条消息渲染；running 工具用 `<Spinner>` | 0.5,5 |
| `message/notice-banner.tsx` | **新建** notice/commandNotice 渲染（动态区） | 0.5,3 |
| `prompt/index.tsx` | 迁 token；圆角边框 | P0,4a |
| `prompt/completion.tsx` | 迁 token | P0 |
| `components/logo.tsx` | ink-gradient；宽/窄 logo 选择；去奇偶换色 | P0,1 |
| `render/logo.ts` | figlet 固定 FIGfont 主 logo + 小号回退 logo/tagline | 1 |
| `components/spinner.tsx` | **新建** 自驱动 Spinner | 5 |
| `message/parts/tool-part.tsx` | 导出纯 `renderToolLabel` | 5 |
| `dialogs/permission-dialog.tsx` | 迁 token；拆 initial/escape 默认 | P0,2 |
| `dialogs/{confirm,select-one}.tsx` | 迁 token | P0 |
| `agent/src/skill/loader.ts` | override 加 `kind` 判别 | 3 |
| `agent/src/adapters/ui-inprocess.ts` | **(生产)** createSkillLogger 跳过 override | 3 |
| `agent/src/adapters/ui-runtime/composition.ts` | 对称跳过 override | 3 |
| `ohbaby-cli/package.json` | +`figlet` +`ink-gradient` | 1 |
