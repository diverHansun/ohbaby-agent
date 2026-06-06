# 02a — 主题与配色方案

日期: 2026-06-05
更新: 2026-06-06
状态: **结合 logo 对齐（金/紫/蓝暖调）**，待维护者微调

设计原则：
- **两层**：`colors.ts` raw palette（裸 hex）→ `tokens.ts` 语义层。组件只引语义层。
- **唯一改色入口**：所有 hex 集中在 `colors.ts`，便于跟 logo 配色频繁对齐，不散到组件。
- **默认暗色**（PowerShell 黑底）；`detect.ts` 探测不到/不确定一律回退暗色。
- **降级**：按 `chalk.level` 决定真彩 hex 还是 16 色 ansi 名。

> **⚠️ 硬性约定：不渲染文字角色头。** 任何消息**不得**输出 `you` / `ohbaby` / `assistant` / `tool` 等角色文字标签。
> 用户与 AI 的区分**只靠样式**。本批次固定为：历史用户消息左竖线，
> assistant 无角色头，当前 prompt 背景块突出。

---

## logo 配色提取

ohbaby logo（金边圆徽：金铠甲少年怀抱紫襁褓婴儿，天蓝背景）核心色：

| logo 元素 | 色相 | 在 TUI 的角色 |
|---|---|---|
| 金色描边 / 铠甲 / 星星 / 盾牌 | 金 / 琥珀 | **品牌主色 primary**（header/logo、选中态、用户 icon、cursor） |
| 紫色襁褓 / 婴儿 | 淡紫 / 薰衣草 | **强调 accent**（reasoning「思考」、spinner 紫金的紫） |
| 天蓝背景 / 心形 | 天蓝 | **info / 次要**（工具名、markdown 链接） |
| 白披风 / 云 | 暖白 | 正文文本（偏暖，不用冷灰白） |
| 棕发 | 暖暗棕灰 | 边框 / 中性暗调 |

整体基调：**暖金为主、蓝紫为辅**，文本走暖白/暖灰以与金调统一。

---

## colors.ts — 原始调色板

### Dark（默认）

| 名称 | hex | 来源 / 用途 |
|---|---|---|
| `gold` | `#D4A24F` | logo 金（**降亮柔化**，减纯黑底光晕）· **品牌主色** / 选中 / 用户 icon |
| `goldBright` | `#E0B463` | 强调态 / cursor / spinner 金帧 |
| `purple` | `#B9A3E3` | logo 紫 · **accent** / spinner 紫帧 / 品牌标题辅色（暗底最稳，保持不降亮） |
| `purpleBright` | `#C9B8EC` | 紫强调 |
| `skyBlue` | `#6E9FCE` | logo 天蓝（**降亮减发虚**）· **info** / 工具名 / 链接 / 品牌标题点缀 |
| `green` | `#8FCB9B` | 成功 / diff add |
| `red` | `#E8857D` | 错误 / diff remove |
| `yellow` | `#E0C06B` | 警告（与 gold 拉开：偏绿黄） |
| `text` | `#E8E4DC` | 正文（暖白） |
| `textStrong` | `#F5F2EC` | 标题 / 加粗 |
| `textDim` | `#9A938A` | 次要信息（暖灰） |
| `textMuted` | `#6E675F` | reasoning 底色 / 提示（暖暗灰） |
| `border` | `#3E3A34` | 竖线 / 分隔 / 边框（暖暗） |

### Light（claude-code 风，对 `#FFFFFF` 调对比度）

| 名称 | hex | 用途 |
|---|---|---|
| `gold` | `#B5832A` | 品牌主色 / 用户 icon |
| `purple` | `#7C5BC4` | accent / reasoning |
| `skyBlue` | `#2E6FB0` | info / 链接 |
| `green` | `#3D9A57` | 成功 |
| `red` | `#C8453E` | 错误 |
| `yellow` | `#9A7B1F` | 警告 |
| `text` | `#1A1714` | 正文（暖黑） |
| `textDim` | `#5F5750` | 次要 |
| `textMuted` | `#6E675F` | reasoning |
| `surface` | `#F0EBE2` | 当前 prompt 背景块（暖浅） |
| `border` | `#C0B8AC` | 边框 |

---

## tokens.ts — 语义层（组件唯一引用面）

```ts
interface Theme {
  text:    { normal; strong; heading; headingAccent; muted; link };
  role:    { assistant };                       // 仅颜色，无文字标签
  message: {
    userGutter?: string;             // 暗色：左竖线颜色（中性 border，不上品牌色）
    userBlockBg?: string;            // 当前 prompt 背景块；历史用户消息不用背景块
  };
  tool:    { name; arg; running; failed };
  status:  { idle; running; waiting; error };
  reasoning: string;                 // 思考文本（灰 textMuted，克制）
  brandTitle: { primary; secondary; tertiary }; // OHBABY：金主 + 紫/蓝点缀
  diff:    { add; remove };          // 延后
  cursor;  border;
  spinner: { frames: string[]; palette: string[] };  // 紫金双色，见下
}
```

### Dark / Light 映射

