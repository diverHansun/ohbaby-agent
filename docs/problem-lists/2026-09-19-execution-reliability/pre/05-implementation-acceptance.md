# C 阶段组合实施验收（C1 + C2 + C3）

## 范围、基线与验收决定

- 日期：2026-09-26；平台：macOS arm64。
- 独立审查范围：开发分支 `68b11ba2` → C3 `5f14cc16`，包含 C1、C2、C3 的全部十个提交；验收补修另见本文。
- 契约：[C.1–C.9、C01–C15](c-concurrency-and-resource-protection.md)；历史分阶段证据：[C1](c1-implementation-acceptance.md)、[C2](c2-implementation-acceptance.md)、[C3](c3-implementation-acceptance.md)。
- 用户最新决定：Windows/Linux 能力与验证留作后续，不阻塞本次 macOS 范围内整项 C 验收与开发分支合并。未获得的跨平台证据不标为通过。本次没有调用 Pi。
- 结论：按用户指定的 macOS 范围，C1+C2+C3 组合验收通过，具备合入开发分支及进入 improve-2 S0 的条件。平台后续项和并行测试负载敏感性保留，不冒充跨平台或无条件性能保证。

## 实施及组合交付

C1 的锁只负责互斥，真实操作 Promise 结束才释放。C2 将批次顺序、每会话普通容量（默认 10）、直接派遣容量（默认 3）和进程内共享资源分开；真实 owner 由 composition 传入。C3 延续 Bash job 的原始 owner 和环境引用，逻辑结果、所属进程组停止与管道收尾各自结算。来源限制只影响原 root 的相关新调用，独立 root 和受信控制入口仍可工作。

超时/取消先登记保护与清理责任，逻辑结果归还容量；文件和来源保护不因结果、历史上限或清理观察到期而释放。有限观察后未确认的冲突新调用只得到一次普通资源错误，不 invoke、不自动重放。迟到结束只更新原 owner 的 cleanup，不改原结果、不重复归还容量。Full Access 与明确规则自动放行均经过真实 composition owner 路径。

未增加数据库表、持久化状态机、前端清理面板、跨进程锁或全树 Stop。事实可靠保存、保存失败 fatal、SQLite 争用下取消响应和展示仍归 improve-2；整树 Stop 与冷恢复仍归 improve-4。

## 独立审查及验收补修

### Standards

独立子代理发现 1 项 P1：不区分大小写的 macOS 卷上，尚不存在的 `Target.txt` 与 `target.txt` 原先会取得两把写 lease，也能绕过 unconfirmed 保护。真实临时目录复现后增加失败回归，再修复资源标识。资源准入、lease 覆盖和文件批次 plan 使用同一只读卷身份规则；实际执行及权限路径不改写。敏感卷保留大小写，跨挂载边界按各分量所属父卷处理，无法确认时保守冲突。没有创建探测文件或引入通用文件系统管理器。

非阻塞维护项：`executeToolWithTimeout` 同时协调期限、事实、清理与环境寿命，后续修改需维持生命周期测试。按 SWE 的关注点分离原则可在职责进一步扩展时提取局部对象，本次不为函数长度进行额外重构。

### Spec

独立子代理发现 1 项 P2：MCP 客户端本地 abort 后 Promise 立即 reject，scheduler 原先将其发布为 cleanup confirmed，但远端仍可能活动，违反 C.4.1/C.6 的真实停止事实要求。新增真实 scheduler＋adapter＋生产 sanitizer 回归先红后绿。适配器通过受信 WeakMap 声明本地 settlement 不能证明远端停止；取消后保持 unconfirmed，同时正常释放本地空资源/环境引用及调用容量。正常成功或远端工具错误不误报清理异常；不停止共享 MCP server，不扩大来源限制。

### 测试覆盖补强

原有测试分散证明了文件保护、容量归还和独立文件推进，却未在一个真实 Write/Edit 超时场景中证明完整组合门。现对 Write/Edit × 迟到 resolve/reject 四组测试统一配置单槽：A 超时后其 Read/Write 不执行；B 通过真实 scheduler 写读成功；B 再占槽时 A 迟到结束不误还 B 的槽，C 必须等 B 完成。

新增规则自动放行的真实 composition 参数化测试，与 Full Access 一起验证子会话 ancestry、跨 run 来源保护、独立 root 推进、环境 retain 和确认后恢复；两者都断言没有调用 permission.ask。

## C01–C15 验收映射

以下测试路径相对 `packages/ohbaby-agent/src/`。真实模型测试验证完整调用链，确定性竞态测试负责证明互斥、计数及时间边界，两者互不替代。

