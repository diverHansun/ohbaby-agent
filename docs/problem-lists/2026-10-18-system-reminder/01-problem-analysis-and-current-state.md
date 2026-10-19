# 问题分析与现状

> 基线 `e527285e`。路径相对 `packages/ohbaby-agent/src`；行号以该基线为准。本页区分当前代码与目标方案。

## 1. 现有状态提示

| 机制 | 当前落点 | 问题 |
| --- | --- | --- |
| environment 与 MCP 菜单 | assembler.ts:230-246 生成，context-manager.ts:524-553 挂到发起 user 消息 | 依赖 initiatingUserMessageId；恢复 run 没有发起消息时不挂载。长 run 变化及压缩丢失不会补发 |
| Goal 续跑 | goals/injection.ts:57-76，user 正文与 displayText | 已有自己的准入与去重；本轮只归类，不重做 |
| step-limit | lifecycle.ts:197-206、592，system tailDirective | Anthropic 和 Responses 都会提升 system，收尾改变请求前部 |
| mode | composition.ts:618-620 选择 plan／agent 系统提示词 | 下一个 run 切模式会改变 system；同一 run 的固定快照也不能表达中途切换 |

Todo 只有工具读写结果，没有运行中提醒。skill 正文来自工具调用或用户 slash 展开，压缩后不保证仍可见；用户已选择只提示已用名称，不自动恢复正文。

## 2. 说明文件与环境事实

说明文件的重复加载和子代理遗漏由 [姊妹议题](../2026-10-18-subagent-system-prompt/01-problem-analysis-and-current-state.md) 处理；不把说明文件注册为提醒服务。

`core/system-prompt/layers/environment.ts:25-29,51-65` 已提供 cwd、平台、本地日期、是否 Git 仓库和可选 OS 版本。日期为 YYYY-MM-DD，没有时分秒与时区字段；minimal 省略 OS 版本。Git 检测会向上查 `.git`，不应每个提供者重复检测。

## 3. 请求准备与消息顺序

lifecycle.ts:547-617 先取 protected inputs、解析工具、建立 run 提示词快照，再调用 prepareTurn。prepareTurn 内部读取历史、测量和压缩；成功后才进入 runModelStep，并在 :1398 创建 assistant。

因此不能说 prepareTurn 已经拥有 assistant 消息；要用 assistant 锚点，需提前分配 ID。`core/message/types.ts:166-168` 已允许 createMessage 指定 ID，可直接复用。

`context-manager.ts:1610-1648` 将 protected inputs 独立放在请求尾部，现有准入保存 inputIds。`runtime/prompt-scheduler/current-run-inputs.ts:413-421` 会调整排队 steer 的接收时间，时间排序不能代替本次请求成员关系。新提醒只需锚点排序，不能删掉原有输入准入。

## 4. 失败、压缩与计数

- `core/context/failed-history.ts:24-46` 对长度截断、内容过滤、流中断等失败可能保留可见文本；其他失败可能没有投影。不能写成“所有失败消息都不在历史”。
- stale-input 与溢出重准备可能创建失败 assistant 占位；没有可见投影的占位会被过滤。Todo 可直接数模型有效历史中的普通 assistant 消息，每个原始消息 ID 一次，不需要另建逻辑 step 记录。
- `core/context/context-manager.ts:219-228` 的 getActiveHistory 会去掉无活动 part 的消息，但尚未完成 failed-history 投影；提醒可见性和 Todo 计数都需要模型真正可见的历史。
- `core/context/compaction-policy.ts:104-117` 遇 assistant 或真实 user 开新组，其他消息跟随前组；单有 synthetic 标记也不保证 getMessageOrigin 会将新提醒识别为非 user。当前分组不认识 anchor，目标须显式将带 anchor 的提醒归入后面的 owner assistant 组，并让切点使用同一有序历史。
- 已提交摘要 metadata 有 compactionId（context-manager.ts:1013）；可用于手动压缩与重启后的 skill-usage，不必另建事件系统。

## 5. 协议转换

serializer.ts:230-239 当前把 text part 拼成字符串，会丢掉内容块边界与来源。目标应保留提醒的结构化来源，不能靠用户可伪造的标签识别。

`services/interface-providers/anthropic.ts:199-209` 的 flushToolResults 聚合连续 tool 消息。它不会无故拆分一批连续结果；但若在中间插入 user／system，仍会提前 flush，所以提醒应放在整批结果之后。

Anthropic 的 :221-238 将 system／developer 提到顶部，:240-246 将 user 转为单独回合。当前代码没有相邻 user 文本的统一合并步骤；目标在转换时追加并列 text block，避免部分兼容后端的角色交替限制。不能概括成所有 Anthropic 接口都拒绝相邻 user。

Responses 在 openai-responses.ts:50-60,158-160 将 system 并入 instructions；兼容 Chat 原位透传。尾部提醒因此统一选 user。现有 Anthropic 摘要 messageBoundary 先切段再转换（:383-411），只需在段内合并，不必新建边界映射。

## 6. 模式与技能边界

permission/state.ts 提供 auto／plan；evaluator 读取 level，不按 mode 阻断写入。名为 plan 的 agent 工具配置与权限模式不是一回事。用户允许 plan 阶段写文档，本轮只调整提示语义。`permission/state.ts:33,46-48` 中 mode 有默认值，getMode 同步返回内存状态，不需要为提醒设计“模式不可得”分支。

skill 工具描述包含名称与 description；正文由 skill(name) 按需读取，参考资料走 skill_resource。默认描述预算约 8K 字符，不等于整个目录含包装的绝对硬上限。当前没有内置 find-skills；findSkillFiles 是本地扫描函数。

用户 slash 技能正文直接展开成输入；namingSource 已落 prompt submission，但不是正文 part 的技能使用标记。需要补这项关联，才能在排队、恢复和压缩后准确判断正文是否仍可见。目录热加载、全文恢复与外部技能状态表都不在本轮范围。
