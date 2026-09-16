# improve-6：Context 自有消息结构与计量适配

开启日期：2026-09-15。状态：**实施、分批验证与独立审查完成；仅本地提交，未合并、未推送**。

承接 `openai-responses-migration@5a76738a8f93a2685cf1e4406f16b0917bb09ed2` 上 improve-1～5.5 的实现。本轮由用户开启，处理前序延后的 context 迁移问题。

目标：让 Context 直接使用项目自有的消息／工具结构，安全删除旧 Chat 估算中间格式，并验证 Chat Completions、Responses、Anthropic 三种协议的内容传递。保留压缩／prune 算法，仅修复影响统计或上下文语义的具体缺口。

## 阅读入口

| 文档                                                        | 内容                                          |
| ----------------------------------------------------------- | --------------------------------------------- |
| [00 讨论记录](./00-discussion.md)                           | 用户确认、范围与待审核建议                    |
| [01 历史与现状](./01-problem-analysis-and-current-state.md) | context 逐轮设计沿革、迁移接续、源码问题      |
| [02 实施方案](./02-optimization-plan-and-change-scope.md)   | 自有结构、计量与压缩数据流、文件级范围        |
| [03 参考项目](./03-reference-projects.md)                   | 七个本地项目的调查与本轮取舍                  |
| [04 测试与验收](./04-test-and-acceptance.md)                | 自有消息可靠性、旧格式删除门、最小修复回归    |
| [05 实施验收](./05-implementation-acceptance.md)            | 批次提交、本地与三协议真实 API 验收、失败记录 |

## 方案摘要

1. 完善现有 `ModelMessage`／`ModelToolCall`／`ModelState`，通用内容与有类型约束的协议特殊数据各有位置。
2. 推荐直接从自有请求结构选择计量材料，删除 `legacy-estimation.ts`；用生产 provider 请求捕获验证转换可靠性。使用单一计量器，不新增三套协议计量器。
3. 保留现行预算、EMA 校准、占用快照、七类 UI、mask／prune／增量摘要策略。
4. 最小修复：原生消息中的子代理工具往返分类、原生状态参与分类来源核对、拒绝把截断摘要当作成功摘要、补齐摘要输入中的工具动作。
5. 旧摘要确实累积；overflow 缩小摘要输入后仍按原选段退休，属于既有有损恢复。本轮明确并测试这些边界。

“旧 Chat 退出”指内部旧格式退出，Chat Completions 适配器继续提供协议支持。历史 [`docs/core/context/improve-6`](../../../core/context/improve-6/README.md) 是七类占用 UI 轮次，与本轮不同。

用户于 2026-09-15～16 授权按本轮方案实施，并校准自动压缩使用完整模型窗口的 95%；最新要求见 00 末节。实施结果与失败记录见 [05 实施验收](./05-implementation-acceptance.md)。

再次独立复验与测试断言补强见 [06 独立复验](./06-reacceptance.md)。
