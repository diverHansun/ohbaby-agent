# 讨论记录与已确认要点

> 2026-11-24 与用户讨论定稿。正式现状分析、改造方案与验收标准见 `01`–`04`，新增模块设计见 [docs/services/instructions/](../../../services/instructions/goals-duty.md)。

---

## 1. 背景与动机

1. **KV Cache 击穿与角色优先级错位**：当前 `ohbaby-agent` 在 `SystemPrompt.assemble()` 中直接拼入用户/项目指令文件。只要用户修改指令文件，静态 system prompt 字节即改变，导致会话级 prompt cache 前缀全部失效；同时放进 `system` 角色人为拔高了用户项目指南的优先级。
2. **定位纠偏与行业对齐**：2026 年底行业已围绕 `AGENTS.md`（Linux Foundation / AAIF 开放标准）与 `CLAUDE.md` 收敛；私有文件名 `OHBABY.md` 以及把这些文件视作“全局记忆”的历史设计已过时。
3. **长期记忆历史残留未清干净**：虽然早先移除了独立 `MemoryLoader` 与 `<memory>` 注入，但代码与文档中仍残存旧全局记忆路径、迁移代码、空壳文档以及借用 `"memory"` / `"memory-write"` 命名的工具与权限分类。未来的长期记忆将由独立仓库重新设计，不再与 `ohbaby-agent` 耦合。

---

## 2. 已确认：目标与范围

| 决策项 | 结论 |
| --- | --- |
| System Prompt 纯净化 | 从 `SystemPrompt.assemble()` 中彻底移除指令加载与 `<custom_instructions>` 层；删除 `core/system-prompt/services/custom-instruction-loader.ts` 与 `core/system-prompt/layers/custom.ts` |
| 注入通道与 Cache 策略 | 复用现有 `services/reminder` 管道，新增 `services/instructions` 模块，作为持久化、只追加（append-only）的 `user` 侧 `<system-reminder>` 注入；历史永不原地改写 |
| 支持的文件名 | 统一支持行业标准 **`AGENTS.md`**（复数）与 **`CLAUDE.md`**；彻底移除 `OHBABY.md`；**不兼容**单数 `AGENT.md` |
| 同目录共存策略 | `AGENTS.md` 与 `CLAUDE.md` 同时存在时**两者都读**，按 `trim()` 后内容哈希去重（副本只注入一份；项目内同目录软链别名直接跳过，见 §6 R2） |
| 作用域 | 保留两层：**用户全局级**（`resolveOhbabyHome()` 即 `~/.ohbaby/` 下）+ **项目级**（会话项目根下）；全局在前、项目在后，项目优先于全局，两者均低于 system / 权限规则 / 当前用户直发指令 |
| 项目内目录扫描 | 采用**项目根**单层扫描（使用会话 `projectRoot ?? directory`），不做深层子目录遍历或工具 touch 动态发现 |
| 主/子代理范围 | 主代理与子代理**统一注入**（`audience: "both"`） |
| 长期记忆残留清理 | **A 类**（`resolveLegacyGlobalMemoryPath` 与 `migration` 旧全局记忆迁移由前置专题先删除，见 §6 R3；本轮删除 `docs/core/memory/` 与幽灵 `memory_*` 工具测试）与 **B 类**（`ToolCategory` / `PermissionToolCategory` / `PermissionCallKind` / `goals/tools.ts` 中 `"memory"` / `"memory-write"` 命名）均尽量清理干净 |
| 文档与审查流程 | 已有代码改造按 `plan-code-improvement` 产出 `00`–`04`；新增模块按 `plan-module-design` 产出 `docs/services/instructions/`；完成后内部自检并提交 `openai-codex`（`gpt-6.2` / high）审查；本会话暂不实施代码 |
| 轮次与关键改动清单 | 本议题一轮闭合（全部放 `improve-1/`，轮内分 Stage）；用户未要求在 `02` 写入关键改动清单（§2.9 按规省略） |

