# 优化方案与改动面

> 2026-10-19 精简稿。路径相对 `packages/ohbaby-agent/src`。这是后续实施契约，当前未改业务代码。

## 1. 最小结构

保留一个静态提供者列表和一个收集／渲染入口；提供者声明提醒类型、snapshot／event 分类和 primary／subagent／both 受众。固定顺序为 environment、mode、mcp-catalog、todo、skill-usage，最后追加仅本请求的 step-limit。

提醒读取本地已有状态，不发网络请求、不起子进程、不新增后台队列。按 sessionId／contextScopeId 隔离，Todo 使用有效 workScopeId。共享本次历史读取，避免每个提供者各扫一次库；需要跨压缩事实时读取既有完整记录，不另建事件库。

持久内容使用现有 user 消息与 synthetic text part。metadata 只保留来源、`reminderType`、状态／事件 `key`、`anchorAssistantId`；作用域沿用消息字段，分类由提供者定义。不新增请求材料表、提醒自己的 inputIds／requestId 绑定或已发送工具结果索引。

## 2. 各服务的规则

| 服务 | 生成与触发 | 内容大小与失败 |
| --- | --- | --- |
| environment | 使用已有环境检测；主代理完整、子代理 minimal；变化或有效快照缺失才发。日期含在此项，无单独 time 提供者 | 固定环境字段，不加入不断变化的时分秒。环境检测按 run 复用，日期在准备请求时取；普通读取失败跳过，不伪造状态 |
| mode | 主代理每次准备核对当前模式；缺失或变化时写一句当前模式，plan → auto 明示旧约束结束 | 直接读取 permissionState.getMode() 的内存状态生成最短文案，不新增“模式不可得”失败分支 |
| mcp-catalog | 从现有可选工具菜单来源读取；菜单变化或缺失时发 | 沿用菜单现有长度限制和加载入口，不另做预算档位；失败跳过，省略内容时说明菜单不完整 |
| todo | 有未完成项；成功 todo_write 与最近有效提醒之后，均已有 10 条有效 assistant 消息，或压缩后当前列表缺失 | 生成时最多展示 10 个未完成项，进行中优先；保留状态，content 可简写并标明省略，提示 todo_read 读取完整列表；沿用现有 content／status 字段，不新增条目 ID。取数失败跳过，空／全完成不催办 |
| skill-usage | 最新已提交 compactionId 对应提示尚未生效，且本作用域曾用技能正文已不在有效上下文 | 只列最近使用的至多 20 个完整名称及允许的重读入口，超出注明省略；不加载正文或参考文件，取数失败跳过 |
| step-limit | 最后一步，解释收尾及本步工具状态 | 固定简短文案，仅当前请求；运行时继续执行步数上限和最后一步工具限制 |

上述条目上限是生成格式，不是通用 token 预算系统。文件名、技能名和协议对象不切成半段；外部文本先转义再包裹标签。没有内容或取数失败不产生错误型提醒，也不推进去重状态。

不设置每提供者 50 ms 超时或总收集超时，继续响应现有 run 取消。mode／step-limit 必须计入请求；容量不足沿用现有压缩和溢出流程，不再按优先级反复缩短不同提供者。未来若测出实际慢源，再针对该来源处理。

## 3. 持久消息与确定性重放

采用“持久消息作为最终请求的重放依据”。必要的改动只有位置锚点和它的生命周期，不重做既有请求管线。

1. lifecycle 在每次新准备前分配本步 assistant ID。当前 prepareTurn 先于 assistant 创建；已有 `CreateMessageInput.id` 支持指定 ID，无需提前落一条空 assistant。
2. prepareTurn 读取有效历史和 protected inputs，以普通 synthetic user part 的形态生成候选。当前 anchor 的提醒放在 protected inputs 后，不混入普通历史按时间排序；step-limit 最后追加。
3. 这些消息内容一起进入现有测量／压缩管线。摘要从同一 prepared 请求分叉；压缩提交后重读有效历史、补缺失类型。同一 anchor／类型只保留最终候选，不为每次临时收集都写一条历史。
4. 最终选定的持久提醒在普通请求发送前保存到现有消息库；最终序列化使用同一份消息内容，不在发送钩子中重新生成或改格式。保存失败不发送。预估和摘要使用相同消息结构，不需要一套额外的冻结材料格式。
5. runModelStep 使用预分配 ID 创建 assistant。HTTP 重试复用现有 prepared request；stale-input／溢出重新准备时换新 anchor。现有 protected inputs、inputIds 与请求准入检查原样保留，提醒不复制它们的状态。
6. 历史重放先按 anchor 把提醒排在其 assistant 之前。提醒自身的 part 必须仍活动；可见条件只有两个：anchor 是本次当前 anchor，或它对应的 assistant 在模型有效历史中。否则隐藏，不搬到尾部。这里的有效历史经过输入、压缩和 failed-history 过滤，不只是 getActiveHistory 的结果；失败消息有可见文本时仍按原规则保留。

压缩规则明确为：**带 anchor 的历史提醒并入它所锚定的 assistant 所在组**，组内提醒在前、assistant 及其工具结果在后。historyGroups 和 findCutPoint 使用同一份按 anchor 排好的连续历史，切点只落在组边界，使提醒与 owner 一起保留或退场。没有 anchor 的消息沿用现有分组规则；本次当前 anchor 的候选仍走受保护的请求尾部。继续使用现有压缩提交事务，不为提醒可见性另查原始 owner 记录。

