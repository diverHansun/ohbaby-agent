# instructions 模块 data-model.md

本文档定义 `services/instructions` 模块的核心领域概念、关键数据要素与生命周期归属，确保设计、接口与测试使用同一套概念语言。

---

## 1. Core Concepts（核心概念）

- **InstructionScope（指令作用域）**：标识指令文件的归属层级，只有两个取值：`global`（用户全局 `~/.ohbaby/`）与 `project`（当前会话项目根）。
- **InstructionSource（单份指令源）**：成功读取、通过安全扫描且去重保留后的一份指令文件记录，携带来源作用域、展示路径、规范化正文、内容指纹与截断标记。
- **加载结果**：一次文件系统探测的输出就是按生效顺序排列的 `readonly InstructionSource[]`，只含本步验证通过的文件（读错时可能来自上次成功读取），不另设包装类型或读错标记。
- **上次成功读取（`lastGoodReads`）**：按候选文件绝对路径记住最近一次成功解码的正文，只在该文件本步读错时顶替，见 dfd 第 3 步。
- **InstructionSnapshotState（历史已公告状态）**：从 `ReminderContext.history` 中派生的只读投影，表示当前活跃上下文窗口内最近一次已发给模型的指令状态（`absent` 未公告 / `active` 有有效指令 / `cleared` 已显式声明失效）。
- **InstructionReminderPayload（提醒输出载荷）**：交给 `services/reminder` 持久化的最终快照，由确定性 `key`（内容哈希或清空哨兵值）和渲染好的正文文本组成。

---

## 2. Entity / Value Object 区分

| 概念 | 性质 | 说明 |
| --- | --- | --- |
| `InstructionScope` | Value Object | 固定枚举值（`global` / `project`），决定排序与展示标签 |
| `InstructionSource` | Value Object | 不可变值对象，内容以 `trim()` 后的文本和 SHA-256 摘要标识 |
| `InstructionSnapshotState` | Derived Value | 每次由 `context.history` 现算派生，不单独存库 |
| 项目诊断集合 | Ephemeral State | 每个项目根上一步仍存在的诊断签名，仅存于进程内存，进程重启后重新上报一次，无副作用 |
| 上次成功读取 | Ephemeral State | 每个候选文件最近一次成功读到的正文，仅存于进程内存；进程重启后为空，读错的文件退回为本步跳过 |

---

## 3. Key Data Fields（关键数据字段）

### InstructionSource
- **scope**：`global` 或 `project`，用于确定渲染分组和优先级说明。
- **fileName**：命中的标准文件名，仅限 `AGENTS.md` 或 `CLAUDE.md`。
- **path**：候选文件的绝对路径，只用于上报安全告警和 warning 时的 `sourcePath`（发给 UI），不写进发给模型的正文。
- **displayPath**：渲染给模型看的固定来源标签，等于 `${scope}/${fileName}`，例如 `global/AGENTS.md`、`project/CLAUDE.md`。不含绝对路径，所以不需要转义，也不会把本机目录名发给模型。
- **content**：最终进入正文的文本，已经过单文件上限截断、`trim()` 和总预算截断。
- **contentHash**：最终有效正文 `content` 当前值的 SHA-256 十六进制摘要（单文件去重时按单文件裁剪 + `trim()` 后的可见正文计算，总预算截断改了 `content` 后重算；由于有界读取不读超出上限的尾巴，两份超长文件若可见前缀相同即视为同内容，仅改不可见后缀不触发新快照）。
- **truncated**：布尔值，被单文件上限或总预算截断时都为 `true`。它参与快照 `key` 计算。渲染时在该文件正文末尾加一行固定英文提示 `[Truncated: <displayPath> exceeds the size limit; the rest is not included.]`，让模型知道这份规则不完整（借鉴 dsh、ZCode）。整份被总预算省略（`budget-omitted`）的文件不在 `sources` 里，不提示模型，只给用户告警。

### LastGoodRead（`lastGoodReads` 的值）
- **content**：解码、单文件裁剪、`trim()` 后的非空正文（还没经过安全扫描和总预算分配）。
- **truncated**：这份正文是否触发了单文件上限 `FILE_LIMIT`。替代时据此重新上报 `FILE_LIMIT`，签名不变，不会重复打扰用户。

### InstructionReminderPayload（映射为 `ReminderBody`）
- **key**：
  - 当有有效指令时：对本次有效指令集合派生的确定性 SHA-256 摘要（所有非空快照使用同一固定头注，无双模式分支，内容相同即 key 相同）。
  - 当发出移除通知时：固定哨兵值（如 `"cleared"`），防止后续步骤重复发出移除通知。
