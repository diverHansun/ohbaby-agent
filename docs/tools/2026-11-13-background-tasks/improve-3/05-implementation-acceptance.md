# improve-3 后端实施与验收

2026-11-14。实施分支 `codex/background-tasks-improve-3`，从开发分支 `codex/background-tasks-dev-20261113` 的 `332ec6d2` 建立。实现、独立子代理审查、指定Pi两轮复审及最终完整验证均已完成。未合并、未推送。只实施后端，前端与 shell-job 目录迁移仍待后续安排。

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
4. Pi指出list正文与metadata重复完整JSON。正文改为短摘要，详细事实仅在结构化metadata中保留一份，避免重复占用模型上下文。

## 审查与取舍

权限、生命周期及消费者分别由子代理独立检查，最终未发现未解决的确定P1/P2。指定Pi `github-copilot/gemini-4-carbon`、`high`进行实施中审查和完成后复审，沿用同一项目会话；最终结论为 **Spec PASS / Craft PASS，无真实阻断问题**，并明确撤回首轮lost等待假设。

Pi首轮的两项阻断意见经源码及真实路径验证后未采纳：

- 参数错误的ExecutionError封装属于现有调度器统一约定，plan/execute均相同；T02未规定错误类别。保留task前置校验，单调用和批调用各覆盖7类非法输入，验证明确错误说明、无审批、无list/output/kill调用。避免为了换错误名称改全局框架，或把校验延后到审批之后。
- recovery会原子写入lost和resultReadyAt；abandon先refresh，保留就绪事实。新增测试经实际recover/abandon验证阻塞读取正确结束。不能把任意终态视为结果就绪，否则会破坏已有的foreign输出排空保证；不针对真实路径无法产生的状态加兜底。

另补会话initialSnapshot恢复旧deny的公开入口验证，覆盖默认/full-access及output/stop两动作；旧allow不迁移。测试均加在已有文件，无新增测试文件。

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

最终冻结版本运行 `pnpm run preflight` 成功（退出码0）：格式、ESLint、TypeScript、完整测试及全工作区构建均通过。测试为 **720文件通过、6文件跳过；8464项通过、20项跳过**。ESLint为0错误、234个原有警告；没有增加警告。构建仍提示既有Web大chunk及外部导入警告，不影响构建成功。

首轮全量曾暴露两处旧测试夹具：composition仍断言task不存在、cleanup仍读取terminalWaiters。同步新合同后，64项定向复测通过，随后完整验证通过；最终冻结后再跑完整检查得出上述8464项结果。

代码/测试提交为 `de367e50`（`feat(tools): unify shell job management under task`），文档另作本地提交；留在实施分支等待用户审查，未合并开发分支、未推送。16份改动文档的本地链接检查及diff空白检查通过。

真实进程验证环境为本机macOS，未进行Linux/Windows实机验收、24小时长测或外部模型驱动的ohbaby端到端验收。Pi是代码审查，不等于ohbaby真实模型验收。原D28极端强杀窗口和身份不明不误杀边界保持；跨活跃后端只读，不新增控制转发。

另一后端崩溃后若尚未触发既有恢复/复查入口，output仅观察持久事实，不主动探测PID或取得恢复权，最多等待本次wait_ms；这属于原定有界读取范围，不把“读取超时”伪装成任务执行超时。
