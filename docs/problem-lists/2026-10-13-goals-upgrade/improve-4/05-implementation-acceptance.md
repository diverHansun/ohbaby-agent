# 第 4 批实施与验收：自动插话与未消费输入恢复

日期：2026-10-15。分支 `codex/goals-upgrade-improve-4`，基于 improve-3 收尾提交 `a97e07ce`。本批保留独立开发分支，不合并 `codex/goals-upgrade` 或 main，等待 improve-5 总体验收。

契约：[02](./02-optimization-plan-and-change-scope.md)、[04](./04-test-and-acceptance.md)；阶段架构与接口摘要：[docs/goals/improve-4](../../../goals/improve-4/architecture.md)。本文件记录实际交付，不改写原规划与前批验收。最终全量测试、Pi 审查和提交信息见下文。

## 实施结果

- 普通输入先持久接受，再在原 session owner 条目内尝试一次自动 steer。目标必须是当前 active goal 的有效执行，且仍允许输入；成功使用当前 run，保持该轮 scope、模型设置与剩余 step。没有新 run、goal 轮次或 blocked 审计轮，也不承诺单独回答。
- 预期竞争返回 `not-steered` 与具体原因，原 prompt、消息和队列顺序不变。真实异常返回 `error`，已经接受的记录仍可查询；不会把失败呈现成 steer 成功。重复 `clientRequestId` 直接反映已存事实，不重新选目标，去重先于容量检查。
- 恢复提示改为会话级 `unconsumedSteers`。投影从持久输入、run 关闭事实、原消息和显式重发子项推导，覆盖所有关闭原因、跨 run、分页与重启，不依赖最近一次 Stop 或已加载消息窗口。`unconfirmed` 只表示有本地 attempt、尚无本地成功落盘标记。
- 显式 resend 新建 prompt 和 user message，以 `resend:<operationId>` 去重，保存 `resendOfPromptId`。同操作重试复用原记录；新的操作可再次重发。有效子项存在时压制原提示；普通子项未处理便取消或失败时提示恢复。steered 子项即使关闭，也由它自己的输入承接恢复；retained 子项保留既有显式恢复入口，避免父子同时提示。普通子项已有成功请求、随后又失败，仍视为已处理，不误报原输入未消费。
- close、成功确认、重发接受及子项状态变化会触发区外 rebuild 和既有 session 事件。列表只有实变才更新；持久读取或恢复失败仅使该会话的列表为 undefined，并以既有 executionRecovery blocked 表达，不发布假空列表或中断全局快照。历史和其他健康 root 仍可读取，显式重试成功后恢复列表。
- SDK、host、JSON-RPC、HTTP daemon、Web 与 CLI 同步接入结果分型和 resend 命令。消息行标记与会话恢复入口共用会话列表；即使原消息未加载也能读取原文并重发。

## 实现边界与规划衔接

| 项目 | 实际落点与取舍 |
| --- | --- |
| 自动分流 | `runtime/prompt-scheduler/scheduler.ts` 的 accept owner 区内调用 store 方法；不重入公共 `steerQueued`，不新增调度器或锁 |
| 目标资格 | adapter 复用当前 goal 票据、goalId、epoch 与 active 状态；complete、blocked、pause、cancel、replace 已生效时，仍在收尾的旧 run 不再接新输入 |
| 顺序 | prompt 使用既有 `accepted_at` 与 `admission_order`；run input 使用既有 `acceptedAt`，在同一事务按该 run 最大值递增，覆盖同毫秒与较早入队后手动 steer，不依赖 ID 字典序 |
| 恢复查询 | 新增 adapter 局部纯投影模块 `ui-inprocess/steer-recovery.ts`；`listUnconsumedSteers` 与 `listResendChildren` 读完整持久事实，无隐藏 cap 或额外恢复账本 |
| 数据变更 | 迁移 `024_prompt_resend_parent` 只给 `prompt_submission` 增加可空 `resend_of_prompt_id`；不回填历史，不增加唯一父子约束，允许多次显式重发 |
| 成功证据 | steer 使用 `processedRequestId`；普通重发子项读取原 run 持久 assistant `modelRequests` 中成功的 agent-step。已压缩消息保留该元数据；不把 provider 收到或模型理解当作本地已知事实 |
| 事件与恢复 | 复用 `SessionView.rebuild` 和 session.updated。刷新任务表只合并并发工作；启动失败表只保存已有 recovery 的结果，两者都不决定业务消费状态 |
| 访问边界 | server 校验客户端绑定 root；adapter 再校验 durable input 所属 session、scope 与原 prompt。原提示已被子项压制时，同操作重试仍可通过持久事实授权 |
| 客户端变更 | 旧 run 级 `unsentSteer` 与 latest-stop helper 退场；新 SDK 类型与服务端必须一并交付，不把这次协议变化称为旧客户端完全兼容 |
| 下一批 | 本批不改 inactive goal 自动注入、正文与短显示分离、criterion 6000 校验、常驻轮次/时长数字；这些继续归 improve-5 |

