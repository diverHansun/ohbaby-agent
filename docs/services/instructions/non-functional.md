# instructions 模块 non-functional.md

本文档仅记录 `services/instructions` 模块在关键运行路径上的具体工程约束（非通用清单）。

---

## 1. KV Cache 稳定性（成本与延迟核心约束）

- **前缀零污染**：指令文本绝不进入 `SystemPrompt.assemble()`。在代理角色、addon、配置、模型与未压缩历史相同的条件下，编辑全局或项目指令文件绝不改变 `system` 消息及之前历史消息的字节，仅在尾部新增一条 reminder。
- **只追加不回改**：已写入对话历史的 `instructions` reminder 在文件修改、冷恢复或重试期间绝不原地改写，仅在内容变化时向历史尾部追加新记录。
- **无变更零开销**：当全局与项目文件内容未变化时，每步 `collect()` 产出的 `key` 与历史最近快照完全一致，最终追加 token 数为 `0`。
- **空仓库零开销**：当全局与项目目录均无 `AGENTS.md` / `CLAUDE.md` 时，不注入任何占位符或空 reminder，额外 token 数为 `0`。

---

## 2. 安全性与注入隔离

- **权限降级**：指令内容始终通过 `user` 角色 `<system-reminder>` 注入，并在正文头部显式声明其为低优先级参考指引，不得覆盖系统指令、宿主权限规则或用户当前明确要求，也不授予任何额外工具权限。
- **软链规则与全局根防劫持（防数据外泄）**：项目作用域用 `lstat` 只读普通文件，软链一律不读；同目录 `CLAUDE.md` / `AGENTS.md` 经 `readlink` 严格字面匹配且兄弟为普通文件时静默跳过，其他软链（包括指向项目根内 `.env` 的）跳过并上报 warning，确保仓库无法借软链把私密文件写进会话历史或发给模型。全局作用域跟随软链的前提由前置专题在 `utils/project-env.ts` 落地：`loadRuntimeEnvIntoProcessEnv()` 不让项目 `.env` 写入 `OHBABY_HOME`、`HOME`、`USERPROFILE`，加载项目 `.env` 前后 `resolveOhbabyHome()` 解析出的全局根目录不变。
- **高危内容拦截**：所有读取到的指令文件在进入渲染前必须通过 `scanPromptLikeContent()` 扫描；命中 `omit` 级别规则的文件必须整份跳过并仅通过 `onSecurityFinding` 上报（不重复触发 `onWarning`），不部分放行。
- **宿主框架防逃逸**：文件内容中的 `<system-reminder>` 与 `</system-reminder>` 标签（任意大小写、空白与属性变体）必须转义，防止外部仓库破坏宿主 reminder 正文结构；同时保持普通 Markdown 语法与代码片段不被破坏。来源只写固定标签（`global/AGENTS.md` 等），不插入绝对路径。
- **文件类型、平台打开标志、有界读取与合并总预算**：打开文件前先确认是普通文件（项目用 `lstat`，全局用 `stat`），拒绝目录、FIFO 与设备文件；打开时沿用仓内平台 flags（POSIX 项目 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`，POSIX 全局 `O_RDONLY | O_NONBLOCK`，Windows `O_RDONLY`），堵上 POSIX 检查到 `open` 之间的 FIFO 阻塞窗口；打开后对句柄 `stat` 复核仍是普通文件，再执行有界字节读取；默认限制单文件上限 `32 * 1024` 字节、合并总预算 `64 * 1024` 字节（均按 UTF-8 字节计，截断时退到完整字符边界）（按“项目优先于全局、`AGENTS.md` 优先于 `CLAUDE.md`”保留），超限时截断或省略并上报 warning。对于极小上下文窗口模型，若叠加对话历史后最终请求仍超模型输入预算，由 `Lifecycle` 既有的 `context_overflow` 显式报错终止。

---

## 3. 可靠性与退化策略

- **单文件容错隔离**：四个候选路径（全局 2 个 + 项目 2 个）互不牵连；某个文件缺失、为空、软链被拒、不是普通文件、读错或被安全策略拦截时，其余合法文件仍正常加载，加载流程也不会因预先放好的特殊文件而挂起。
- **区分缺失与读错**：仅 `ENOENT` / `ENOTDIR` 视为文件不存在，静默跳过；权限不足、文件被锁等读错只影响出错的那份文件：上报 warning，用它上次成功读到的内容顶替（不追加新快照，也不对模型说它作废），不冻结其他文件的刷新。进程重启后首次读取就读错时没有可顶替的内容，这份文件本步缺席，恢复后按正常更新补回。
- **同目录别名兼容**：项目里 `ln -s AGENTS.md CLAUDE.md`（或反向 `ln -s CLAUDE.md AGENTS.md`）且 `readlink` 字面严格匹配另一固定文件名、该兄弟为普通文件时静默跳过，内容只加载一份；其余项目软链拒读并告警；全局作用域的软链照常跟随，并按内容哈希去重。

---

## 4. 三系统适配（macOS / Linux / Windows）

- **不比较路径字符串**：判断不依赖 `realpath` 前缀比较，不受大小写不敏感文件系统、Windows 盘符、UNC 和 junction 的影响；三系统采用相同拒读策略。
- **平台打开标志**：沿用仓内 `read-file-page.ts` / `shell-jobs/reader.ts` 惯例，POSIX 按作用域使用 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 或 `O_RDONLY | O_NONBLOCK`，Windows 使用 `O_RDONLY`。
- **大小写不敏感文件系统（已知差异）**：macOS 和 Windows 默认不区分大小写，小写的 `agents.md` 也会被 `lstat("AGENTS.md")` 命中并加载，显示标签仍是 `project/AGENTS.md`；Linux 上不会。不为此做特殊处理，用户文档写明只认大写文件名。
- **Git for Windows 未开启软链**：仓库里的 `CLAUDE.md -> AGENTS.md` 会被检出成内容为 `AGENTS.md` 的普通小文件，按普通文件加载，不做特殊处理。
- **文件编码**：Windows PowerShell 5.1 的 `>` / `Out-File` 默认写带 BOM 的 UTF-16 LE，2019 年以前中文版 Windows 记事本默认存 GBK；mac / Linux 编辑器基本都是 UTF-8。三系统用同一套识别逻辑（BOM → 严格 UTF-8 → GB18030），解码器是 Node 24 官方构建自带的 `TextDecoder`，行为不随系统区域设置变化。
- **测试**：CI 在 ubuntu、windows、macos 三个系统上运行。FIFO 用例在 Windows 跳过；创建文件软链在 Windows 上可能报 `EPERM`，沿用仓库已有做法（参照 `shell-jobs/output-file.unit.test.ts`）在 `win32` + `EPERM` 时跳过该用例。

---

## 5. 性能与可观测性

- **低 I/O 开销**：每步最多并行探测 4 个固定路径，不递归遍历目录树，不启动后台进程或文件 watcher，正常本地磁盘读取耗时控制在毫秒级。
- **告警防刷屏**：按生效项目根记住上一步仍然存在的诊断签名集合，本步只上报集合里没有的新诊断，然后用本步结果替换旧集合（签名为 `filePath + kind + detailKey`）。持续存在的问题只报一次（覆盖连续多步循环、同一步压缩二次收集，以及同一项目的子代理和并发会话）；修好后再坏会重新上报。集合为空即删除条目；条目数以项目根个数为上限，`ohbaby-server` 长驻时也不会无限增长，不需要 FIFO 上限、外部销毁钩子或定时器。
