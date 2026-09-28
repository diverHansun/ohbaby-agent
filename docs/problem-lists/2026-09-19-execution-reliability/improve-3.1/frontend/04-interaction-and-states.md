# 交互与状态

表中的 Expand/Collapse/Close/Return 是动作名称，不要求显示为按钮文字；Expand/Collapse/Close 使用图标，Return 语义由关闭或根面包屑承载，不新增返回按钮；tooltip / aria-label 按 03 统一。

## 显示模式

| 当前状态 | 动作 | 结果 |
| --- | --- | --- |
| Closed | 点击有效委派行 | Sheet；获取目标附近消息并定位 |
| Sheet | 点击另一个委派行 | 同一窗口切换身份/锚点，无叠窗，无开场动画 |
| Sheet | Expand | Expanded，保留数据和阅读锚点 |
| Expanded | Collapse 或 Escape | Sheet，保留阅读状态 |
| Sheet | Close 或 Escape | Closed，恢复根输入框、草稿和焦点 |
| Expanded | Close、面包屑根入口或 Return | Closed，直接回主会话 |
| 任意 child 模式 | root/workspace 改变 | 关闭并取消原读取，旧响应不可回写 |

Escape 只由当前最上层交互处理；存在其他模态时先交给它，IME composing 时忽略。不点击外部关闭，主历史露出的任务行仍可指针点击切换；键盘 Tab 在当前子浮层控件间循环，Escape/关闭可退出，避免进入被遮住的根控件。打开时聚焦标题（preventScroll），关闭回触发卡片；卡片已卸载则回根标题/安全入口，不盲目聚焦输入框并提交。

## 数据与执行状态

| 状态 | 内容表现 | 可用动作 |
| --- | --- | --- |
| Loading / locating | 头部可用、正文骨架，保留返回路径 | Close / Return |
| Queued | 蓝色 From parent 消息，标注 Queued | 阅读；无发送/取消 |
| Starting | 同 ID 父气泡，等待正式消息创建 | 阅读 |
| Running | 文字/思考增量和工具状态及时出现 | 阅读、展开工具、跳至最新 |
| Approval blocked | 保留内容，提示 Approval required | Return；子窗口不渲染审批 |
| Completed | 最终 assistant 正文自然保留 | 阅读 |
| Failed / Cancelled / Interrupted / Timed out | 真实状态的小型文字提示，已有内容保留 | 阅读 / Return |
| Reconnecting / read failed | 保留已知内容并标明可能过期 | Retry / Return |
| History unavailable | 说明缺失；如有可靠存储结果显示 Stored result | 阅读 / Return |

`Starting` 是正式父消息尚未落地的显示过渡，不新增执行状态枚举。终态使用后端真实枚举映射；不得把 interrupted 一律写成 cancelled。未启动即取消时用 `Cancelled before start`；其他未启动终态也保留真实含义。

## 阅读行为

显式点委派行先定位父消息，不自动跳到最新。只有用户滚至尾部或点击 Jump to latest 后进入贴底；向上读自动退出贴底。新消息和工具展开造成高度变化时保持 message ID + offset 锚点；工具展开状态按稳定调用/part 身份保存。

浮层与放大切换保持当前锚点。切换 child 先存旧状态再读新数据；显式卡片锚点仍优先于旧保存位置。历史页插入时保持当前可见消息，缺口必须可见。完成或新委派不能抢当前阅读位置。

## 输入与权限

Sheet 时可见的主 composer 外壳保持原输入框高度和外形，仅显示 `Read-only subagent`，不增加图标按钮。草稿保留但不作为 child 输入显示；textarea/附件/模型/策略控件不可聚焦，发送、Enter、快捷键、Steer、Stop 的处理函数均受统一阅读模式限制。关闭图标仅关闭查看器，不执行任何审批或停止。

Expanded 时隐藏根 composer，底部仅显示 `Read-only`，通过关闭或根面包屑回到主会话。根 pending registry 正常更新；有审批通过 `Approval required` 轻提示告知，不另加重复返回控件。Sheet/Expanded 均不渲染根权限条及审批弹窗；关闭后恢复原审批入口。停止控制始终留在主会话。
