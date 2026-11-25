# instructions 模块 test.md

本文档定义 `services/instructions` 模块的测试范围、不可接受失败的关键场景、集成边界与验证策略。

> 说明：本仓库暂无独立 `test-blueprint` 文档；子包未单独定义 `test` 脚本，所有测试由仓库根目录 Vitest 统一收集并执行（`pnpm test` 或 `pnpm vitest run <path>`）。

---

## 1. Test Scope（测试范围）

### 覆盖范围
- 两层作用域（`~/.ohbaby/` 与 `projectRoot`）下 `AGENTS.md` 和 `CLAUDE.md` 的发现、顺序与忽略非标准文件名（`OHBABY.md`、`AGENT.md`、`.ohbaby/` 子目录、`~/.ohbaby-agent/`、`~/.config/ohbaby-agent/`）。
- 软链规则：项目作用域只读普通文件（同目录别名静默跳过，其他软链无论指向根内还是根外都拒读并告警），全局作用域跟随软链；`open` 之前的文件类型检查、打开后的句柄复核与有界读取。
- 同作用域与跨作用域的内容哈希去重（含内容完全一致的副本；项目内同目录软链别名由 `lstat` 跳过）。
- 单文件上限与合并总预算分配（项目优先于全局）、prompt-security 扫描（`allow` / `warn` / `omit` 且 `omit` 不重发 `onWarning`）及诊断去重（含同一步压缩二次收集、恢复后再次异常）。
- 正文渲染、优先级声明、固定来源标签（不含绝对路径）、`<system-reminder>` / `</system-reminder>` 大小写/空白/属性变体转义、包装后最终输出结构与普通 Markdown 代码保真。
- Reminder 生命周期：首次注入、未变更静默、编辑后尾部追加、全删除后移除通知、压缩二次收集三种分支、读错只影响出错的那份文件并用上次成功读取顶替。
- 主代理与子代理（`audience: "both"`）在真实 `Lifecycle` + `composition` 下一致获取项目根与全局指令。

### 不在本模块测试范围内
- `SystemPrompt.assemble()` 内部静态模板拼装细节（由 `core/system-prompt/__tests__/` 覆盖）。
- LLM provider 线缆级 `cache_control` 放置逻辑（由 `core/context/prompt-cache-wire.contract.test.ts` 覆盖）。
- TUI notice 渲染样式与 headless CLI stderr 格式（由 `ohbaby-cli` 各自测试覆盖；Web 前端暂未消费 `notice.emitted`）。

---

## 2. Critical Scenarios（关键场景）

