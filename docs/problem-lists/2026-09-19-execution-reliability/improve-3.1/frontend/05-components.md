# 组件契约与复用

下表是职责划分，不是新文件清单。

| 组件职责 | 输入 | 输出/边界 |
| --- | --- | --- |
| DelegationRow | 已关联 execution、简短任务说明、该次状态与耗时 | 发出 open(executionId)；不请求任意 child session，不显示完整过程 |
| ChildConversationViewport | 选中查看器、sheet/expanded、读取状态 | 唯一浮层容器；Expand/Collapse/Close/Return；不负责调度 |
| Child header / breadcrumb | 根/子标题、真实状态、审批提示 | 焦点入口与导航；无权限批准/Stop |
| ConversationStream / MessageRow | 相同消息表示、child 显示行、运行/思考状态、阅读策略 | 共用 Markdown、思考与工具；child 调整布局和阅读 key，不复制一套 renderer |
| Parent message | 稳定 ID、prompt、From parent、Queued/终态 | 蓝色消息；标签只体现来源，不变成可编辑用户输入 |
| Tool card | 原 input/output/status，稳定展开 key | 沿用主样式；child 可由外部保存展开状态 |
| Composer readonly shell | 是否查看 child、返回动作 | 保留主草稿状态、屏蔽交互；不会将草稿转发 child |

主会话新能力应通过明确的可选行为参数接入，例如阅读身份、禁贴底的显式定位、受控工具展开。不把 execution ledger、server cursor 或权限推断写进纯 Markdown 组件。

只有可靠 `Stored result` 且过程缺失时才显示结果降级块。已有最终 assistant 不重复附加同一工具输出；传递 metadata、delivery、artifactPath 等内部字段不进入日常正文。