| ID | 证据与核对结果 |
|---|---|
| C01 | `tools/utils/file-locks.unit.test.ts`：真实 settle 后释放、取消等待者、迟到成功/失败及独立文件。 |
| C02 | `tools/resource-admission.integration.test.ts`、`tools/files.scheduler.integration.test.ts`：真实 Read/Write/Edit、读读并行、写互斥、完整校验到写入受保护、无重复取锁死锁。 |
| C03 | `core/tool-scheduler/resources.unit.test.ts`、`utils/path-canonicalize.unit.test.ts`、resource-admission：别名、symlink、目录树、多资源原子准入；本次补 macOS 缺失目标的大小写别名。 |
| C04 | scheduler/admission/preparation integration：同批必要顺序、公平性、无冲突文件跨过等待、准备取消。 |
| C05 | `adapters/ui-runtime/admission.integration.test.ts` 与 resource-admission：真实 composition 的主/子及另一 root、同进程跨 scheduler/backend 和直接工具入口共享。 |
| C06 | capacity/concurrency/preparation：会话默认十槽、跨批次计数、独立派遣三槽、控制豁免、等待不占容量/期限、准备取消无 invoke/started。 |
| C07 | resource-admission/capacity/Bash scheduler：未知访问形成同批屏障、不同 root 无 dangerous 全局锁、不信任工具名或模型自报控制能力。 |
| C08 | `shell/process.integration.test.ts`：真实 TERM/KILL、leader 先退、关闭管道仍存活、组停但管道未关，以及 50 个真实 zsh 夹具。 |
| C09 | shell unit、shell-job-cleanup、Bash scheduler：缺 PID、终止/探测失败与 helper 拒绝不伪造停止，不越 owner 控制。 |
| C10 | 本次强化的真实 Write/Edit 四组超时测试；Bash scheduler/composition：先交接保护再还槽、跨 run/root 和子会话、sandbox 延迟销毁。 |
| C11 | cleanup、source-cleanup、Bash scheduler/registry：迟到 settle 不重复归还、两个残留独立确认、105 条历史和 dispose 保留 owner、替换 scheduler 不绕过进程级限制。 |
| C12 | Bash scheduler、真实控制工厂、真实 HTTP/LLM smoke：后台派遣归还一次、超时来源保护、task_output/task_kill 可用、确认后仅新调用恢复。 |
| C13 | 文件受控 gate、进程组、服务、SQLite 及临时目录由 fixture finally 清理；不承诺跨进程/重启内存锁。 |
| C14 | cleanup/files/source/Bash scheduler 与 shell unit：正常等待、失败/有限观察转普通准入错误、无 invoke/started、查询不续期，Bash 200ms＋1000ms 与普通 1000ms 分层验证。 |
| C15 | source/resources/cleanup 竞态及文件迟到测试：取消优先、单次结算、不自动重放、确认后新准入恢复，普通竞争不误判异常。 |

## 验证记录

最终稳定代码共覆盖 413 个通过文件、4476 个取得通过结果的测试，另有 6 文件/17 项按既有条件跳过。这里是全量运行加失败文件串行复验的去重覆盖数，**不是一次全量零失败**。原始本机日志位于 `/tmp/ohbaby-pre-c-acceptance-20260926/`，可重复用例保留在仓库，密钥不进入日志或提交。

| 检查 | 命令与真实结果 |
|---|---|
| 全量 unit/contract/integration | `pnpm exec vitest run --maxWorkers=4 --minWorkers=1`：412 文件、4475 项通过，1 个审批历史用例超时；6 文件/17 项跳过，退出码 1，475 秒。 |
| 审批文件完整串行复验 | `pnpm exec vitest run --maxWorkers=1 --minWorkers=1 packages/ohbaby-server/src/coordination/permission-lifecycle.integration.test.ts`：18/18 通过，退出码 0，9.32 秒；原超时用例 6.695 秒。 |
| 真实文件工具 LLM | `OHBABY_RUN_REAL_FILE_TOOLS=1 pnpm exec vitest run --config tests/smoke/file-tools-real.vitest.config.ts`：1/1 通过，55.39 秒、11 次真实模型请求，Read 续读、Grep、Edit、Write 和磁盘结果。 |
| 真实 Bash LLM | `OHBABY_RUN_REAL_BASH_CLEANUP=1 pnpm exec vitest run --config tests/smoke/bash-cleanup-real.vitest.config.ts`：1/1 通过，33.25 秒、7 次真实请求，后台超时→task_output 原状态与 cleanup→新 Bash 输出 C3_RECOVERED。 |
| 子代理端到端 | `pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-agent/src/adapters/ui-runtime/subagent.e2e.test.ts`：8/8 通过，5.90 秒。 |
| 构建与静态检查 | `pnpm run build`、`pnpm run typecheck`、`pnpm run lint` 均退出码 0；所有修改 TS 的 Prettier 及 `git diff --check` 通过。 |

