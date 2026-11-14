# improve-3 后端实施与验收

2026-11-14。实施分支 `codex/background-tasks-improve-3`，从开发分支 `codex/background-tasks-dev-20261113` 的 `332ec6d2` 建立。实现、独立子代理审查、指定Pi审查与收尾复审及最终完整验证均已完成。2026-11-14 按用户批准快进合并到开发分支 `codex/background-tasks-dev-20261113`，阶段集成代码为 `8635d0bd`。随后目录迁移提交 `a68c7774` 与开发分支一起进入 `main`；本轮用户授权推送 `origin/main` 并清理本地临时分支。只实施后端，前端专用展示仍待后续安排，最终目录与验证见末节。

## 实施结果

`bash` 负责启动，`task` 只提供 list/output/stop；`agent` 仍独立管理子代理。task 工具是 Registry 的薄适配，没有新任务实体、数据库迁移、执行器、队列或动作插件框架。

- list 复用已有 Store 查询与 cursor，按可信 session/context scope 精确隔离。默认包含最近结束项，未完成筛选保留尚有清理/收尾责任的任务，六状态精确筛选；正常前台历史不混入，启动占位只计数。每页最多100，摘要不含日志全文；cursor绑定owner及筛选，limit可变。
- output 返回真实快照与有界尾部。阻塞读取以结果就绪为准，wait_ms默认30000、最多600000；到期、取消或steer只结束本次读取，不改变进程硬截止或通知消费。
- stop 调用既有停止和恢复路径。`stopResult` 为 requested/already_finished/tracking_released/cleanup_pending；受理、任务结局及cleanup分别表达。无法确认清理不伪报already_finished，放弃追踪不重新取得信号权。
- 可信工具对象获得control通道；list/output按readonly分类，stop沿用subagent-control。旧名deny仅映射对应动作、复用既有matcher、不迁移allow、不新增权限DSL。
- 内置角色统一为task。自定义旧include/exclude在实际激活时诊断，初始化及未选用角色不受阻，不改用户配置。
- 旧历史保持可读；新metadata区分list和单任务事实。rewind fallback只接受相同session/scope/job的旧回执或task output/stop清理证据，不接受list汇总。

## 本轮发现并修正

1. 原output在其他后端的持久记录上忽略block；现在只在该读取调用期间有界查询，退出即释放timer，不新增常驻轮询。
2. 原output以逻辑终态结束等待，可能早于输出排空；现在沿用既有resultReady事实，等待器在结果就绪、到期、取消或steer时释放。进程硬超时仍由原Registry负责。
3. 独立审查发现task层给status筛选补includeFinished默认值，导致底层互斥校验误拒绝。已修复，并在真实task工具入口循环验证六种状态，补足原先仅测Registry的缺口。
4. Pi指出list正文与metadata重复完整JSON。正文改为短摘要，详细事实仅在结构化metadata中保留一份，避免重复占用模型上下文。模型投影的进一步裁剪见下文“审查后修正”第 2 条。

## 审查与取舍

权限、生命周期及消费者分别由子代理独立检查，最终未发现未解决的确定P1/P2。指定Pi `github-copilot/gemini-4-carbon`、`high`进行实施中审查和完成后复审，沿用同一项目会话；最终结论为 **Spec PASS / Craft PASS，无真实阻断问题**，并明确撤回首轮lost等待假设。

Pi首轮的两项阻断意见经源码及真实路径验证后未采纳：

- 参数错误的ExecutionError封装属于现有调度器统一约定，plan/execute均相同；T02未规定错误类别。保留task前置校验，单调用和批调用各覆盖7类非法输入，验证明确错误说明、无审批、无list/output/kill调用。避免为了换错误名称改全局框架，或把校验延后到审批之后。
- recovery会原子写入lost和resultReadyAt；abandon先refresh，保留就绪事实。新增测试经实际recover/abandon验证阻塞读取正确结束。不能把任意终态视为结果就绪，否则会破坏已有的foreign输出排空保证；不针对真实路径无法产生的状态加兜底。