## 审查与测试推动的修复

1. **同毫秒成功 steer 的内容倒序**：prompt 的 FIFO 已单调，但 run input 仍直接取时钟，两个成功输入可被 inputId 排序反转。新增双后端回归先复现，再在既有事务中按 run 输入最大 `acceptedAt + 1` 排序；手动 steer 较早排队项也按实际进入 run 的时点排序，幂等重试保留原值。
2. **恢复范围受聊天窗口限制**：将最近 Stop/当前消息页推断替换为会话持久查询。分页之外、后续 run 及非 user-stop 关闭原因不再隐藏早期输入；旧终态 run 可补充缺失关闭事实用于读取，不改写历史输入。
3. **普通重发后期失败错误恢复原提示**：最终 prompt 状态不足以判断是否已处理。投影检查持久成功请求，区分“从未成功便失败”和“已经成功、后续失败”；两个方向都覆盖内存与 SQLite。
4. **恢复错误的会话隔离**：启动 allSettled 不再吞掉失败，但也不能让一个字段错误击穿全局 snapshot 或历史读取。失败会话的列表保持 undefined，既有 executionRecovery 显示 blocked；健康会话仍可读取和操作队列。读取不偷偷重试，显式初始化重试成功后恢复原文。live snapshot 查询与 close observer 均同步已打开视图；失败未修复时不能因旧初始化缓存误报 ready。
5. **metadata-only 事件擦掉恢复列表**：既有 session.updated 来源不全携带恢复字段；发布时保留 owner view 当前列表，真正刷新仍由持久投影决定，避免状态在事件与快照间闪回。
6. **SDK ancestry 字段遗漏投影**：`promptRecordToUi` 补齐 `resendOfPromptId`，用真实 resend 后的 session view 断言先复现缺失，再验证透传。

7. **重发祖链出现重复恢复入口**：Pi 的反例经双后端测试复现。有效 steered 子项承接该分支的恢复，关闭后只显示子项；下一代 queued/retained 时整条祖链暂不显示，取消后只恢复最近子项。保留 receipt、输入、run 与原消息校验，缺数据仍报恢复受阻；不同显式重发分支各自保留，绝不按文本合并。
8. **retained 子项与父提示同时可重发**：retained 复用已有 resubmit/cancel 入口并压制父提示，resubmit 保持其 prompt/message/ancestry 身份，取消后父提示恢复。
9. **Web 错误随条目卸载消失**：resend 已接受但分流失败的错误提升到 Composer，SSE 在回执前或后清空列表都仍可见；跨会话响应有 generation guard。
10. **恢复入口的实际可操作性**：浏览器发现透明背景叠字及遮住尾部回复，补不透明容器和底部留白；长原文完整滚动，按钮标签用短预览。CLI 用有总数的单行预览逐项操作，保留方向键并增加 Ctrl+N/P 备用选择键，避免系统快捷键截获。

## 验收证据索引

下列路径相对仓库根。`automatic-steer.integration.test.ts` 与 `steer-recovery.integration.test.ts` 均使用真实内存和 SQLite store，后者另有 SQLite reopen；它们是集成测试，不称为纯单测。HTTP E2E 位于 `packages/ohbaby-server/src/runtime/daemon/goal-execution.e2e.test.ts`。

