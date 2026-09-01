# improve-1 · Web `/skills` 发现卡片与 `/skill` 兼容别名

> 状态：**已按确认方案完成实施、自动化/真实浏览器验收与三路只读子代理复审；待用户审阅本批提交。**
>
> 时间口径：2026-09-01，规划基线 `origin/main@7cec6ba`（v0.1.12），工作分支 `codex/slash-commands-improve-1`。
>
> 本批是对 [`../skill-invocation.md`](../skill-invocation.md) 已落地能力的棕场修补，不是新模块。

## 1. 本批一句话

Web 顶层 `/` 继续不列出单个 skill；发现入口仍是 `/skills` 结果弹窗。修复浮层 `/skills` 行的空参数列、弹窗的指针/键盘选中一致性与长文本/元数据鲁棒性；catalog 为 `/skills` 增加输入别名 `/skill`，但所有 UI 标签仍显示 canonical `/skills`。发送 skill 时继续走既有 `executeSkillCommand` 注入，不改 daemon 语义。

## 2. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 冻结已确认决策 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 现状、浏览器证据、根因与文档/代码 gap |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 实施执行契约与规划基线快照（含关键改动清单） |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 自动化与验收门 |
| [05-implementation-acceptance.md](./05-implementation-acceptance.md) | 实施差异、测试证据与复审结论 |

**03 跳过**：本议题无外部参考项目调研；TUI `/skills` overlay 只作为 01 的现有实现对照，不单独成篇。阅读顺序：`00 → 01 → 02 → 04`。实施只读 `02 + 04` 应能完成本批。

## 3. In scope

- `/skills` 弹窗：skill 行明确为名称 / 描述 / `scope · source` 三段；长名称、描述和 metadata 均有界并单行截断。
- 指针：鼠标悬停更新真实选中态；单击该行直接落入 `/<name> ` 并关闭弹窗。
- 键盘：`↑/↓`、`PageUp/PageDown` 选中（clamp + 选中行滚入可视区）；`Tab` / `Enter` 落入选中项；`Esc` 关闭。
- 顶层 `/` 浮层仍不含 `executionKind:"skill"` 的单个 skill。
- 浮层 `/skills` 行：无 `argsHint` 时使用显式 no-args 布局，不再留下参数列大空洞；有参数命令继续保持现有四列对齐。
- catalog：`/skills` 增加 alias `[["skill"]]`；direct resolve `/skill` 命中 builtin `skills`；标签、补全 chip、弹窗 header 一律 `/skills`，slash 列表不出现 `/skill` 第二行。
- 命令层在 `service.ts` 内维护单一 external-command eligibility projection。占用优先级为 builtin canonical/aliases > 已接受的显式 `extraCommands` > registry skills；所有不能注册为 slash command 的 skill 都不进入 `/skills` 输出。projection 同时保留现有 `cancel` / `mode` / `model` roots 与 `permission/default`、`permission/full-access` exact paths，比较大小写不敏感；builtin 占用路径从真实 builtin-only catalog 机械收集，不手抄第二份名单。
- 同步权威文档 [`../skill-invocation.md`](../skill-invocation.md)：当前契约改成现状口径，历史实施计划显式标为已完成记录。
- 对应 unit / integration 测试与既有落入/执行回归。

## 4. Out of scope

- 顶层 `/` flood 全部 user-invocable skill。
- 弹窗内直接执行 skill（Tab/单击只落入 composer）。
- 改 `executeSkillCommand` / `submitPromptAndWait` 注入协议。
- 把注入后的整份 SKILL.md 收成会话里的 Skill 工具卡。
- skill 参数表单、搜索框、收藏/置顶、分组筛选。
- TUI overlay 视觉改版（TUI 只享受 catalog alias 与共享 `/skills` 输出策略）。
- `/skills` modal 的完整 listbox/option 焦点模型、关闭后焦点恢复与屏幕阅读器专项改造；本批只保证现有 window-keydown 模型下的可观察选中一致性。
- 像素级视觉回归套件。

## 5. 已完成开发闸门

1. 用户已审阅并确认本目录 00–02、04 与同步后的 `skill-invocation.md`。
2. 已按 02 完成 Phase A（alias + 共享保留策略）→ Phase B（弹窗卡片与指针/键盘）→ Phase C（浮层 no-args 行 + 权威规格同步）。
3. 已按 04 运行 targeted / typecheck / lint / 全仓 test / build，并用真实浏览器关闭 palette 后 direct 提交 `/skill` 证明 alias。
4. 实施差异与最终证据已写入 `05-implementation-acceptance.md`，三路只读子代理复审 findings 已全部关闭。

## 6. 实施契约

02 的关键改动清单保留为规划基线快照，不勾选、不回写行号。实现与快照的差异、验收结果统一记录在 05。