另补会话initialSnapshot恢复旧deny的公开入口验证，覆盖默认/full-access及output/stop两动作；旧allow不迁移。测试均加在已有文件，无新增测试文件。

## 审查后修正

2026-11-14 用户要求按 SWE 原则复审本分支。双轴子代理审查（代码工艺、对照设计文档）后，用户批准修正以下三项；其余判断题只作后续参考，本次未改。

1. **本地重复 stop 的 stopResult**：任务句柄在本进程时，如果停止已由先前的 stop 或超时发起、清理尚未完成，原实现返回 `requested`，和持久记录路径的 `cleanup_pending` 不一致。现在本地路径只在本次受理时返回 `requested`，否则按 cleanup 与释放状态返回 `already_finished` 或 `cleanup_pending`。新增重复 stop 用例，验证第二次返回 `cleanup_pending` 且不再发信号；该用例在修正前失败。
2. **list 给模型的投影**：上文第 4 条只去掉了正文里的整段 JSON，元数据投影仍为每个任务附约 24 个字段，含命令全文和多个时间戳。现在模型投影每项只保留 jobId、mode、status、stopReason、cleanup、exitCode；完整摘要仍保存在持久 metadata 中，供 UI 使用。收尾时以20项完整样例对比HEAD与工作区的实际投影函数：metadata JSON从11437字符降为2337字符，减少约80%；该测量不含正文，不代表所有命令的固定token节省。
3. **list 重复实现**：`ShellJobRegistry.list` 和 `ShellJobReader.list` 各写了一份记录到摘要的映射，现合并为 `shellJobSummary`，Registry 只追加输出计数字段。同时删除 Registry 中与 task 入口重复的 limit/status/互斥校验：输入规则只在 task 入口检查，页大小上限仍由 store 保证。上文第 3 条的误拒问题，正是这两层规则不一致造成的。

优化完成时的验证：相关测试做了两轮定向运行，42 个文件 698 项、读取层小改后 52 个文件 746 项（两组有重叠）均通过；工作区 `tsc -b` 通过；改动文件的 ESLint 警告数与修改前相同（均为原有警告），Prettier 通过。该阶段按本议题“窄修只跑相关检查”的约定未重跑完整preflight；本次收尾已补全整体验证，结果见下节。

### 收尾复核

本次对 HEAD `8214f52d` 之后的7份工作区改动重新独立审查。代码工艺与合同两轴均未发现确定的代码阻断问题；摘要提取保留了原UI字段与截断规则，模型正文仍包含ID与简短说明，task入口校验和Store页大小约束仍有效。

Claude的其余意见没有一并改动，取舍如下：

- 现有 `utils/params` 的number/boolean函数用空值合并运算，将null当默认值；task要求拒绝显式null，不能直接替换。边界严格校验不因精简Registry而删除。
- 常量命名、等待函数拆分、结果类型、集中旧名和停止流程合并属于可维护性建议。当前共享摘要仍放在reader中，并未完成中立查询层重组；本轮只消除实际重复，不另建查询服务或动作框架。
- `legacyDenyToolName` 包含参数解析，命名确有改进空间，但前置拒绝发生在审批前；调度器执行前再次检查旧deny。PermissionManager自身未透传旧名，但当前真实链路未发现绕过路径，不为假设增加一套权限迁移机制。
- `task_list` 没有旧执行工厂，不应描述为已发布的历史工具。当前仅有迁移诊断与deny映射，不提供别名执行；其清理可与兼容映射整理一起处理。
- list正文将null写为pending，以及bash历史投影字段扩展，是原实施的剩余观察项，不是本次三项优化已修正的内容。前端专用展示仍在本轮范围外。

另做一次性真实task handler检查（内存持久记录，不新增测试文件）：steer订阅拒绝时错误向调用方传播、任务保持running、不发停止信号；stopped/timeout两个非法状态及timeout/agent_id/stop_all三个无关字段全部拒绝。该证据不等于新增了长期回归用例。