| 验收项 | 真实证据与断言范围 |
| --- | --- |
| S4-01 | `adapters/goal-execution.integration.test.ts` 的 S4-01/02：运行中接受→steered→下一请求含原文；HTTP E2E 自动 steer 场景验证真实 daemon 接受、重试、waiter 和事件 |
| S4-02 | 同一 S4-01/02 断言不取消原 signal、不新建 prompt run、goal 轮数保持 1；输入通过既有 current-run-input 路径进入当前 run，scope/设置/step 不另起一套执行。blocked 的按已准入 run 审计沿用 improve-3 集成与 daemon 测试 |
| S4-03 | `runtime/prompt-scheduler/automatic-steer.integration.test.ts` 的 target-sealed 分支与 `current-run-inputs.integration.test.ts` 封口保护；adapter 原手动封口契约改为分型结果，原记录保留 |
| S4-04 | automatic-steer 的 target-unavailable；`adapters/ui-inprocess.contract.test.ts` G24 在 pause/cancel/replace/complete 已提交、旧执行仍持有期间验证目标消失和用户排队；S4-17 补模型生命周期 |
| S4-05 | automatic-steer 的真实 resolver 错误保留 durable accepted 记录、重复请求不重新决策；store 身份冲突仍抛真实异常；CLI `app.contract.test.tsx` 验证接受后的自动 steer 错误可见且不恢复已提交 draft |
| S4-06 | automatic-steer 的原 receipt 重试、已有 queued 记录以及中间窗口 waiter；scheduler 原有状态/去重测试，adapter 同 operation 重发断言，无重复消息 |
| S4-07 | automatic-steer 双后端验证早期 queued 挡住后项、冻结时钟与反向 ID、两次成功自动输入顺序、旧 queued 手动输入与 runtime 输入交错顺序 |
| S4-08 | adapter G24 的 pause/cancel 与 accept 交错；S4-10/12 先接受后停止进入恢复列表；没有自动 resume goal |
| S4-09 | `adapters/ui-inprocess/steer-recovery.integration.test.ts` 分别覆盖 completed/failed/interrupted/process-interrupted，daemon 失败输入通过 SSE 实时出现 |
| S4-10 | recovery integration 覆盖原消息在 55 条以上后续消息之外、SQLite reopen 与旧终态 run；adapter S4-10/12 覆盖后续 run/Stop 不覆盖旧输入；`ui-persistent.integration.test.ts` 覆盖未选 session 恢复失败不假空、历史/健康会话隔离与显式重试 |
| S4-11 | recovery 与 automatic-steer：attempt 后 close 为 unconfirmed，成功落盘确认后移除；SDK `run-inputs.unit.test.ts` 与 CLI/Web 会话列表显示只表达本地状态 |
| S4-12 | adapter S4-10/12：新 prompt/message、ancestry 透传、同 operation 重试、取消恢复、新 operation 可再发；recovery 双后端验证普通子项成功后晚失败与从未成功、steered 祖链承接、retained 恢复、独立分支及损坏子项拒绝；HTTP E2E 验证原文、幂等 HTTP 重发与实时压制 |
| S4-13 | daemon 大 protected input E2E：25,000 个独特输入片段、32K context，实际 ContextManager 拒绝下一请求，UI 显示失败、原文可恢复，显式重发仍失败后父提示恢复；既有 close/seal 防护保留 |
| S4-14 | adapter 手动结果、`host/ui-command-gateway.unit.test.ts` trusted owner 透传；server JSON-RPC/HTTP、Web daemon client 测试；Web Composer 拒绝仍 queued，CLI 手动 steer 不确定响应稳定重试 |
| S4-15 | `services/database/retained-migration.integration.test.ts` S4-15：真实旧库应用迁移后原字段可读、ancestry 为 NULL、列可空，新增两个重发子项可查且原记录不变；database schema/migration 原回归继续运行 |
| S4-16 | automatic-steer 预先持久接受、重建 scheduler 后以同 ID 重试，保持 queued、不追溯分流；这是 accept/steer 间故障窗口的确定性模拟，没有宣称做操作系统 kill 测试 |
| S4-17 | goal-execution 的 S4-17 参数化模型 blocked/complete 已持久提交、尾请求被 deferred 卡住时接受用户输入：no-goal-run、queued、不打断收尾、释放后用户执行，goal 轮数不增；G24 另覆盖 replace，HTTP E2E 覆盖 complete 尾部结算 |
| S4-18 | automatic-steer 将容量设为 1，既有记录重试先去重并复用状态/receipt，不再分流；原 scheduler 容量拒绝仍保留 |
| S4-19 | current-run-input observer 在 close/confirm 后通知；adapter S4-10/12 不重连观察取消后提示恢复；daemon SSE 关闭后恢复、resend 后压制；SDK/CLI/Web 列表标记更新不依赖消息页 |
| S4-20 | automatic-steer 真实 scheduler/store 自动与手动成功、onSteered/onUpdated 抛错仍保留 durable receipt 并结算 waiter；HTTP E2E 最终 prompt.updated 为 steered、队列无 queued 项、waiter 完成，当前 goal 轮数不增 |
| S4-21 | automatic-steer deferred 卡住 durable accept 后分流前的窗口，同 ID 读取 queued 并等待；释放后同 waiter 结算、仅一条输入与一次分流，最终 receipt 可查 |

