# instructions 模块 goals-duty.md

本文档定义新增模块 `services/instructions`（位于 `packages/ohbaby-agent/src/services/instructions/`）的设计目标与职责边界。

> 关联改造规划：[2026-11-24-instructions-reminder-and-memory-cleanup](../../problem-lists/2026-11-24-instructions-reminder-and-memory-cleanup/README.md)

---

## 1. Design Goals（设计目标）

### G1: 把易变的指令文件与静态 System Prompt 解耦，保住 KV Cache 命中率
用户随时可能编辑全局或项目级的 `AGENTS.md` / `CLAUDE.md`。这些内容不再进入 `SystemPrompt.assemble()`，而是经由现有的 `system-reminder` 管道，以持久化、只追加（append-only）的 `user` 侧消息进入对话历史。文件未变时不产生重复文本；文件变化时仅在当前轮末尾追加新快照，绝不改写静态 system prompt 或历史前缀。

### G2: 对齐行业标准，消除私有文件名与“长期记忆”混用
统一支持行业标准文件名 `AGENTS.md` 与 `CLAUDE.md`，彻底移除 `OHBABY.md` 私有约定（`resolveLegacyGlobalMemoryPath` 等旧全局记忆路径由前置专题删除）。指令文件的定位明确为**人类编写的常驻工作指南**，而非自动积累的长期记忆存储。

### G3: 明确低优先级与安全信任边界
指令文件来自用户配置或外部代码仓库，属于低信任上下文。向模型注入时必须放在 `user` 侧 `<system-reminder>` 中，显式声明其优先级低于系统指令、宿主权限规则与用户当前直接要求；同时保持内容安全扫描、长度上限与框架标签转义，防止恶意仓库伪造系统指令或闭合 `<system-reminder>` 标签。

### G4: 极简、可预测的发现与去重行为（KISS）
只保留两层作用域（用户全局 `~/.ohbaby/` 与会话项目根），每个作用域内均同时探测 `AGENTS.md` 与 `CLAUDE.md`，对内容一致的副本（如软链或直接拷贝）自动去重，避免浪费 token。不引入后台文件 watcher、子目录动态探测或 `@path` 递归导入，把复杂度控制在当前真实需求以内。

### G5: 主代理与子代理一致消费
主代理和子代理通过同一套 reminder provider 获取相同的全局与项目工作指南，不破坏子代理各自的任务契约与委派边界。

---

## 2. Duties（职责）

### D1: 发现并安全读取指令文件
- 在用户全局目录（由 `resolveOhbabyHome()` 解析，即 `$OHBABY_HOME` 或 `~/.ohbaby`）和会话项目根目录（`projectRoot ?? directory`）下，按固定顺序探测 `AGENTS.md` 与 `CLAUDE.md`。
- 项目作用域只读普通文件：用 `lstat` 检查，软链一律不读（同目录 `CLAUDE.md` / `AGENTS.md` 经 `readlink` 字面严格匹配且兄弟为普通文件时静默跳过，其他软链跳过并告警），防止恶意仓库借软链把项目根内外的私密文件（如未提交的 `.env`、`~/.ssh/id_rsa`）发给模型。
- 全局作用域跟随软链：前置专题已让 `utils/project-env.ts` 保证项目 `.env` 不会改变 `resolveOhbabyHome()` 解析出的全局根目录，兼容 dotfiles 把单个文件软链出去的用法。
- 打开前确认目标是普通文件（FIFO、目录、设备节点直接跳过），打开时沿用仓内平台非阻塞/禁跟链标志，打开后复核句柄仍是普通文件，再执行短读循环有界读取；按 BOM、UTF-8、GB18030 的顺序识别编码（支持带 BOM 的 UTF-16 LE / BE，用户不需要手动转换）；处理文件不存在、非普通文件、无法识别的编码、空文件、单文件与总预算截断以及读取异常（区分 `ENOENT` 缺失、确定性拒绝与权限/I/O 错误）。
- 判断不依赖 `realpath` 前缀比较，在 macOS、Linux、Windows 上采用相同拒读策略。
- 在加载阶段调用现有 prompt-security 扫描器，对高危内容执行省略（omit）并通过回调上报安全告警（省略文件仅通过 `onSecurityFinding` 上报，不再重复触发同源 `onWarning`）。

