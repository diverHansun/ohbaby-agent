# improve-2 前端：数据、API 与状态

> 2026-10-03 接续修订：Ctrl+R 手动恢复由 [improve-3 前端 06](../../improve-3/frontend/06-data-api-and-state.md) 的自动接续替代。现有 pending 身份与草稿隔离保持，不新增自动重新提交。

## 1. 事实来源与消费

字段以 `packages/ohbaby-sdk/src/snapshot.ts`、`client.ts`、`permission.ts` 和现有实现为准；不复制完整 DTO、不假设新增后端能力。

| 来源/动作                                                                      | 消费与后续                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| editor reducer / sessionDrafts                                                 | UC-INPUT-01、UC-DRAFT-01；本地完整文本与光标                                    |
| getCurrentModel / submitPromptAccepted，经 recovery.submit                     | UC-INPUT-01；准备阶段核对能力，接管后由 pending/receipt 跟踪                    |
| acquire/renew/releasePromptEditLease、editQueuedPrompt、resubmitRetainedPrompt | UC-QUEUE-01；保留 leaseId、promptId、operationId 与首次文本                     |
| permission-sync / respondPermission                                            | UC-PERMISSION-01；真实请求与 epoch/root/binding context；成功由权威同步撤下请求 |
| session todos ＋ 当前绑定 run/control 快照                                     | UC-TASKS-01；计数/样式/自动显隐派生；停止回看读取原数据，不生成完成状态         |

## 2. 显示转换

EditorState → 字素边界＋显示行/列＋可见窗口；显示行不是持久化字段。审批 DTO → 来源、标题、description、可用范围说明、choice labels；内置已知 choices 才能补真实范围解释，未知 choice 不推断。Tasks DTO → completed/total 与紧凑子集。

不强制建立额外 ViewModel 类；一个小纯函数能清楚完成的投影不铺新分层。

## 3. 生命周期与身份

草稿与编辑前快照按会话/新会话代次保存。草稿不自动写磁盘；新会话首次得到 receipt 后按既有流程绑定真实 session，快速后续输入使用同一接收序列。

发送前先捕获不可变文本与来源代次，再清当前编辑区，允许下一份输入；复用现有首发串行序列。准备结束校验来源，切换后取消未接管动作，快照保留在原会话进程内记录和输入历史；不建持久 pending 文本库。普通 pending 只保存 ID/session/epoch，未知结果只查原回执，不能重新 submit。明确拒收（含 QUEUE_FULL）和接管前拒绝保留可恢复文本，通过既有历史键显式取回；不覆盖新草稿。旧会话结果更新原事实，不能通过 current ref 修改新会话输入。

队列 acquire/renew/save/release 全部随来源代次和 lease 身份检查；过期 lease 不因切回会话变有效。retained 结果未知时冻结首次文本、复用 operationId；用户 Esc 返回普通草稿不等于撤销后端可能已成功的重发。取消编辑恢复的是整个编辑前 EditorState，不仅是 text。

审批以完整响应 context 为边界；无 ready/context 不回应。发送中禁重复，不乐观批准；成功等现有事件/同步收敛，失败保留当前请求，PERMISSION_NOT_PENDING 调用已有 resync。若断开导致成功响应后事件缺失，复用现有同步重连机制核实，不凭 UI 计时器自判成功或重复发送。

Tasks 的自动展示使用同 session/run/epoch 的可信运行事实和后端 visible；手动回看可读取同 session 原始 todos，即使 visible=false，但不得跨工作范围找旧副本。普通后端 run 已有停止隐藏，active Goal 可保留 visible，本轮仅加 TUI 显示策略，不写回后端。局部偏好按 session/run 关联，新 run 重设默认展开；Todo 更新和审批往返不清偏好；退出不持久化这些 UI 偏好。

本轮输入/审批不新增轮询。若 improve-3 自动恢复已落地，故障或待确认请求按其限定调度接续，健康状态不额外轮询；不因本轮旧约束删回自动路径。页面/会话切换取消或忽略不再有效的 UI 更新；订阅、计时器和租约清理继承已有协议，不因界面隐藏就停掉真实审批或任务终态更新。

## 4. 错误映射

| 错误/状态来源                     | UI 表现与恢复                                                           | 04 对应状态          |
| --------------------------------- | ----------------------------------------------------------------------- | -------------------- |
| recovery.canSubmit=false          | 原文可编辑，说明同步；接续 improve-3 后自动恢复，不提示 Ctrl+R          | Prompt 同步中        |
| 准备被上下文切换取消              | 原提交快照/历史保留，不发送到新会话；回原上下文可取回再提交             | 发送前准备/未发送    |
| QUEUE_FULL 等明确拒收或接管前拒绝 | pending 按现协议清理/不创建；原进程快照可通过输入历史取回，不覆盖新输入 | 明确拒收             |
| 已提交但回执不明                  | 保留原 pending/requestId，只查询回执，不重新 submit，不覆盖新输入       | 回执未知             |
| lease 到期/获取失败/保存失败      | 保留原文，按是否有效允许保存；没有有效 lease 不发 edit                  | Queue 失效/失败      |
| retained 网络错误                 | 显示 outcome unknown，原文本与 operationId 重试                         | Retained 重发未知    |
| PERMISSION_NOT_PENDING            | 撤去可操作假象并 resync，不表示已允许                                   | Permission 失败/失效 |
| 其他 respondPermission 错误       | 原请求显示原因，身份仍有效时显式重试                                    | Permission 失败      |
| choices/context 缺失              | 同步或不可操作说明，不生成兜底 allow                                    | Permission 不可操作  |

仅使用源码已确认的错误码，包括 PERMISSION_NOT_PENDING 和 QUEUE_FULL；其他错误按现有 SDK 结果/formatError 映射，不在文档里发明协议 code。

## 5. 可控场景与复用

测试 fixture 至少覆盖：unicode-draft、long-draft、session-switch-during-prepare、queue-lease-expired、retained-receipt-lost、permission-long、permission-no-deny、permission-expired、tasks-many。名称是场景标识，不是新增产品命令。

位置：纯局部 fixture 在对应测试附近；跨模块场景放 `tests/integration/cli/` 的具体 helper。延迟用可手动 resolve/reject 的 promise、租约用 fake clock、断开用现有 client/transport fake；主流程尽可能用真实 App/recovery/store。供真实终端验收时，最小专用 fixture 入口复用同一场景数据，可选场景、延迟和断开，不连接真实模型或执行真实命令。该入口是实施交付的一部分，不要求搭通用 UI 开发平台。
