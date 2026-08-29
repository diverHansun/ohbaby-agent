# 00 - 讨论记录与设计边界

## 1. 背景

这次讨论来自一次真实的交互故障：TUI 执行 slash command 时，内部 `ui.command.record` JSON 被写到终端，穿插在 Ink 画面和用户输入之间；`ohbaby serve` 也曾持续向启动终端输出同类记录。

上一轮修复已经把 command recorder 的默认隐式 I/O 改为显式注入/no-op，关闭了直接根因。但它暴露了更大的系统问题：项目中“给用户看的提示”“给开发者看的诊断”“结构化观测记录”“进程生命周期信息”缺少统一分类，若继续逐点修补，类似问题还会从迁移告警、daemon logger、清理异常或调试分支重新出现。

因此本轮先设计一套小型 logging/diagnostics 基础，再进入代码实现。

## 2. 使用者视角

### 2.1 普通用户

用户关心的是：现在发生了什么、是否还能继续、需要做什么。用户不应该理解 JSON event、stack、operationId 或 logger 生命周期，也不应该因为内部诊断输出而失去输入焦点或看到 TUI 画面错位。

### 2.2 开发者与维护者

开发者需要在“不复现用户隐私”的前提下知道：哪个组件、哪个事件、哪个安全关联 ID、耗时、重试/降级结果和标准化错误。开发者需要稳定、可检索、可自动解析的本地文件，而不是散落的 `console.*` 文本。

### 2.3 支持与问题排查

用户可以主动提供本地日志片段，但日志本身必须默认做到最小化、可解释、可删除且不自动上传。即使用户愿意分享，也不能把 prompt、模型回复或凭据预先写进去。

## 3. 术语统一

| 名称 | 含义 | 默认去向 |
| --- | --- | --- |
| 用户提示 | 用户需要理解或采取行动的信息 | TUI 组件或 CLI/serve 命令层 |
| 诊断事件 | 结构化、安全、可关联的运行事件 | 本地 JSONL 日志 |
| 调试事件 | 比默认更细的分支、尝试、时序元数据 | 本地 JSONL，需提高 level |
| 错误对象 | 程序内部异常载体 | 先经 `safeError`，再决定是否入日志/转成用户提示 |
| command record | SDK/UI 命令边界的结构化观测记录 | 显式 sink；不等同于 logger |
| product output | 命令正常输出或 TUI 画面 | 由对应交互层拥有，不属于日志 |

关键点是：**一次失败可以同时产生一个用户提示和一个诊断事件，但二者是两个经过不同策略处理的投影，不是把同一个 Error 原样打印两次。**

## 4. 已确认决策

### D1：自研轻量 logger

项目需要的是几种 level、静态 event definition、受限字段 encoder、JSONL 编码、单进程文件轮转和 best-effort 生命周期。Pino/Winston 能做到更多，但也会扩大依赖、默认行为和可误用面。首版选择自研，未来只有在吞吐、生态或 exporter 需求明显超过当前设计时再重新评估。

### D2：终端与日志严格分权

- TUI 的 `stdout` 归 Ink 渲染；
- CLI/serve 的产品输出归命令层；
- logger 不得直接写 `stdout` 或 `stderr`；
- 日志初始化/写入失败由组合根转换为一次受控用户提示，而不是 writer 自己打印。

这不是“把 stdout 改成 stderr”，而是取消底层模块对终端的所有权。

### D3：默认 `info`，内容永远不是 level 开关

TUI 与 serve 默认都为 `info`。`debug`/`trace` 只改变安全事件的详细程度，不能隐式打开 prompt、completion、tool/MCP/HTTP body 或秘密。若未来确有正文捕获需求，必须另立能力、另做显式同意和独立风险设计，不能复用日志 level。

### D4：JSONL 与最小事件模型

每行是一个完整 JSON 对象。必填字段只保留 `ts`、`level`、`event`、`component`；其余只能由静态 event definition 声明并经专用 encoder 生成。普通调用者不能传开放 string record；不默认重复写 hostname、pid、role、environment、schemaVersion 或自由文本 `message`。

### D5：动态路径语义化