本次指定Pi `github-copilot/gemini-4-carbon`、`high`复审当前diff，结论为Spec PASS / Craft PASS，无实证阻断问题。其将task_list称为必须兼容的说法不应作为发布历史证据；接口文档的原条件是“若曾单独发布”。本次完整验证结果见下节；修正前8464项结果单独保留为历史证据。

## 验收映射

| 合同 | 证据入口与覆盖 |
| --- | --- |
| T01/T03/T11/T18 | builtin/角色与scheduler真实工具声明；缺task及伪同名关闭后台能力；旧角色激活诊断；旧工具名返回迁移错误且不调用stop。 |
| T02/T04/T17 | registry.unit通过createTaskTool执行参数、六态、未知/越权同错误；query.integration在memory及SQLite验证session/scope隔离。 |
| T05/T10 | scheduler.unit与capacity.integration验证真实task的默认权限、动作deny、第三方同名隔离及普通容量满时仍可管理。 |
| T06/T07/T08 | registry.unit/integration与persistence.integration验证wait到期/steer/取消、停止后的输出收尾、foreign持久读取等待、真实状态与cleanup。 |
| T09 | query.integration双存储验证超过100项分页、owner/filter cursor绑定、前台异常、未收尾终态及放弃追踪；task入口验证分页摘要不携带日志。 |
| T12/T13 | metadata.unit保留新旧事实、有界list；rewind-shell.integration保留legacy夹具，新增task output/stop与list、错误owner/job的证据区分。 |
| T14/T15/T16 | 原shell-job notices/capacity/cleanup、Bash scheduler及真实运行时集成纳入全量回归；前两轮同ID、原硬截止、满额停止当前命令及owner结束清理机制保持。 |

当前定向记录：消费者三文件39项、列表相关三文件38项、工具与真实运行时六文件116项通过；后续审查四文件98项与权限/容量五文件170项通过。这些集合有重叠，不相加充当测试总量；最终完整结果见下节。

## 安全删除与代码工艺

删除旧createTaskOutputTool/createTaskKillTool工厂、注册、角色清单、旧双管理工具门控与过渡等待常量。新task复用原输出/停止/查询；不保留可执行别名，不自动重放旧stop。

必要的旧名仅留在历史投影、rewind、deny兼容、激活迁移诊断与真实legacy测试夹具。前端旧展示及mock尚未迁移，通用正文可读不代表专用卡片或后台面板已交付。

Registry、Store、进程树回收、source-cleanup、环境retain/release、输出持久化及可靠通知仍有真实消费者，完整保留。没有删除仍承担资源责任的代码。新增回归放在既有测试文件，不新增临时测试框架。

DSH的独立wait取消、Kimi的管理能力门控、ZCode的转换/收尾责任分离作为核对依据；不照搬其硬超时重置、通用任务平台或“请求停止即成功”的简化。详见[本轮参考取舍](03-reference-projects.md)。

## 最终验证与交付边界

**审查后优化的本次验证**：格式检查、ESLint及TypeScript通过（0错误、234项原有警告）。完整测试首轮为719文件通过、1文件失败、6文件跳过；8464项通过、1项失败、20项跳过。唯一失败是打包测试安装依赖时，npm上游请求 `@earendil-works/pi-tui` 失败、测试代理返回502；保留该事实，不记为一次全绿preflight。未改代码，定向重跑打包测试1/1通过；随后单独执行 `pnpm run build` 通过。合计8465项测试均取得通过结果，20项按配置跳过。无需为已定位的下载失败重复运行全部测试。

该阶段优化在独立子代理与指定Pi复审后，以 `8635d0bd` 提交并按用户批准本地集成到开发分支，当时未推送。下面保留原实施的历史验收记录。

修正前代码提交 `de367e50` 运行 `pnpm run preflight` 成功（退出码0）：格式、ESLint、TypeScript、完整测试及全工作区构建均通过。测试为 **720文件通过、6文件跳过；8464项通过、20项跳过**。ESLint为0错误、234个原有警告；没有增加警告。构建仍提示既有Web大chunk及外部导入警告，不影响构建成功。

