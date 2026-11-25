# 4. 测试与验收标准

本文定义 `improve-1` 的验证范围、关键测试场景、回归底线、发布门验收标准及红队对抗检查点。后续实施会话按本文自测，验收会话直接对照本文出具 `05-implementation-acceptance.md`。

> 说明：本仓库暂无独立 `test-blueprint` 文档；子包 `packages/ohbaby-agent` 与 `packages/ohbaby-cli` 自身未定义 `test` 脚本，所有测试由仓库根目录 Vitest 统一收集并执行（`pnpm test` / `pnpm vitest run <path>`）。新增模块细粒度单测规格同步见 [docs/services/instructions/test.md](../../../services/instructions/test.md)。

---

## 4.1 测试范围

| 测试层级 | 覆盖目标 | 主要位置 |
| --- | --- | --- |
| 单元测试（Unit） | `services/instructions` 加载、软链规则、`open` 前文件类型检查、句柄复核与有界读取、总预算分配、去重、扫描、定向转义、提醒状态机与诊断去重；`core/system-prompt` 静态组装；`permission` / `tool-scheduler` `"internal-state"` 分类 | `packages/ohbaby-agent/src/services/instructions/__tests__/*.unit.test.ts`、`core/system-prompt/__tests__/*`、`permission/classifier.unit.test.ts` 等 |
| 集成测试（Integration） | `services/reminder` 顺序与去重、`Lifecycle` → `ContextManager.prepareTurn()` 透传与同一步 compaction 二次收集、三协议 HTTP 夹具同 run 刷新与主/子代理隔离、`goals` 4 个真实工具调度免审批 | `services/reminder/reminder.unit.test.ts`、`tests/integration/adapters/ui-runtime/custom-instructions.integration.test.ts`、`tests/integration/core/context/{project-instructions,environment-reminders}.integration.test.ts`、`core/tool-scheduler/capacity.integration.test.ts` |
| 契约测试（Contract） | Prompt Cache 前缀字节不变性（Anthropic / OpenAI / OpenAI-Compatible）；`ui-inprocess` 安全拦截与指令 warning notice 路由；CLI 渲染契约 | `core/context/prompt-cache-wire.contract.test.ts`、`adapters/ui-inprocess.contract.test.ts`、`packages/ohbaby-cli/src/cli/stdout-renderer.contract.test.ts` |
| 静态检索与文档核查 | 确认生产代码中无遗留 `OHBABY.md`、`resolveLegacyGlobalMemoryPath`、`memory-write`、`"memory"` 工具分类；验证全仓编译、lint、format 与文档无死链 | `rg`（限定生产代码）+ `pnpm typecheck` + `pnpm lint` + `pnpm format:check` + `pnpm --filter ohbaby-agent prompt:check` |