这组证据按分层职责组合，不声称每个竞态排列都经过浏览器与真实模型。原 scope、reasoning、step 上限与 compact/cache 算法没有在本批另起实现；当前 run 复用与 protected-input 大输入组合测试验证接线，最终缓存/压缩/重连组合仍由 improve-5 收齐。

## 执行记录与人工验收

以下统计来自最终代码上的全量执行；定向测试用于复现审查发现，不替代全量门禁：

| 最终执行 | 结果 |
| --- | --- |
| `pnpm test:unit` | 339 文件，4218 通过、2 跳过 |
| `pnpm test:contract` | 37 文件，548 通过 |
| `pnpm test:integration` | 164 文件，1557 通过；包含 S4-15/S4-17、Pi 三项修复与恢复祖链的最终代码 |
| 确定性 daemon E2E | 1 文件，4 通过；1 个付费 API opt-in 用例默认跳过，已另行实际执行。覆盖自动 steer、失败恢复/幂等重发、大 protected input |
| 真实 API | `OHBABY_RUN_GOAL_REAL_E2E=1` 单独执行 5/5 通过。deepseek-flash / openai-compatible：4 请求，其中 goal 3 请求、1 轮，累计 25,357 tokens，缓存 24,064 tokens，usageIncomplete=false，completion notice=1；返回 steer marker，恢复项=0。此实测在 Pi 恢复边界修复前完成，之后重跑确定性 daemon E2E，不重复消耗 API |
| 静态、格式与构建 | typecheck、lint、prompt:check、修改源码 Prettier、diff --check、完整 pnpm build 通过。Lint 为 0 errors / 122 warnings，新增源码行无告警；构建仍提示 Web 主 chunk 超过 500 kB，本批未额外拆包 |
| CLI / Web 人工冒烟 | Web 使用真实 daemon + SQLite + 确定性 provider、独立临时工作区，在桌面与 390×844 窄屏实际验收：两种恢复状态、长原文滚动、键盘选中重发、SSE 移除对应项、刷新保持未确认项、尾部回复可见、无横向溢出；浏览器控制台无 error。临时服务已停止。CLI 未运行日常配置下的人工 pnpm dev；用 Ink/终端进程契约与集成测试验证，未把自动化称为人工验收 |

## 借鉴、审查与提交

沿用 [03](./03-reference-projects.md) 的定点参考：Codex 的单一输入决策点和分型拒绝原因；ZCode 的同一 intent 原地回队、身份与顺序不变；DSH 的用户工作优先由 improve-2 既有门禁承担。本批没有引入参考项目的额外数据库、Rust 锁结构、armed/revision 激活层或“目标未完成便阻塞用户队列”的政策。kimi-code、claude-code 的总体比较见 [plan/03](../plan/03-reference-projects.md)，不把不存在的具体复用写成本批实现来源。

独立子代理已复现同毫秒 run input 顺序问题并推动修复，并修正 Web resend 错误随条目卸载的问题；最终只读复审无未解决 P1/P2。用户指定的 Pi 已执行一次，实际模型 `github-copilot/claude-opus-5.5`，thinking medium；会话 `4a7ca5d7-d9e7-493b-9af6-e00f1b7d2b74`，工作目录为本仓库根。Pi 指出的 1 个 P1、2 个 P2 已逐项复现并修复（会话错误隔离、steered 祖链、retained），由独立子代理复核。其原文已完整展示在本次聊天中。分批提交记录见文末；没有合并或推送。

SWE 边界：复用既有 owner、事务、prompt/input/message/run 事实；局部查询 helper 承担跨事实投影，不扩出通用框架。保留错误和未确认事实，不靠自动重试、截断列表或复用旧消息伪造恢复成功。旧客户端与回滚版本不理解新的分型和 ancestry，回退时应一并评估后端、SDK、CLI/Web 与既有数据库新记录；本批不独立宣称可无语义损失回滚。

### Pi 建议的取舍

- 采纳 CLI 备用选择键。保留既有 Ctrl+←/→，Ctrl+N/P 只在有恢复项时选择，不修改草稿。
- 不把 unconfirmed 改成“未送达”：本地 attempt 不能证明网络或模型状态。context preparation 超限的实测在请求前失败，投影为 unconsumed，未错误显示 unconfirmed。
- 全文按需读取会改变本批会话级原文恢复协议，暂不采纳；本批保留完整事实。大输入事件体积与 session 查询索引建议留在 improve-5 组合回归观察，当前没有 MB 级重连压测或索引性能证据，不宣称已验证无性能风险。

### 分批提交

基线为 improve-3 收尾提交 `a97e07ce`，以下提交均位于 `codex/goals-upgrade-improve-4`：