| 场景 ID | 场景描述 | 预期结果 |
| --- | --- | --- |
| I-01 | 项目根同时存在内容不同的 `AGENTS.md` 和 `CLAUDE.md` | 两者均加载，顺序为 `AGENTS.md` 在前、`CLAUDE.md` 在后，各自标注固定来源标签 `project/AGENTS.md`、`project/CLAUDE.md` |
| I-02 | 项目根 `CLAUDE.md` 是 `AGENTS.md` 的符号链接，或 `trim()` 后内容完全一致 | 只加载并注入 `AGENTS.md` 一份，不重复消耗 token |
| I-03 | 全局 `~/.ohbaby/AGENTS.md` 与项目 `<root>/AGENTS.md` 内容不同 | 两者均加载，顺序为全局在前、项目在后，正文声明项目优先于全局 |
| I-04 | 项目根恰好等于 `~/.ohbaby` 或项目文件内容与全局文件完全一致 | 不重复注入同一份文本，仅保留项目作用域条目（若该文件是软链，项目作用域按规则拒读，由全局作用域加载一份）。项目随后读错时仍只出现全局来源，项目拒读也不影响全局下次读错时的回退 |
| I-05 | 目录中仅存在 `OHBABY.md`、单数 `AGENT.md` 或 `<project>/.ohbaby/AGENTS.md` | 全部忽略，不加载、不产生任何 reminder（零 token） |
| I-06 | 文件包含 `</system-reminder>`、`</SYSTEM-REMINDER >`、`<system-reminder attr="x">` 以及正常 TypeScript 泛型（`Array<string>`、`a && b`） | 经 `renderReminderText()` 最终包装后，正文中的标签变体均被安全转义，仅最外层保留一对宿主 `<system-reminder>...</system-reminder>`；`Array<string>` 与 `a && b` 保持原样 |
| I-07 | 文件命中高危 prompt-injection（如 `ignore previous instructions`） | 该文件被省略，仅触发一次 `onSecurityFinding`（单文件超限时也不发 `FILE_LIMIT`，独立的 I/O 读错仍正常上报）；同目录另一份合法文件仍正常加载 |
| I-08 | 多步工具循环（连续 5 次 `collect()`，含同一步压缩二次收集）期间文件未变；随后文件恢复正常再再次异常；另用同一 `projectRoot`、不同 `sessionId`（模拟子代理的子会话）和另一个 `projectRoot` 各收集一次 | 仅第 1 步返回 reminder；第 2–5 步由 collector 去重不追加；告警在未恢复前仅上报一次，恢复后再次异常时重新上报；同一 `projectRoot` 的另一个 `sessionId` 历史里没有快照，照常返回 reminder，但不再上报同一告警；另一个 `projectRoot` 各自上报一次 |
| I-09 | 会话中途用户修改了 `CLAUDE.md` | 产生新的 `key`，在当前步尾部追加使用统一固定头注的新快照 reminder；历史旧消息字节完全不变；再下一步未改则静默 |
| I-10 | 会话中途用户删除所有指令文件（或全部读错、被拒、触发安全省略） | 发出一次 `key = "cleared"` 的通知，正文说明“当前没有已验证可用的指令，之前的指令快照不再适用”，不推测原因；再下一步静默不再重复发 |
| I-11 | 同一个 provider 实例，前一步已成功加载项目 `AGENTS.md`（A）与 `CLAUDE.md`（B）。情形一：本步 A 读取报 `EACCES`，B 被修改；情形二：本步 A 被安全扫描 `omit`，B 报 `EACCES`；情形三：全新 provider 实例（模拟进程重启，缓存为空），活跃历史已有含 A、B 的快照，本步 A、B 都报 `EACCES` | 情形一：上报一次 A 的 warning，追加含旧 A 与新 B 的快照；情形二：A 上报一次 security finding、B 上报一次 warning，追加只含旧 B 的快照；情形三：两条 warning，追加 `cleared`。读错用例通过注入受控异常实现，三系统一致 |
| I-12 | 主代理与子代理（`isSubagent: true`，执行 `directory` 为子目录，且子目录与 `projectRoot` 放有不同 `AGENTS.md`） | 两者经真实 `Lifecycle` + `composition` 均只收到 `projectRoot` 与全局的 `instructions` reminder，不误读子目录文件 |
| I-13 | 项目根 `AGENTS.md` 分别是：指向项目根外标记文件的软链、指向项目根内 `.env` 标记文件的软链、指向 `docs/rules.md` 的软链、悬空软链；另一组中 `CLAUDE.md -> AGENTS.md` 与 `AGENTS.md -> CLAUDE.md`（`readlink` 字面为另一固定文件名且兄弟为普通文件）；全局 `~/.ohbaby/AGENTS.md` 软链到临时 dotfiles 目录 | 前四种拒读并各上报一次 warning，标记内容既不出现在持久化历史中，也不出现在最终模型请求中；双向字面同目录别名静默跳过、不告警、只加载一份；全局软链正常加载。项目 `.env` 改写全局根的防护由前置专题 AC-12 覆盖，本用例不重复。Windows 创建软链报 `EPERM` 时跳过这些软链子用例 |
| I-14 | 4 个候选文件合并超过总预算（默认 `64 * 1024` 字节）；另有一份超过 `32 * 1024` 字节的中文文件；再测：① 只改单文件 `32 * 1024` 字节之后的不可见尾巴；② 总预算剩 1 字节时遇到多字节汉字开头的文件 | 按「项目优先于全局、`AGENTS.md` 优先于 `CLAUDE.md`」分配预算，低优先级条目截断或省略并触发 `code: "FILE_LIMIT"` / `"TOTAL_LIMIT"` warning；中文文件截断后 UTF-8 字节数不超过上限、结尾不含 `U+FFFD`、`truncated = true`，渲染正文中该文件末尾有一行 `[Truncated: project/AGENTS.md …]` 提示，未截断的文件没有；只改不可见后缀不追加新快照；剩 1 字节遇汉字整份记 `budget-omitted`、不生成空来源、不扣减剩余字节（后续短条目仍可用）；小窗口模型在首轮及压缩重建时行为可预测 |
| I-15 | 项目根的 `AGENTS.md` 是 FIFO（`mkfifo`）、同名目录，或 UTF-8 和 GB18030 都解不了的文件（如正文中含 `0xFF 0xFF`）；同目录 `CLAUDE.md` 为合法文件；活跃历史已有旧快照；另测正常文件打开时的 flags | spy 确认静态 FIFO / 目录根本不调用 `fs.open`，该候选被跳过并上报一次 warning；该文件按 `kind: "rejected"`、`code: "INVALID_ENCODING"` 跳过并告警；`CLAUDE.md` 的修改照常追加只含 `CLAUDE.md` 的新快照；正常文件 `fs.open` 传入的 flags 符合平台策略（POSIX 项目含 `O_NOFOLLOW \| O_NONBLOCK`、POSIX 全局含 `O_NONBLOCK` 且不含 `O_NOFOLLOW`、Windows 为 `O_RDONLY`）。FIFO 用例在 Windows 上跳过 |
| I-16 | 在临时目录（路径含用户名样式的目录名）中加载全局与项目指令；另测宿主 `OHBABY_HOME` 设为相对路径导致全局目录解析失败 | 最终包装文本只出现 `global/AGENTS.md`、`project/CLAUDE.md` 这类固定标签，不出现临时目录的绝对路径；warning 回调里的 `sourcePath` 仍是绝对路径；`HOME_UNRESOLVED` 场景跳过全局作用域、项目指令照常加载，且 warning 的 `sourcePath` 为 `"global"`、UI 标题为 `"global instructions skipped"` |
| I-17 | 同一段中英混合正文分别存成：带 BOM 的 UTF-8、带 BOM 的 UTF-16 LE、带 BOM 的 UTF-16 BE、无 BOM 的 GBK、无 BOM 的纯中文 UTF-8；另测一份约 40K 个 ASCII 字符的 UTF-16 LE 文件，以及在上限处恰好落在多字节字符和代理对中间的文件；再把 UTF-16 LE 版放成 `AGENTS.md`、UTF-8 版放成同目录 `CLAUDE.md` | 五种编码都正常加载，正文完全相同且不含 `U+FEFF`；纯中文 UTF-8 没被误判成 GB18030；40K 的 UTF-16 文件截到 `32 * 1024` UTF-8 字节并上报 `FILE_LIMIT`；截断边界不产生半个字符或孤立代理项；编码不同、内容相同的两份文件按哈希去重只加载一份。三平台都跑 |
| I-18 | 同一个 provider 实例：第 1 步 A 正常读取；第 2 步 A 的 `fs.open` 报 `EBUSY`；第 3 步恢复正常。另一组：第 1 步正常，第 2 步删除 A，第 3 步在原路径放回新 A 并让它报 `EACCES`。再一组：A 超过单文件上限，第 2 步报 `EBUSY` | 第 2 步只上报一次 `EBUSY` warning，`collect()` 返回的 `key` 与第 1 步相同，collector 不追加消息；第 3 步也不追加。删除那组：第 2 步按正常流程处理删除，第 3 步不拿旧内容顶替（缓存已在删除时清掉）。超限那组：顶替后的快照仍带截断提示，`FILE_LIMIT` 不重复通知 |

