# improve-1：参考项目与取舍

2026-10-02。本文只记录对 [02](02-optimization-plan-and-change-scope.md) 有影响的借鉴，详细调查见 [plan/02](../plan/02-frontend-review-notes.md)。源码是本地检出快照，截图是用户实际应用参考；不能将两者视为同一版本。

## 3.1 来源

| 来源 | 范围与版本依据 | 对本轮的作用 |
| --- | --- | --- |
| OpenCode | 本地 16c56fe5，tui 1.18.32；用户截图显示另一运行版本 | 中性用户区域、细侧线、工具与元信息层级 |
| pi | 本地 5fd446ca1，tui package 0.87.1；用户截图应用 0.99.2 | 输入轻边界、底栏分组、基础能力与产品组件的边界 |
| ohbaby Web | 仓库内现有实现 | 内部消息过滤、类别色、模型/effort 与上下文数据契约 |
| Gemini CLI | 本地 bedef96e | Ink 稳定历史/活动区分工的参考，不能证明 ohbaby 的修正问题已解决 |
| 本地 Claude Code/CCB | 本地 77a7934e，README 声明为恢复工程 | 后续 Tasks 小修参考；不作为官方 SDK 或本轮移植对象 |
| Ghostty | 用户主终端；官方控制序列资料 | 解释 CSI 3 J 对回滚区的影响；实际体验仍须本机验证 |

本地并列参考仓库链接仅用于研究，不是运行依赖。

## 3.2 采用与调整

| 参考入口 | 借鉴 | ohbaby 取舍 |
| --- | --- | --- |
| [OpenCode 用户消息](../../../../../opencode/packages/tui/src/routes/session/index.tsx:1398) | 完整中性面板、侧线与一致内边距 | 采用已确认方向；不硬抄颜色、全屏宽度或大量上下留白 |
| [OpenCode 工具行](../../../../../opencode/packages/tui/src/routes/session/index.tsx:1874) | 对象、状态、内容层级分开 | 调整为 ohbaby 的少量类别色和真实状态，不统一全部土黄 |
| [pi user-message](../../../../../pi/packages/coding-agent/src/modes/interactive/components/user-message.ts) | 产品层消息组合 | 仅借鉴设计；此组件属于 coding-agent，不能作为 pi-tui SDK 导入 |
| [pi MainScreen](../../../../../pi/packages/tui/src/tui-main-screen.ts:278) | 终端输出边界与重绘条件 | 用于验证风险，不承诺替换后自动保留回滚；不与 Ink 同屏争用终端 |
| [Web 来源过滤](../../../../apps/ohbaby-web/src/ui/conversation/ConversationStream.tsx:79) | 内部运行时消息不进入用户时间线 | 采用同一来源契约，TUI 在划分/提交前过滤 |
| [Web 工具色](../../../../apps/ohbaby-web/src/ui/conversation/tool-card.tsx:230) | 少量分类强调 | 采用语义方向，不复制名称子串匹配作为规范，不将类别色当执行结果 |
| [Web effort](../../../../apps/ohbaby-web/src/ui/composer/ReasoningControl.tsx:129) | 能力识别、兼容偏好与默认值 | 沿用数据逻辑；常驻底栏显示值，未知显示 unknown |
| [Web 上下文](../../../../apps/ohbaby-web/src/ui/shared/ContextUsage.tsx) | 展示后端 session usage | TUI 使用无标签的百分比和小写 k/m；不移植 SVG 圆环或弹出层 |
| [Gemini MainContent](../../../../../gemini-cli/packages/cli/src/ui/components/MainContent.tsx:308) | Static 历史与 pending 区 | 参考责任划分；必须额外验证 ohbaby 已提交消息修正和旧页前插 |
| [CCB Tasks](../../../../../claude-code/src/components/TaskListV2.tsx) | 计数、状态符号、续行对齐 | 留给后续 C；不引入负责人、任务依赖或完整管理系统 |

## 3.3 不移植的内容

不采用 OpenCode 常驻侧栏、Pi 长启动资源清单、参考图中的逐段 Thought。只借用已确认的视觉特征，不增加 Web CSS 层、不建立自有 React→pi renderer、不深度 fork pi、不引入 pi 的业务包。

pi-tui 的 `Component/render(width)/handleInput` 不是 Ink React 组件协议。纯函数与 Editor 的接入成本不同；公开 API 和版本要在实际引入时验证。本轮不以安装 SDK 为交付目标。

[Ghostty ED](https://ghostty.org/docs/vt/csi/ed) 说明 CSI 3 J 清除回滚区；[配置参考](https://ghostty.org/docs/config/reference#scroll-to-bottom)的默认滚动设置不能替代用户实际配置。不得把修改用户设置作为应用修复。

## 3.4 模型审阅的权重

Opus 5.5 的最终意见来自缩小后的文字重试，依据主代理转述，不是独立看图或源码复验。采纳“视觉高度与清屏回归一起验收”的提醒；不采纳停止所有后台刷新、固定 Thinking、默认增加留白等未确认做法。原文已在对话交付，取舍见 plan/02 §10。

本轮执行优先级：用户最终确认 → 02 的行为约束 → 可核对的参考证据 → 模型建议。实现者不能用参考项目的默认值覆盖两行底栏、原生回滚和隐藏 reasoning 的要求。