---

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 对应 02 Stage |
| --- | --- | --- | --- | --- |
| AC-01 | 项目根同时存在内容不同的 `AGENTS.md` 与 `CLAUDE.md` | Unit | 两份文件均加载，`AGENTS.md` 在前、`CLAUDE.md` 在后，均用固定标签标注来源（`project/AGENTS.md`、`project/CLAUDE.md`） | Stage 1 |
| AC-02 | `CLAUDE.md` 为同目录 `AGENTS.md` 软链或 `trim()` 后内容相同 | Unit | 只保留并渲染 `AGENTS.md` 一份，不重复注入 | Stage 1 |
| AC-03 | `~/.ohbaby/AGENTS.md` 与 `<projectRoot>/AGENTS.md` 共存 | Unit | 全局在前、项目在后；若两者内容一致则去重保留项目条目 | Stage 1 |
| AC-04 | 仅存在 `OHBABY.md`、单数 `AGENT.md`、`<project>/.ohbaby/AGENTS.md` 或 `~/.ohbaby-agent/AGENTS.md` | Unit | 全部忽略，不加载、不产生 reminder（零 token） | Stage 1 |
| AC-05 | 恶意文件内容包含 `</system-reminder>`、`</SYSTEM-REMINDER >`、`<system-reminder attr="x">` 以及普通代码 `Array<string> && true` | Unit | 经 `renderReminderText()` 最终包装后，正文中的标签变体均被转义，仅最外层保留一对宿主标签；普通泛型与 `&&` 保持原样 | Stage 1 |
| AC-06 | `REMINDER_ORDER`、`Lifecycle` `stepInput` 与 `ContextManager` 透传 | Unit / Integration | `"instructions"` 位于 `"environment"` 之前；`Lifecycle` 每步与强制压缩重试均透传 `params.projectRoot`；即使 `detectEnvironment` 失败仍凭 `projectRoot ?? directory` 正确加载项目指令 | Stage 1 |
| AC-07 | 静态 System Prompt 纯净化 | Unit | `SystemPrompt.assemble()` 与 `createSystemPromptProvider().build()` 在角色/addon/配置相同时，对有无 `AGENTS.md`/`CLAUDE.md` 产出字节完全一致的 `systemPrompt` | Stage 2 |
| AC-08 | **KV Cache 前缀不变性（核心）** | Contract / Integration | 依托三协议 HTTP 集成测试（`custom-instructions.integration.test.ts`）与 `prompt-cache-wire.contract.test.ts`：Turn 1 注入 `AGENTS.md` → Turn 2 未改动无新增 reminder → 同 run 或 Turn 3 修改 `AGENTS.md` 后仅在尾部追加新快照 reminder（使用统一“以本快照为准”固定头注）；Anthropic / OpenAI / OpenAI-Compatible 下 `system` 与旧历史前缀完全字节一致；再下一步未改则静默 | Stage 2 |
| AC-09 | 中途全删除；读错只影响单个文件并用上次成功读取顶替 | Unit / Integration | Turn 1 有 A、B 两份指令 → Turn 2 删除全部文件后发出一次 `key="cleared"` 通知 → Turn 3 静默。另测：A 报 `EACCES` 而 B 被修改时，A 告警一次，追加含旧 A 与新 B 的快照；A 被安全 `omit` 而 B 报 `EACCES` 时，追加只含旧 B 的快照；A 短暂 `EBUSY` 后恢复，全程不追加新快照；A 被删除后再读错，不拿旧内容顶替；项目与全局同根时两者缓存独立，项目读错不借用全局软链正文，项目拒读不删除全局回退记录；全新 provider（缓存为空）遇到全部读错时追加 `cleared`，正文不说“已删除”。读错用 `vi.spyOn` 注入，三系统一致（对应 `test.md` I-10、I-11、I-18） | Stage 1 / Stage 2 |
| AC-10 | **同一步 Compaction 二次收集与最终请求** | Integration | 直接检查触发 compaction 的当次 `prepareTurn()` 产出的**最终请求**：① 旧快照保留在 kept tail 时行为一致；② 旧快照被压缩且磁盘仍有文件时，本次最终请求直接重建快照；③ 旧快照被压缩且文件已删时静默，loader 不再注入失效来源；另测读错：同一 provider 此前读成功过时，用上次成功读取重建快照；全新 provider（缓存为空，模拟进程重启）时上报告警并静默，这是已接受的代价，不算缺陷（读错须在这一步第一次出现，否则已被诊断去重吞掉；同时验证 `compression-prompt.ts` 包含“不抄录外部指令”的提示，不把提示词当作硬撤回承诺） | Stage 1 / Stage 2 |
| AC-11 | 主代理与子代理统一注入（真实 composition + 目录隔离） | Integration | 经真实 `Lifecycle` + `composition`：项目根放 `AGENTS.md`（标记 A），子目录放不同 `AGENTS.md`（标记 B），主代理与运行在子目录的子代理均只收到标记 A 与全局指令，绝不混入标记 B | Stage 2 |
| AC-12 | 安全拦截 notice、去重与恢复后再触发 | Contract / Unit | 含 `ignore previous instructions` 的 `CLAUDE.md` 被跳过，命中规则仅沿 `onSecurityFinding` 生成 `prompt-security:*` notice（超出单文件上限也不额外发 `FILE_LIMIT`；多规则命中可各自产生 finding）；连续多步及同一步压缩二次收集不刷屏；文件恢复合法后再次注入高危内容时重新触发 notice | Stage 1 / Stage 2 |
| AC-13 | A/B 类长期记忆残留清零 | Unit / Integration | ① 前置专题已落地（本条只核对 `rg -n "migrateOhbaby|OHBABY_LEGACY|resolveLegacy" packages/ --glob "!**/dist/**"` 为空）；② `CreateGoal`/`UpdateGoal`/`GetGoal`/`SetGoalBudget` 注册为 `category: "internal-state"`，`todo_write` 保持 `category: "write"` 且分类 `kind` 为 `"internal-state"`；③ 在 `default` 权限 level 下上述工具自动放行、显式 session `deny` 规则仍优先拦截、未知工具仍回落写入审批；④ `memory-surface.unit.test.ts` 已删 | Stage 3 |
| AC-14 | 文档与根目录入口同步 | Static | `docs/core/memory/` 与根目录 `OHBABY.md` 已删除；`.gitignore` 忽略 `/AGENTS.md` 与 `/CLAUDE.md`（本地文件改名为 `AGENTS.md` 只在开发者本机核对，CI 不检查）；`README.md`、`README.zh.md`、`packages/ohbaby-cli/README.md` 的指令章节改为 `AGENTS.md` / `CLAUDE.md` 新规则；受影响模块权威文档（含 `docs/core/context/{architecture,test}.md`、`docs/tools/{architecture,goals-duty}.md`、`docs/core/tool-scheduler/goals-duty.md`、`docs/config/agents/goals-duty.md`）与 `docs/services/instructions/` 双向链接有效 | Stage 4 |
| AC-15 | **软链规则（Critical 安全门）** | Unit / Integration | 项目根 `AGENTS.md` 分别软链到：项目根外标记文件、项目根内 `.env` 标记文件、`docs/rules.md`、悬空目标，均拒读并各告警一次，标记内容既不出现在持久化历史中，也不出现在最终模型请求中；`CLAUDE.md -> AGENTS.md` 与 `AGENTS.md -> CLAUDE.md`（字面目标为另一固定文件名且兄弟为普通文件）静默跳过、只加载一份；全局 `~/.ohbaby/AGENTS.md` 软链到临时 dotfiles 目录时正常加载。全局根防劫持（项目 `.env` 写 `OHBABY_HOME=<attackerDir>`）由前置专题 AC-12 把关，本专题开工前已通过。Windows 上创建软链报 `EPERM` 时跳过这些软链子用例（对应 `test.md` I-13） | Stage 1 / Stage 2 |
| AC-16 | **合并总预算、截断原因码与小窗口模型行为** | Unit / Integration | 4 份大文件超出默认 `64 * 1024` 字节总预算时（单位为 UTF-8 字节，中文截断后不出现 `U+FFFD`），按「项目优先于全局、`AGENTS.md` 优先于 `CLAUDE.md`」截断/省略并上报固定原因码 `FILE_LIMIT` / `TOTAL_LIMIT` 的 warning，被截断的文件在渲染正文末尾带 `[Truncated: …]` 提示；只改单文件 `32 * 1024` 字节之后不可见后缀时不追加新快照；总预算只剩 1 字节遇到多字节中文开头时整份记 `budget-omitted`、不生成空 `InstructionSource` 也不产出 `U+FFFD` 且保留剩余字节给后续更短条目；小上下文窗口模型在首轮及压缩重建时行为可预测（不因无总预算意外撑爆，真正超模型上限时显式走 `context_overflow`）（对应 `test.md` I-14） | Stage 1 / Stage 2 |
| AC-17 | **特殊文件、无法识别的编码与平台打开标志（安全门）** | Unit | 项目根 `AGENTS.md` 为 FIFO、同名目录或 UTF-8 和 GB18030 都解不了的文件、同目录 `CLAUDE.md` 合法、活跃历史已有旧快照：通过 spy 确认 `fs.open` 对静态 FIFO / 目录根本未被调用并只告警一次，解不了的文件按 `kind: "rejected"`、`code: "INVALID_ENCODING"` 跳过并告警，`CLAUDE.md` 的修改照常追加只含 `CLAUDE.md` 的新快照；另验证正常文件 `fs.open` 传入的 flags 符合平台策略（POSIX 项目含 `O_NOFOLLOW \| O_NONBLOCK`、POSIX 全局含 `O_NONBLOCK` 且不含 `O_NOFOLLOW`、Windows 为 `O_RDONLY`）（对应 `test.md` I-15；FIFO 用例在 Windows 上跳过，目录、无法识别的编码与 flags 用例按平台覆盖） | Stage 1 |
| AC-18 | **模型看不到本机路径与 `HOME_UNRESOLVED`** | Unit | 最终包装文本只出现 `global/AGENTS.md`、`project/CLAUDE.md` 这类固定标签，不出现临时目录的绝对路径；warning 回调里的 `sourcePath` 仍是绝对路径；宿主 `OHBABY_HOME` 为非法相对路径时跳过全局作用域、项目指令照常加载，warning 的 `sourcePath` 为 `"global"`、UI 标题为 `"global instructions skipped"`（对应 `test.md` I-16） | Stage 1 |
| AC-19 | **扫描器行号计算不再是平方级** | Unit | `security/prompt-security.unit.test.ts` 新增多命中用例（同一文本中数千处命中、分布在不同行），断言每条 finding 的行号正确；不做计时断言（三系统 CI 上计时不稳），靠代码审查确认行号随匹配位置单向推进或使用预建换行索引；MCP 相关扫描测试不回归 | Stage 1 |
| AC-20 | **指令 warning 送达 UI 与项目级去重** | Contract / Unit | 项目 `AGENTS.md` 为非别名软链时，UI 只收到一条 key 为 `instructions:${sourcePath}:rejected`、title 为 `AGENTS.md skipped` 的 warning 通知；连续多步与同一步压缩二次收集不再出现；截断场景 title 为 `… truncated`，总预算整份省略时为 `… skipped`，`HOME_UNRESOLVED` 时为 `global instructions skipped`；同一 `projectRoot` 下另一个会话（模拟子代理）不再收到同一条 warning（对应 `test.md` I-08） | Stage 1 / Stage 2 |
| AC-21 | **多编码加载，用户不需要手动转换** | Unit | 带 BOM 的 UTF-8 / UTF-16 LE / UTF-16 BE、无 BOM 的 GBK 和纯中文 UTF-8 写的同一段正文都能加载，结果完全相同且不含 `U+FEFF`；UTF-8 不被误判为 GB18030；超长 UTF-16 文件按解码后的 UTF-8 字节截断并上报 `FILE_LIMIT`，截断处没有半个字符或孤立代理项；内容相同、编码不同的 `AGENTS.md` / `CLAUDE.md` 去重为一份（对应 `test.md` I-17，三平台都跑） | Stage 1 |
| AC-22 | HTML 与 JSONL 导出隐藏提醒过滤 | Integration | 同一会话含普通用户和助手正文、instructions 及另一类隐藏 reminder。两种导出的会话数据均只保留普通正文；普通正文中手写的同名标签保留，隐藏 reminder 不贡献空消息或消息计数。HTML 检查其内嵌的会话数据。 | Stage 2 |


