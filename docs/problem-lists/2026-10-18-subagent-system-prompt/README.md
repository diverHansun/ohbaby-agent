# 子代理系统提示词

> 规划定稿于 2026-10-19，代码基线 `e527285e`。00–04 保留实施前契约；实现、测试证据与限制见 [实施验收](./05-implementation-acceptance.md)，真实浏览器、压缩与缓存抽测见 [在线验收](./06-live-acceptance.md)，历史方案评审见 [评审记录](./05-review-records.md)。

本批让主、子代理共用已有说明加载器，保留各自的角色提示词；同时移除重复的独立 memory 注入。

项目说明使用会话已有的 `projectRoot`，执行工具仍使用工作目录。可选全局说明保留，项目的具体约定优先，全局作为默认。有可用文件就读，没有就跳过，不新增警告。

先独立完成本议题，再实施 [system-reminder](../2026-10-18-system-reminder/)。本轮不做长期记忆、权限调整或子代理调度改造。

| 文档 | 内容 |
| --- | --- |
| [00](./00-discussion.md) | 当前决议 |
| [01](./01-problem-analysis-and-current-state.md) | 问题与源码依据 |
| [02](./02-optimization-plan-and-change-scope.md) | 精简后的方案与改动面 |
| [03](./03-reference-projects.md) | 六个参考项目 |
| [04](./04-test-and-acceptance.md) | 后续实施验收 |
| [评审记录](./05-review-records.md) | 历史评审与本轮取舍 |
| [实施验收](./05-implementation-acceptance.md) | 实际变更、测试证据、修复与验证限制 |
| [在线验收](./06-live-acceptance.md) | 编译 Web、真实子代理恢复、三协议压缩与实际缓存用量 |
