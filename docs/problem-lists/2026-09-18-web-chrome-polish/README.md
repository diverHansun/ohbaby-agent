# Web Chrome：工具箭头、输入框对齐、会话顶栏高度

> 状态：**improve-2 已实施，05 待验收；improve-3 规划完成，待用户审查**（2026-09-19）。暂不提交。
>
> 日期：2026-09-18（议题首轮）；improve-3 开启日 **2026-09-19**。
>
> 议题：Web 会话 chrome。improve-1 修箭头、`>`、顶栏高度。improve-2 修输入框周边、侧栏开关动画、玻璃底、彩色字标。improve-3 修新建会话按钮、顶栏上下文圆环、完整访问确认卡。

## 1. 议题

improve-1 把折叠箭头锁 14px、去掉 `>`、会话顶栏收到约 44px。improve-2 把 mode/permission 收进输入框、补侧栏推进动画、玻璃底和三色字标。用户接着要处理：侧栏「New session」描边被裁切、顶栏上下文占用圆环看不见、点 full-access 图标前需要风险确认。

## 2. 轮次地图

| 轮次 | 开启日期 | 触发事件 | 状态 | 文档 |
|------|----------|----------|------|------|
| improve-1 | 2026-09-18 | 首轮规划 | 实施与验收中（05 待验收模式写入） | [improve-1/](./improve-1/) |
| improve-2 | 2026-09-18 | **主动切割 / 跟进**：improve-1 把字标、侧栏动效、mode/policy 脸划出；落地后单独立轮 | 已实施，05 待验收模式写入 | [improve-2/](./improve-2/) |
| improve-3 | 2026-09-19 | **主动切割 / 跟进**：improve-2 把 PermissionModal、侧栏内部控件、header 圆环对比度划在范围外；用户在 improve-2 落地后把新建按钮、圆环、full-access 确认卡立成新一轮 | 规划完成，待审查 | [improve-3/](./improve-3/) |

improve-1 / improve-2 的 05 尚未写。用户要求先规划 improve-3，不挡。实施仍按各轮自己的 02+04，不混写。

不预开 improve-4。轮内分 Stage，不因「要做几天」再开轮。

## 3. 本轮文档地图（improve-3）

| 文档 | 作用 |
|------|------|
| [improve-3/00-discussion.md](./improve-3/00-discussion.md) | 已确认产品决策与边界 |
| [improve-3/01-problem-analysis-and-current-state.md](./improve-3/01-problem-analysis-and-current-state.md) | 现状、代码锚点、与权威 UI 文档的 gap |
| [improve-3/02-optimization-plan-and-change-scope.md](./improve-3/02-optimization-plan-and-change-scope.md) | 实施契约：含本轮视觉 token 与状态矩阵（plan-frontend-design 的布局/交互折叠于此，不另开 `docs/frontend/` 00–08） |
| [improve-3/03-reference-projects.md](./improve-3/03-reference-projects.md) | 用户提供的新建会话图标与完整访问确认卡：adopt / adapt / reject |
| [improve-3/04-test-and-acceptance.md](./improve-3/04-test-and-acceptance.md) | 单测、回归与发布门 |
| [improve-3/05-implementation-acceptance.md](./improve-3/05-implementation-acceptance.md) | 本轮实施完成后由验收模式写入 |

推荐阅读顺序：`00 → 01 → 03 → 02 → 04`。实施以 `02 + 04` 为准；与 `00` 冲突时先改文档再改代码。

improve-1 / improve-2 文档地图见各自目录。不回写上一轮的 00–04。

## 4. improve-3 In scope / Out of scope

**In scope**

- 侧栏 New session：去掉描边；默认无底；hover 整颗浅灰；Lucide `SquarePen` 替换 `+`；修右缘被裁切。
- 会话顶栏上下文占用圆环常驻：有 usage 显示进度，无 usage 显示空环，不再整颗消失。
- 点手形图标切到 full-access 前弹出确认卡：英文「Not now / Use full access」，默认选后者，正文友好提示风险。

**Out of scope**

- TUI。
- 把「New session」改成「新建会话」；翻译整个 Web。
- 改 PermissionModal（工具审批）、权限协议、`PATCH /v1/permission` 字段。
- 改 context 估算/投影算法；在圆环旁常驻 `32k / 200k` 文字。
- slash 命令切 full-access 的确认（本轮只拦输入框图标）。
- 记住「不再提醒」、改 plan 模式确认。
- 回写 improve-1 / improve-2 的 00–04。
- Playwright 视觉回归。

## 5. 实施契约

规划会话不写代码。用户审查 improve-3 的 00–04 通过后，由实施会话按该轮 `02 + 04` 开发。完成用户审查前，不合并、不推送。