两条真实模型用例均通过 HTTP loopback listener、persistent runtime 和 Zenmux `openai/gpt-5.6-luna`，按 `tests/models-4-tests.md` 读取既有凭据。普通 task_output 的 UI 会展示被观察 job 的 timed_out，测试同时核对原始持久化控制调用 completed 与 cleanup confirmed，不把超时 job 伪装成成功。

审批大批次在并行负载下触及原有 30 秒测试期限。只读阶段计时将主要耗时定位在首个审批前的批次准备和最终 prompt 收口，审批响应本身仅约 1–1.7 秒。两次精确单测 27–28 秒通过；将本轮生产补丁在内存中回退到 `5f14cc16` 的对照约 20 秒通过；重任务结束后的完整文件串行复验中该用例仅 6.695 秒。没有改产品逻辑或扩大测试期限。将并行负载敏感性保留为测试工程后续项，当前证据不支持认定此次资源/MCP 补修造成产品回归。

首轮全量未通过，不计为成功：若干进程/终端用例超时；打包编译读取到了并行补修先红后绿的中间状态（新测试引用的资源标识函数尚未写入）。后续冻结代码、完成构建再降低 worker 数复验，不据此放宽产品断言或增大测试超时。

## 保留边界与 improve-2 交接

- Windows：仍缺少 leader 退出后持续持有进程树归属证据的能力，正常 shell 结果不证明整个树停止，可能长期保留来源限制；单列后续实现与原生验证。
- Linux：尚未原生执行此轮验收；平台 mock 不替代原生证据。
- macOS 资源标识：卷能力探测未知时保守冲突，可能降低并发；Unicode 文件名等价规则未完整覆盖。硬链接、外部进程改写、主动脱组和跨进程/跨重启保护仍不属于 C 的保证。
- 热替换证据由原 owner 持有、dispose 保留及替换 scheduler 共同提供，未将其写成一次实际完整 composition 热替换端到端。整树关闭与冷恢复由第四轮组合验收。
- 没有为纯同步内存登记制造产品级故障注入接口；执行前 retain 失败和登记前 spawn 失败已有回归。灾难性内存耗尽不在进程内可靠性保证内。
- improve-2 S0 可消费 `ToolExecutionOwner`、受信 `ToolAdmission`、`ResourceLease`、`onExecutionFact/onExecutionFactError`、清理与来源等待原因；不得重新造锁/计数/清理负责人。实际开始、逻辑结果、清理以及可等待保存的时序保持分离。
- improve-1 与 improve-1.1 的验收及代码已在开发基线 `68b11ba2` 中。本次仅开放 C 前置，不宣称 improve-2 的 S0 接线或 T03/T06/T08/T16/T19 已实施通过；下一轮仍须按实际接口完成 S0。

## 本地提交及合并记录

验收补修和补强均在 `codex/pre-c3-bash-cleanup` 上分批提交：

| 提交 | 内容 |
|---|---|
| `ffb8b7e9` | macOS 未创建文件的大小写别名资源保护及回归。 |
| `18b6af17` | MCP 取消后的远端未确认事实和生产适配链回归。 |
| `83b96cd3` | C1/C2/C3 真实文件超时组合门、规则放行 owner 验证。 |
| 本记录所在提交 | C 组合验收、平台决定和 improve-2 输入索引。 |

每批保留原有 lint/typecheck 提交钩子且通过。已按授权将 `codex/execution-reliability` 从 `68b11ba2` 依次 fast-forward 到 C1 `0bb2d5a9`、C2 `ad92e49e`、C3 `563bb7d5`，无冲突；合并后 `git diff --exit-code HEAD codex/pre-c3-bash-cleanup` 为空，确认与已验收文件树一致。

开发分支上额外运行 C 组合回归：tool-scheduler 全目录、文件锁及真实文件工具、Bash scheduler/registry、shell 全目录、两份真实 composition、MCP cleanup 与资源路径回归，共 **26 文件、294 项通过**，退出码 0，10.17 秒。最终合并记录作为开发分支上的独立文档提交，不改变已测产品代码。

保留分支：

- `codex/pre-c1-file-lock-lifetime` → `0bb2d5a9`
- `codex/pre-c2-resource-admission` → `ad92e49e`
- `codex/pre-c3-bash-cleanup` → `563bb7d5`

没有删除临时分支、没有 push、没有合入 main。下一次 improve-2 从本开发分支实际状态开始 S0；本次不启动 improve-2 实施。
