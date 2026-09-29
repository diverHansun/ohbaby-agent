# Permission Buttons · 配色系统

当前审批卡只有三种动作。保留现有低饱和配色，不为本轮同步改造重做视觉系统。

| 按钮         | 角色 | 背景      | 描边      | 文字      | hover 背景 |
| ------------ | ---- | --------- | --------- | --------- | ---------- |
| Allow once   | 默认 | `#5f86c4` | `#5278bb` | `#ffffff` | `#5278bb`  |
| Always allow | 次级 | `#eef2f9` | `#d8e1f0` | `#4a6ba6` | `#e3ebf6`  |
| Reject       | 拒绝 | `#faf3e4` | `#ead7ad` | `#8f6f2f` | `#f4ead2`  |

Always allow 仅在 backend 提供该选项时出现。Cancel run 已从审批移除；旧 `.ohb-perm-abort` 红色兼容样式不代表当前公开选项，也不要求本轮删除 CSS。

这些颜色仅用于权限卡专用类，不改变 `.ohb-button`、`.ohb-button-primary` 或 composer Stop。审批就绪状态决定 disabled，颜色不承担范围校验或授权决策。

验收看当前实际选项：同屏只有 Allow once 是实心主按钮，每个可见动作有 hover，未同步时全部批准/拒绝按钮不可操作。