| 提交 | 内容 |
| --- | --- |
| `42439586` | 自动 steer、持久恢复、显式重发及 SDK/host/daemon/CLI/Web 接线，含各层既有测试更新与 HTTP E2E |
| `a4c86772` | 独立的 scheduler 竞态与恢复祖链集成回归，覆盖内存和 SQLite |

阶段架构、验收矩阵与本记录另作第三批文档提交。所有提交运行仓库原有 lint/typecheck 钩子；本批未推送、未合并，improve-5 完成后再集中检查和合并。

## 2026-10-15 UI 精简补充

用户指出恢复卡片默认展开、提示过多。本节记录 `4c520771` 之后的展示层调整，不改变前述持久恢复与重发契约。

- 截图中的整块恢复卡由 `42439586` 引入；其中 “Please verify the mobile layout…” 是隔离验收时的用户输入原文，不是产品指引。成功 steer 后的 safe-boundary 提示则来自更早的 `a75d96f6`。
- Web 默认仅显示无边框的单行 “N inputs to review”，实测高度 34px；点击后才显示状态、完整原文和逐项重发。没有恢复项时不显示入口，也不留额外空白。原消息上的简短状态保持不变。
- 删除 Web/CLI 的成功 steer 长提示、CLI 的 “Resend accepted” 与不可用操作标签，以及 Goal 面板重复解释替换目标的文字。Goal 状态入口、暂停原因、操作按钮、折叠的 Optional limits 保留。
- CLI 恢复区从三行缩为状态/快捷键与单行预览，多条才显示选择快捷键。新操作开始清除旧拒绝反馈，真实的新拒绝与错误仍显示。
- 折叠不卸载恢复项，保留 pending 与幂等 operationId；切换会话重置展开状态。重发错误由 Composer 保存，即使 SSE 先移除恢复项或用户收起列表也能看到，旧会话的迟到错误不污染新会话。

参考的是实际挂载的源码：DSH `GoalBar.tsx` 的 36px 单行状态与 `QueueDock.tsx` 的折叠队列；Kimi TUI `footer.ts` 的摘要与 `/goal` 主动查询详情；ZCode `ConversationStatusPanel.tsx` 的紧凑/展开结构及避免重复 composer 计数的做法。没有把 ZCode 未挂载的旧 banner 或 Kimi 仓库外的 Web 实现当作证据，也没有借呈现精简删除 ohbaby 自己的持久恢复能力。

Pi 使用用户指定的 `opencode/claude-opus-5-5`、medium 完成关键源码调整。首次调用因上游 thinking 签名绑定错误中断，保留已落盘修改；同模型重新建立会话后完成收尾（会话 `46cc7cdc-7077-4cde-ae83-044acb9fcf86`）。主代理负责测试、启动服务、浏览器验收与后续修正；Pi 原文已完整展示在聊天中，未写入仓库。

独立复审发现恢复列表与错误同时出现时，固定底部留白漏算错误高度。浏览器在 390px 宽度复现：长错误高 364px，正文尾部进入 composer 覆盖区。修复复用既有 CSS 留白变量，以局部 ResizeObserver 测量恢复区域的实际高度；错误限高但保留全文滚动和键盘聚焦。复测折叠/展开与长错误并存时，正文尾部均在 composer 上方，独立复审无遗留 P1/P2。

| 补充验证 | 结果 |
| --- | --- |
| Web 全部测试 | 42 文件、565 项通过，包含默认折叠、长原文、多项操作、会话隔离、折叠幂等重试及迟到错误 |
| CLI contract 与 transcript | 2 文件、158 项通过，包含稳定请求身份、拒绝仍排队、草稿保留与新操作清除旧反馈 |
| 静态与构建 | typecheck、修改文件 lint/Prettier、diff check、完整 pnpm build 通过；保留既有 Web 大 chunk 构建提示 |
| 浏览器 | 本地真实 daemon + SQLite + 确定性 provider，1280×800 与 390×844；展开、键盘选中第二项、失败后折叠再重试、同 operationId、SSE 仅移除对应项、刷新、换会话、最后一项处理后留白归零均通过；原草稿保留 |
| 视觉与控制台 | 已实际查看桌面、窄屏和错误状态截图，无横向溢出或尾部遮挡；正常流程无 console error/warning，故障注入的预期 503 单独核对 |

本次没有后端改动，也未重复调用付费模型 API；浏览器测试使用隔离临时工作区，验收后停止服务。继续保留 improve-4 分支，不推送、不合并，不提前实施 improve-5。