| 语义 token | Dark | Light | 用在哪 |
|---|---|---|---|
| `text.normal` | `text` | `text` | AI 正文 |
| `text.strong` | `textStrong` | `text` | 加粗 |
| `text.heading` | `gold` | `gold` | markdown 标题主体（纯金） |
| `text.headingAccent` | `skyBlue` | `skyBlue` | markdown 标题的 `#` 标记 / H1 下划线（轻微蓝点缀） |
| `text.muted` | `textMuted` | `textMuted` | 提示 |
| `text.link` | `skyBlue` | `skyBlue` | markdown 链接 |
| `role.assistant` | `text`（无装饰） | `text` | AI 消息 |
| `message.userGutter` | `textMuted`（比 border 微提亮，仍中性、不上品牌色） | — | 暗色用户左竖线 `▎` |
| `message.userBlockBg` | `surface` 或暗色等价 surface | `surface` | 当前 prompt 背景块；历史用户消息不用 |
| `tool.name` | `skyBlue` | `skyBlue` | 工具名（天蓝） |
| `tool.arg` | `textDim` | `textMuted` | 工具主参摘要 |
| `tool.running` | `purple` | `purple` | running spinner（呼应 spinner） |
| `tool.failed` | `red` | `red` | 失败短错误摘要，不使用失败 icon |
| `status.idle` | `textDim` | `textMuted` | 状态行常态 |
| `status.running` | `gold` | `gold` | 运行中（品牌金） |
| `status.waiting` | `yellow` | `yellow` | 等待权限 |
| `status.error` | `red` | `red` | 错误 |
| `reasoning` | `textMuted`（灰） | `textMuted`（灰） | reasoning 文本（克制，不抢正文） |
| `brandTitle.primary` | `gold` | `gold` | OHBABY 标题主色（金） |
| `brandTitle.secondary` | `purple` | `purple` | OHBABY 标题辅色（紫） |
| `brandTitle.tertiary` | `skyBlue` | `skyBlue` | OHBABY 标题点缀（蓝） |
| `cursor` | `goldBright` 反显 | `gold` 反显 | 编辑器光标（品牌金） |
| `spinner` | 金紫交替（见下） | 金紫交替 | running 动画 |
| `border` | `border` | `border` | 竖线 / 分隔 |
| `diff.add` / `diff.remove` | `green` / `red` | 同 | （延后） |

### spinner —— running 时金紫交替（湖人紫金，呼应 logo）

```ts
spinner = {
  frames: ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"],  // braille 旋转
  palette: [goldBright, purple],   // 帧着色在金/紫间交替（或按帧 index 取色）
}
```
渲染：运行中显示；每帧颜色按 `frameIndex % palette.length` 在金/紫间切换，形成紫金脉动。工具行 running 状态复用 spinner，完成后不保留图标。

### syntax（代码块高亮）

委托 `cli-highlight`，token 映射到调色板：keyword→`purple`、string→`green`、number→`gold`、comment→`textMuted`、function→`skyBlue`、type→`goldBright`。未知语言回退 `text.normal`。

---

## 消息装饰与 PromptDock

**历史消息（暗色默认，亮色同口径调色）**
```
▎你好啊                         用户历史：左竖线 ▎，无背景块

  你好！有什么我可以帮你的？       AI：无装饰，直接渲染 markdown
  Thought                      reasoning 完成后：折叠为灰色摘要
  Bash    pnpm test             工具完成后：工具名 + 主参摘要
```

**运行中工具**
```
⠙ Bash    pnpm test             running：左侧 spinner，金/紫交替
```

**当前 PromptDock**
```
> ask anything...

auto · default · session_abc     38.4K / 1M (4%)
```

> 再次强调：历史消息**没有任何 `you`/`ohbaby` 文字角色头**；当前输入靠背景块突出，
> 工具完成态不保留成功/失败 icon。

---

## 品牌标题 OHBABY（header / logo）

空会话 header 的 **OHBABY** 字样用**紫金蓝三色，金为主、紫与蓝点缀**（呼应 logo 金铠甲 + 紫襁褓 + 天蓝背景）。
- 实现：`renderOhbabyLogo()` 返回静态 ANSI 行，色值取 `brandTitle.*`。不引入 `figlet` 运行时依赖。
- 建议形态：`OH` 金 · `BA` 紫 · `BY` 蓝（按字母段分色，金占主），或金主体 + 紫/蓝装饰符/星点。具体在 `logo.tsx` 定。
- **注意区分**：这是 header 品牌标题；markdown 正文里的 `#` 标题走 `text.heading`（纯金）+ `text.headingAccent`（标记符轻微蓝），二者不同。

## 已定决策（本轮 review 敲定）

1. **reasoning = 灰**（`textMuted`），克制不抢正文。（不用紫）
2. **历史用户消息 = 左竖线**；当前 prompt 才使用背景块。
3. **工具 running = spinner**；完成后不保留图标，失败只追加短错误摘要。
4. **OHBABY 品牌标题 = 紫金蓝三色**（金主，紫/蓝点缀）；markdown `text.heading` = 纯金 + `text.headingAccent` 标记符轻微蓝。
5. **暗色用户竖线微提亮**：用 `textMuted` 而非 `border`，仍中性不上品牌色；亮色主题保持同一结构，只调色不换交互语义。
6. **暗色金/蓝降亮柔化**（护眼）：金 `#E5B567→#D4A24F`、金亮 `#F0C674→#E0B463`、天蓝 `#82B7E8→#6E9FCE`；紫保持（暗底最稳）。亮色主题不受影响。原则：金蓝只点缀、正文走暖白，避免大面积高亮造成纯黑底光晕/疲劳。

后续仅配色微调，改本文件 `colors.ts` 表即可，语义层与组件不受影响。
