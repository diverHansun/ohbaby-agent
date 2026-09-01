# 讨论记录与已确认要点

> 2026-09-01 与用户讨论定稿。正式方案见 01、02、04。规划基线 `origin/main@7cec6ba`，工作分支 `codex/slash-commands-improve-1`。

---

## 1. 背景与动机

Web 端「slash + skill」后的发现体验存在问题。只读排查与浏览器复现确认：发现入口本来就是 `/skills` 结果弹窗（`b5e00f4` 已接执行与落入），不是要在顶层 `/` 列出全部 skill。本批修复浮层空参数布局、弹窗真实选中/落入一致性与卡片鲁棒性，并为 direct 输入 `/skill` 提供兼容别名。

浏览器证据同时推翻了早期草案中的一条根因：skill 描述 `span` **没有**命中 `.ohb-list-row > span:first-child` 的 MCP 状态点规则，因为它不是行的第一个子元素。文档不得继续把“圆点选择器冲突”写成卡片根因。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| 文档落点 | `docs/ohbaby-web/ui/slash-commands/improve-1/`（单批） |
| 分支 | 文档与后续实施均放在 `codex/slash-commands-improve-1` |
| 发现入口 | `/skills` 结果弹窗；顶层 `/` 保持精简，不 flood 单个 skill |
| 鼠标 | 光标悬停 = 真实选中态；**单击直接落入** composer 并关弹窗 |
| 键盘 | 选中（↑/↓、PgUp/PgDn）+ **Tab 落入**；Enter 与 Tab 同为落入（不直接执行）；选中行保持可见 |
| 卡片内容 | 名称、描述、metadata 三段；metadata 与 TUI 口径一致，显示 `scope · source`（缺 source 时只显示 scope） |
| `/skill` 别名 | catalog 上 `/skill` 是 `/skills` 的 **input-only alias**；标签 / 补全 chip / 弹窗 header 一律 `/skills`，slash 列表不出现 `/skill` 第二行 |
| direct alias 证明 | 必须绕过 palette 的 canonical label 后再提交 `/skill`，或直接测 runtime resolve；“输入 `/skill` 后直接 Enter”本身不能证明 alias |
| 可调用性策略 | `/skills` 只列出真正可通过 slash 落入并执行的 skill；builtin canonical/aliases 自动占用，显式 `extraCommands` 次优先，registry skills 最后；同时保留现有 reserved roots 与 exact paths |
| 策略事实源 | 独立 policy 只处理 normalized path/占用集合；`service.ts` 组装一次 eligibility projection，catalog 与 `builtin.ts` 的 `/skills` handler 消费同一投影，不双写名单、不制造循环依赖 |
| 浮层布局 | 有参数命令保留四列；无参数命令使用显式 no-args modifier 与三列布局，不能用无界 `max-content` 参数列 |
| 发送注入 | 落入 `/<name> ` 后用户 Enter，走既有 skill 命令注入；不改 daemon |
| 权威文档 | `skill-invocation.md` 写当前契约；已落地的旧实施计划显式标成历史完成记录，不再以 “Current State 尚未实施” 误导 |
| 关键改动清单 | 写入 02 |
| 参考项目 | 不单独立 03；TUI overlay 仅作现有实现对照 |

## 3. 已确认：边界（不做的事）

| 项 | 本批不做 / 后续做 |
|----|-------------------|
| 顶层 `/` 列出全部 skill | 本批不做 |
| 弹窗内直接跑 skill | 本批不做 |
| 改 SKILL.md 注入协议 | 本批不做 |
| 会话里把注入结果收成 Skill 工具卡 | 后续批次 |
| 参数表单 / 搜索 / 收藏 | 本批不做 |
| TUI skills 面板视觉改版 | 本批不做 |
| 像素级视觉回归 | 本批不做；保留真实浏览器行为验收 |

## 4. 已确认：与关联议题的关系

| 文档 | 关系 |
|------|------|
| [`../skill-invocation.md`](../skill-invocation.md) | Layer 1/2 权威规格；本批同步为当前契约，并把旧实施计划标成历史完成记录 |
| [`../README.md`](../README.md) | 顶层 `/` palette 与只读 modal 总规；本批不推翻“`/` 不 flood skill” |
| [`docs/problem-lists/slash-tui/02-借鉴优秀项目.md`](../../../../problem-lists/slash-tui/02-借鉴优秀项目.md) | 曾建议 `/skills` alias `/skill`，与 `/mcps` → `/mcp` 对称；本批补上，显示侧不暴露 alias |

被否决、不得再当本批目标的方案：在输入 `/skill` 时把全部 user-invocable skill 铺进顶层浮层；以及把 MCP 状态点选择器当成当前 skill 卡片的已证实根因。

## 5. 参考项目

无外部参考项目。TUI `SkillsPanel` 提供两项现有实现对照：可导航窗口与 `scope · source` metadata；Web 不照搬 TUI 的无指针模型。

## 6. 用户确认记录

- 2026-09-01：确认文档落点、本批范围与临时分支。
- 鼠标：“使用鼠标光标进行选中，单击直接落入；键盘仍是选中 + Tab”。
- 别名：“skill 当作 skills 的 alias，显示上一律 skills，只是当输入 skill 时也能兼容”。
- 需要 02 关键改动清单；完成后做文档自检（自检记录不入库）。
- 2026-09-01 初审：确认 slash 列表只保留 `/skills`，不展示 `/skill`；名为 `skill` / `skills` 的动态 skill 从 slash 列表隐藏。
- 2026-09-01 复审：确认采用审核后的推荐方案——修正错误卡片根因；`/skills` 只展示 slash-invocable skills；共享命令 eligibility 单一事实源；metadata 为 `scope · source`；无参数行显式布局；权威文档历史/现状分层；文档对齐后启动子代理复审，用户最终审核后再开发。子代理进一步补齐了 builtin canonical/aliases、accepted extra commands 与 legacy exact paths 的完整占用矩阵，不改变已确认方向。
