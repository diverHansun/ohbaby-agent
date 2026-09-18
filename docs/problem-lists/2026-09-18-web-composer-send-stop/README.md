# Web Composer：单槽发送/停止 + 思考强度芯片

> 状态：**实施完成，验收通过**（2026-09-18；附带低优先级测试/手工缺口，见 05）。
>
> 日期：2026-09-18
>
> 议题：Web 输入框把 Send 和 Stop 并排成两颗主按钮，运行时空草稿仍挂一颗灰 Send；思考强度挤在 footer。本轮把主操作收成一个槽位，把思考强度搬进输入框做成无边框芯片，并去掉 Web 上的操作常识提示。

## 1. 议题

用户在 Web composer 看到：发送前只有 Send；发送后 Send 变灰不可点，旁边又多出 Stop。这是展示层冗余，不是发送/中断能力不够。

同时要把 Stop 腾出来的位置给思考强度：有思考能力的模型，输入框内是「档位芯片 + 一颗主按钮」；无思考能力时只有主按钮。Web 不再常驻 `enter to send` / `double click esc to interrupt`；TUI 的 Esc 中断提示保留。

## 2. 轮次地图

| 轮次 | 开启日期 | 触发事件 | 状态 | 文档 |
|------|----------|----------|------|------|
| improve-1 | 2026-09-18 | 首轮规划 | 实施完成，验收通过 | [improve-1/](./improve-1/) |

只有一轮。实施若分多次会话，用 improve-1 的 02 Stage，不预开 `improve-2/`。

## 3. 本轮文档地图

| 文档 | 作用 |
|------|------|
| [improve-1/00-discussion.md](./improve-1/00-discussion.md) | 已确认产品决策与边界 |
| [improve-1/01-problem-analysis-and-current-state.md](./improve-1/01-problem-analysis-and-current-state.md) | 现状、代码锚点、与权威 UI 文档的 gap |
| [improve-1/02-optimization-plan-and-change-scope.md](./improve-1/02-optimization-plan-and-change-scope.md) | 实施契约：Stage 1–3、改动面、风险回滚 |
| 03 | **跳过**：无仓库内可对照的参考项目；对话里的产品截图只约束「无边框、hover 细描边」，不单开 03 |
| [improve-1/04-test-and-acceptance.md](./improve-1/04-test-and-acceptance.md) | 单测、回归与发布门 |
| [improve-1/05-implementation-acceptance.md](./improve-1/05-implementation-acceptance.md) | 对照 02/04 的实施验收 |

推荐阅读顺序：`00 → 01 → 02 → 04`。实施以 `02 + 04` 为准；与 `00` 冲突时先改文档再改代码。

## 4. In scope / Out of scope

**In scope**

- Web composer 右侧只保留**一个**主操作槽：Send / 转圈 / Stop / Save 按状态变脸，绝不并排两颗。
- 运行中有草稿时显示 Send；发送后进入现有后端队列，草稿清空后恢复 Stop。重连期间按最后已知运行状态保留灰 Stop。
- 思考强度搬进 `.ohb-composer-input`，主按钮左侧；平时无边框透明底，hover/focus 浅灰细边；保留大脑图标与英文档位。
- 去掉 Web composer footer 的 `enter to send` / `double click esc to stop` 以及重复的连接状态 hint。
- 去掉 Web Thinking 行的 `double click esc to interrupt`；只留 `Thinking · Ns` / `starting agent`。
- 改队列 hint 保留。Stop 的 `title` 可带双击 Esc。
- 同步 `docs/ohbaby-web/ui/components.md`、`states.md`，以及 `test.md` 里与 Send 转圈相关的过时句子。

**Out of scope**

- TUI 的 `Press Esc again to interrupt` 及双击 Esc 行为。
- 把 Send 改名为 Queue、把 Stop 改名为暂停。
- Thinking 行做成可点中断。
- 拆 `ActionSlot` 组件、Split Button、为防布局跳动预留空位。
- 改 `canSend` / `canStop` 的数据含义（running 仍可入队）。
- mode / permission 按钮搬进输入框，或做成图里那种整张卡片式 composer。
- 思考档位中文化（「高」）、检测中加字、关不了思考就藏按钮。
- 后端 `abortSession`、队列、admission 协议。

## 5. 实施契约

用户已确认 00–04 的产品方向，并明确授权实施会话按 `02 + 04` 开发。代码在临时分支 `codex/temp-web-composer-send-stop`（`5b930cde`…`d0ce7faf`）。验收见 [05](./improve-1/05-implementation-acceptance.md)。完成用户审查前，不合并、不推送。

## 6. 后续视觉密度优化

圆形无字主按钮、思考强度随按钮缩窄向右贴近、输入框 1–7 个视觉行、状态纯字与工具名去内层胶囊，见独立议题 [web-composer-density](../2026-09-18-web-composer-density/README.md)。本目录的 00–05 保留单槽行为和本轮实施记录；后续外观与高度的实施契约以新议题 02/04 为准。
