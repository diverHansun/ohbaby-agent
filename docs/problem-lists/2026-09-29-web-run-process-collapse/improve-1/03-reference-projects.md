# 参考项目调查与取舍

## 调查口径

2026-09-29 读取本地代码和已有测试，没有运行这些项目做界面验证。结论限于所列实现；测试描述与断言是代码证据，不代表本次执行测试通过。

| 项目 | 本地目录 | HEAD |
| --- | --- | --- |
| OpenCode | `/Users/hansun025/Projects/code-cli/opencode` | `16c56fe5ec` |
| ZCode | `/Users/hansun025/Projects/code-cli/ZCode` | `29628c9` |
| Kimi Code | `/Users/hansun025/Projects/code-cli/kimi-code` | `be7d5f5fe` |
| DeepSeek Harness | `/Users/hansun025/Projects/code-cli/deepseek-harness` | `477b4f4205` |

这些项目的 turn 与 ohbaby 的 run 并非同一协议，借鉴交互与归属方式，不照搬数据结构。

## OpenCode

[timeline/rows.ts](/Users/hansun025/Projects/code-cli/opencode/packages/app/src/pages/session/timeline/rows.ts) 的 `constructSessionMessageRows` 按 assistant.parentID 寻找用户消息，`constructMessageRows` 继续按部件分组输出。另一条 [session-turn.tsx](/Users/hansun025/Projects/code-cli/opencode/packages/session-ui/src/components/session-turn.tsx) 渲染路径同样按 parentID 关联 assistant 消息。

在检查的 Web 路径里，未发现与本议题相同的“终态后把全部过程放到一个耗时入口里”的统一折叠。存在工具组层面的收起，不能把局部收起当作整轮折叠。

采纳：使用明确身份关联。没有直接照搬的整轮折叠条件。不以“OpenCode 也如此”证明本方案。

## ZCode

[conversationTurnWorkSegments.ts](/Users/hansun025/Projects/code-cli/ZCode/packages/ui/src/v4/conversationTurnWorkSegments.ts) 的 `splitVisualWorkSegments` 在 guided 用户输入处切出新展示段；`buildConversationTurnWorkSegments` 分离最终正文与此前过程。

`assistantHistoryDefaultOpen` 明确包含“只有一个视觉段、没有 visibleAssistantTextRow、仍有过程内容”的保持展开条件。[ConversationTurnGroup.tsx](/Users/hansun025/Projects/code-cli/ZCode/packages/ui/src/v4/ConversationTurnGroup.tsx) 的历史状态按钮组合时长与 ChevronRightIcon。

采纳：没有最终正文时保持过程可见；文字与箭头共同作为入口。未采纳：按 steer 切多个视觉段、分别计算段时长。本轮用户已选择中途补充后正常展示。

## Kimi Code Web

该仓库 [AGENTS.md](/Users/hansun025/Projects/code-cli/kimi-code/AGENTS.md) 明确说明 Web 源码已迁至另一个 code-app 仓库。此处检查仓库附带的 [index-CiJ6FDOC.js](/Users/hansun025/Projects/code-cli/kimi-code/apps/kimi-code/dist-web/assets/index-CiJ6FDOC.js)；不是把 VS Code 插件行为代替 Web 结论。

构建产物保留 `TurnFold`、`ThinkingBlock` 组件名和 `kimi-web.turn-folding` 设置键：

- 有可选的整轮过程折叠，时间和 chevron 放在同一个按钮中。
- ThinkingBlock 观察 streaming 从真变假后收起。
- 分组函数 `S5t` 优先保留最后一个非空 text 及其后内容；没有文本时尝试某些工具或通知；均没有时返回全部 folded、visible 为空。
- TurnFold 观察 live 状态变化并重置展开，不应据此声称它完整采用了本方案的成功/失败/steer 豁免规则。

采纳：轻量的前端展示分组、时间与箭头合并命中。未采纳：没有最终正文仍可把所有内容自动收起。构建产物符号可能随构建改变，后续复查按组件名和设置键定位。

## DeepSeek Harness

[ChatNodeSeat.tsx](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx) 把 liveProcess、hasInterleavedInput 与 turnProcessAlwaysOpen 合并为外层保持展开条件。[turn-process.ts](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/client/ui-chat/src/client/contract/turn-process.ts) 明确保留运行中、aborted、error 的展开状态，user/steering/error 等节点独立于过程。

[chat-view.client.spec.tsx](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/client/ui-chat/tests/chat-view.client.spec.tsx) 有直接相关用例：

- `keeps a live Turn expanded and folds it once at turn/end`。
- `preserves steering-separated process groups ... after Turn completion`：中途补充后完成，过程组与用户输入原序可见，整轮按钮不可用。
- `withholds process controls without a loaded Turn boundary ...`：缺少轮次边界时不生成控制，不增加新的领域状态。

[过程边界计算](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts) 允许 answerAnchorSeq 为空；因此不能说它统一要求“没有最终回复就保持展开”。

采纳：整体完成后折叠、停止/失败保留、中途输入保持正常顺序。未采纳：完整的节点投影架构、展示模式与无答案时仍可折叠的策略。

## 对本方案的实际影响

“中途补充时不整轮折叠”有直接代码和测试参照，目的在于保持对话顺序容易理解，并非无法识别 run。

“没有最终正文时保留过程”是用户选择的体验规则，有 ZCode 的类似保护，但不是四个项目共同的技术标准。“无法确定归属”不设为状态，只是不把未关联消息纳入本轮控制。

此前对模型 `final_answer` 标记的讨论不再构成本方案依赖。等待已有整体完成事实，可以避免为了 UI 收起时机改模型协议。本轮验收无需读取 `.env` 或再次调用真实模型 API。
