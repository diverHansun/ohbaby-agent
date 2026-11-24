# 3. 参考项目借鉴

> 本文记录 2026-11-24 对 `code-cli/` 下三个项目的核查结果，只记事实和借鉴点。

## 3.1 三个项目的做法

| 项目 | 等待审批的标记 | 位置 | hover 时 |
|---|---|---|---|
| kimi-code | `Badge` 文字徽标"待授权"，warning 色 | 行尾，替换掉相对时间 | 徽标隐藏，让位给 pin、归档按钮 |
| dsh | `StateDot` 圆点，`amber-500`（`#f59e0b`），另在行尾用灰色文字"待审批"替换时间 | 圆点在左侧 16px 前导槽 | 行尾文字被操作按钮替换，左侧圆点保持可见 |
| ZCode | 绿色胶囊徽标"等待确认" | 标题后面 | 徽标保留，等待期间不渲染操作按钮 |

出处：

- kimi-code：`packages/app-components/src/SessionRow.vue`，徽标在 `.act` 里，hover 规则 `.se:hover .act .ui-badge { opacity: 0 }`。
- dsh：`packages/client/ui-workspace/src/client/rows/Rows.tsx:614-651`、`Rows.module.css:303-324`；颜色见 `ui-primitives/src/StateDot.module.css:21-23`。
- ZCode：`packages/ui/src/TaskInteractionBadge.tsx:62`、`TaskListItem.tsx:834-847`。

另外，三个项目都能在任意会话上显示等待状态，不只是当前会话。

## 3.2 借鉴点

- 采用 dsh 的位置：状态标记放在左侧前导列。这样 hover 按钮只占右侧，标记永远不被盖住，也不会位移。
- 不采用 kimi-code 的"hover 时隐藏"，也不采用 ZCode 的"等待期间不给操作按钮"。用户要求 hover 时圆点和「…」都能看到。
- 不用文字徽标。ohbaby Web 的约定是不做胶囊控件，保持克制。
- 颜色不用 dsh 的 `#f59e0b`，用户选了更偏黄的 `#F2C230`。