> **“不进入历史/请求”的承诺范围**：AC-12、AC-15 等说的“不出现在历史和请求中”，只适用于**从未被接纳**的内容（读取前被拒、扫描时被 `omit`）。如果某份内容以前已经注入过、现在才失效，追加的更新快照或 `cleared` 只能告诉模型它不再适用，不会从历史中删除已发出的旧正文；旧正文在被压缩掉之前仍会随请求发送。验收只检查“新快照不含它、最新快照替代旧快照”。
---

## 4.3 集成边界

1. **`core/lifecycle` ↔ `core/context` ↔ `services/reminder` ↔ `services/instructions`**：验证 `Lifecycle` 每步 `stepInput` 透传 `projectRoot`、`ContextManager` 透传路径、同一步 compaction 两次收集只持久化第二次候选，以及 `arrangeReminderHistory()` 在多轮与失败重试后的顺序稳定。
2. **`services/instructions` ↔ `core/system-prompt/security` ↔ `adapters/ui-runtime/composition`**：验证高危指令被安全拦截后，既不会进入 model request，也仅沿 `onSecurityFinding` → `noticeFromPromptSecurityFinding` 发送 `prompt-security:*` notice（不重发通用 `onWarning`）；普通 warning 沿 `onWarning` → `noticeFromInstructionWarning` 发送 `instructions:*` notice。
3. **`goals` ↔ `core/tool-scheduler` ↔ `permission`**：验证 `category: "internal-state"`（`CreateGoal`/`UpdateGoal`/`GetGoal`/`SetGoalBudget`）与 `todo_write`（`category: "write"`、`kind: "internal-state"`）在工具注册、调度与权限评估三处完全闭合，且 `evaluator.ts` 经 `never` 穷尽检查无漏分支。

