# 03 · 测试计划与验收标准

分三部分：**(A) 实施前 spike**、**(B) 测试改动**、**(C) 验收标准**。
测试栈：`vitest` + `ink-testing-library`（v4）。运行：`pnpm --filter ohbaby-cli test`、`pnpm --filter ohbaby-agent test`。

---

## A. 实施前 spike

### ✅ S2 已在设计阶段验证（结论已并入本文档）
**问题**：`<Static>` 内容进 `app.frames` 还是 `app.lastFrame()`？决定整个 `app.contract.test.tsx` 断言策略。
**实测**（ink 6.6 + ink-testing-library 4，throwaway spike 已跑并删除）：
- `<Static>` 历史内容**始终出现在 `lastFrame()`**，且在后续动态 re-render 后**仍保留**（流式场景已验证：第三帧 = 最新 live + 历史 static 全在）。
- 原因：ink-testing-library 的 fake stdout 无 `rows`，ink 走「`clearTerminal + fullStaticOutput + output` 整写」路径（[ink.js:181-186](../../../node_modules/.pnpm/ink@6.6.0_@types+react@19.2.8_react@19.2.3/node_modules/ink/build/ink.js)），每帧都含 static。
**结论（更新）**：`lastFrame()` 会保留 `<Static>` 内容，但这不是纯收益。跨 session 替换 transcript 时，旧 committed 行也会被保留。因此 v1 不把会话历史放入 `<Static>`；对应新增 stale transcript 回归用例。

### 仍需做的 spike

| Spike | 目的 | 方法 | 失败回退 |
|---|---|---|---|
| **S1 figlet/gradient** | 确认 `figlet` importable font + `ink-gradient` 在 ink-testing-library（无 TTY）下能渲染、不抛错；**且 `columns<52`(窄/0 宽) 不 crash**；低色降级 | `figlet.parseFont("ANSI Shadow", importedFont)` 后渲染 `<Gradient colors={[a,b,c]}><Text>{renderOhbabyLogo().join("\n")}</Text></Gradient>`，看 `lastFrame()` 有块字符；`FORCE_COLOR=0` 看是否仍出字形；窄宽下不抛 | 换更窄 FIGfont（如 `Standard`）；再不行半块 ASCII 常量 |
| **S3 真机闪烁** | 确认 prompt 固定边框/宽度 + 消息拆分后的 Windows 打字观感 | `pnpm --filter ohbaby-cli build` 后跑起来连续打字目视，对照改前 | 若仍闪，排查 logo/cursor + 收窄 store selector；真正 transcript 静态化需另做 viewport/虚拟列表设计 |

> S1 先于问题 1 实现；S3 是 4b 的人工验收项（无法自动化）。

---

## B. 测试改动

### B1. 需更新的现有测试