`<home>`、`<workspace>`、`<ohbaby-home>`、`<tmp>` 是规范化结果中的示例占位符。实现必须从当前用户环境、项目解析结果和 `OHBABY_HOME` 等真实配置得到根目录，并按“最长、最具体匹配优先”替换，不能硬编码某个用户路径。

### D6：用户定义名称伪名化

内置 MCP/agent/skill 名称可直接记录；用户定义名称使用稳定短 hash。同一次环境中可以关联，但日志不暴露原名。hash 是伪名化，不是加密，因此仍按敏感数据管理。

### D7：每个进程独占日志文件

不让 TUI 与 serve 进程并发追加同一个固定文件。文件名携带 UTC 启动时间、pid 和短实例 ID；轮转只由文件所属进程执行，从结构上避免跨进程锁与相互截断。

### D8：配置面保持小

首版只公开：

- `OHBABY_LOG_LEVEL`
- `OHBABY_LOG_DIR`

文件大小、段数和保留期采用内部固定策略，不在首版增加环境变量矩阵。

### D9：分阶段，但同属 `improve-1`

日志地基、TUI 接入、serve 接入、退出/崩溃、错误展示、E2E 分阶段实现并独立 commit。目录名用于归类问题主题，不用作实施批次编号。

### D10：CLI 默认启用，library 默认 no-op

用户通过 ohbaby CLI 启动 TUI/fresh serve 时默认创建 `info` 文件日志；直接调用公开 agent/server factory 而不传 diagnostics capability 时保持 no-op，避免库调用和测试意外写入真实用户目录。serve capability 必须 lazy，只有确认不是复用已有 server 后才创建文件。

### D11：事件定义代替开放字段

普通调用者不能使用 `logger.info(string, Record<string, string>)`。level/event/component/字段 key 由静态 event definition 声明，每个字段通过受限 encoder 转换；这样 `trace` 的正文禁区不只依赖调用者自觉。definition 必须同时经过 package-private nominal brand、运行时 identity registry 和 ESLint/AST 静态声明规则三道门，logger 调用点永远不能传动态字符串或伪造对象。Migration helper 保留显式 `onWarning` 作为用户文案 seam，同时返回结构化 report；缺省不再 `process.emitWarning`。CLI presenter 只消费 warning 文案，diagnostics projector 只消费 report 计数，二者不能串线。

## 5. 方案边界

### 5.1 本轮设计范围

- logger port 与进程 logger 组合方式；
- JSONL 事件、level、字段和敏感信息合同；
- 文件创建、权限、轮转、保留、flush 与失败退化；
- TUI in-process 与 `ohbaby serve` 的接入位置；
- 迁移现有 `OHBABY_DEBUG`、migration warning、server console/stderr 旁路；
- 用户提示和诊断事件之间的映射边界；
- 自动测试、真实进程、TUI 与 Web E2E 验收。

### 5.2 明确不扩张

- 不做远程 telemetry、OTel、日志上传或集中检索；
- 不让 logger 订阅并保存所有 domain events；
- 不做任意对象自动序列化；
- 不把正文捕获藏在 `trace` 下；
- 不把 Web 浏览器 console 全面重构绑进日志地基；
- 不建立静态 `error code -> retryable` 总表，因为重试性依赖请求阶段、幂等性和实时策略；
- 不为了测试创建生产用 MemorySink；测试用 capture logger 保持为测试辅助对象。

## 6. 仍保留给实现阶段的局部选择

以下选择不改变合同，可在实现时以最小代码为准：

- logger 内部文件名和目录模块的精确文件拆分；
- 队列采用 Promise 串行链还是小型显式 queue；
- event definition 与 field encoder 的精确文件拆分。

这些不能推翻 [logging-policy.md](./logging-policy.md) 的敏感信息、终端所有权和失败退化规则。

## 7. 文档后的下一步

本套文档完成后先做两类独立审查：

1. 内容审查：决策是否一致、引用是否准确、有没有偷渡新需求；
2. 可实施性审查：与当前包依赖、组合根、构建和测试设施是否匹配。

审查意见回写并经用户确认后，才开始第一阶段代码开发。