---

## 4.4 回归清单

改造完成后以下既有能力**绝不可退化**：
- `environment`、`mode`、`mcp-catalog`、`todo`、`skill-usage` 现有 5 类 reminder 的排序、去重、UI 隐藏与压缩后重建行为不变。
- `todo_write` 与 `CreateGoal` / `UpdateGoal` / `GetGoal` / `SetGoalBudget` 在 `default` 权限 level 下继续免审批放行，且显式 session `deny` 规则优先拦截。
- 老会话（无 `instructions` reminder，或历史消息含字面 `<memory>` 文本）冷恢复不报错、不改写历史文本。
- `pnpm --filter ohbaby-agent prompt:check` 继续通过（静态 `.md` 模板与 `templates.generated.ts` 保持同步）。
- C 类 RAM 内存存储（`InMemory*`、`:memory:`、`adapters/ui-state/memory-store.ts` 等）零误伤。

---

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
| --- | --- | --- |
| 类型与资源校验 | 全仓 TypeScript 编译与 prompt 模板校验零报错 | `pnpm typecheck && pnpm --filter ohbaby-agent prompt:check` |
| 全量自动化测试 | 根目录 Vitest 全量运行通过，且**显式核对执行测试文件数与用例数 > 0**（含 AC-01 至 AC-22，禁止因 `--passWithNoTests` 零用例误过） | `pnpm test`（外加定点复核：`pnpm vitest run packages/ohbaby-agent/src/services/instructions/ tests/integration/adapters/ui-runtime/custom-instructions.integration.test.ts tests/integration/core/context/project-instructions.integration.test.ts tests/integration/core/context/environment-reminders.integration.test.ts packages/ohbaby-agent/src/core/context/prompt-cache-wire.contract.test.ts`） |
| 静态残留清零（生产代码） | 生产代码中零 `OHBABY.md`、零 `resolveLegacyGlobalMemoryPath`、零 `memory-write`、零 `ToolCategory`/`PermissionToolCategory` 的 `"memory"`（允许 AC-04 负例测试中构造 `OHBABY.md` 夹具） | `rg -n "OHBABY\.md|resolveLegacyGlobalMemoryPath|memory-write" packages/ apps/ README.md README.zh.md --glob '!*.lock' --glob '!*.test.*'` 返回空；`rg -n '"memory"' packages/ohbaby-agent/src/{core/tool-scheduler,permission,goals}/ --glob '!*.test.*'` 返回空 |
| 代码风格与格式 | Lint 与格式检查通过 | `pnpm lint && pnpm format:check` |
| 文档一致性 | `docs/core/memory/` 已删除；`docs/services/instructions/` 完整；`docs/core/system-prompt/`、`docs/project/`、`docs/permission/`、`docs/goals/`、`docs/core/tool-scheduler/`、`docs/core/context/architecture.md`、`docs/tools/architecture.md` 与代码一致 | 人工对照 `02 Stage 4` 逐项核对并检验相对链接零报错 |

