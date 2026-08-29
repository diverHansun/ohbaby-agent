# Logging Policy

> 本文是 `improve-1/` 中关于日志与诊断边界的唯一规范来源。其他文档用于解释原因和实施方式；发生表述冲突时，以本文为准。

## 1. 规范关键词

- **MUST / 必须**：实现和评审不可偏离；
- **MUST NOT / 禁止**：任何 level 和默认实现都不可绕过；
- **SHOULD / 应当**：除非有明确、记录在案的理由；
- **MAY / 可以**：兼容合同的实现选择。

## 2. 输出所有权

1. Logger **MUST NOT** 写 `process.stdout`、`process.stderr` 或 `console.*`。
2. TUI 运行时的 `stdout` **MUST** 只由 Ink/终端渲染生命周期拥有。
3. CLI 与 `ohbaby serve` 的正常产品输出 **MUST** 由命令层拥有。
4. 日志不可用、写入失败等情况 **MUST** 通过组合根转换成全生命周期最多一次的受控提示；底层 writer 不得自行打印。TUI 活跃时提示属于 UI；Ink 已恢复终端后才发生的 dispose/drain 失败，由 CLI 命令层向 stderr 写固定、安全、非 JSON 文案。
5. 把输出从 stdout 移到 stderr **不等于**满足本合同。
6. Migration/helper/library factory 在未注入 presenter/logger 时 **MUST** 返回 report 或使用 no-op，不得默认 `process.emitWarning`；migration 可保留显式 `onWarning` 用户文案回调，但该文案 **MUST NOT** 进入 logger。CLI 组合根显式拥有用户提示。

## 3. Level 合同

| Level | 使用条件 | 示例 |
| --- | --- | --- |
| `error` | 操作最终失败、进程将失败或用户目标未完成 | provider 最终失败、server 启动失败 |
| `warn` | 发生降级/回退或可能影响用户，但操作仍继续 | 标题生成失败后保留临时标题 |
| `info` | 低频生命周期、里程碑和安全配置选择 | serve started、session opened |
| `debug` | 尝试、分支决策、重试和开发排查元数据 | retry scheduled、fallback selected |
| `trace` | 高频细粒度时序和安全元数据 | queue state、adapter boundary timing |

补充规则：

- 默认级别为 `info`；
- 不定义 `fatal`；进程终止仍记录 `error`，可带 `terminal: true`、`exitCode`；
- 一次失败重试中的单次失败通常是 `debug`，发生用户可感知降级时为 `warn`，全部尝试耗尽才是 `error`；
- `trace` **MUST NOT**改变第 5 节的数据边界。

## 4. 最小事件合同

每行 JSONL **MUST** 是一个完整 JSON 对象，且至少包含：

```json
{
  "ts": "2026-08-29T08:00:00.000Z",
  "level": "info",
  "event": "serve.started",
  "component": "server"
}
```

字段规则：

- `ts`：UTC ISO 8601；
- `level`：第 3 节五种值之一；
- `event`：稳定的点分语义名，不使用自然语言句子；
- `component`：稳定、低基数的内置组件名；
- `event`、`component`、level 与允许的字段 key **MUST** 由模块级静态 event definition 同时声明，调用时不能传入自由字符串；
- 每个 definition **MUST** 为每个字段指定 encoder（数值/布尔、受限 enum、ohbaby ID、hash 后的外部 ID、规范化路径/URL、伪名化名称或安全错误）；
- 普通业务调用面 **MUST NOT** 暴露开放的 `Record<string, string>`、自由 `message` 或 `child(userInput)`；
- error 字段由 definition 内的 error encoder 调用统一 `safeError()` 产生，调用者不能构造最终 `SafeLogError`；
- **MUST NOT** 接受任意 request、response、config、context、Error 或 class instance 后再“自动猜测如何脱敏”；
- 未实际使用的字段不写，禁止为“以后也许有用”增加空值和重复字段；
- role、pid、进程实例等已包含在路径/文件名中的信息不要求逐事件重复。

一个合理的错误事件示例：

```json
{"ts":"2026-08-29T08:01:02.003Z","level":"error","event":"provider.request.failed","component":"llm","operationId":"op_ab12","attempt":3,"error":{"name":"TimeoutError","code":"ETIMEDOUT","message":"Provider request timed out"}}
```

首版固定编码上限：

- event 最长 96 个 ASCII 字符，component 最长 48 个 ASCII 字符；
- 一个 definition 最多 16 个扩展字段；
- 普通安全字符串编码后最多 512 UTF-8 bytes；
- safe error message 最多 512 UTF-8 bytes；
- 清洗后的 stack frames 合计最多 8 KiB；
- 单行 JSONL 最多 16 KiB；超过时先移除 stack，再按 definition 声明的可选字段逆序移除，并写 `truncated: true`；必填字段仍必须保留。`truncated` 是 JSONL encoder 保留的协议字段，不计入业务 definition 的 16 个扩展字段，业务代码不得自行声明或写入。

