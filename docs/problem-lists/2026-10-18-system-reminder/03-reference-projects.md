# 参考项目

> 2026-10-19 对用户提供的六份本地源码复核。下表固定本次代码快照；结论不代表所有版本或实际线上表现。claude-code 是非正式重构源码，部分路径含 stub，源码注释中的实验数据不能当作本轮实测结果。

## 1. 代码快照

仓库根均为 `/Users/hansun025/Projects/code-cli/`。

| 项目 | commit |
| --- | --- |
| claude-code | 77a7934e15d69da13879112ed7db695c9ee7a52a |
| codex | 12cca49c81c8aa6a37a5cc4e39964ee3b70f9458 |
| deepseek-harness | d743267388641bc76f17c45ce8b4c231aed1d32c |
| kimi-code | cbd754049a114ee36d1b27675c82819e4963c692 |
| opencode | 15b24ae12ddb8b7ae3e923b286b4032761bee510 |
| pi | 7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6 |

## 2. 实际机制与注入位置

| 项目 | 实际做法 | 对 ohbaby 的意义 |
| --- | --- | --- |
| claude-code | 类型化 attachment 在消息规范化时转为 user 内容；包裹和合并受 feature gate 影响。hook additional context 只是其中一个来源，Stop hook 的控制结果也不等于普通提示文本 | 借鉴状态生产与呈现分离，不能把 system-reminder 等同 hooks，或声称所有分支一律同形 |
| codex | WorldState 用分节的类型化快照比较状态，包含 Absent/Unknown/Known；片段自行声明 user 或 developer，模式使用 developer 片段 | 借鉴显式状态差异与重建基线；不能概括成全部仅比较哈希 |
| deepseek-harness | 每步投影 runtime context；比较当前可见历史，变化或缺失时生成 user 快照。另有 system 分节投影路径 | 借鉴按当前有效历史补发；runtime context 并非统一 XML 标签 |
| kimi-code | AgentReminderService 接受多种返回值：字符串包 user reminder，数组和原始消息另有路径；部分动态工具提供者会返回 system | 借鉴统一服务与作用域；不能概括成一律 user + XML |
| opencode | plan 插件逐请求核对实际模式和可见历史，缺失或过时就追加 synthetic user 提醒；动态 instructions 是另一套 epoch/协议投影路径 | mode 提醒与原生 system 更新不能混为一谈 |
| pi | 核心提供 custom message、before_agent_start、context 等扩展接口；示例 plan-mode 扩展注入隐藏提醒，没有统一 reminder service | 可借鉴扩展时机，不能说 Pi 没有提醒；自定义消息与纯扩展状态条目也要区分 |

源码入口（路径相对各仓库）：

- Claude：`src/utils/messages.ts:2591`、`:2656`、`:2950`，`src/utils/attachments.ts`；`src/services/analytics/growthbook.ts:443` 是合并开关的默认值。
- Codex：`codex-rs/core/src/context/world_state/collaboration_mode.rs:95-145`、`persistent_mode.rs:14`；`codex-rs/core/src/session/world_state.rs:242`、`session/mod.rs:3719`。
- DeepSeek：`packages/core/agent-loop/src/runtime-context.ts:114`，`agent.ts:267`、`:426-440`。
- Kimi：`packages/agent-core-v2/src/features/reminder/reminderService.ts:97-161`、`:173`。
- OpenCode：`packages/core/src/plugin/plan.ts:55-72`、`instructions/index.ts:142-158`。
- Pi：`packages/coding-agent/src/core/extensions/runner.ts:1443-1472`，`examples/extensions/plan-mode/index.ts:176`。

## 3. 必要状态与失败处理

六个项目没有一套共同的“所有提醒必达”框架。应分别观察运行时控制、状态来源和提示文本。

- Claude 的 attachment 收集包含约 1 秒的 AbortSignal，并有捕获后返回空的分支（attachments.ts:793、:1059-1094）。这是协作取消，不等于所有提供者硬超时或关键提醒绝不丢失。
- Kimi 的提供者异常会跳过该结果（reminderService.ts:97-110）；Pi 扩展错误也有记录后继续路径。不能据此推导所有业务状态都适合忽略。
- Codex 的 WorldState 在模型请求之前构建、记录，失败有向上传播路径；不是统一吞错继续。
- OpenCode 的 instructions 在首次没有基线且来源 unavailable 时阻止初始化；已有基线时保留旧值（instructions/index.ts:142-158）。这属于它的指令初始化选择，不是 ohbaby 可选文件的要求。
- OpenCode 最后一步保留工具定义但设置 toolChoice none，并追加 MAX_STEPS_PROMPT（llm.ts:223-241）；执行门另有处理（runner/step.ts:95-97）。提示文字不是唯一控制。
- DeepSeek 的 required 标志主要用于避免抑制某些分节（system-prompt/src/index.ts:578），不能据此声称 token 预算绝对保证。