---

## 4.6 对抗性审查要点（红队视角）

1. **攻击面 1 · 借软链或项目 `.env` 劫持 `OHBABY_HOME` 把私密文件发给模型（Critical）**
   - *风险*：陌生仓库提交 `AGENTS.md -> ~/.ssh/id_rsa`（指向项目根外），或 `AGENTS.md -> .env`（指向项目根内、但 `.env` 是用户本地未提交的私密文件），或通过项目 `.env` 写入 `OHBABY_HOME=<恶意绝对路径>` 诱导全局分支跟随软链，将敏感内容读入隐藏历史并发送给远程 LLM；`scanPromptLikeContent()` 无法识别普通敏感文本。
   - *防御*：项目作用域用 `lstat` 只读普通文件，软链一律不读；同目录 `CLAUDE.md` / `AGENTS.md` 经 `readlink` 严格字面匹配且兄弟为普通文件时静默跳过，其他软链跳过并告警。判断不依赖 `realpath` 前缀比较，不受大小写、Windows 盘符、UNC、junction 差异影响。前置专题让 `utils/project-env.ts` 不接受项目 `.env` 里的 `OHBABY_HOME`、`HOME`、`USERPROFILE`，全局作用域在此前提下跟随软链（前置专题 AC-12 用合法绝对路径 `OHBABY_HOME=<attackerDir>` 验证）。AC-15 断言被拒内容未进入持久化历史与最终请求。
   - *残余风险*：用户主动把敏感内容写进项目根的普通文件 `AGENTS.md`，属仓库内正常文本，无法在路径层区分；用户若自己在宿主环境里把 `$OHBABY_HOME` 指到陌生仓库，全局作用域会跟随其中的软链，用户文档需提示不要这样设置。