## 5. 数据边界

### 5.1 允许记录

- 时间、level、稳定 event/component；
- 由 ohbaby 生成或经过严格格式校验的 session/run/operation/request ID；外部可控 ID 必须先 hash；
- duration、attempt、count、boolean feature state、结果类别等低风险标量；
- 经第 6 节规范化的路径/URL；
- 经第 7 节处理的 MCP/agent/skill 名称；
- 经 definition 的 error encoder 和统一 `safeError()` 处理的错误摘要。

### 5.2 始终禁止

以下内容在 `error` 到 `trace` 的所有 level 中均 **MUST NOT** 进入普通日志：

- 用户 prompt、模型输出、reasoning、消息历史和摘要正文；
- tool 参数、tool 返回值、shell 命令正文、stdin/stdout/stderr 内容；
- MCP request/response body、resource 内容；
- HTTP request/response body；
- 环境变量或配置文件的整体对象/原文；
- API key、token、password、cookie、authorization header、私钥或其他凭据；
- 未经过 `safeError()` 的 Error/message/stack；
- 任意“先序列化，之后再正则脱敏”的原始对象。

`textLength`、token count、状态码等元数据可以记录，但不得与原文同行保存。

## 6. 路径与 URL

### 6.1 路径

实现 **MUST** 从当前运行时解析真实根目录，而不是硬编码：

- 当前 workspace/project root；
- `resolveOhbabyHome()` 得到的 ohbaby home；
- 当前用户 home；
- 当前系统 tmp。

规范化时按最长、最具体的前缀优先，将匹配部分替换为 `<workspace>`、`<ohbaby-home>`、`<home>` 或 `<tmp>`。这些只是输出语义，不是固定目录，也不要求用户单独配置。

无法匹配任何允许根的绝对路径应保守写成 `<external>/<short-hash>`，不保留原始父目录或文件名。

path encoder 只接受调用点语义上已经是“路径”的值，并负责 root 替换、路径边界、长度和已知 credential 形态清洗；它不是能判断任意自然语言是否来自 prompt 的通用 DLP。正文不进入路径字段，靠第 4 节的封闭 event definition 和代码审查保证。相对路径可以在消解 `.`/`..`、清除越界前缀并通过 credential 清洗后保留；因此“所有自然语言片段都必须从合法文件名消失”不是本合同。

### 6.2 URL

- **MUST** 删除 userinfo、query 和 fragment；
- 已知 HTTP route 应优先记录 route template，而不是带用户值的实际路径；
- 内置 provider 只记录稳定 provider ID；用户配置的 hostname/IP/origin 必须 hash，不直接记录公司域名、租户名或内网地址；
- 不需要排障的外部 path 应省略或 hash；
- body 永不记录。

## 7. 名称规则

- 由配置来源/provenance 判定的 ohbaby 内置 MCP、agent 和 skill 名称可以原样记录；
- 用户定义的 MCP、agent 和 skill 名称 **MUST** 使用稳定短 hash，即使它与某个内置名称同名也不能按内置处理；
- provenance 缺失、未知或在用户配置覆盖内置项时，必须按用户定义名称 hash 或直接省略；**MUST NOT** 仅凭名称等于内置名称就推断为 builtin；
- 首版使用 `SHA-256(kind + "\\0" + name)` 的前 12 个十六进制字符，不新增 salt/key 状态文件；
- 日志中不同时写原名和 hash；
- 文档与 UI 必须把它称为“伪名化”，不能宣称匿名或加密；无 salt 的短 hash 仍可能被字典猜测，因此不能升级为公开标识。

## 8. Error 安全化

所有错误入日志前 **MUST** 经过单一 `safeError()` 边界：

- 只输出允许的静态/分类后 `name`、稳定 `code`、规范化且限长的 `message`，必要时输出清洗后的限长 `stack`；
- 默认不复制任意 `Error.message`；provider/MCP/HTTP/第三方 SDK 等外部来源必须使用 event definition 提供的静态通用摘要；
- 只有已审计的内部错误类别可以通过专用 encoder 保留清洗后的 message；
- 移除已知 credential 形态、URL query/userinfo，并应用路径规范化；
- stack 只在确有排障价值且经过清洗时出现；必须删除会重复原始 message 的首行，只保留规范化后的 frame；
- cause 链必须限深，不能递归倾倒对象；
- 安全化失败时返回最小占位错误，不得让 logger 抛出第二个异常。

用户提示不得直接展示日志里的 stack；面向用户的文案由交互层根据当前操作上下文生成。

## 9. 文件与生命周期

### 9.1 目录和命名