**ohbaby 的选择**：mode 与 step-limit 使用本步已知状态，保留最短行为说明；其余提醒按各自规则省略或简化。指令文件仍可选，不照搬 OpenCode 的初始化阻断，也不新增日志警告。

## 4. 压缩与技能

Claude 的 `src/services/compact/compact.ts:1546-1586` 从当前 agent 的已调用技能记录恢复正文，最近优先，单个约 5K、合计约 25K；单条先截断，合计超限再跳过。专用 plan 恢复见同文件 :1594-1611。这里没有遍历恢复所有参考文件。

这是可参考的实现，不是 ohbaby 的最终选择。用户已确认：默认技能目录只展示名称和 description，正文按需读取；压缩后只给已用名称和重读入口，取消自动回填正文及上述预算。

Kimi 的压缩后处理会让提供者重新判断；这不等于原样重放全部旧提醒。Pi 的 session manager 保存压缩时的结构化 system checkpoint（session-manager.ts:1260-1285），它也不是 ohbaby 所需的技能正文恢复机制。

DeepSeek 的技能目录更新（`packages/skill/tool-skill/src/index.ts:215-251`）替换的是尚未提交的 decision.messages 候选。旧稿把它写成“改写已发送历史”不准确。Pi plan-mode 示例的 context 过滤影响下一次模型请求，不是删除持久历史；虽然会改变请求材料，也不能描述成删除数据库消息。

## 5. 工具结果与缓存

Claude 的 `smooshSystemReminderSiblings`（messages.ts:2141）把提醒放入最后一个 tool_result，真实用户文字保持兄弟节点。messages.ts:2938-2943 的注释记录过特定模型实验的 92% → 0% 结果；本轮只确认源码有该说明，没有复现实验，也不把结果推广到所有兼容后端。

本轮不采用 Claude 的 tool_result 嵌入优化。OpenCode 的 `packages/ai/src/protocols/anthropic-messages.ts:857-868,894-897` 在 fallback 路径将状态更新包成独立 text block，追加到 user 回合；`:830-839` 检查未完成工具批次。ohbaby 采用同级 text block 的方式，不改工具正文；按现有摘要边界分段内合并，保持 [工具输出稳定与摘要同源契约](../2026-10-10-compact-cache-and-tool-output/06-overall-acceptance.md)。OpenCode 另有模型专属 native update 路径，本轮不引入。

## 6. 消息持久化带来的简化

- Claude 在 `src/query.ts:1894` 附近收集 attachment，进入循环消息材料，再由 messages.ts 规范化。
- Kimi 的 reminderService.ts:115-161 将提供者结果追加到 ContextMemory，带 `origin.kind = injection`；后续从历史找已有 injection。
- Codex 的 session/mod.rs:4735-4800 构建状态差异，有模型可见内容时 record_conversation_items，再保存 WorldState。
- OpenCode 的 plan.ts:55-72 同时补当前请求并保存 synthetic 消息；保存失败有自己的降级路径，不是与 ohbaby 完全相同的提交保证。

共同可借鉴的是“让消息历史承载内容，再确定性转换”，而非复制 ohbaby 旧方案里的工具发送证明与提醒专用绑定。各项目的原生状态、持久化时机和失败语义并不完全相同；不能据此断言一个 anchor 自动解决所有恢复问题。ohbaby 只补自身现有输入准入所需的顺序锚点。

## 7. 本轮不采用的扩展

- 不增加通用 hooks 运行平台、技能全文自动恢复或新搜索工具。
- 不增加每提供者 50 ms 超时、通用预算降级、工具结果发送证明或额外缓存边界映射。
- 不为了动态模式反复改系统提示词，也不照搬长 plan 说明的周期轮换。
- 不增加按秒触发的提醒。Codex 时间提醒并非所有配置下一律默认关闭，persistent mode 也会影响默认启用；ohbaby 没有因此新增定时器的需求。
- 不把任何项目的原生 system/developer 支持直接推成三协议通用保证。

参考项目提供实现证据；ohbaby 的产品行为以用户确认的 00 和 02 为准。
