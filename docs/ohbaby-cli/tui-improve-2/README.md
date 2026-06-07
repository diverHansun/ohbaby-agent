# TUI 改进 2（tui-improve-2）

ohbaby-cli 终端界面（`packages/ohbaby-cli/src/tui/`）的第二轮前端打磨。本目录是**设计、验收与实施计划文档**，不含实现代码。当前 spec 与 execution plan 已对齐，后续可按 [04-execution-plan.md](./04-execution-plan.md) 逐任务实施。

> 状态：设计已与维护者逐项拍板（见下「已定决策」），并经子代理与当前源码核查修正。**本轮已对齐 spec，实施分支为 `codex/tui-improve-2-ui-fixes`**。

## 范围

tui-improve-2 = **主题系统（地基）+ message-list 拆分 + 5 个前端修复**，分阶段：

- **Phase 0 · 主题系统**：新建 `tui/theme/`（`colors.ts` / `tokens.ts` / `detect.ts` / `index.ts`），落地 [tui-improve-1 02a](../tui-improve-1/02a-theme-and-colors.md) 设计的紫金蓝品牌调色板（dark/light + chalk.level 降级），把现有 7 个读色组件迁移到语义 token。这是 5 个修复（尤其 logo 渐变、spinner 紫金、边框）的颜色来源。
- **Phase 0.5 · 拆 message-list**（评审驱动）：把巨组件按 SRP 拆成 `message-list`(编排)/`message-row`/`notice-banner`。这样问题 3/4b/5 的改动落在不同小文件；窄 store selector 仍作为后续性能项记录（详见 02）。
- **Phase 1 · 5 个修复**：建立在 tokens + 拆分之上（见下表）。

**明确不做**（仍属独立工作，不在本轮）：tui-improve-1 [02-implementation-plan](../tui-improve-1/02-implementation-plan.md) 更大的结构性重写——`layout/` shell、工具渲染器注册表、`render/` 重构、虚拟滚动等。

## 与 tui-improve-1 的关系

- **主题系统**：tui-improve-1 02a 设计了 `colors.ts → tokens.ts` 紫金蓝调色板，但**尚未实现**（当前 `theme.ts` 仍是 `cyan/yellow` 扁平版）。本轮把这套主题系统做完，作为权威调色板来源；本文档不重复 hex 表，**直接引用 02a**。
- **Logo 决策覆盖**：tui-improve-1 决策 #4 原定「OHBABY 手绘三色、不引入 figlet/big-text 依赖」。本轮**覆盖**为 `figlet + ink-gradient` 平滑渐变（接受新依赖）。理由：`ink-big-text` 运行时会带入 GPL-3.0-or-later 的 `cfonts`；`figlet` 与 `ink-gradient` 均为 MIT，更适合后续 npm 发布。本文档为该决策的最新口径。
- **Spinner**：直接采用 tui-improve-1 决策 #3 的紫金 braille 规格。

## 5 个修复一览

| # | 问题 | 根因位置 | 选定方案 |
|---|---|---|---|
| 1 | OHBABY 大字渲染不好看 | [render/logo.ts](../../../packages/ohbaby-cli/src/tui/render/logo.ts) · [components/logo.tsx](../../../packages/ohbaby-cli/src/tui/components/logo.tsx) | `figlet`(固定字体) + `ink-gradient`，渐变停 **gold→purple→skyBlue**；窄终端回退小号 logo |
| 2 | Permission 默认高亮 Reject | [dialogs/permission-dialog.tsx](../../../packages/ohbaby-cli/src/tui/dialogs/permission-dialog.tsx) | 默认高亮首个 `allow`（Allow once）；Esc 仍取 deny |
| 3 | `Skill … overrides` 永久占据转录顶部 | **生产路径** [ui-inprocess.ts:384-396](../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts)（+ 对称 composition.ts）→ [message-list.tsx](../../../packages/ohbaby-cli/src/tui/components/message/message-list.tsx) | `createSkillLogger` 跳过 `kind:"skill-override"`；loader 加判别字段 |
| 4 | 输入框无边框 + 打字闪烁 | [components/prompt/index.tsx](../../../packages/ohbaby-cli/src/tui/components/prompt/index.tsx) · prompt 容器宽度不稳定 | (4a) `borderStyle="round"` 圆角边框；(4b) transcript `<Static>` 暂缓，避免跨 session append-only 旧内容残留 |
| 5 | Spinner 工具调用时不转 | [parts/tool-part.tsx](../../../packages/ohbaby-cli/src/tui/components/message/parts/tool-part.tsx) | 自驱动 `<Spinner/>` 组件，braille @80ms，金/紫交替；`OHBABY_TUI_NO_ANIM` 可关 |

