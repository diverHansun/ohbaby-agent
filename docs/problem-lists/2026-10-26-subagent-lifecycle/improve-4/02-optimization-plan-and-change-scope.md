# 2. 优化方案与改动面：主会话入口切换与旧浮层迁移

> 2026-10-29 按 D46 从 improve-1 拆出。讨论记录在 [improve-1/00](../improve-1/00-discussion.md)，现状见 [improve-1/01](../improve-1/01-problem-analysis-and-current-state.md) 的 P8。
> 前提：improve-3 已合并，右侧栏可用。

## 2.1 目标与范围

把主会话里的子代理入口切到右侧栏，然后删掉旧的子会话浮层和它带来的副作用。做完以后只剩一套详情入口。

## 2.2 主会话入口

- agent 工具调用卡完整保留，输入和输出都能看。
- 子代理**真正启动成功**后，在工具卡后面追加一条"xx 子代理启动"的快捷提示。点击后自动展开右侧栏，打开（或复用）Subagents Tab，并定位到这个实例，带上 `anchorExecutionId`。
- 入口根据结构化的实例和执行元数据生成，不解析自然语言。
- 什么时候显示入口：
  - spawn 成功、对空闲实例 send 启动了新执行：显示。
  - 对运行中实例的 send：只显示"消息已投递"的回执，不显示新启动。
  - 失败或满额（`started: false`）：不显示启动成功。
  - 前台执行：确认启动后就可以显示入口，结束后工具输出照常补齐。
- 实例被 close 后，这条快捷提示撤下，不能再打开 child 详情。派遣行通过执行元数据找到实例 ID，再查 improve-2 的完整实例快照：快照里没有这个实例，就说明它已关闭（快照包含当前会话全部未关闭的实例）。快照读取失败时保持原样，不当作已关闭。普通的工具调用记录保留，作为原会话的事实，不删数据库，也不改写历史消息。

## 2.3 删除旧交互

删除以下内容：

- 主会话里的子会话浮层，以及按输入框位置测量定位的逻辑。
- `childExpanded` 和旧的 Expand/Collapse。
- 打开子会话就禁用主输入框、隐藏审批面板的行为（[SessionScreen.tsx:265、334、421](/Users/hansun025/Projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/ui/session/SessionScreen.tsx:265)）。
- 只服务于旧浮层的 `subagent-layout` 几何组件和 CSS。

只删没有其他调用者的代码。审批布局、CLI 还在用的 reader、共用的样式都不能误删。旧浮层的专属测试随代码一起删除，不为了保住旧断言而保留没用的实现。

## 2.4 历史兼容

- 历史里的 `subagent_run` 记录照样显示。实例还没关闭的，点击能定位到新的右侧栏；已关闭的，入口不可用。
- CLI 的 execution reader 继续可用。

## 2.5 分批实施

本地分支 `subagent/improve-4-migration`，从合并了 improve-3 的 main 切出。

| 批次 | 内容 | 完成标准 |
| --- | --- | --- |
| D1 入口切换 | `SessionConversation.tsx`、`DelegationRow`、`useSessionInteractions` | 快捷提示和跳转可用。通过 I4-01、I4-02 |
| D2 删除旧浮层 | `SessionScreen.tsx`、`SubagentView`、`subagent-layout`、相关 CSS 和测试 | 旧行为消失，主输入和审批不受影响。通过 I4-02、I4-03 |
| D3 回归与文档 | 历史记录、CLI；同步 `docs/ui/`、`docs/ohbaby-web/redesign-2026-10/` | 通过 I4-04、I4-05 |

## 2.6 与讨论记录对齐

| 决策 | 落在哪 |
| --- | --- |
| D11、D39：保留工具输出，点击启动提示直达右侧详情 | 2.2 |
| D10、D24：关闭后入口撤下，历史记录保留 | 2.2、2.4 |
| D38、D46：替换旧浮层，最后只剩一套详情入口 | 2.3 |

## 2.7 风险

| 风险 | 怎么防 |
| --- | --- |
| 删浮层时误伤审批布局或 CLI | 把阅读内容和模态外壳分开；保留仍被使用的 reader、样式和协议 |
| 旧链接让已关闭的实例重新出现 | 入口根据实例状态生成，close 后撤下；详情接口本身也拒读（improve-2） |