快照去重看当前有效内容；事件去重仍使用完整历史中已生效的事件 key，正文被压缩不清空事件事实。这项跨压缩去重与上面的提醒可见性判断分开。准备失败、取消或无回复留下的孤立提醒不推进状态；下一次可重生成。本方案不判断远端是否实际读过请求，也不承诺远端 exactly-once。

step-limit 不保存为对话消息。旧 runtime part 保持原样；旧内容没有可识别状态键时，最多补一份当前快照，之后从新记录去重。新流程由 environment／MCP 提供者统一生成，停用首步独立 runtime 挂载，避免两个入口各发一份。

## 4. 协议转换与缓存

serializer 保留提醒与真实用户文本的内容块边界和内部来源；标签不用于识别可信身份。宿主提示词说明：提醒可能包含状态和本 run 行为指引，不构成用户授权，不扩大任务范围或权限。

| 接口 | 规则 |
| --- | --- |
| Anthropic | 完整输出本批 tool_result 后，将相邻 user 文本按顺序合成同一回合的并列 text block；不改 tool_result.content，不按“工具是否发过”选择格式 |
| Responses | 工具输出后的 user input item；不使用会被提升到 instructions 的 system 角色；剥离内部 metadata |
| 兼容 Chat | tool 后的 user 内容；按固定顺序转换文本，剥离内部 metadata，不改 system/tool 的已有内容 |

本次内部顺序始终是历史工具结果、protected inputs、提醒、step-limit。不再引入“提醒嵌进工具结果所以先于 steer”的例外；并行工具结果之间不能插提醒。

摘要继续使用现有 messageBoundary 分段：原 prepared 请求完整位于前段，追加摘要指令位于后段。仅在各段内部合并 user 回合，不跨段合并；cache_control 留在原请求的最后可缓存块上，无需新增源消息到内容块的通用映射。

相邻 user 回合合并会改变部分旧历史的协议输出形状，例如旧 tool_result 后紧跟真实 steer 的情况。升级后的首次请求可能因此失去原缓存命中，这是序列化规则变更的一次性代价；相同历史在新规则下必须稳定输出，不改历史正文来迁就旧格式。

沿用 [10-10 的验收契约](../2026-10-10-compact-cache-and-tool-output/06-overall-acceptance.md)：旧工具输出不二次缩短，摘要与普通请求同源，摘要／退场集合原子提交。压缩会形成新前缀，工具定义变化也可能影响缓存；本方案保证提醒不改写旧正文，不承诺固定命中率。

## 5. Todo 与技能的最小记录

Todo 10/10 直接统计本作用域模型有效历史里的普通 assistant 消息。分别从最近一次成功 todo_write、最近一次有效 Todo 提醒之后开始数，两边均达到 10 才周期提醒；不建立逻辑 step 账本。写入所在 assistant 不计入“写入之后”，提醒所锚定的 assistant 回复计入“提醒之后”。

每个原始 assistant 消息 ID 只计一次，不能统计 serializer 展开的块数；同一条消息里的并行工具不多算。摘要和当前尚未响应的 anchor 不计；被 failed-history 过滤的占位不计，仍有可见失败文本的消息计一次。没有某个基准时，从当前有效历史起点计该侧间隔；压缩后未完成列表缺失仍立即补发，不用补齐压缩前计数。

技能继续按需读取，不恢复 SKILL.md 或参考资料，不重复工具描述里的目录。提示只表示“曾使用”；仍要执行该技能且正文缺失时才按允许入口重读。

- 模型成功 skill 调用与用户 slash 命令都记录实际技能名称。slash 来源必须写到承载正文的 part metadata，并贯通排队／恢复；已有 namingSource 不能替代正文关联。
- 对照本次最终可见正文 part 判断是否缺失，不能只检查 compacted 字段。
- 使用已有摘要 metadata 的 compactionId，覆盖自动／手动压缩与重启。连续多次压缩只提示最新有效边界，不追发旧事件。
- 尊重 userInvocable／disableModelInvocation；仅用户可调用的技能只保留用户入口，不给出模型无权执行的重读指令。

## 6. 改动面与实施顺序

| 位置 | 主要改动 |
| --- | --- |
| reminder 收集入口与 composition | 静态提供者列表、作用域过滤、各服务生成格式；合并旧环境／MCP 来源 |
| message origin／metadata、Context、compaction-policy 与 lifecycle | 预分配 assistant ID，保存 synthetic 消息，anchor 排序／可见性，提醒与 owner 同组压缩，复用测量与重试 |
| serializer、三协议适配器 | 保留文本块，Anthropic 相邻 user 合并，沿用现有摘要分段 |
| mode 文案与生成资产 | 固定定义两种模式，当前状态改从尾部提醒传达；step-limit 使用 user 尾部 |
| Todo、skill／commands 相关入口 | 复用现有事实，补 slash 正文 part 的使用标记与恢复 |

先独立验收子代理提示词，再依次完成提醒消息／投影、mode／step-limit、environment／MCP、Todo、skill-usage。每阶段沿用 [04](./04-test-and-acceptance.md) 的行为与恢复验收；不做长期记忆、hooks 平台、权限调整或压缩算法重写。