## 参考项目对照

| 项目 | 路径 | 框架 | 借鉴 |
|---|---|---|---|
| **gemini-cli** | （web 调研） | Ink | `ink-gradient` + 大字/手绘 ASCII，宽度自适应 logo |
| **claude-code** | （web 调研） | — | 填充 ASCII + 渐变（`oh-my-logo` 即其复刻对象） |
| **kimi-code** | `D:/Projects/Code-cli/kimi-code` | `@earendil-works/pi-tui` | spinner setInterval、圆角面板 logo、permission 选择器、startup 提示不入转录 |
| **opencode** | `D:/Projects/Code-cli/opencode` | `@opentui/core` | spinner 帧表、`SplitBorder` 竖线、block logo 思路（RGBA shimmer 不可移植） |
| **hermes-agent** | （web 调研） | 自研 | 图→ASCII（braille/blocks）+ YAML skin 主题引擎（不同范式，参考其主题化思路） |

> opencode/kimi 用自定义 cell/行级 diff 渲染器，只重绘变化单元格；ohbaby 用 Ink 且全程未用 `<Static>`，这是问题 4/5 的共性根因。

## 依赖增量（`packages/ohbaby-cli`）

| 包 | 用途 | 兼容性 |
|---|---|---|
| `figlet@^1` | 固定 FIGfont 生成 OHBABY ANSI/ASCII 大字 | MIT；可用 importable font，避免运行时文件探测 |
| `ink-gradient@^4` | Ink 内渐变上色（wraps gradient-string） | MIT；peer `ink>=6, react>=19.2` ✓（正中本栈） |

不引入 `ink-big-text`（间接依赖 `cfonts`，GPL-3.0-or-later）/ `oh-my-logo`（把 `ink@5/react@18` 列为硬依赖，会在 Ink 6 树里造成重复）。`chalk ^5` 已是依赖。

## 文档结构

1. [01-problem-analysis.md](./01-problem-analysis.md) — 逐项根因（带 `file:line`）+ 参考项目对照。
2. [02-implementation-plan.md](./02-implementation-plan.md) — Phase 0 主题系统 + Phase 1 五修复方案、代码草图、改动清单、风险。
3. [03-tests-and-acceptance.md](./03-tests-and-acceptance.md) — spike、需更新/新增测试、验收标准（含人工验收）。
4. [04-execution-plan.md](./04-execution-plan.md) — 可执行实施计划（agentic worker 按任务推进）。

## 已定决策（维护者拍板）

1. Logo：`figlet + ink-gradient`，固定 OHBABY 字样，渐变 **gold→purple→skyBlue** 三停。
2. 主题：**本轮做完 tui-improve-1 主题系统**（colors/tokens/detect + ThemeProvider，dark/light，chalk.level 降级，组件迁语义层）。
3. 输入框：**圆角边框**（覆盖 tui-improve-1 的背景块设计）。
4. Static：**v1 暂缓 transcript `<Static>`**；保留 `MessageRow`/`NoticeBanner` 拆分，但会话历史保持可替换动态渲染。
5. Spinner：采用 tui-improve-1 紫金 braille 规格 + 动画开关。

## 关键风险

- **范围**：主题迁移 + 拆分 + 5 修复，严格按 Phase 0 → 0.5 → 1，各自跑测试。
- **分支基线**：`codex/tui-improve-2-ui-fixes` 从 `codex/tui-improve-1-a-c` 开出，是 stacked improve-2 分支；进入 `mvp` 时应先合 improve-1，再合 improve-2。
- **发布许可证**：logo 依赖不使用 `ink-big-text/cfonts` 路线，避免 GPL 传递依赖影响 npm 发布判断。
- **`<Static>` 与 session 切换 — v1 暂缓**：S2 证实 `lastFrame()` 会保留 static 内容；后续集成测试进一步证明这会在 `/resume`、`/sessions` 后残留上一 session 的 committed 行。transcript 是可切换视图，不能直接用 Ink append-only `<Static>` 承载。
- **真彩降级**：低色终端 gradient 经 chalk 降级，验收看 16 色终端观感。
- **store selector 时炸弹**：[app.tsx:47](../../../packages/ohbaby-cli/src/tui/app.tsx) 订阅整个 state，流式高频 delta 触发整树重算；本轮先完成拆分，selector 收窄留作后续性能项（02 的 4c）。
- **行为变更测试**：问题 1/2 + 主题迁移会改现有测试预期，须同步更新（清单见 03）。