---

## 3. Integration Points（集成点测试）

1. **`services/reminder` Collector 集成**：
   - 验证 `REMINDER_ORDER` 中 `"instructions"` 排在 `"environment"` 之前。
   - 验证 `kind: "snapshot"`、collector 向 provider 传入 `previousKey?` 与确定性 `key`（更新后下一步不再重复发射）的协同正确。
2. **`Lifecycle` ↔ `ContextManager.prepareTurn()` ↔ Compaction 集成**：
   - 验证 `Lifecycle` 构造每步 `stepInput` 时透传 `params.projectRoot`，`ContextManager` 透传 `directory` / `projectRoot` 至 `ReminderContext`。
   - 验证 Turn 1 注入、Turn 2 未改动时无重复注入、Turn 3 文件修改后仅在尾部追加（Turn 1/2 消息数组前缀完全字节一致）。
   - 验证同一步 compaction 发生后，本次最终请求正确处理三种情形：旧快照保留、旧快照被压缩且磁盘仍有文件（自动重建）、旧快照被压缩且文件已删或读错且无可顶替内容。
3. **`adapters/ui-runtime/composition.ts` 集成**：
   - 验证高危 `CLAUDE.md` / `AGENTS.md` 经由 `instructions` reminder 仅沿 `onSecurityFinding` → `noticeFromPromptSecurityFinding` 发送 `prompt-security:*` notice（不额外触发通用 `onWarning`；多条规则命中可各自产生 finding）。
   - 验证项目 `AGENTS.md` 为非别名软链时，UI 只收到一条 key 为 `instructions:${sourcePath}:rejected`、title 为 `AGENTS.md skipped` 的通知，后续多步循环不再出现。