- **text**：注入 `<system-reminder>` 内部的完整正文，已完成边界标签转义。

### InstructionWarning（`onWarning` 回调参数）
- **sourcePath**：出问题的候选文件绝对路径（`code === "HOME_UNRESOLVED"` 时无法解析文件路径，固定填 `"global"`），只发给 UI，不进模型正文。
- **kind**：`read-error` | `rejected` | `truncated` | `budget-omitted`。
- **code**：固定错误码或原因码：
  - `read-error` / `rejected`：如 `EACCES`、`PROJECT_SYMLINK`、`NOT_REGULAR_FILE`、`INVALID_ENCODING`、`HOME_UNRESOLVED`；
  - `truncated`：`FILE_LIMIT`（单文件超 `maxFileBytes`）或 `TOTAL_LIMIT`（合并总预算截断）；
  - `budget-omitted`：`TOTAL_LIMIT`（合并总预算不足以容纳整份或连第一个完整 UTF-8 字符都放不下）。
- **message**：给人看的英文说明。
- 结构化传递是为了让 Reminder Adapter 直接拿 `kind` / `code` 组成去重签名，UI 层直接拿 `kind` 生成 notice key，都不用解析字符串。

### 诊断签名（内部去重键）
- 按生效项目根（`ReminderContext.projectRoot ?? directory`，两者都缺时用空字符串）分组；组内签名由 `filePath + kind + detailKey` 组成。诊断只取决于项目里的文件，所以主会话、子代理的子会话（`subagent-host.ts` 的 `createChildSession()` 用父会话的 `workingDirectory` 新建带 `parentId` 的会话，项目根相同）和并发会话共用一组，同一问题只报一次。通知本身保持工作区级（不填 `UiNotice.sessionId`）：TUI 按 notice key 替换同 key 的旧通知；headless CLI（`stdout-renderer.ts`）不按 key 去重，逐条写 stderr；Web 前端当前忽略 `notice.emitted`。
  - `security-finding`：`detailKey` 为 `patternId`（按 `filePath + "security-finding" + patternId` 去重，不依赖被省略文件并不存在的最终 `contentHash`；文件修好后签名消失，之后再次命中会重新上报）。
  - `read-error` / `rejected`：`detailKey` 为错误码或拒绝原因（如 `EACCES`、`PROJECT_SYMLINK`、`NOT_REGULAR_FILE`、`INVALID_ENCODING`、`HOME_UNRESOLVED`）。
  - `truncated` / `budget-omitted`：`detailKey` 为固定原因码 `code`（`FILE_LIMIT` 或 `TOTAL_LIMIT`），持续超限时只报一次，恢复不超限后再超限时重新上报。

---

## 4. Lifecycle & Ownership（生命周期与归属）

| 数据 | 创建方 | 存活周期 | 更新 / 清理方式 |
| --- | --- | --- | --- |
| 磁盘上的 `AGENTS.md` / `CLAUDE.md` | 用户或代码仓库 | 长期（宿主文件系统） | 本模块只读，绝不创建、修改或删除 |
| 加载结果（`InstructionSource[]`） | `loader.ts` | 单次 `collect()` 调用期间 | 调用结束即释放 |
| 已持久化的 `system-reminder` 消息 | `ContextManager`（经由 `ReminderCollector`） | 会话历史内（直至 compaction 压缩或会话归档） | 永不原地改写；变更时仅在尾部追加新消息 |
| 项目诊断集合（`Map<projectRoot, Set<签名>>`） | `reminder.ts`（provider 实例内） | provider 实例生命周期（长驻 daemon 中为单工作区 `composition` 生命周期） | 每步用本步诊断整体替换该项目根的集合；集合为空即删掉该条目。条目数以项目根个数为上限，不设 FIFO 上限；不依赖外部生命周期钩子、无定时器、不持久化 |
| 上次成功读取（`Map<绝对路径, { content, truncated }>`） | `reminder.ts`（provider 实例内），由 `loader.ts` 按规则读写 | 同上 | 读成功即覆盖；不存在、被拒或为空即删除；只在非缺失读错时读取。每个项目根最多 2 条，全局共 2 条，单条不超过 `maxFileBytes`；总条目随访问过的项目根数线性增长，文件正常时不回收（和项目诊断集合一样，作为可接受的代价）；不设 FIFO 上限、无定时器、不持久化 |