## 评审记录

### 第一轮子代理（源码核查）已并入
1. 问题 3 修复目标纠偏：生产路径在 `ui-inprocess.ts:384-396`，注入 `skillRegistry` 时 composition.ts 的 logger 被绕过——必须改 `ui-inprocess.ts`。
2. 补漏测试：`render/logo.unit.test.ts:9` 也断言字面 `OHBABY`，logo 改造后会破。
3. permission 初始回退纠偏：无 allow 时回退 Esc 安全默认而非裸 index 0。

### 第二轮子代理（SWE 分层评估）已并入
1. **S2/S4 当场实测**：`<Static>` 内容在 `lastFrame()` 跨 re-render 保留，但这正好导致跨 session stale transcript；v1 改为暂缓 transcript Static，并新增 `MessageList` 替换转录不残留旧 committed 行的单测。
2. **message-list 拆分（Phase 0.5）**：巨组件承担渲染/分区/着色三职、本轮被 3 问题同改，先拆 `message-row`/`notice-banner` + 命名 `pairToolCallResult`（评审 2.3/2.6/risk #2）。
3. **4c 收窄 store selector**：`app.tsx:47` 订阅整个 state 是「最大定时炸弹」；本轮拆分为后续 selector 收窄打基础，未把 4c 当作已完成项。
4. **依赖顺序锁**：Phase 0 先迁全部读色文件、Phase 0.5 先拆分，行为修复落在已迁好的小组件上，无二次迁移（评审 2.1）。
5. **主题初始化无闪**：`detectTheme()` 同步、Provider 首帧即算、`useTheme()` 默认 dark，不需 `ready` gate（评审 2.5）。
6. **permission 用惰性 `useState` 而非 `useMemo([request])`**：避免对象引用导致 memo 失效（评审 2.8）。
7. **`renderToolLabel` 正名**：只产标签、不分支；spinner/空格分支放组件层（评审 2.4/命名）。
8. **render/logo.ts 删旧主 logo**：只保留固定 FIGfont 主 logo 与小号回退，避免手写 ASCII 与组件两条重复路径（评审 2.3 DRY）。
9. **性能预期 + 可自动化的文本帧快照回归**（评审 2.2/2.7）；C3 人工项标注执行者/时机。

### 第三轮对齐（本轮）
1. **Logo 依赖改口径**：`ink-big-text + ink-gradient` → `figlet + ink-gradient`。技术目标不变（OHBABY 大字 + 紫金蓝渐变），但避开 `cfonts` GPL-3.0-or-later 传递依赖。
2. **分支策略写明**：improve-2 当前为 stacked 临时分支，基于 improve-1 代码结构；后续按 improve-1 → improve-2 顺序 merge 到 `mvp`。
3. **启动/发布口径写明**：本地运行先 `pnpm build` 再 `pnpm start`；正式 npm 发布需等待 TUI 修复、打包 smoke、全量 preflight 与 MCP phase 口径一起放行。

### 第四轮二次修复（当前）

1. **风险表收口**：`app.tsx` 不再订阅整份 state，拆成 `HeaderContainer` / `MessageListContainer` / `CatalogInvalidation` 等窄 selector 容器；logo 增加 app contract 正向断言，确认空态 frame 包含 `renderOhbabyLogo()` 的 figlet 锚点。
2. **command 输出静默**：权限模式切换、权限等级选择、`/new`、`/resume` 这类状态型成功命令不再进入 TUI notice；失败命令仍显示为 `error`，显式查询类输出（如 `/status`、`/help`、`/models`）保留文本/面板，但不暴露 `command_#`。
3. **slash 候选分页**：`/` 的候选池保留完整 catalog，显示层只窗口化 6 条；`PgUp/PgDn` 在 slash 菜单打开时按页起点翻页，输入 `/s` 后仍按前缀过滤。
4. **工具/文本顺序**：后端 `run-stream-adapter` 只在最后一个 part 是 text 时更新文本；工具结果后到来的文本追加为新的 text part，保证 TUI 按实际事件先后顺序渲染。
5. **prompt 位置**：本轮通过隐藏 command 噪声减少输入框跳动；完整 fixed viewport / Static transcript 仍作为独立后续 spike，不混入本批。