首轮全量曾暴露两处旧测试夹具：composition仍断言task不存在、cleanup仍读取terminalWaiters。同步新合同后，64项定向复测通过，随后完整验证通过；原实施冻结后再跑完整检查得出上述8464项结果，不代表审查后修正的验证结果。

代码/测试提交为 `de367e50`（`feat(tools): unify shell job management under task`），原验收文档提交为 `8214f52d`，审查后修正及收尾记录为 `8635d0bd`；三者先进入开发分支，现已随开发分支集成到main。16份改动文档的本地链接检查及diff空白检查通过。

真实进程验证环境为本机macOS，未进行Linux/Windows实机验收、24小时长测或外部模型驱动的ohbaby端到端验收。Pi是代码审查，不等于ohbaby真实模型验收。原D28极端强杀窗口和身份不明不误杀边界保持；跨活跃后端只读，不新增控制转发。

另一后端崩溃后若尚未触发既有恢复/复查入口，output仅观察持久事实，不主动探测PID或取得恢复权，最多等待本次wait_ms；这属于原定有界读取范围，不把“读取超时”伪装成任务执行超时。

## 开发分支集成记录

2026-11-14 用户明确批准将improve-3合并到开发分支并更新文档，先不推送。合并前工作区干净，开发分支 `332ec6d2` 是实施分支 `8635d0bd` 的祖先；采用 `git merge --ff-only`，无冲突、无额外业务变更。合并后验证开发分支与已验收实施分支的文件树完全一致，因此沿用上述测试及构建证据，不重复全量运行。

合并后只更新议题README与验收记录，进行链接和diff空白检查，并由提交检查执行ESLint与TypeScript。前端与目录迁移仍未实施，主分支未改动；本轮没有推送。

## 目录迁移与main集成

2026-11-14，用户完成暂存目录迁移后，要求审查、指定Pi复核，随后合并main、推送并删除本地临时分支。采用 `src/shell-jobs/`，与 `tools/`、`shell/` 平级：该模块管理Shell命令的生命周期、持久化、恢复和通知，adapters及services也直接消费；`task` 是模型工具名，不将该模块扩大为通用task运行时。

目录迁移提交 `a68c7774`：共57个文件受影响，21个文件重命名（含fixtures），`tools/bash.ts` 与 `tools/task.ts` 保留工具入口。旧 `tools/shell-job-*.ts` 对应新 `shell-jobs/*.ts`；`shell-output-file.unit.test.ts` 对应 `shell-jobs/output-file.unit.test.ts`。历史验收条目中的旧路径是原提交位置。现有tools/utils小辅助依赖保留，不在移动提交夹带行为解耦。

两位只读子代理分别检查迁移及task后端合同，均未发现阻断问题；指定Pi `github-copilot/gemini-4-carbon`、`high`最终复审为 **Spec PASS / Craft PASS，无实证阻断问题**。56个TypeScript文件经路径归一化的语法树比对，无其他语法变化；动态fixture位置、测试发现、打包入口和公共exports保持有效。架构依赖表已同步为shell-jobs。

迁移后运行完整 `pnpm run preflight`，退出码0：**720个测试文件通过、6个跳过；8465项通过、20项跳过**。格式、ESLint、TypeScript和全工作区构建全部通过；ESLint仍为0错误、234项原有警告。本次打包安装测试正常通过。没有新增测试文件或业务行为。

远程main在集成前获取并核实为 `f42608d4`，本地main从该提交快进到 `a68c7774`，无冲突。合并后文件树与已验收开发分支完全一致；随后仅更新议题README与验收记录。交付目标为 `origin/main`，本地临时分支清理范围为 `codex/background-tasks-dev-20261113` 及 `codex/background-tasks-improve-1/2/3`。前端专用展示、Linux/Windows实机验收等原有边界保持。
