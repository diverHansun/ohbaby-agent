# Web Composer：圆形发送、输入增高、少一层卡片

> 状态：**实施完成，待用户审查**（2026-09-18）。
>
> 日期：2026-09-18
>
> 议题：Web 发送钮太大且带字；空输入框偏高；连接状态和工具名多套一层胶囊。本轮只改展示层 chrome，不改发送、排队、中断、工具配对。

## 1. 议题

上一批 [web-composer-send-stop](../2026-09-18-web-composer-send-stop/README.md) 已经把主操作收成单槽。本轮在那个槽上改样子：圆钮只放纸飞机；圆钮缩窄后思考强度控件随布局向右靠近主按钮；输入框空着一行、最多显示 7 个视觉行再内部滚；顶栏连接状态和工具名去掉内层胶囊，外层工具卡/结果卡不动。

和 send-stop 分开立议题，文档不混写。

## 2. 轮次地图

| 轮次 | 开启日期 | 触发事件 | 状态 | 文档 |
|------|----------|----------|------|------|
| improve-1 | 2026-09-18 | 首轮规划与实施 | 实施完成，待审查 | [improve-1/](./improve-1/) |

只有一轮。实施若分多次会话，用 improve-1 的 02 Stage，不预开 `improve-2/`。

## 3. 本轮文档地图

| 文档 | 作用 |
|------|------|
| [improve-1/00-discussion.md](./improve-1/00-discussion.md) | 已确认产品决策与边界 |
| [improve-1/01-problem-analysis-and-current-state.md](./improve-1/01-problem-analysis-and-current-state.md) | 现状、代码锚点、与权威 UI 文档的 gap |
| [improve-1/02-optimization-plan-and-change-scope.md](./improve-1/02-optimization-plan-and-change-scope.md) | 实施契约：Stage 1–4、改动面、风险回滚 |
| 03 | **跳过**：无仓库内可对照的参考项目；对话里的产品截图只约束「圆钮、少一层胶囊」，不单开 03 |
| [improve-1/04-test-and-acceptance.md](./improve-1/04-test-and-acceptance.md) | 单测、回归与发布门 |
| [improve-1/05-implementation-acceptance.md](./improve-1/05-implementation-acceptance.md) | 实施结果、验证证据与剩余边界 |

推荐阅读顺序：`00 → 01 → 02 → 04`。实施以 `02 + 04` 为准；与 `00` 冲突时先改文档再改代码。

## 4. In scope / Out of scope

**In scope**

- 单槽主按钮：空闲/入队/改队列都是蓝色圆钮 + 纸飞机，不要「Send」「Save」字；刚发出去转圈画在圆里；空草稿且 running 时同一圆坑换成停止方块，不要「Stop」字。
- 点纸飞机：空闲则发新消息；正在跑用户消息则走现有队列；正在改 Queue 里已有条目则保存这条的修改（`editQueuedPrompt`）。成功后原条目按队列顺序继续调度，不新增第二条；若此时轮到它，也可能立即开始执行。脸上不再写 Save。
- 输入框：空着约一行高；随行增高；最多显示 7 个视觉行（含自动折行），之后高度封顶，滚动发生在 textarea 内部（滚轮、PageUp/PageDown）。
- 长高后圆钮和思考芯片贴输入框右下；`>` 贴顶。
- 发送/停止样式与 `.ohb-button` / `.ohb-button-primary` 拆开，权限弹窗和 overlay 主按钮不要变成圆。
- 顶栏连接状态：去掉胶囊和圆点，只留带颜色的字。`running` / `connecting` / `reconnecting` 字轻轻呼吸；`idle` / `resyncing` / `disconnected` 静着。
- 工具名：去掉标题小胶囊（底、边、内边距），颜色留在字上。外层 `.ohb-tool-panel` 和展开后的结果 `<pre>` 不拆。

**Out of scope**

- TUI。
- 拆外层工具卡、结果卡、命令 notice 上的同类小胶囊、Goal 芯片。
- 改 `canSend` / `canStop`、队列协议、`abortSession`、工具 call/result 配对。
- 整张卡片式 composer、把 mode/permission 搬进输入框。
- 像素级视觉回归框架、Playwright 必做。

## 5. 实施契约

规划会话不写代码。用户审查 00–04 通过后，由实施会话按 `02 + 04` 开发。完成用户审查前，不合并、不推送。