---

## 3. 已确认：边界（不做的事）

| 项 | 本轮不做 / 后续去向 |
| --- | --- |
| 新的长期记忆系统 | 独立仓库另行设计，本仓库不再承载长期记忆逻辑 |
| 项目子目录递归 / tool touch 发现 | 本轮不做，后续若大型 monorepo 有明确痛点可增量扩展 |
| 文件系统 `fs.watch` 热监听 | 本轮不做，直接按步读取 4 个固定候选路径 |
| `@path` 导入 / `.claude/rules/` / `*.local.md` | 本轮不做，保持 KISS |
| 旧路径兼容（`~/.ohbaby-agent/`、`~/.config/ohbaby-agent/OHBABY.md`、`<project>/.ohbaby/`） | 本轮彻底移除直接探测；`~/.ohbaby-agent/` 已废弃，整套迁移代码由前置专题先删除（见 §6 R3），本轮不再改 `migration/` |
| 子代理按角色跳过指令（如 `Explore` 跳过） | 本轮不做，主/子代理统一注入 |
| RAM 内存类命名（`InMemory*`、`:memory:`、`adapters/ui-state/memory-store.ts` 等） | 非长期记忆，严禁误删或误改 |

---

## 4. 已确认：与关联议题/模块的关系

- **新增模块权威设计**：[docs/services/instructions/](../../../services/instructions/goals-duty.md) 定义新模块边界与契约。
- **受影响既有权威文档（实施阶段需同步更新）**：
  - [docs/core/system-prompt/](../../../core/system-prompt/goals-duty.md)（移除 G4/D4 custom instructions 层与 `custom-instruction-loader` 描述）
  - [docs/core/memory/](../../../core/memory/architecture.md)（整目录移除）
  - [docs/project/](../../../project/architecture.md)（删除过期的 `Memory 模块管理 OHBABY.md` 段落）
  - [docs/core/tool-scheduler/](../../../core/tool-scheduler/data-model.md)、[docs/permission/](../../../permission/data-model.md)、[docs/goals/](../../../goals/data-model.md)（同步 `ToolCategory` / `PermissionToolCategory` / `PermissionCallKind` 从 `"memory"` / `"memory-write"` 迁移至 `"internal-state"`）
  - [docs/core/context/architecture.md](../../../core/context/architecture.md) 与 [docs/tools/architecture.md](../../../tools/architecture.md)（同步更新指令刷新时机与清除 `memory_*` 工具示例）
  - 仓库根目录：删除 [OHBABY.md](../../../../OHBABY.md)，将根目录指南规范为 `AGENTS.md` / `CLAUDE.md`，同步更新 [packages/ohbaby-cli/README.md](../../../../packages/ohbaby-cli/README.md)。

---

## 5. 参考项目

本方案参考了同级 `code-cli/` 目录下的 `deepseek-harness`（`dsh`）、`kimi-code`、`ZCode`、`codex` 与 `claude-code` 源码实现，详细对比与取舍见 [03-reference-projects.md](./03-reference-projects.md)。

---

## 6. 实施前评审修订（2026-11-24）

对照代码与参考项目复核方案后，逐条与用户确认的修订如下。每条确认后已同步到 `02`、`04` 与 `docs/services/instructions/`。

