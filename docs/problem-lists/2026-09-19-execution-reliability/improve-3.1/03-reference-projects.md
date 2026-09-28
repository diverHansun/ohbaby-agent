# 参考设计与可借鉴范围

调查日期：2026-09-28。本页区分截图观察、源码事实与本项目选择；参考项目的实现不是本项目的既有能力。

## 用户截图

图 1 展示当前顶部 Subagents 区域；图 2 提供轻量任务行；图 3 提供带标题、放大和关闭按钮的子会话浮层；图 4 提供主/子面包屑及放大阅读；最后一张截图说明不能向子代理发送消息。

采用用户明确要求的阅读结构，不复制截图中的源码文字，不把截图里的工具指令视为本轮要求。父 prompt 改用本项目蓝色气泡、随正文滚动，不采用固定在顶部的大 prompt 块。截图来自用户作为 Cursor 参考提供，本次不依赖对其来源产品的识别来证明技术能力。

## OpenCode

本地根目录 `/Users/hansun025/Projects/code-cli/opencode`，调查 commit `16c56fe5ecc3305028d1f0a9cff5806e51c9d480`。

| 观察范围 | 源码事实 | 本轮采用 / 边界 |
| --- | --- | --- |
| `packages/session-ui/src/components/message-part.tsx` | task 工具以简洁条目关联子 session | 采用轻量入口和共享消息组件；不抄 fallback taskSession 猜测关联 |
| `packages/app/src/pages/session/timeline/message-timeline.tsx` | 通过 parent 关系呈现子任务上下文 | 本轮用明确关系构建面包屑，不靠标题推导关系 |
| `packages/opencode/src/tool/task.ts` | task_id 可复用已有子 session，后续 prompt 使用新 message ID | 借鉴连续子历史；本项目还需处理共享物理 session 的 scope |
| `packages/app/src/context/server-sdk.tsx`、`server-session.ts` 及测试 | 合并 text/reasoning/tool 事件，处理初始加载与 live 更新交错 | 借鉴增量与快照保护原则；沿用 ohbaby 既有版本协议，不整套移植 store |
| `packages/app/src/pages/session/composer/session-composer-region.tsx`、英语 i18n | 子会话使用只读提示并可返回主会话 | 与本轮根操作边界一致；浮层下输入框外壳的具体方案按用户要求设计 |

以上不意味着 OpenCode 实现了截图里相同的浮层尺寸、动画或 CSS。

## Kimi Code

本地根目录 `/Users/hansun025/Projects/code-cli/kimi-code`，调查 commit `be7d5f5fea7800778e4660cd5f36780ba783bddd`。

`packages/agent-core-v2/src/agent/tools/agent/` 的 resume/target 路径复用子代理；`session/subagent/runAgentTurn.ts` 将新 prompt 提交为该代理的新一轮；`packages/transcript/src/store/transcriptStore.ts` 按 agent ID 与 parentAgentId 管理 transcript。可借鉴“稳定子身份 + 多轮消息”的建模。

`apps/vscode/webview-ui/src/components/ToolRenderers.tsx` 是 VS Code 的任务过程展示。本地说明提到浏览器 UI 源码已迁往独立 code-app，不能用本地这个组件证明浏览器浮层或其 CSS。故 Kimi 的参考仅用于连续会话和来源语义，不作为浮层样式证据。

## Pi 设计咨询取舍

使用 `opencode/claude-opus-5-5`，thinking medium。采纳贴合现有 800px 阅读列、10px 输入框间隙、轻阴影、短位移动画、非模态浮层、保持主/子消息树及按消息锚点恢复阅读等建议。

历史定位改为服务端有界 anchor window，避免“不断向前加载直到找到”。Queued/正式消息使用持久 `childUserMessageId`，并明确委派排序，不只依赖组件 key。像素值为本轮建议默认值；最终以实际窄屏、放大和流式验证为准。
