# 数据含义与不变量

## Core Concepts

| 概念 | 含义与归属 |
| --- | --- |
| 子执行事实 | execution store 中不可随通知改写的终态、输出和原因 |
| 结果来源 | `subagent-result:${executionId}`；同一 execution 的重复事件不产生新结果 |
| 运行时输入 | 某 run 接收的输入，沿用 sourceId、inputId、messageId；由 runtime input store 管理 |
| 自动启动机会 | 一个结果主动请求主运行的机会；不等于已消费结果 |
| 消费确认 | 成功持久化的模型请求明确包含该 inputId 后写入的 processedRequestId |

结果来源在跨 run 重投时不变，inputId 继续包含 run 身份，messageId 使用 `runtime:${inputId}`。用户消息继续使用现有全局唯一 ID 工厂。运行时来源不能因 UI 传入局部编号而改变身份；UI 投影必须与最终持久身份一致。

## Key Data Fields

保留现有 delivery 的 state、notificationId、inputId、processedRequestId 等字段。`delivered` 只表示输入已接收，`processed` 只表示成功请求包含它，不表示主代理已经完成任务或认可结果。

本轮建议只补以下必要信息，具体字段命名在实施时保持仓库风格：

| 信息 | 保存位置 | 用途 |
| --- | --- | --- |
| 最近自动启动的 runId | execution.delivery | 把 attempted 与实际主运行关联，核对入口失败、Stop、请求尝试和恢复 |
| 剩余入口恢复额度 | execution.delivery | 新结果初始为 3，每次重试前减 1，收到 Stop 置 0；不是实际尝试次数。重启、active/idle 和刷新不重置；退避仍由 supervisor 内存定时器管理 |
| goalId（string／null／缺失） | execution 接收记录 | string 表示所属 Goal，null 明确表示普通任务，缺失只表示旧记录未知；在派遣时写入，不在结束时推测 |

不再复制一套 pending、claimed、acked 消息表。运行状态和错误读取既有 run ledger，请求尝试读取既有 input 的 firstAttemptRequestId 和持久请求成员关系。只有从这些记录无法得出的最小信息才允许增加字段。

## Lifecycle and Ownership

终态的保存先于通知。完成、自然失败、超时，以及 reason 为受控常量 `process-interrupted`／`service-shutdown` 的 interrupted 进入 pending。后一项包含正常停服；停服时只保存，重启接管后再通知。手动停止、关闭、其他控制原因不新增自动通知。集中维护精确常量的判定，不解析任意错误文本，也不额外保存一份原因类别。迟到的成功回调不能覆盖已确立的终态，沿用 lateResult 规则。

同一终态的所有写入路径必须保留相同的控制原因。closeAdmission 先 abort、turn catch 先结束时，markInterrupted 也要从 lease.stopReason／受控 abort reason 保留 service-shutdown，不能固定写 cancelled，再指望 dispose 覆盖不可变终态。

接收时先校验 session、scope、父子身份与内容一致性，再记录 runtime input，并关联 execution.delivery。若接收已提交而关联失败，重试沿同一 inputId 查证、补关联，不插入另一条内容。其他打开的 run 已持有输入时等待其关闭，不并行抢走。

请求尝试与成功确认分开：在发出 provider 请求前持久记录输入成员；成功记录写入后确认 input，再确认 execution。恢复时若最后一步缺失，必须按精确 inputId 查到已成功的请求，补齐确认。需要分页核对该 run 的所有请求，不能只查 firstAttemptRequestId，后续重试可能使用不同 requestId；不得仅看最后一条 assistant 消息、时间相近或主 run 最终状态。后续步骤失败也不撤销已成功的确认。

若进程在 provider 调用与结果落盘之间退出，只能知道“尝试过、是否成功未知”，不能保证外部请求没有执行。保留结果并呈现中断，不自动重复同一结果的模型调用；新结果或用户输入可以携带它继续。

## 自动启动的判定表

| 当前事实 | 自动行为 |
| --- | --- |
| 从未认领、终态允许通知、会话准入通过 | 合并当前可用结果并启动 |
| 已接收、主 run 仍活跃 | 交给该 run 在后续安全输入边界处理；顺带接收不立即消耗自动机会 |
| 首个模型请求前发生入口失败，且没有 Stop／准入禁止 | 有限重试；最多额外 3 次，沿用 5／10／20 秒退避；不另建错误分类体系 |
| 已尝试模型但失败、用户停止该主 run | 不由同一结果再次独立唤醒；结果仍未消费，可被新事件带入 |
| 已成功请求，但确认写入未完成 | 补确认，不重新请求模型 |
| 归属或历史证据不足 | 保留并说明不能安全自动恢复，等待新的明确触发 |

额度是每份结果的入口恢复预算，重试前持久递减，重复事件、刷新、重启不重置。触发该 run 的结果在收到 Stop 时把额度置 0，不为此在 startSession 外新造账本行；顺带接收的结果不受这项操作影响。退避定时器重建不补发错过的 tick。准入不允许（归档、Goal 暂停、owner 冲突等）不是入口错误，不创建 run 或消耗额度。

必须区分“它触发了这次 run”与“它被运行中的 run 顺带接收”。前者被 Stop 后不自己重开；后者只有实际进入请求才用掉自动机会：若 C 在 Stop 收尾窗口被接收却未进入请求，仍可在 idle 后启动一次。原 coordinator 在 markDelivered 后立刻 claimWakeup 的逻辑必须移除，改为按持久请求尝试核对。新 C 也可以携带未消费 A/B，这不把 A/B 的失败自动机会重新开放。

顺带交付是否已请求，以 input.firstAttemptRequestId 为权威，不能依赖稍后写入的 execution claim。T07 查成功时则检查全部请求成员，不能把“首次尝试”与“最终成功”混为一谈。

## 兼容性

新增字段向后兼容，不能把旧记录的缺失字段解释为“从未尝试”或“普通任务”。旧 attempted 若无法通过精确来源／输入／请求关联还原主 run，保留为历史未消费结果，等待新输入或新子结果；不根据时间推测并批量清除标记。已经是 delivery=none 的历史 interrupted 不追溯升级为 pending；新版本保存的终态，包括接管遗留 running 时新写的终态，才按新规则建立投递事实，仍须先通过归属校验。

goalId 来自创建该 execution 的运行上下文，由组合层传入并由子派遣继承，不能信任模型自报，也不能拿当前会话的 Goal 反推历史归属。旧 goalId 缺失时，仅允许在完整持久 Goal 历史能证明该会话从未创建 Goal 的情况下按普通结果处理；记录不完整或曾有 Goal 时保留未知，仅阻止该条自动路由。已明确为 null 的普通结果不受影响。Goal 已结束或替换也不得把旧 Goal 结果转成普通来源。

Rewind 后失效的输入／执行依现有范围处理，条件更新不得重新确认被回退的对象。list/monitor 读取投递状态不会修改上述任何字段。