4. **Prompt Cache 线缆契约与三协议 HTTP 集成**：
   - 在 `prompt-cache-wire.contract.test.ts` 与 `tests/integration/adapters/ui-runtime/custom-instructions.integration.test.ts` 中验证：中途修改项目指令文件后，`system` 消息及历史前缀消息对 Anthropic / OpenAI / OpenAI-Compatible 均保持字节级不变。

---

## 4. Verification Strategy（验证策略）

- **单元测试（临时真实目录，不 mock `fs`）**：使用 `fs.mkdtemp` 创建隔离的临时 `homeDirectory`、`projectDirectory` 及作用域外标记文件（含真实符号链接测试；`EACCES` 等读错一律用 `vi.spyOn` 让指定路径抛出受控异常，不用 `chmod`，因为 Windows 上改权限不生效），覆盖 `loader.unit.test.ts`、`renderer.unit.test.ts`、`reminder.unit.test.ts`。
- **读错注入约定**：loader 用默认导入 `import fs from "node:fs/promises"`（与现有 loader 一致），测试对 `fs.lstat` / `fs.stat` / `fs.open` 用 `vi.spyOn` 注入受控异常；ESM 的命名导出不能被 spy。
- **FIFO 用例防挂起**：只断言“在 `open` 之前已拒绝”（spy `fs.open`，确认没被调用），不靠超时兜底；实现若退回“先 open 再检查”，测试会直接失败而不是挂住 Vitest worker。
- **集成与契约测试**：在 `tests/integration/adapters/ui-runtime/custom-instructions.integration.test.ts`、`tests/integration/core/context/project-instructions.integration.test.ts`、`packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`、`packages/ohbaby-agent/src/core/context/prompt-cache-wire.contract.test.ts` 中验证端到端请求体、缓存前缀不变性与 notice 上报。
- **验证命令（仓库根目录执行并核对执行用例数 > 0）**：
  - `pnpm vitest run packages/ohbaby-agent/src/services/instructions/`
  - `pnpm test`
  - `pnpm typecheck`