| 文件:行 | 现状断言 | 变更后 | 原因 |
|---|---|---|---|
| [app.contract.test.tsx:110-111](../../../packages/ohbaby-cli/src/tui/app.contract.test.tsx) | `toContain("OHBABY")` + `toContain("___  _   _")` | 断言 FIGfont 块字符（如 `█`）+ 选定 tagline 锚（如 `ohbaby`） | 问题 1：固定 FIGfont 块字、无下划线、无字面 `OHBABY` |
| [render/logo.unit.test.ts:9](../../../packages/ohbaby-cli/src/tui/render/logo.unit.test.ts) | `renderOhbabyLogo().join("\n")` 含 `"OHBABY"` | `renderOhbabyLogo({ maxWidth: 80 })` 断言多行非空 + FIGfont 块字符；`renderOhbabyLogo({ maxWidth: 30 })` 断言字面 `OHBABY` fallback | 问题 1：主 logo 由 `figlet` 固定生成，窄屏回退单独测 |
| [app.contract.test.tsx:780-781](../../../packages/ohbaby-cli/src/tui/app.contract.test.tsx) | `> Reject [deny]` 高亮、`  Allow once [allow]` 未高亮 | `> Allow once [allow]` 高亮、`  Reject [deny]` 未高亮 | 问题 2 |
| [app.contract.test.tsx:1300-1330](../../../packages/ohbaby-cli/src/tui/app.contract.test.tsx)（"defaults to deny"） | 回车 → `{choiceId:"deny"}` | 改名"defaults to first allow"；回车 → `{choiceId:"allow"}` | 问题 2 |
| [tool-part.unit.test.ts:6-21](../../../packages/ohbaby-cli/src/tui/components/message/parts/tool-part.unit.test.ts) | `renderToolPart(running)==="⠋ Bash ..."` | 断言纯标签（`renderToolLabel(...)==="Bash pnpm test"`，无 leading 标记/spinner 字形） | 问题 5：running 改组件渲染 |
| 含颜色断言的 contract 测试（如 [app.contract.test.tsx:113](../../../packages/ohbaby-cli/src/tui/app.contract.test.tsx) 系列 `not.toContain`） | 依赖旧 `cyan/yellow` 视觉 | 对齐语义 token 后回归；多为 `not.toContain`，预计小改 | Phase 0 主题迁移 |

> ✅ **Static spike 已转成护栏**：`lastFrame()` 含 static 内容是真的；跨 session stale 也是真的。v1 用动态 transcript + `MessageList` stale 回归测试守住正确性。

### B2. 新增测试

**Phase 0 · 主题**
- `colors.ts`：dark/light 两套 key 完整、均为合法 hex。
- `tokens.ts`：每个语义 token 在 dark/light 都解析到调色板里存在的色；`brandTitle/spinner/tool/status/border` 等本轮必用 token 存在。
- `detect.ts`：无信号默认 dark；`chalk.level<2` 时 token 解析为 16 色名（不返回 hex）。
- `useTheme()`：Provider 缺失时报错/有合理默认（按实现定）。

**问题 2 · permission**
- choices `[allow, deny]`：初始高亮在 allow；回车 → `{choiceId:<allow>}`；Esc → `{choiceId:<deny>}`；无 allow 时回退 Esc 安全默认（如 `[abort,deny]` → deny）。

**问题 5 · spinner**
- `Spinner` 组件：`OHBABY_TUI_NO_ANIM=1` 时静态首帧 `⠋`、不启定时器；动画态 `vi.useFakeTimers()` 推进 80ms 切帧、颜色在金/紫交替；卸载清 `clearInterval`。
- MessageList：running 工具行出 spinner 首帧 + 工具名；completed 行仍 `  Bash ...`。

**问题 3 · skill 噪声**
- `ui-inprocess.ts` 的 `createSkillLogger`：`warn("...overrides...", {kind:"skill-override"})` **不**触发 `publishNotice`；`warn("Invalid skill skipped",{error})` 仍触发。
- 回归 [ui-inprocess.contract.test.ts:3070](../../../packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts)（invalid→notice 保持绿）。
- loader 单测 [loader.unit.test.ts:94](../../../packages/ohbaby-agent/src/skill/loader.unit.test.ts) 保持（文案不变）。
- 端到端核查：跑起 TUI/ui-inprocess 测试确认覆盖场景**不再**产生 `Skill warning`。

**问题 1 · logo**
- `renderOhbabyLogo({ maxWidth })` 使用固定 FIGfont，宽屏输出多行非空且含块字符（如 `█`）；窄屏回退含 `OHBABY` 锚。
- `<Logo/>` 宽终端渲染 FIGfont 块字符；`columns<52` 渲染小号回退。
- 选定 tagline 锚存在（供 contract 复用）。

**问题 4a · 边框**
- Prompt 渲染含边框字符（`╭`/`╰` 或上下 `─`），`> message` 占位在框内；`columns=80` 不溢出（参 [metrics.unit.test.ts](../../../packages/ohbaby-cli/src/tui/layout/metrics.unit.test.ts) 风格）。