- 默认根目录：`<ohbaby-home>/logs/<role>/`；
- 首版 role 至少包括 `tui`、`serve`；现有 one-shot CLI 可使用 `cli`；
- `OHBABY_LOG_DIR` 可以覆盖日志根目录；
- 每个进程写自己的文件：`<UTC-start>-<pid>-<short-instance-id>.jsonl`；
- 多进程 **MUST NOT** 共同轮转同一个固定文件。

### 9.2 权限和本地性

- POSIX 上目录权限应为 `0700`、文件权限应为 `0600`；
- 其他平台采取可用的最接近私有权限；
- 日志只保存在本地，本改造不自动上传或发送。

### 9.3 轮转和保留

首版内部固定策略：

- 单段最大 8 MiB；
- 每进程最多 3 段（当前活动段 + 最多 2 个已轮转段）；
- 清理 `mtime` 已超过 14 天的已识别日志历史，并跳过当前实例前缀；
- 轮转/清理由持有者执行，只处理 role 目录内严格符合 ohbaby 命名规则的文件，未知文件永不删除；
- 清理前解析文件名中的 pid；`kill(pid, 0)` 成功或返回 `EPERM`/其他不确定结果时视为仍存活并跳过，只有明确 `ESRCH` 才可清理；PID 重用导致旧文件暂时保留是可接受的安全侧退化；
- 轮转/清理竞态 fail-open；
- 首版不公开 size/count/retention 环境变量。

### 9.4 队列与 flush

- 写入使用最多 1,024 个已编码事件的异步串行队列；
- 队列满时，对新事件查找队列中最早且严重度更低的事件并淘汰；若不存在更低级事件，则丢弃新事件。因而 error 可淘汰 trace/debug/info/warn，但全 error 队列会丢弃新 error；
- 丢弃计数按 level 累计；队列随后首次降到容量以下时，在下一普通事件前最多插入一条 `logger.events_dropped` 安全汇总，dispose 时也尝试写一次；该汇总走内部编码路径，不递归调用 logger；
- `flush()` 是不关闭 logger 的 2 秒 barrier，只供组合/测试在进程仍继续时使用；
- `dispose()` 停止接收新事件，执行一次最长 2 秒的 drain 并关闭 writer，且必须幂等；正常退出只调用 `dispose()`；
- process logger handle 的拥有者必须显式 dispose；业务模块只接收 `Logger`，不能靠 duck typing 猜测或重复关闭 handle。

## 10. 配置与失败退化

首版只支持：

- `OHBABY_LOG_LEVEL=error|warn|info|debug|trace`
- `OHBABY_LOG_DIR=<absolute-path>`

行为合同：

1. 只有将要创建 process logger 的 TUI、fresh serve 或显式 opt-in CLI 才验证配置；这些路径上用户显式提供非法 level 或非法目录配置时启动阶段受控报错，避免用户以为日志正在工作。direct library no-op、reused serve 和未 opt-in 的 one-shot CLI 不消费该配置，也不因它失败；
2. 未配置自定义目录、默认目录不可写：业务继续，禁用文件日志，并由组合根提示一次；
3. 运行中写入失败：logger 原子地转为 disabled，通知组合根一次，不递归记录该失败；
4. TUI 活跃时通过 UI 状态/通知呈现；Ink 已恢复终端后才发生的首次 dispose/drain 失败由 CLI 命令层向 stderr 写一条固定、安全、非 JSON 警告；serve 由命令启动层输出一次警告；
5. `onUnavailable` 回调最多调用一次；回调自身抛错必须被吞掉；
6. CLI TUI/serve 显式启用默认 `info` 文件日志；公开 agent/server library factory 未注入 diagnostics capability 时默认 no-op；
7. flush/dispose 失败不覆盖原业务退出码；shutdown-only failure 仍遵守同一个 once gate，不能在 UI notice 后重复打印。

## 11. 反误用约束

实现阶段应以 lint/类型/API 共同约束：

- `packages/ohbaby-agent/src/**` 与 `packages/ohbaby-server/src/**` 默认禁止直接使用 `process.stdout`、`process.stderr`、`console.*`，仅对经过审查、确实拥有输出协议的极窄入口做 allowlist；
- logger 只接受模块级静态 event definition 及其经过 schema 推导的 input；不公开开放 fields record，也不接受 `unknown`、`any` 或任意嵌套 record；
- 本地 ESLint/AST 规则 **MUST** 限制 `defineDiagnosticEvent()` 只能出现在顶层 `const` initializer，且 level/event/component 为字面量；
- writer 只接收已经过策略层编码的 JSONL 字符串，不接收原始对象；
- 测试必须证明 `trace` 仍拒绝正文，而不只检查默认 `info`；
- 测试必须扫描凭据、prompt、tool/MCP/HTTP body 和真实绝对路径不会出现在日志文件中。

## 12. 变更规则

任何希望放宽第 5 节禁区、增加远程上传、改变默认终端行为或新增正文捕获能力的改动，都必须先修改本文并进行独立安全审查；不能通过新增环境变量、debug flag 或临时 `console.*` 绕过。
