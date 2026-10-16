# goals 升级独立总体验收

> 日期：2026-10-16。实施前代码基线：`018a5c96`；本轮入场版本：`8909dad0`；全量回归版本：`3623cd01`；最终生产版本：`8bfbfa99`。
> 本文补充五批实施记录，不覆盖各批 05 的历史事实。总体契约见 [plan/04](./plan/04-test-and-acceptance.md)，阶段架构见 [docs/goals/improve-5](../../goals/improve-5/architecture.md)。

## 验收结论与范围

五批升级的执行准入、预算与恢复、完成结算、自动 steer、正文与显示分离、请求空闲保护均有现有实现和可重复测试。独立验收发现两个命令入口问题，先分两批修复并完成全量回归；Pi 随后指出面板草稿同步问题，复现后作为第三批补修。没有新增状态层、调度器、verifier、数据库表或配置项。

本轮阅读了用户提供的[实施前讨论](https://chatgpt.com/s/cx_6ad07b9234388191bcb6fc78721038bb)、总体 plan、五批 00–05、improve-5 的 06–09 收尾记录，以及 [context 改造记录](../2026-10-10-compact-cache-and-tool-output/README.md)。讨论中提出的旧 epoch、goal root 定点取消、落盘失败重驱、迟到建流、steer 回执和 Web resume 参数边界，均纳入代码对照。

improve-5/04 原要求首轮显示 `Goal started`、续轮显示 `Goal auto-continue`；后续 [improve-5/06](./improve-5/06-prompt-and-composer-followup.md) 已明确改为首轮完整目标、续轮短提示。本轮按最新决策验收，live/replay 显示仍需一致。

## 方案与代码对照

下表中的路径以仓库根目录为起点。细粒度场景沿用各批 05，本轮重新执行全量 unit、contract、integration，并检查跨批 HTTP、SQLite 和浏览器行为。

| 场景 | 代码与验证入口 | 本轮判断 |
| --- | --- | --- |
| A1–A10：准入、生命周期、旧轮保护 | `packages/ohbaby-agent/src/goals/`、`adapters/goal-execution-control.ts`；`admission.unit.test.ts`、`goal-lifecycle.integration.test.ts`、`adapters/goal-execution.integration.test.ts` | 同 session 执行权、准入计轮、objective 实改失效 epoch、旧结果隔离、落盘失败不忙重试均通过 |
| B1–B12：状态、两轴预算、blocked 审计、resume | `goals/service.ts`、`store.ts`、`budget-input.ts`、`commands/goal.ts`；budget、blocked-audit、service、persistence、command 测试 | token 不参与预算；三次同因按已准入 run 计数；双维恢复原子合并；补齐多行参数及非法尾部拒绝 |
| C1–C8：完成、usage、恢复 | `adapters/goal-execution.integration.test.ts`、`goals/persistence.integration.test.ts`、daemon goal E2E | complete 先落盘，尾部 usage 后结算再 clear；重复和旧结果有身份保护；恢复槽登记先于执行占位释放 |
| D1–D7：活跃时间截止 | `goals/goal-deadline.integration.test.ts`、`adapters/goal-child-stopping.integration.test.ts`、`goal-stopping.integration.test.ts` | 活跃等待计时、预算更新重排、迟到定时器失效、goal root 定点中断通过，不取消用户 root |
| S1–S12：accept、steer、FIFO、未消费输入 | `runtime/prompt-scheduler/scheduler.ts`、`automatic-steer.integration.test.ts`、`adapters/ui-inprocess/steer-recovery.integration.test.ts`、daemon goal E2E | accept 后分流、幂等 receipt 和 waiter、FIFO 与显式恢复通过；预期竞争保留原 queued 项，真实异常显式报错、已接受事实可查 |
| U1–U13：正文、显示、状态、上下文 | `goals/injection.*.test.ts`、`adapters/goal-context.integration.test.ts`、`goals/goal-compact.integration.test.ts`、Web GoalControl 与 SessionScreen | 正文与显示分离、runtime context 独立、inactive 无新增注入、criterion 6000 UTF-16 拒绝边界、自动/手动压缩和重连通过；补齐 Web 多行目标 |
| W1–W7：请求空闲保护 | `core/llm-client/stream-idle.integration.test.ts`、daemon model-idle E2E | 建流与 next 等待有界；有部分输出后不盲重试；取消优先级、迟到 opening/next 清理和正常消费者耗时通过 |

watchdog 仍归 llm-client 的请求尝试所有，未出现需要抽到独立模块的新消费者。goal store 仍是目标与计数的权威来源，摘要不承担恢复目标正文的职责。没有以调度代码较长为由扩展重构范围。

## 三批修复

### 1. 完整解析多行 resume：`1e76c00e`

原命令只解析 `argv`，忽略 `invocation.body`。例如 `/goal resume 100 turns\n3h` 只处理轮次；正文中的非法参数也可能被静默忽略。Web 只在首行出现参数时直接执行，参数全部写在第二行时会打开无参面板。

修复将首行参数与 body 一并交给已有 budget parser；Web 用解析后的 argv/body 判断是否为带参恢复。新增真实 parser/service/store 和 Web 入口回归覆盖双维、反序、仅正文参数、重复维度、缺值和垃圾尾部。非法输入保持目标状态、额度与持久记录不变。

先跑新增测试得到 11 个失败，再修改生产代码，定向 43 项通过。本轮没有增加另一套预算解析器。

### 2. 保留 Web 目标正文：`3623cd01`

composer 的 overlay 只接收首行 rawArgs，会丢掉 body；replace 用 split/join 拼回文本，会折叠空白。面板再提交 `/goal ${objective}` 时，目标若以 `status`、`pause` 等词开头，还会被当成控制命令。

修复后，overlay 接收完整首行与正文，只剥离 replace 命令前缀；保存时分别使用 `/goal\n正文` 和 `/goal replace\n正文`。正文中的换行、空行、内部缩进、引号、反斜杠、中日韩字符与 XML 字符保留。仍按既有约定 trim 目标整体两端。

为复用同一命令入口，后端明确支持 body-only 创建：`/goal\n非空正文` 创建目标；裸 `/goal` 或只有空白 body 仍查询状态；无 session 时非空正文返回 `no_session`。这是本轮为完整传输目标所作的小范围命令兼容扩展，旧“非空 body 也仅查询”的测试相应更新，没有新增命令或 API。

新增目标回归先得到 5 个失败，另补无 session 反例得到 1 个失败；修复后 command、Web integration、App 共 228 项通过。独立子代理额外核对 21 项输入断言，均通过。

### 3. 保存后不再回写旧草稿：`8bfbfa99`

Pi 指出，带草稿打开面板后继续编辑并保存，后端的 objective 更新会触发 effect，再次应用原始 `objectiveDraft`；用户看到的终稿因此退回初稿。无参数 `/goal replace` 还会把空字符串视作草稿，清空预填目标。

通过真实 Web/runtime/store 集成增加创建、替换和空预填三项反例，先得到 3 失败、18 通过。修复仅区分面板新 intent 与已保存 objective 的更新来源，空 replace 不再传入草稿。修复后 3 文件 206 项通过，另运行全部 Web 测试与完整构建；保存成功时文本框保持终稿，Save objective 恢复禁用。

## 实际测试结果

环境为 macOS、Node 26.3.1、pnpm 9.15.0。全量三层测试对应 `3623cd01`；第三批仅改 Web 面板及其回归测试，随后补跑全部 Web 和完整构建。真实 API 基线先在 `8909dad0` 执行，前两批修复后的命令链路另由真实浏览器完整验证，第三批由渲染 App、真实 Web runtime 和命令后端的集成用例验证。

| 检查 | 实际结果 |
| --- | --- |
| `pnpm test:unit` | 340 文件；4259 通过，2 跳过 |
| `pnpm test:contract` | 37 文件；551 通过 |
| `pnpm test:integration` | 165 文件；1573 通过；436.60 秒，含串行 CLI 打包集成 |
| 既有未归类测试补跑 | 11 文件通过、1 文件跳过；122 项通过、2 跳过 |
| goal + model-idle 确定性 HTTP E2E | 2 文件；6 通过、4 个真实 API opt-in 跳过；这 4 项另有下述实际运行 |
| goal + model-idle 开启真实 API 的 E2E | 2 文件；10 通过、0 跳过，其中 4 个真实 API 用例 |
| Pi 补修后全部 Web 测试 | 43 文件；591 通过，包含新增 3 项真实后端集成反例 |
| `pnpm build` | `3623cd01` 与 Pi 补修后均完整构建成功，CLI Web 资源复制成功 |
| lint / typecheck | 提交钩子全仓检查通过；lint 为 0 errors / 122 既有 warnings |
| 格式与变更检查 | 修改源码 Prettier、`git diff --check` 通过；无意外生成物改动 |

完整集成的首次运行与新增失败用例编写有时间重叠，结果为 1569 通过、4 失败；失败均为刚加入的 Web 目标文本反例。修复后重新完整运行得到 1573 全部通过，没有将这次失败归为环境问题。测试跳过项不计作通过项，定向结果也不与全量重复相加。

确定性 E2E 命令：

```sh
pnpm exec vitest run --config vitest.e2e.config.ts \
  packages/ohbaby-server/src/runtime/daemon/goal-execution.e2e.test.ts \
  packages/ohbaby-server/src/runtime/daemon/model-idle.e2e.test.ts
```

本轮未执行人工 PTY 操作；CLI 的 Ink、命令、40 列布局及打包测试随全量套件通过。没有把它们写成真人终端验收。

## 真实 API 与浏览器

按 `tests/models-4-tests.md` 选用模型；凭据由测试进程读取 `.env`，不打印、不提交。服务、SQLite、workspace 均使用临时隔离目录。

真实 goal E2E 使用 DeepSeek `deepseek-flash` / openai-compatible：5 次请求（4 goal + 1 title）、2 轮，37458 total / 28544 cache-read，`usageIncomplete=false`。自动 steer、准确 marker、首轮完整目标与续轮短显示、完整模型正文、runtime context、标题来源和重连回放均通过，完成通知恰好一次，恢复项为零。

model-idle 的真实正常请求分别走 Chat Completions、Responses、Anthropic 三条协议，均完成。空闲故障通过确定性定时器注入验证，未真的等待 10 分钟静默；正常真实请求不能单独证明超时竞争正确。

浏览器在修复后的源码服务上完成以下操作：

1. 创建目标，由模型将总轮数设为 1；首轮结束后 blocked，显示 1/1。点击无参 Resume 被正确拒绝，状态不变。
2. 重启服务并刷新，仍为 blocked 1/1。通过多行 `/goal replace` 修改目标，保留空行、两空格缩进、`<台北> & 東京`，保存后没有自动恢复。
3. 提交 `/goal resume 2 turns\n1h`，两维一次写入，已用轮数和时长保留；模型返回 marker 并 complete。刷新后目标条保持清空。
4. 在 390×844 视口创建以 `status report for "台北" & 東京` 开头的多行目标，确认作为正文创建，模型执行并在 1/1 blocked；展开 Optional limits，字段与操作可读，文档宽度等于 390，无横向溢出。验收后删除该临时目标。

SQLite 对第一目标记录的核对为：seq 7 原子恢复 `{turnBudget: 2, wallClockBudgetMs: 3600000}`，保留已用 2989 ms；seq 8 计到第 2 轮；seq 9 complete → seq 10 最终 usage → seq 11 clear，顺序与次数正确。累计 38074 total / 36096 cache-read，`usageIncomplete=false`。第二目标 21520 total / 20608 cache-read，最终也已清空。

浏览器成功请求共 7 个，均 HTTP 200：input 67673、total 67930、cache-read 64512，观测 cache-read/input 为 95.329%。system 与 tools 的摘要在 7 次请求间一致，6 对相邻请求均保留上一次完整 input 为精确前缀，包括服务重启和 replace/resume 后。3 条目标消息均含完整转义目标及独立且唯一的 runtime context；显示 metadata 分别为完整首轮目标、turn 2 短提示、第二目标完整正文。

初次浏览器启动曾出现 Connection error：测试 observer 的白名单仅允许 Zenmux，拒绝 DeepSeek URL，实际 wire 请求为零。只在临时复制的测试 launcher/observer 中增加精确 DeepSeek endpoint 后重跑，生产代码未因该错误修改。这次失败没有计入成功请求。

浏览器控制台最终无 warning/error。临时服务 PID 18354 已停止，端口 49463 已关闭。证据留在本机 `/tmp/ohbaby-goals-acceptance-20261016/`：`browser-summary.json`、`web-objective.png`、`web-complete.png`、`web-mobile.png`、各层测试日志；不将临时路径当作跨机器可用的归档。

## 独立审查

Standards 与 Spec 分开审查，避免“测试通过”替代方案核对。

- Spec 子代理对照总体和五批决策、场景与代码，复跑 15 文件 270 项；发现多行 resume 静默忽略 body，已复现并修复；未报告其他已确认的方案偏差。
- Standards 子代理检查执行身份、结算与恢复交接、steer 串行化、watchdog 迟到结果，复跑 5 文件 130 项；未发现已确认的其他缺陷或必须重构的问题。
- 真实 E2E 子代理执行付费链路、准备隔离浏览器服务，并独立复核命令输入修复和脱敏持久化证据。
- Pi：`google/gemini-4-argon`，high，仅调用一次，仓库根目录，会话 `4ef09b5c-9209-433f-aac0-56e9f7009983`。结论 GO，没有报告阻塞性架构问题；指出面板旧草稿回写及空 replace 预填，已独立复现并修复，Standards 子代理另复核新 diff 并独立重跑 Web goal 集成 21/21 通过。原始完整回复已在聊天展示。另建议增高文本框或移动保存反馈，本轮不扩展视觉调整：文本框可滚动，当前桌面/窄屏操作已验收。没有将 Pi 对三协议缓存兼容的判断扩写为本轮全部模型场景实测通过。

## 边界与交付

complete 仍由模型自报；提示中的证据要求没有变成硬 verifier。blocked 的同因比较仍按当前字符串规则。真实缓存数字是本次模型服务观测，不是计费对账或长期命中率承诺；未观测 cache-write，不将未知值当成零。自动/手动压缩的正确性由真实 ContextManager 配合确定性 provider 的集成测试支撑，本轮没有重新执行 context 议题的全部付费压缩矩阵，也未做 MB 级恢复文本压力测试。

前两批修复提交为 `1e76c00e`、`3623cd01`，第三批面板同步补修为 `8bfbfa99`；验收文档单独提交。按用户指定流程，全部验收提交先 fast-forward 合入本地 `codex/goals-upgrade`，再 fast-forward 合入 `main`；只推送 `main`，不推送 `codex/goals-upgrade`。确认已合并后删除本地 `codex/goals-upgrade-improve-1` 至 `-5` 与本轮临时验收分支。最终执行结果以 Git 核对和交付消息为准。
