# improve-3 最终整批审查

日期：2026-10-15。审查范围：`fed91056..f450ec15`，分支 `codex/goals-upgrade-improve-3`，42 个改动文件；另核对尚未提交的 improve-3 阶段文档及 05 实施验收记录。按 `requesting-code-review/code-reviewer.md` 执行只读审查；除本报告外未修改源码、索引或分支，未调用 Pi，未重复全量测试。

## Strengths

- **契约落地完整**：blocked 成为持久化第四态，模型入口只允许 complete/blocked；预算与安全阀走 blocked，用户暂停、执行失败、重启归一仍走 paused。SDK 投影、CLI warning 显示、Web 恢复入口与这一状态契约一致。
- **审计不依赖模型自数轮次**：服务用可信 run 绑定与当前 epoch 做资格判断，审计器按票据轮号、相邻性及归一化原因计数，同一轮不能重复贡献。第三次先保存 blocked 再提交内存计数，保存失败仍能重试；真实恢复、正文实改和新目标明确清链。
- **恢复保持原子性与累计用量**：纯解析模块完整消费参数并由命令/工具共享；planResume 在既有 session 串行区内读最新快照、合并和检查两轴及安全阀，store 用单条 update 同时恢复与更新预算。失败不会留下部分额度更新。active 调额保留 append 前的时间锚点，不赠送保存期间的活跃时间。
- **截止与执行身份有明确边界**：timer token 防旧回调清新 timer；回调在串行区复核目标、状态及最新预算。中断捕获实际 goal ticket，不将旧 epoch 的 mutation 资格错误用于停止范围；用户执行无匹配 goal 票据时不会被 session 范围中断。准备阶段、运行阶段及 runReady 交接都复用 improve-2 的取消机制。
- **失败路径与测试证据吻合**：截止 append 失败仍取消捕获执行，保留原始错误和 stopIntent 原因；driver 不会用 interrupted 覆盖截止原因。测试实际检查 deferred append、持久化记录、主执行 signal、两棵子任务树和 production watchdog，不只断言 mock 调用。
- **客户端保持简单**：Web 的参数化 resume 仅在 goal/resume 分支打开受控 allowOverlay，完整原文到后端解析；无参保留面板。额度字段留空不改原值，失败保留面板和输入。扁平布局、独立 objective 保存、按状态显示主动作，无新组件框架或下一批常驻统计。

## Issues

### Critical

未发现可复现问题。

### Important

未发现可复现问题或阻止本批交付的测试缺口。

### Minor

未发现需要本批额外修改的具体问题。没有将后续批次范围、已记录的异常降级或纯风格偏好列为缺陷。

## 计划符合性与边界

Stage 1–5 的主要行为均有源码与对应测试；准备取消、子树隔离和 watchdog 竞争分布在 adapter integration，而非全部放入规划最初指定的单一文件，属于合理按真实协作边界分层。Web integration 使用真实 App、Web runtime、daemon route 与命令后端；确定性 HTTP E2E 进一步覆盖 production tools、SQLite、三轮审计及恢复后清链。

阶段文档写入 `docs/goals/improve-3/`、历史原文保留的调整已在 05 明确说明，并指出本批四态取代旧 blocked 非常驻结论。未看到 improve-4 自动 steer/FIFO 或 improve-5 常驻数字、criterion 等被提前实现。

持久化持续失败时，执行已停止但内存可能仍为 active、timer 不自动重试，是已明确记录的异常降级；实现没有伪造落盘成功，也没有用自动重启掩盖失败。不能将这一故障条件下的状态等同于正常 blocked 成功。

## 验证与建议

本轮逐项阅读 git diff、关键完整源码、相关上下游执行中断/准入代码、新增测试与阶段文档，执行 `git diff --check fed91056 f450ec15` 通过。未重复运行测试、浏览器或真实 API；通过数量采用主代理已执行并记录的验收证据，不能称为本审查重新实测：unit 4,209 通过/2 跳过，contract 540 通过，integration 1,500 通过，最终受影响集合 226 通过；确定性 E2E、独立真实 DeepSeek 和桌面/手机 CUA 结果见 05。

后续 improve-4/5 按已登记的跨批组合继续验证，尤其是自动 steer 后的审计轮号、blocked 未消费输入和目标更替后旧执行释放。当前证据覆盖关键竞争窗口，不代表穷举全部时序排列。

## Assessment

**本批可交付：是。** 在本次静态审查及已记录验证范围内，未发现 Critical/Important 缺陷；实现遵守既有串行区和执行票据边界，新增复杂度集中在本批必要行为，没有第二套状态权威或调度器。

**合并操作：不执行。** 按用户要求保留本分支，待 improve-5 统一验收后再处理合并；本报告不构成提前 merge/push 授权。
