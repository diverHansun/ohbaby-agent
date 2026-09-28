# 数据、API 与状态映射

本页描述拟增加的契约，**不是当前 API 已支持能力**。服务端规则以 [总方案 2/3](../02-optimization-plan-and-change-scope.md) 为准。

## 数据边界

| 前端需要 | 当前基础 | 本轮补充 |
| --- | --- | --- |
| 主历史调用对应 execution | ledger 已保存 requester run/scope + requestId | 在接受后即可读取显式 call 关联，不依赖终态结果 |
| 连续 child 历史 | 单 execution 的 childRun 历史 | 服务端解析 root+subagent 到 session/scope，跨 run 读取 |
| 精确委派位置 | execution 保存 prompt，缺 child user ID | 接受时预留 childUserMessageId；有界 anchor window 与双向 cursor |
| Queued 蓝色消息 | ledger 有已接受 prompt | 仅显示投影；正式消息创建后按相同 ID 替换 |
| 主会话同等流式 | 根 session snapshot/change 协议 | scope 独立 generation/revision，复用合并/恢复机制和共享传输 |
| 阅读状态 | 局部 scroll/工具 state | 每查看器保存锚点、offset、贴底意图与展开 map |

读取请求最少包含当前绑定身份、rootSessionId、execution/subagent 选择、可选 anchor/cursor/limit；客户端不接收任意 scope ID 来绕过服务端解析。页大小遵循现有上限，服务端拒绝跨身份 cursor。

## 合并顺序

订阅启动并缓冲变化 → 取得相应版本 snapshot → 安装权威内容 → 丢弃旧版本并应用后继变化。缺口或 generation 改变触发 resync；无法确认时不继续拼接。逻辑 scope 版本与物理 session ID 分离，不能伪造一个合成 sessionId 传入根 API。

父消息/委派的显示排序、Queued→正式替换参与同一版本边界。分页、anchor 和增量采用服务端持久 delegationSequence 所确定的同一总顺序，不能在客户端分页后重新分组排序。历史窗口只补它覆盖的范围；不能把较旧历史 part 覆盖 live part。旧历史与最新尾部不连续时保持 gap，向下滚动按需加载后续页，并提供跳至最新图标；不能为方便渲染假装历史已经齐全。

锚点阅读窗口与实时基线分开：同一快照版本提供有界目标窗口和 live tail，中间可保留 gap。append 到来前，目标 message/part 必须已通过完整基线或建立事件安装；活动 part 不得被普通缓存淘汰。reader 可以更新屏幕外的 live tail，而不移动用户的历史阅读位置。超预算受控重建实时基线，不循环重取旧锚点窗口。

## 请求生命周期与缓存

选中身份改变使用 generation/ticket 和 AbortSignal 双重隔离迟到响应。切 child 保存小型 UI 状态，再取消旧详细订阅；切 root/workspace 清理对应读取缓存。消息缓存有界并可淘汰，恢复时重读服务器；仅保留按需阅读状态，不缓存所有 child DOM 或全量历史。离开 root 后可释放该 root 的局部状态，不承诺跨刷新记住滚动位置。

数据错误至少区分未授权/绑定失效、目标不存在、定位不可用、历史缺失、网络/重连失败。错误码名称在现有 SDK 约定内确定，UI 按语义处理；未授权时不能保留可交互的旧 child 视图，也不能退回整个共享 session。
