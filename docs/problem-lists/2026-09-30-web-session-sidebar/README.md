# Web 会话侧栏整理

2026-09-30 开启第一轮；基线 `b13c9376`。目标是降低列表杂讯、增加浏览器本地置顶和统一操作菜单。

## 轮次与边界

| 轮次 | 日期 | 触发 | 内容 |
|---|---|---|---|
| [improve-1](improve-1/README.md) | 2026-09-30 | 首轮 | 设计、实施和验收同一套侧栏改动 |

仅 Web；后端与 TUI 不增加置顶。Rename、归档列表和恢复入口留作后续候选，不预开新轮。
用户明确授权本次按文档 → 自检/子代理/Pi 审核 → 本地临时分支实施 → 子代理/浏览器验收顺序完成；不 commit、不 push。

## 文档入口

改造契约见 [02](improve-1/02-optimization-plan-and-change-scope.md)，前端视觉及行为分别见 [03](improve-1/frontend/03-ui-layout-and-style.md)、[04](improve-1/frontend/04-interaction-and-states.md)。
现有模块设计入口：[ohbaby-web UI](../../ohbaby-web/ui/README.md)。本议题覆盖旧侧栏的圆点、Recent sessions、常驻归档和 footer 表达，其余保持现有设计。