### D2: 内容去重
- 对读取到的有效指令内容做 `trim()` 规范化与哈希比对。
- 同作用域内 `AGENTS.md` 与 `CLAUDE.md` 内容完全一致时，只保留先读到的 `AGENTS.md`。
- 跨作用域（例如项目根恰好与 `~/.ohbaby` 为同一物理目录，或项目文件与全局文件内容完全一致）时，按内容哈希避免完全相同的文本被重复注入（同一物理文件读出的内容必然相同，不再比较路径），保留更具体的项目作用域条目。

### D3: 渲染低优先级、抗逃逸的 Reminder 正文
- 将去重后的全局与项目指令渲染为适合嵌入 `<system-reminder>` 的结构化正文，按“全局在前、项目在后”排列，用固定标签标明来源（如 `global/AGENTS.md`、`project/CLAUDE.md`），不插入绝对路径。
- 附带明确的优先级声明（项目覆盖全局；两者均不得覆盖系统指令、宿主权限规则与用户当前直接要求，且不授予额外权限）。
- 对文件内容中的 `<system-reminder>` / `</system-reminder>` 标签做安全转义，避免闭合宿主框架，同时保留 Markdown 代码块、泛型与 shell 语法（不做全量 HTML 实体转义）。

### D4: 适配现有 Reminder 管道并管理生命周期变更
- 提供符合 `ReminderProvider` 契约的工厂函数（`type: "instructions"`、`kind: "snapshot"`、`audience: "both"`），接入 `createReminderCollector`。
- 为每个有效快照生成确定性的内容哈希 `key`，复用 reminder collector 的快照去重机制：内容不变时零输出；内容变化时在尾部追加带更新说明的新快照；压缩（compaction）后在活跃历史中重新注入。
- 每步只采用本步验证通过的文件；被拒或被省略的文件不沿用旧版本。读错（权限、文件被锁）表示“这次没读到”，用该文件上次成功读到的内容顶替，不向模型声明它作废。
- 当先前活跃历史中已注入过非空指令、本步却没有任何可用指令时（删除、清空、被拒、安全省略，或进程重启后首次读取就读错），发出一次“当前没有已验证可用的指令，之前的指令快照不再适用”的通知；若从未存在指令文件，则保持静默（零 token）。
- 追加的通知不会删除历史里已发出的旧正文，模块只保证新快照不含被拒内容、最新快照替代旧快照。

### D5: 控制重复诊断噪音
- 因为 reminder 收集发生在每一步 `prepareTurn()`，模块负责对同一作用域下未变化文件产生的相同 warning / security finding 做去重，避免多步工具循环期间反复刷屏告警。

---

## 3. Non-Duties（非职责）

### N1: 不负责长期记忆（Long-Term Memory）
本模块不存储、抽取、检索或更新跨会话记忆，不提供任何 `memory_*` 工具或 `<memory>` 标签。长期记忆将由独立仓库单独设计。

### N2: 不负责兼容私有或非标准文件名
不支持 `OHBABY.md`、单数 `AGENT.md`、`.ohbaby-agent/` 旧目录、`~/.config/ohbaby-agent/OHBABY.md` 旧全局记忆路径，也不扫描 `<project>/.ohbaby/` 子目录。

### N3: 不负责静态 System Prompt 组装
不参与 `SystemPrompt.assemble()`，也不关心 base/task/subagent-roles 模板如何拼装。

### N4: 不负责子目录递归扫描与工具驱动发现
本轮不向上或向下遍历项目子目录，也不监听 `read`/`write`/`edit`/`bash` 工具路径来动态加载嵌套 `AGENTS.md`。

### N5: 不负责文件系统 Watcher、热重载命令或 `@path` 导入
不建立 `fs.watch` 监听进程，不解析 Claude Code 的 `@file` 引用语法或 `.claude/rules/*.md` 规则目录。

### N6: 不负责持久化历史消息与 Provider 投影
历史消息的持久化、anchor 锚定排序、compaction 裁剪与各模型协议的投影由 `core/context`、`core/message` 与 `ohbaby-llm` 负责。