**问题 4b · transcript stale**
- 多消息：`lastFrame()` 同时含历史与最后一条；替换 transcript 后不得保留旧 committed 行。
- 暂不测试 `<Static>` 退役时机；v1 不把可切换 session transcript 放入 Ink append-only Static。

**子组件单测（message-list 拆分后，见 02）**
- `MessageRow` / `NoticeBanner` 各自可独立渲染断言（拆分降低对整树 `app.contract` 的依赖）。

### B3. 测试辅助
- 全局在 logo/spinner 涉及的测试设 `OHBABY_TUI_NO_ANIM=1` 稳定输出。
- **不需要** `app.frames` 迁移 helper（S2 已证 `lastFrame()` 含 static）。如个别用例要看「历史所有帧」，`app.frames.join("\n")` 仍可用，但非必需。

---

## C. 验收标准

### C1. 功能性验收

| # | 验收点 |
|---|---|
| P0 | 所有颜色来自 `tokens.ts` 语义层（组件无裸色名/hex）；默认暗色；低色终端降级不崩；dark/light 两套可用。 |
| 1 | 空态 logo 为固定 FIGfont 块字 + **gold→purple→skyBlue 渐变**；窄终端（<52 列）回退小号不溢出；低色降级可读。 |
| 2 | 权限弹窗回车默认 **Allow once**；Esc 仍 deny；Ctrl+C 仍 abort run。 |
| 3 | 启动后转录顶部**不再常驻** `Skill … overrides …`；invalid/被更高优先级忽略的告警仍可见。 |
| 4a | 输入区圆角边框可见，`>` 与占位在框内，dock/usage 在框外下方；80/120 列对齐正常。 |
| 4b | 连续打字**不再整屏闪烁**（Windows PowerShell + Windows Terminal 真机确认，S3）。 |
| 5 | 工具 running/pending 时 spinner **持续旋转**（≈80ms/帧，金/紫交替）；完成后回静态 `  `；无 setInterval 泄漏；`OHBABY_TUI_NO_ANIM=1` 可关。 |

### C2. 自动化门槛
- `pnpm --filter ohbaby-cli test` 全绿（主题 + 更新后的 contract + 新增 logo/spinner/permission/border/transcript-stale 测试）。
- `pnpm --filter ohbaby-agent test` 全绿（skill loader + ui-inprocess + composition）。
- typecheck / lint 通过；无未清理 `setInterval`、无 React `act` 泄漏告警。

### C3. 人工验收
**执行者**：维护者；**时机**：合并前一次（非每次改动）。先尽量自动化（见下），剩余靠人工。

**可自动化的「视觉」回归（文本帧快照，纳入 C2）**：
- logo（宽/窄两宽度，`OHBABY_TUI_NO_ANIM=1`）、输入框边框、空态布局 → `lastFrame()` 文本快照（toMatchInlineSnapshot），改动时 diff 一眼可见。这些不依赖真彩，纯结构。

**只能人工的项**（真彩/动效/真机，无法快照）：
- [ ] 真机连续打字观感验收（S3，Windows PowerShell + Windows Terminal）。
- [ ] logo 紫金蓝渐变**颜色**观感（截图对比改前/改后）。
- [ ] spinner 真在转、金紫脉动节奏自然。
- [ ] 权限默认项符合直觉、误触不致自动同意。
- [ ] 暗/亮主题 + 低色（16 色）终端 观感正常。

### C4. 回归与非目标
- 回归：markdown 渲染、slash 补全、history、permission mode 切换（Shift+Tab）、interactions 弹窗、context 用量、Ctrl+C abort——均不受影响。
- 非目标（本轮不做）：tui-improve-1 的 `layout/` shell、工具渲染器注册表、`render/` 重构、虚拟滚动；toast 系统；opencode 级 logo 动画 shimmer；主题热切换/自定义主题文件。
