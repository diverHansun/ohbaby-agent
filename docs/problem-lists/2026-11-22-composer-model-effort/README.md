# 输入框模型与思考强度合并

本议题于 2026-11-22 开启，把 ohbaby Web 输入框底部的"模型"按钮和"思考强度"下拉框合并成一个按钮、一个菜单。只做 Web，不做 TUI。

姊妹议题 [语音输入](../2026-11-22-voice-input/README.md) 会在同一行控件里放麦克风和波形，合并后腾出的宽度正好给它用。

## 范围

| 本轮做 | 本轮不做 |
|---|---|
| 模型和思考强度合并成一个按钮，按钮上显示"模型名 + 灰色强度" | 后端、SDK 接口改动（现有数据已够用） |
| 一个菜单：按提供方分组的模型列表，下面一行"Effort ›"，点进去选当前模型的强度 | TUI |
| 手机"更多"菜单去掉思考强度一项，统一走合并后的按钮 | 滑块、分段按钮等新的选择样式 |
| 同步 `docs/ohbaby-web/redesign-2026-10/` 里相关的设计文档 | 模型管理页、设置页的改动 |

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-22 | 首轮 | 合并按钮与菜单、手机"更多"菜单调整、设计文档同步 | 已实施，待验收 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定和边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 现在两个控件怎么实现、问题在哪 |
| [02 优化方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 交给实施会话的方案和改动范围 |
| [03 参考项目借鉴](improve-1/03-reference-projects.md) | Claude Code、Codex、Cursor、deepseek-harness、ZCode、kimi-code 的做法 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 测试场景和验收标准 |
| 05 实施验收 | 本轮实施完成后，由验收模式写入 `05-implementation-acceptance.md` |

## 实施约定

02 和 04 是交给实施会话的契约：开发者按 02 改代码，按 04 自测。规划会话本身不写代码。
