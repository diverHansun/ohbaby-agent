# system-reminder 机制

> 2026-10-19 完成分批实施与验收，分支 `feat/system-reminder`，实施基线 `8a16f5e2`。当前规则见 00、02、04；历史评审见 [05](./05-review-records.md)，批次记录见 [06](./06-implementation-acceptance.md)，浏览器及三协议真实请求结果见 [07](./07-live-acceptance.md)。仅本地提交，未 merge、未 push。

system-reminder 把服务已有的状态补给模型。有内容才提醒，不承担日志告警、权限授予或长期记忆职责。

方案采用现有消息存储：持久提醒保存为 synthetic user 消息，再按确定规则序列化；只加一个 assistant 锚点解决重放顺序。Anthropic 使用与工具结果并列的 text block。各服务自己控制内容大小，容量处理沿用现有管线。

不新增请求冻结材料表、提醒专用准入协议、工具结果发送证明、通用预算降级框架或每提供者超时。

[子代理提示词与说明统一加载](../2026-10-18-subagent-system-prompt/) 已完成前置验收。项目／可选全局说明属于稳定系统提示词，不注册提醒器。

| 文档 | 内容 |
| --- | --- |
| [00](./00-discussion.md) | 当前决议与提醒分类 |
| [01](./01-problem-analysis-and-current-state.md) | 现状与源码依据 |
| [02](./02-optimization-plan-and-change-scope.md) | 精简后的方案与改动面 |
| [03](./03-reference-projects.md) | 六个参考项目与借鉴边界 |
| [04](./04-test-and-acceptance.md) | 验收契约与场景 |
| [05](./05-review-records.md) | 历史评审与本轮取舍 |
| [06](./06-implementation-acceptance.md) | 分批实施、测试和审查记录 |
| [07](./07-live-acceptance.md) | 全仓回归、浏览器、压缩与缓存真实验收 |