| 编号 | 问题 | 结论 |
| --- | --- | --- |
| R1 | 原方案先 `fs.open()` 再对句柄检查 `isFile()`。对 FIFO 调用 `open` 会无限阻塞（已实测），恶意仓库放一个 `mkfifo AGENTS.md` 就能挂住每一步 `prepareTurn()` | 改为打开前先 `fs.stat()` 校验 `isFile()`，非普通文件跳过并告警；按确定性拒绝处理（`hadReadError` 后来在 R2 中整个删除）；不用 `O_NONBLOCK`（Windows 无此常量）；接受 `stat` 与 `open` 之间的极短 TOCTOU 窗口 |
| R2 | Pi（`openai-codex/gpt-6.2-astra`，high）安全审查发现：① 项目根内的软链也可能指向未提交的 `.env`，“真实路径在根内”拦不住 `AGENTS.md -> .env`；② “任一候选读错就整体保留旧快照”会让一个持续读错的文件冻结其他文件的刷新，连另一份文件刚被安全拒绝都公告不出去；③ 模型侧来源写绝对路径，既要转义又泄露本机目录名；④ 扫描器 `lineForIndex` 每次命中都从头数换行，是平方级开销（已核实，见 `core/system-prompt/security/index.ts:207`）；⑤ 验收里“不进入历史/请求”没有区分从未接纳和曾经接纳的内容 | ① 项目作用域用 `lstat` 只读普通文件，软链一律不读：同目录 `CLAUDE.md` / `AGENTS.md` 别名静默跳过，其他软链跳过并告警；全局作用域用 `stat` 跟随软链（用户选定：`$OHBABY_HOME` 由用户自己设置，兼容 dotfiles），用户文档提示不要把它指到陌生仓库；删除 `realpath` 前缀比较。② 删除 `hadReadError` 与整体保底：每步只采用本步验证通过的文件，读错只影响那份文件；历史有旧快照而本步一份可用的都没有时发 `cleared`，正文不推测原因。③ 来源只写固定标签 `global/AGENTS.md` 等，路径不再转义。④ `open` 后对句柄 `stat({ bigint: true })` 复核类型和 `dev` / `ino`；检查与 `open` 之间的窗口明确列为残余风险（只防静态陌生仓库）。⑤ 修复扫描器行号计算。⑥ 04 补充承诺范围：追加通知不会删除历史里已发出的旧正文。⑦ 三系统适配：只看文件类型和 `dev` / `ino`，不比较路径字符串；不用 `O_NONBLOCK`；读错测试用 `vi.spyOn` 注入而不用 `chmod`；Windows 上软链创建报 `EPERM` 时跳过用例，FIFO 用例只在 macOS / Linux 跑 |
| R3 | 原方案在 `migrateConfigTree()` 里新增规则，跳过旧配置根下的 `AGENTS.md` / `CLAUDE.md` / `OHBABY.md`。评审时一度担心这会丢掉用户放在 `~/.ohbaby-agent/` 的全局指令；用户随后确认 `~/.ohbaby-agent/` 已废弃、不再兼容 | 撤掉跳过规则，本轮不再修改 `migration/`。删除整套迁移代码（`migration/`、`resolveLegacy*`、`OHBABY_LEGACY_*` 及其调用方）拆成独立专题，**作为本轮的前置条件先完成**；前置专题同时删除 `resolveLegacyGlobalMemoryPath` 和旧 loader 里的旧路径探测，本轮不再碰 `paths/`。02 §2.3 写明开工前的 `rg` 检查（结果应为空） |
| R4 | 原方案单独建 `diagnostic-deduper.ts`：512 条先进先出 Map、五段式指纹、文件恢复后清理旧键。每步最多 4 个文件，这套淘汰和清理逻辑过重；02 §2.6 还写了“会话释放时清理”，和“不需要销毁钩子”自相矛盾 | 删除 `diagnostic-deduper.ts`，去重逻辑放进 `reminder.ts`：每个会话记一份上一步仍存在的诊断签名集合（`filePath + kind + detailKey`），每步只上报新出现的，再用本步结果替换；集合为空就删除会话条目。借鉴 Codex `active_warnings`。不设上限、不淘汰、不需要销毁钩子；按 `sessionId` 分组，主代理与子代理不重复报 |
| R5 | 原方案让 provider 接收 `onWarning`，但 `composition.ts` 目前只接了 `onSecurityFinding`，warning 变成什么样的 UI 通知没有定义；回调参数也只是字符串，去重时还得解析 | `onWarning` 改为结构化参数 `{ sourcePath, kind, code, message }`。在 `prompt-context.ts` 新增 `noticeFromInstructionWarning()`：key 为 `instructions:${sourcePath}:${kind}`，title 为 `<文件名> skipped` 或 `<文件名> truncated`，沿用仓库其他 warning 通知的写法。安全发现仍走常驻的 `prompt-security:` 通道，指令 warning 作临时通知。新增 AC-20 |
| R6 | 02 §2.5 原计划在包根新增导出 `createInstructionsReminderProvider`、`loadInstructions`，作为旧导出的替代入口 | 不新增包根导出。仓内其他包没有引用旧的 `loadCustomInstructions` 等符号；现有 5 个 reminder provider 和 `ReminderProvider` 类型都不从包根导出，单独导出会不一致，还要长期当公开接口维护。Breaking Change 清单不变，以后确有外部需求再加 |
| R7 | 长度单位混用：读文件说按字节有界读取，截断和总预算却写 UTF-16 码元。中文 UTF-8 一个字 3 字节，读取上限会先于截断上限触发，`truncated` 标记不准 | 全部统一为 UTF-8 字节：单文件 `32 * 1024`、总预算 `64 * 1024`，量的是文件正文按 UTF-8 编码后的字节数，不含渲染外壳。读取时多读 1 字节判断超限；截断退到完整字符边界，不留半个汉字。参数改名 `maxFileBytes` / `maxTotalBytes`。参考 Codex `project_doc_max_bytes` |
| R8 | 子代理审查（Opus）发现：子代理跑在自己的子会话里（`subagent-host.ts` 的 `createChildSession()` 带 `parentId` 新建会话），`sessionId` 与主代理不同，R4 写的“主代理与子代理共用诊断集合”不成立 | 用户选定：每个会话各报一次，不改 reminder 契约。UI 按 notice key 替换同 key 通知，界面上仍只显示一条。改正 data-model、02 §2.2 与 I-08 的说法 |
| R9 | 根目录 `AGENT.md` / `CLAUDE.md` 是 `.gitignore` 忽略的本地个人文件，Stage 4“重命名为 `AGENTS.md`”的前提不对；根 `README.md` / `README.zh.md` 第 156 行的旧规则两个专题都没覆盖 | 用户选定：`AGENTS.md` 保持本地不提交，`.gitignore` 的 `/AGENT.md` 改为 `/AGENTS.md`，仓库只删被跟踪的 `OHBABY.md`。两份根 README 与 `docs/core/context/test.md`、`docs/tools/goals-duty.md`、`docs/core/tool-scheduler/goals-duty.md`、`docs/config/agents/goals-duty.md` 补进 Stage 4 与 AC-14 |
| R10 | 同一次审查的其他问题：总预算截断后 `truncated` / `contentHash` 含义未定义；`budget-omitted` 标题写成 truncated；`previousKey` 过滤规则与 `cleared` 正文归属未写；全局目录解析失败会连带丢掉项目指令；Stage 1 完成标准含 Stage 2 才能跑的用例；Breaking Change 清单有误列漏列；还残留“按路径去重”“读错保守降级”旧说法 | 逐项补定义并改正：总预算截断也置 `truncated`、`contentHash` 随 `content` 重算、渲染不额外提示；`budget-omitted` 标题为 skipped；`previousKey` 与 collector 同一过滤条件，`cleared` 正文为 renderer 常量；全局目录解析失败只跳过全局作用域；I-12/I-13 的请求层部分移到 Stage 2；大小写不敏感文件系统列为已知差异 |
| R11 | 2026-11-25 复审（Pi `gpt-6.2-astra` high + 源码核实）发现 Blocker：`utils/project-env.ts` 的 `loadRuntimeEnvIntoProcessEnv()` 先加载项目 `.env`（`override: false`），后解析 `OHBABY_HOME`。用户 shell 未预设 `OHBABY_HOME` 时，陌生仓库的 `.env` 可设置 `OHBABY_HOME=.` 并配软链，直接绕过项目禁软链、借全局分支读出私密文件（连带劫持全局配置） | 采纳方案 A（主任务 Stage 1）：在 `loadRuntimeEnvIntoProcessEnv()` 中先基于宿主环境确定 `OHBABY_HOME` / `globalEnvPath`，加载项目 `.env` 时禁止项目 `.env` 写入 `OHBABY_HOME`（原本未设却被项目 `.env` 填入时立即清除）。同时保护指令、`model.json`、`mcp`、`skills` 与全局 `.env`，不新增跨层参数透传。AC-15 与 I-13 补充经真实 `loadRuntimeEnvIntoProcessEnv()` 链路的防劫持测试 |
| R12 | 2026-11-25 复审发现两处读取细节可进一步加固与简化：① 原方案因 Windows 无 `O_NONBLOCK` 而在全平台放弃非阻塞打开，但仓内 `read-file-page.ts` 与 `shell-jobs/reader.ts` 已有成熟的平台 flags 分支；② 项目软链的同目录别名判断原需 `fs.stat(候选)` 跟随目标再比对 `dev/ino`，既要兜底 `ENOENT`/`ELOOP` 又对 `ino === 0n` 退化，而别名与非别名在安全上本就不读，只是报不报告警的 UX 差异 | ① 沿用仓内平台分支：POSIX 项目文件用 `O_RDONLY \| O_NOFOLLOW \| O_NONBLOCK`，POSIX 全局文件用 `O_RDONLY \| O_NONBLOCK`，Windows 用 `O_RDONLY`（继续保留打开前检查与打开后句柄复核），堵上 POSIX 检查到 `open` 之间的 FIFO 阻塞窗口；② 项目软链别名检查改为 `fs.readlink()` 字面匹配：仅当字面目标为同目录另一固定文件名（`AGENTS.md` ↔ `CLAUDE.md`）且该兄弟文件经 `lstat` 为普通文件时静默跳过，其余所有软链（含悬空/循环/相对写法）一律拒读并告警，不再 `stat(候选)` 跟链 |
| R13 | 2026-11-25 复审发现规格冲突：`dfd-interface.md` 规定单文件最多读 `maxFileBytes + 1` 字节，`data-model.md` 却要求 `truncated` / `budget-omitted` 告警的 `code` 使用“截断前正文的 `contentHash`”，两者不可能同时满足；同时未定义总预算剩余字节不足一个完整 UTF-8 字符时的处理 | 全模块只保留最终有效正文的 `contentHash`（供去重与快照 `key` 使用，修改 32 KiB 之后不可见尾巴不触发新快照）；截断告警 `code` 改为固定原因码：`FILE_LIMIT`（单文件超限）或 `TOTAL_LIMIT`（合并总预算截断或整份省略），`detailKey` 直接用 `code`。总预算剩余字节不足以容纳下一个完整 UTF-8 字符时，整份按 `budget-omitted`（`code: "TOTAL_LIMIT"`）跳过，不生成空 `InstructionSource`，也不扣减剩余额度（后续更短条目可继续使用）。AC-16 与 I-14 补两个边界用例 |
| R14 | 2026-11-25 复审发现三处可简化与漏改：① `services/reminder/index.ts` 已算好各 provider 的 `latest` key，`instructions/reminder.ts` 再抄第三遍历史过滤循环易漂移；② `renderer.ts` 区分 `baseline` / `update` 双模式既增加复杂度又容易与执行模式（`auto`/`plan`）混淆；③ 静态模板 `core/system-prompt/prompts/subagents/base.md:21` 仍写着让子代理遵守 “in this system prompt” 的指令，Stage 2 漏改 | ① `services/reminder/index.ts` 将 `ReminderProvider.collect` 扩为 `collect(context, previousKey?)`，由 collector 直接传入本 provider 对应的 `latest.get(provider.type)`，消除重复扫历史；② 砍掉 `renderer.ts` 的 `baseline`/`update` 分支，所有非空快照统一使用同一句“以本快照为准、未列先前来源不再适用”的固定头注，adapter 仅在“本步为空且此前为非空哈希”时发 `cleared`；③ Stage 2 删除 `subagents/base.md:21` 这条过时条目（与 `primary/base.md` 保持精简一致，由第 14 行与 reminder 自身优先级头注约束），并运行 `pnpm --filter ohbaby-agent prompt:generate` 更新 `templates.generated.ts` |
| R15 | 2026-11-25 复审与源码核实发现三处边界：① `ohbaby-server` 常驻 daemon 中每个工作区复用同一个 `composition` 与 provider 实例，若工作区存在持续告警，已结束的主/子会话会无限留在诊断 `Map` 中（`non-functional.md` 写“只留当前有问题会话”不准确）；② 指令 warning 与 `prompt-security:` 均不填 `UiNotice.sessionId`，在 daemon 为工作区广播，TUI 按 `notice.key` 合并、headless CLI 逐条打 stderr、Web 前端当前忽略 `notice.emitted`，原文档对各端展示夸大；③ `HOME_UNRESOLVED` 时不存在候选文件绝对路径 | ① `reminder.ts` 的会话诊断 `Map` 加 512 条 FIFO 上限（超过 512 个 `sessionId` 时删除最早插入的条目，3 行代码封顶内存，仍不需销毁钩子或定时器）；② 保持工作区级通知（不填 `UiNotice.sessionId`，与现有 `prompt-security:` 一致），把 `02`、`data-model`、`dfd-interface`、`non-functional` 对 TUI / headless CLI / Web / 广播语义的描述改实；③ `HOME_UNRESOLVED` 时 `sourcePath` 固定为 `"global"`，notice 标题为 `global instructions skipped` |
| R16 | 2026-11-25 复审收尾细节：① 有界读取需明确短读循环与非法 UTF-8 处理；② 文档存在未经实测的“SSD <1ms”“100% 静态”及过满的“压缩摘要明确不复述”“单条 finding”表述；③ `02 §2.4` 漏列 `permission/evaluator.unit.test.ts`，`evaluator.ts` 需在 `never` 编译检查外保留运行时 fail-closed，测试夹具 `memory_1` 可顺手正名 | ① `dfd-interface.md` 与 `data-model.md` 明确短读循环读至 EOF 或 `maxFileBytes + 1`；合法截断边界后再用 `TextDecoder("utf-8", { fatal: true })` 解码，非法 UTF-8 按 `kind: "rejected"`、`code: "INVALID_UTF8"` 跳过并告警；② 删去未经实测的 `<1ms` 与 `100% 静态` 措辞，将压缩提示词与安全扫描多规则 finding 语义改实；③ `02 §2.4` 补列 `permission/evaluator.unit.test.ts`，Stage 3 明确 `evaluator.ts` 保留运行时异常值 fail-closed 兜底并顺手清理 `scheduler.unit.test.ts:2227-2326` 中的 `memory_1` 等测试夹具命名 |
| R17 | 2026-11-25 二次复审（Pi `gpt-6.2-astra` high + 跨文档子代理）最终收口：① AC-15 / I-13 用 `OHBABY_HOME=.`（非法相对路径）测防劫持，全局整体失效也会假通过；且 `project-env.ts` 应保证项目 `.env` 加载前后 `resolveOhbabyHome()` 最终根不变（护住 `OHBABY_HOME` 及宿主未设时的 `HOME`/`USERPROFILE`）；② `security-finding` 去重键写 `patternId + contentHash`，但被 `omit` 文件没有最终 `contentHash`；③ 若干旧文案与测试行锚点待对齐 | ① AC-15 / I-13 改用合法临时绝对路径 `OHBABY_HOME=<attackerDir>`，不向 loader 传 `homeDirectory`，同一次测试同时断言可信全局标记出现且恶意目录标记不出现（Windows 无软链权限时保留非软链防劫持断言）；`project-env.ts` 守住 `OHBABY_HOME` 及宿主原本未设时的 `HOME`/`USERPROFILE`；② `security-finding` 去重 `detailKey` 简化为 `patternId`；③ 对齐 `goals-duty.md`、`dfd-interface.md`、R3 残留的 `paths/`/`migration/` 措辞、R16 残留的“单条”措辞，并将 `INVALID_UTF8`、`HOME_UNRESOLVED` 与 512 FIFO 上限补进测试场景表 |
| R18 | 2026-11-25 实施前复审（SWE 视角）发现三处可收敛：① R11 的 `project-env.ts` 防护保护的是整个全局配置根（model、mcp、skills、指令），和指令无关；前置专题本来就要改同一个 `loadRuntimeEnvIntoProcessEnv()`（删迁移调用），两个专题改同一函数会冲突。另外 R11 把 `OHBABY_HOME=.` 当作可利用手法，实际 `resolveOhbabyHome()` 对相对路径直接抛错（`paths/ohbaby-home.ts:58-60`），真正的风险是写合法绝对路径把全局根整个换掉，或写非法值让启动失败；② 通知是工作区级广播，按 `sessionId` 去重会让每个子代理把同一告警再广播一遍，还得为长驻 daemon 加 512 条 FIFO 上限；③ 打开后比对 `dev` / `ino` 只防“检查后被换成另一个普通文件”，这需要本地进程配合，不在静态仓库的威胁模型内，却带来 `bigint`、`ino 0n` 两个特例 | ① 防护整体挪到前置专题 Stage 1（项目 `.env` 不接受 `OHBABY_HOME`、`HOME`、`USERPROFILE`，前置专题 AC-12 用合法绝对路径 `OHBABY_HOME=<attackerDir>` 验证），本专题只消费 `resolveOhbabyHome()`，开工前确认 AC-12 通过；I-13 / AC-15 删去环境加载链部分；② 诊断去重改为 `Map<projectRoot, Set<签名>>`，同一项目的主会话、子代理和并发会话共用，去掉 512 条 FIFO 上限及其测试，取代 R8 的“每会话各报一次”和 R15 的 FIFO 上限；③ 去掉 `dev` / `ino` 比对、`bigint` 读取、`ino 0n` 特例和 `CHANGED_DURING_OPEN`，保留打开前类型检查、平台 flags 和句柄 `isFile()` 复核 |
| R19 | 用户要求不能让用户手动转换编码。对照 dsh、ZCode、kimi-code、Claude Code：四家读指令文件都只认 UTF-8（dsh 严格、其余有损），UTF-16 会被跳过或读成乱码；但 ZCode（`text-metadata.ts`：UTF-8 BOM → UTF-16LE BOM → 严格 UTF-8 → GBK 系）、kimi-code（`encoding.ts`：UTF-16 LE/BE BOM + 0 字节猜测）和 Claude Code（`fileRead.ts`：`FF FE`）的通用读文件工具都处理了编码。本机实测 Node 24 的 `TextDecoder` 自带 `utf-16le`、`utf-16be`、`gb18030`，且合法 UTF-8 按 GB18030 解码不报错 | 编码识别按 BOM（UTF-8 / UTF-16 LE / UTF-16 BE）→ 严格 UTF-8 → GB18030 的顺序，都失败才拒读，错误码 `INVALID_UTF8` 改为 `INVALID_ENCODING`；GB18030 兜底不告警；读取边界用 `stream: true`，删掉解码前手动回退字符边界的步骤；原始读取上限改为 `2 * maxFileBytes + 8`，长度一律在解码后按 UTF-8 字节计（R7 不变）；不猜无 BOM 的 UTF-16，不引入新依赖；新增 I-17 / AC-21 |
| R20 | 对照参考项目：dsh（`render.ts:303-313`）和 ZCode（`request-user-context.ts:100-102`）截断时都会在模型可见的正文里注明，原方案沿用 Codex 不提示，模型不知道规则不完整 | 用户确认告诉模型：`truncated = true` 的来源在正文末尾加一行固定英文提示 `[Truncated: <displayPath> exceeds the size limit; the rest is not included.]`，不计入预算，不影响 `key`；整份被省略的文件不提示模型（不在 `sources` 里，要提示就得把它算进 `key`），只给用户告警 |
| R21 | 用户提出：能否不注入 `AGENTS.md` / `CLAUDE.md` 正文，改为让模型自己用 Read 读。调研 10 个参考项目：加载指令文件的 9 个对项目根和全局文件全部注入正文；只有 Codex、kimi-code 对子目录文件只给路径，且都不强制、不检查模型是否读了 | 用户确认保持注入正文。理由（漏读风险、省不了 token 和刷新机制、Read 工具缺少本模块的安全与编码处理）记入 03 §3.3“明确不借鉴”；kimi 的“只提醒路径”留作将来支持子目录 `AGENTS.md` 时的参考 |
| R22 | 对照 dsh、ZCode 复查读错规则：读错时把文件从快照拿掉，再加上每份快照的固定头注“先前未列来源不再适用”，等于在文件被短暂锁住时告诉模型“规则作废了”，这是错误的陈述，一来一回还多追加两份全量快照。dsh（`state.ts`）整组回退到上次读成功的内容，ZCode（`context-refresh.ts`）认为读不到不等于删除，都保留旧内容；R2 否掉的是“整体冻结”，不是“保留旧内容”本身 | 用户选方案 C：Reminder Adapter 持有进程内 `lastGoodReads`（`Map<绝对路径, { content, truncated }>`）传给 Loader；读成功即覆盖，不存在、被拒或为空即删除；只在非缺失读错时用缓存顶替，顶替后照常走安全扫描、去重和总预算，读错 warning 照常发；进程重启后缓存为空，退回为本步跳过。改写 dfd 第 3、6 步与 §3.1、data-model、architecture 权衡 4、goals-duty、non-functional、02、03；I-11 / AC-09 改写，新增 I-18 |
| R23 | 实施前子代理终审（opus）：无阻塞项。发现 AC-10 ③ 与 dfd 第 6 步压缩说明仍是 R22 之前的“读错降级为空”；02 只说 Stage 4 部分可提前，没列是哪些；前置专题三处开工门禁漏了 AC-12；另有 AC 总数、`INVALID_ENCODING` 示例、缓存上界措辞、诊断对比需同步完成、持续读错的代价、`docs/core/memory/improve-1` 与死链范围、README 写旧文件名会触发 `rg` 门禁等小项 | 全部按终审建议改文档：AC-10 ③ 拆成有缓存重建 / 无缓存静默；02 §2.3 列明可随 Stage 3 提前的文档项，`OHBABY.md` 与 README 指令章节等须在 Stage 2 之后；前置专题 README 与 02 门禁加上 AC-12；死链检查限定权威文档。项目 `.env` 经 `XDG_DATA_HOME` / `LOCALAPPDATA` 改数据根不在本轮范围，归入“项目 .env 启动级变量”后续专题 |

## 7. 2026-11-25 实施顺序与导出边界

先完成旧目录退役，再清理长期记忆残留，最后接入 instructions。用户确认 HTML 和 JSONL 会话导出都过滤所有宿主注入的隐藏 reminder。用户和助手主动写出的同样文字照常导出，按消息元数据区分。