2. **攻击面 2 · 符号链接循环、FIFO、特殊设备文件或超大文件**
   - *风险*：仓库放置 FIFO 命名管道、指向 `/dev/zero` 的软链或数百 MB 的文件作为 `AGENTS.md`。对 FIFO 调用无标志 `fs.open()` 会一直阻塞（已实测：promise 永不返回，进程也无法正常退出），每一步 `prepareTurn()` 都会挂住；无界 `readFile` 读超大文件或设备文件会导致 OOM。
   - *防御*：打开文件**之前**先确认是普通文件（项目用 `lstat`，全局用 `stat`），FIFO、目录、设备节点直接跳过并告警，其他候选照常处理；确认后再沿用仓内平台 flags 打开（POSIX 项目 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`，POSIX 全局 `O_RDONLY | O_NONBLOCK`，Windows `O_RDONLY`），并对句柄 `stat()` 复核仍是普通文件，再做有界字节读取（不用无界 `readFile`），叠加单文件（`32 * 1024`）与合并总预算（`64 * 1024`）。AC-17 锁定静态 FIFO 根本不调 `open` 且平台 flags 符合策略。
   - *残余风险*：Windows 上不支持 `O_NONBLOCK`（但 Windows 本身无 POSIX FIFO 路径）；检查到打开之间若被本地进程换成另一个普通文件，本模块不识别（需要本地进程配合，不在威胁模型内）；合法超长文件（>32K/64K）会被截断并告警，符合预期。
3. **攻击面 3 · 更新循环振荡与同一步 Compaction 竞态**
   - *风险*：若 `key` 计算不稳定，或压缩后旧项目规则在文件已删除的情况下死灰复燃，会导致每步重复注入或继续遵循过时规则。
   - *防御*：取消双模式渲染，所有非空快照使用同一固定头注，`key` 仅由去重后的 `sources` 确定性计算，并由 collector 直接向 provider 传入 `previousKey`；`compression-prompt.ts` 提示不抄录外部指令文件；AC-08 与 AC-10 分别锁定多步静默与压缩当次最终请求行为。
   - *残余风险*：用户外部脚本高频连续改写 `AGENTS.md` 时每步仍会追加新快照，属预期行为。
4. **攻击面 4 · 恶意仓库标签闭合逃逸与提示词注入**
   - *风险*：陌生仓库在 `AGENTS.md` 中写入 `</system-reminder>`、`</SYSTEM-REMINDER >`、`<system-reminder attr="x">` 试图破坏宿主 reminder 正文结构。
   - *防御*：先经 `scanPromptLikeContent` 拦截高危指令，再经大小写不敏感正则转义所有 `<system-reminder...>` / `</system-reminder...>` 变体（来源只写固定标签，不插入路径），并在头部显式声明低优先级不授额外权限（AC-05 针对最终包装输出校验）。
   - *残余风险*：规则扫描无法穷尽所有自然语言社会工程学诱导；终极防线仍依赖宿主 `permission` 审批门禁。
5. **攻击面 5 · 权限类别改名遗漏导致安全降级或误阻断**
   - *风险*：`CreateGoal`/`UpdateGoal`/`GetGoal`/`SetGoalBudget` 改为 `"internal-state"` 后，若 `evaluator.ts` 仍有宽泛 `default` 分支且漏配 `case "internal-state"`，TypeScript 不会报错，运行期会直接拒绝或弹出异常审批。
   - *防御*：在 `evaluator.ts` 保留 `never` 编译期穷尽检查 `PermissionCallKind` 并对异常运行时值保持 fail-closed 拒绝；AC-13 显式覆盖 4 个真实 goal 工具、`todo_write`、显式 session `deny` 优先级与未知工具回落写入审批。
   - *残余风险*：无；编译期与运行期测试双重锁定。
