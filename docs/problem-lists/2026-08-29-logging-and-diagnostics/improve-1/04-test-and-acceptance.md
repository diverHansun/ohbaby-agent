# 04 - 测试与验收方案

## 1. 测试目标

这次改造不能只证明“logger 会写一行 JSON”。必须同时证明四件事：

1. **用户界面正确**：TUI/serve/Web 不出现内部日志和原始 JSON；
2. **诊断文件可用**：真实进程产生可解析、可关联、可轮转的 JSONL；
3. **敏感边界不可绕过**：`trace`、异常、路径、用户定义名称都不能泄露正文/凭据；
4. **logger 失败不拖垮业务**：初始化、运行中写入、队列满、flush/dispose 超时都按合同退化。

测试采用项目已有的 unit / contract / integration / smoke 分层；外部 LLM/MCP 使用本地 scripted fake，文件系统和子进程生命周期在 integration/E2E 使用真实实现。

## 2. 测试原则

- 测试结果，而不是内部私有方法调用次数；
- 安全规则必须同时有正向与负向测试；
- 不依赖真实云 API、用户 API key 或网络；
- 不仅 spy 当前 Vitest 进程，还要启动真实构建产物；
- 不把“stdout/stderr 绝对为空”作为错误断言：TUI 的 stdout 本来就由 Ink 写画面，serve 也有合法 ready 输出；应断言没有越权诊断内容，并对白名单产品输出分类；
- 涉及退出和 dispose 的测试必须观察真实子进程关闭，不用 `setImmediate()` 猜测队列已排空；
- 实现前不写“已通过”，实际结果统一在 `05-implementation-acceptance.md` 记录。

## 3. 单元测试

### T-U1：Level 过滤矩阵

对五种配置逐一断言允许/抑制事件：

- `info` 允许 error/warn/info，抑制 debug/trace；
- `trace` 允许全部 level；
- 非法值由配置解析直接拒绝；
- level 只控制事件是否出现，不改变字段策略。

### T-U2：最小 JSONL 合同

- 每次写入只有一行且以换行结束；
- 行可被 `JSON.parse`；
- 必填字段仅 `ts`、`level`、`event`、`component`；
- 字符串中的换行被 JSON 转义，不打断 JSONL；
- undefined 字段被省略；
- 96-char event、48-char component、16 个扩展字段、512-byte 普通字符串/error summary、16-KiB 整行上限分别生效；
- 超过整行上限时按 definition 可选字段逆序移除并标记 `truncated: true`；`truncated` 只能由 encoder 写入、不计入业务字段上限，业务 definition 声明同名字段会被拒绝；首版不生成 stack，未来若开放内部 stack encoder，必须另加 8-KiB 上限并优先裁剪 stack；
- 序列化异常不能逃出 logger。

另外验证 event/component 只接受静态格式，不能把用户定义名称、路径或正文拼进命名空间；外部可控 correlation ID 必须先 hash 或被拒绝。

### T-U3：`trace` 不能打开正文

构造带唯一 sentinel 的：

- prompt；
- completion/reasoning；
- tool args/result；
- shell command/stdout/stderr；
- MCP request/response；
- HTTP body；
- API key/cookie/auth header。

即使 level=`trace`，最终 JSONL 也不得包含任何 sentinel。允许的只是 `textLength`、token count、status、duration 等安全数值。

这里不把 encoder 冒充成“理解任意字符串语义”的 DLP：路径 encoder 合法保留相对路径或受控后缀，因此任意 prompt sentinel 若被调用者错误地当成路径传入，编码器无法凭空识别它。真正的硬边界由两层测试组成：

- event definition 不能声明 prompt/body/command/output 等正文槽位，调用点也不能传动态字段或自由 message；
- ID、URL、entity name、Error 等 encoder 按各自合法输入测试拒绝、hash、规范化或静态摘要；path encoder 使用真实路径样本验证 root 替换、外部 hash 和凭据模式清洗，而不要求删除所有可能恰好出现在文件名中的自然语言。

最终 E2E 仍以真实 prompt/tool/body sentinel 扫描日志；一旦它们从真实正文流进入 JSONL 就判失败。这个测试验证架构没有正文通路，不声称用正则识别所有可能的人类文本。

### T-U4：路径标准化

至少覆盖：

- workspace 位于 home 内时，最长匹配得到 `<workspace>/...` 而不是 `<home>/...`；
- ohbaby home 由 `OHBABY_HOME` 指向自定义绝对路径；
- tmp/home/workspace 重叠或包含相似前缀时按路径边界匹配；
- Windows drive/分隔符与 POSIX 路径；
- 未匹配绝对路径变成 `<external>/<short-hash>`；
- 相对路径保持相对且不能通过 `..` 重新暴露外部绝对路径。

### T-U5：URL 标准化

- 删除 username/password、query、fragment；
- 已知 route 使用 template；
- 内置 provider 记录稳定 ID；用户配置 hostname/IP/origin 只出现 hash，不出现公司域名、租户或内网地址；
- 外部路径按策略省略/hash；
- authorization 和 body 不进入结果；
- malformed URL fail-closed。

### T-U6：名称伪名化

- 内置 MCP/agent/skill 名称只有通过 definition 的静态 enum allowlist 才能保持原名；
- 用户定义名称只能进入始终 hash 的专用 encoder，不能由调用者传 provenance 改变行为；
- 用户定义实体即使与内置实体同名，仍使用 hash；
- 来源缺失、未知或用户覆盖内置项时一律走用户名称 encoder 或省略，不能按名称猜 builtin；
- 同一 kind/name 得到稳定短 hash；不同 kind 的同名实体不会得到相同 hash；
- 不同名称通常不同；
- 结果明确是 hash 标识，不做可逆编码。

### T-U7：`safeError`

- 首版只开放保守的 external error encoder，不开放“内部安全 message”、stack 或 cause encoder；未来若新增这些能力，必须在同一批次补齐路径替换、限长和 cause 限深测试后才能开放；
- provider/HTTP/MCP 原始 error body/message 不被信任；
- Error name/code 只来自静态 allowlist，任意自定义 name/code 不进入结果；
- 未知 Error、throwing getter 与非 Error 值得到最小占位；
- token、URL query、authorization 形态不会因错误 message/stack 被复制；
- `safeError()` 自身永不抛出。

### T-U8：Writer 生命周期

使用注入的 clock/id/文件 adapter 或 internal test seam 覆盖：

- 串行顺序；
- 1,024 个事件队列上限；满时新事件只淘汰“最早且更低级”的已排队事件，否则丢弃新事件；
- capacity 恢复/dispose 时至多一条按 level 计数的 `logger.events_dropped` 汇总；
- 单段达到阈值后轮转；
- 每进程最多 3 段（含活动段）；
- 历史清理竞态 fail-open；
- 第一次写失败触发一次 `onUnavailable`，后续不重复、不递归；
- `onUnavailable` 自身抛错被吞掉；
- 非关闭 `flush()` barrier 成功/失败/2 秒超时，`dispose()` 的 2 秒 drain；
- dispose 幂等；
- 文件模式/目录模式在 POSIX 正确。

内部阈值可以通过 internal constructor/test seam 缩小，不为测试公开生产环境变量。

## 4. 类型与合同测试

### T-C1：调用面禁止 raw object

通过 TypeScript compile fixture / `@ts-expect-error` 和 runtime schema 负向测试证明以下行为不合法：

- logger 直接接受 event/component/string fields，绕过静态 definition；
- definition 使用 widened string event/component、自由 text/object encoder 或用户输入作为字段 key；
- `{}`、手写带相似字段的对象、spread clone 均不能作为 definition 传入 `emit()`，runtime identity check 也必须拒绝伪造对象；
- 非 error encoder 传递数组、嵌套对象、原始 Error、unknown config；
- 把 tool/MCP response 直接作为字段；
- 用户定义实体原名作为 component/event/key 或按“同名内置”逃过 hash；
- writer 接收未编码 record。

### T-C2：No-op 与无副作用

- 未注入 logger 的现有 agent/server factory 保持行为中性；
- no-op 不构造完整 record、不调用 clock/UUID、不写文件/终端；
- command recorder 仍由自己的显式 sink 控制，不因 logger 接入改变协议。

### T-C3：注入 logger 的生命周期合同

- agent/server 业务模块只接收 `Logger`，不拥有 process handle；
- TUI composition 正常/异常 dispose 都按顺序关闭 backend，再由唯一拥有者调用一次 logger `dispose()`；
- 实际 server composition 持有 handle，supervisor 通过明确的强类型 `disposeDiagnostics` seam 在 signal exit 前协调关闭；
- start 失败、正常 stop、signal stop、idle stop 均只 dispose 一次；
- EADDRINUSE 自动换端口不会泄露或重复 dispose handle；
- supervisor 在 dispose 前记录最终 success/failure，signal/idle catch 和其他调用方在 dispose 后不再调用 logger；
- render 前 migration warning/unavailable 进入 startup notice，render 后 unavailable 只通知一次；Ink 已恢复终端后才发生的首次 unavailable 改由 CLI 命令层输出一条固定、非 JSON 警告；三种 phase 共享同一个 once gate，notice subscriber 或 `onUnavailable` 抛错不逃出 logger；
- 任何层都不通过 `{ flush?: ... }` duck typing 猜测，也不重复关闭同一个 process handle；
- command recorder 若具有自己的 flush，继续遵守它独立的强类型 recorder 合同，不与 logger handle 混合。

### T-C4：输出所有权 lint

ESLint 对 agent/server **生产源码**设置 `no-restricted-properties`/等价规则，默认禁止 `process.stdout`、`process.stderr`、`process.emitWarning`、`console.*`。Phase A 对 title/token/migration/supervisor/create-app 现存旁路设置逐文件临时 allowlist，B/C 每迁移一处即删除一项；`services/database/connection.ts` 对 Node SQLite warning 的窄拦截是注明原因的永久 allowlist；测试文件使用单独 override。用 ESLint Node API 对内存/临时违规文本做 contract test，证明规则会拦，不能把永久失败 fixture 放进正常 lint glob。

definition 的安全合同由 TypeScript compile fixture 与 runtime contract test 验证：widened string、动态字段和结构伪造不能通过；模块级 `const` 复用作为 review 层面的 SHOULD，不建设自定义 AST fixture。

### T-C5：启动 warning consume-once

- `takeAll()` 首次返回全部 warning，第二次为空；
- TUI 在 render 前消费，普通命令在 handler 入口消费；
- parse/usage/handler 早期失败以及故意遗漏消费时，顶层 `finally` 恰好兜底一次；
- 长运行 handler 在入口消费，signal/退出不会把 warning 留在内存；
- warning 文案不进入 JSONL，重复消费不会重复展示。

## 5. 文件与真实进程集成测试

### T-I1：真实文件创建与权限

在隔离的 `OHBABY_HOME`/`OHBABY_LOG_DIR`：

- 创建 role 子目录和 JSONL；
- POSIX 检查目录 `0700`、文件 `0600`；
- 每行解析并符合最小 schema；
- 正常 shutdown 后尾记录可读；
- 测试结束删除临时目录。

### T-I2：并行实例不争用

启动两个真实子进程使用同一 log root、同一 role：

- 生成两个不同文件；
- 文件名包含各自 pid/instance；
- 每个文件内部行完整、顺序稳定；
- 一个进程轮转/退出不截断另一个进程。
- retention 只删除严格匹配命名协议且 mtime 超期的文件；当前实例、pid 仍存活或 `kill(pid, 0)` 返回 EPERM/不确定的文件不删除；未知文件不删除。

### T-I3：默认目录不可写与显式坏配置

- 显式非法 level、相对 `OHBABY_LOG_DIR`、目录实际是普通文件、父目录稳定不可创建：子进程受控启动失败，错误文案可理解；
- 上述 fail-fast 只适用于实际创建 logger 的 TUI/fresh serve/显式 opt-in CLI；direct library no-op、reused serve 和未 opt-in one-shot 即使环境中有非法值也不因未使用配置失败；
- 默认目录不可用：业务仍成功，只有组合根的一次提示；
- 提示中没有 stack/秘密；
- logger 不在 stdout/stderr 额外递归报错。

### T-I4：TUI in-process backend 真实构建产物

扩展现有 `tests/integration/cli/command-record-terminal.integration.test.ts` 的模式：

1. 构建 sdk/agent/server/cli；
2. 子进程加载真实 `dist`；
3. 由于 direct library factory 默认 no-op，该 child 显式创建并注入 role=`tui` 的 process logger，再创建 in-process backend、执行 slash command，最后由唯一拥有者 dispose；fake prompt、光标恢复和 Ink 画面节奏由下文真实 PTY 见证覆盖；
4. 捕获子进程 stdout/stderr；
5. 断言不存在 `ui.command.`、日志 JSON、prompt sentinel、credential；
6. 断言独占 JSONL 存在且含预期安全 lifecycle/operation 事件；
7. 断言 dispose 后尾记录已经落盘；
8. `/status` 显示该 child 实际 `logFilePath`，普通输入区不自动插入路径。

自动子进程测试把“否定终端污染 + 肯定日志落盘 + 真实退出时序”放在同一条路径，不能只 spy `process.stdout.write`；fake prompt 与完整画面节奏属于 operator-assisted PTY 证据，不冒充无人值守 child assertion。

### T-I5：真实 `ohbaby serve`

复用当前 command-record serve 子进程测试结构：

1. 用真实 `packages/ohbaby-cli/dist/bin.js serve --port 0 --no-open` 启动；
2. 通过 scripted local provider 和 RPC/HTTP 执行 slash command/prompt；
3. 调用 shutdown 并等待真实进程关闭；
4. stdout 只允许 ready/明确产品输出，并在 fresh 启动显示准确 diagnostics 路径；stderr 默认无内部 JSON；
5. JSONL 包含 serve start、请求结果元数据、shutdown；
6. 不包含 auth token、request body、prompt/tool result；
7. 退出码不因 dispose drain 改变。

### T-I6：late drain 进程测试

子进程内创建真实 process logger，紧接着记录尾事件并触发正常 dispose/退出。父进程只在子进程关闭后读取文件并断言尾事件存在。另设受控 writer hang/failure fixture，证明 2 秒 dispose timeout 不挂死且原退出码保持；非关闭 `flush()` 另由 unit/contract 测试验证。

TUI phase-aware 行为采用分层证据：Ink/app contract 验证 active phase 只提示一次，CLI unit 验证 `terminal-restored` 后的固定 late notice，真实 logger child 验证 hanging close 不改变原退出码；operator-assisted PTY 再见证终端恢复、光标与画面未受污染。首版不把这四层证据误写成单个无人值守 TUI 子进程；若未来发生这一边界的回归，再升级为专用 PTY/terminal-adapter child 测试。

### T-I7：CLI 默认与 library no-op

- direct `buildCoreAPIImpl()` / `startDaemonServer()` 未传 diagnostics capability 时不在真实 HOME/OHBABY_HOME 创建日志；
- 真实 CLI TUI composition 默认创建 role=`tui` 日志；
- 真实 CLI fresh serve 默认创建 role=`serve` 日志；
- serve 复用已有进程时，发起复用的客户端进程不产生新的伪 serve 文件；
- 早期 config migration、data migration 的 CLI 路径都不走 `process.emitWarning`；config `onWarning` 文案只进入当前启动过程的内存 buffer，config report 从 `LoadRuntimeEnvResult` 返回，data helper 直接返回 report；direct `startDaemonServer()` 只有显式传 `onDataMigrationReport` 才观察 fresh data report，默认保持安静；
- 分别运行 TUI、fresh/reused serve、serve status/ps/stop 和现有 one-shot 命令，证明每条 config migration warning 恰好由对应命令层呈现一次，且 JSONL 只含 report 计数、不含 warning 文案。
- fresh serve 的 diagnostics 路径对应真实文件；reused serve 不打印一个属于客户端的伪日志路径。

### T-I8：已确认的错误格式一致性

- stdout renderer 的 command failure 与 runtime failure 都保留稳定 error code；
- TUI prompt/app 的最终 `IrisError` 使用共享 `[code] message` 格式；
- 普通 Error 仍使用安全 message，不凭空制造 code；
- 错误格式修复不把 stack、provider body 或 secret 带入用户界面。

## 6. TUI 实际交互 E2E

单纯 pipe stdout 无法验证光标、raw mode 和 Ink 重绘，因此实施完成后必须在真实 PTY/本机终端执行一次可复现流程：

1. 使用隔离 HOME/OHBABY_HOME/LOG_DIR 和本地 scripted provider 启动真实构建后的 `ohbaby`；
2. 输入 `/status`、`/skills` 等 slash command；
3. 连续输入两条 prompt，确认输入节奏、光标和重绘正常；
4. 触发一个可恢复降级和一个最终失败；
5. 正常退出，再执行一次中断/崩溃恢复路径；
6. 保存 PTY transcript 或屏幕截图作为验收证据；
7. 检查终端没有 `{\"record\":...}`、JSONL、stack 或 logger warning 插入；
8. prompt/model/tool sentinel 只允许出现在对应消息/工具 UI 区域且次数符合流程，不得作为额外 JSON/logger/stack 行出现；
9. 检查日志文件有对应安全事件，并扫描正文 sentinel/secret/path 不存在。

自动化优先复用系统可用 PTY harness；若跨平台 harness 需要新依赖，先用现有 child-process integration + Ink contract tests 作为 CI 门，再把本机真实 PTY 作为发布前必跑验收，不为一次测试盲目引入重量依赖。最终验收文档必须写清“自动化”还是“人工/agent 实跑”，不能混称。

## 7. Web/serve E2E

扩展 `scripts/run-compiled-web-e2e.mjs` 的现有真实构建流程：

- 设置隔离 `OHBABY_LOG_DIR`；
- 启动真实 compiled `ohbaby serve`；
- 保留当前 scripted provider、tool call、follow-up、刷新/会话恢复行为；
- 在 prompt、tool result、API key、authorization 中分别放唯一 sentinel；
- 流程结束后读取 serve JSONL，断言只出现长度、token、duration、outcome 等安全元数据；
- UI 仍能看到正常 user/assistant/tool panel；prompt/model/tool sentinel 只能出现在对应产品节点中，不能以日志行、错误 stack 或额外副本出现；
- server 启动终端没有诊断 JSON；
- shutdown 后尾记录落盘。

浏览器前端不必在首版使用同一个 Node file logger，但 Web 用户路径必须证明 backend 日志接入没有改变请求、流式事件、刷新和错误展示。现有 compiled Web 脚本需要从 stdin 提交浏览器证据，因此把它标记为“交互式/agent 实跑 E2E”，不是无人值守 CI 门；扩展时还要让 harness 在 `waitForReady()` 返回后继续持有 serve stdout/stderr buffer，供最终输出分类断言。

## 8. 用户可见验收场景

| 场景 | 用户应该看到 | 日志应该有 | 禁止出现 |
| --- | --- | --- | --- |
| TUI 正常启动 | 正常界面 | `tui.started` 等低频事件 | JSON/路径/logger banner |
| slash command | 命令结果/面板 | command outcome 元数据（若有价值） | `ui.command.record` 原文 |
| provider 重试成功 | 通常无额外噪音 | debug attempt + final outcome | prompt/response body |
| 降级继续 | 简洁提示（仅用户需要时） | warn fallback 元数据 | stack |
| 最终失败 | 清晰错误与可行动建议 | error + safe error + correlation | credential/raw SDK error body |
| 日志目录不可用 | 一次受控提示，业务可继续 | 无法写文件是预期 | 每次事件重复警告 |
| serve ready | ready URL/必要信息 | serve started | supervisor JSON 刷屏 |
| 正常退出 | 终端恢复、退出及时 | shutdown/尾事件 best-effort | 卡死/改退出码 |

## 9. 敏感信息验收样本

每个集成/E2E 临时环境都注入唯一、易扫描且不会误匹配的 sentinel，例如：

- `PROMPT_SECRET_<uuid>`
- `MODEL_BODY_<uuid>`
- `TOOL_RESULT_<uuid>`
- `MCP_BODY_<uuid>`
- `API_KEY_<uuid>`
- 一个真实 temp/workspace/home 绝对路径
- 一个用户定义 agent/MCP/skill 名称

验收时按 surface 分开检查：

- 所有 `.jsonl`：正文/凭据 sentinel 必须完全不存在；
- backend/serve 的 stderr 和 raw diagnostic stream：正文/凭据 sentinel 必须完全不存在；
- TUI transcript：正文 sentinel 只允许位于预期消息/工具区域，不得出现日志 JSON、stack 或额外副本；
- Web E2E 证据：按 DOM/事件类型断言 sentinel 只出现在预期产品节点，不能对整个证据文件做全局禁止。

所有诊断 surface 中，内置名称可出现，用户定义名称只能出现预期 hash；绝对路径只能以语义占位符或 external hash 出现，经过清理的合法相对路径可以保留。API key/cookie/auth 等 credential 在任何 surface 的验收证据中都不得显示。

## 10. 阶段门与命令

每个阶段只跑与变更直接相关的 targeted tests，然后在阶段 commit 前执行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

涉及 compiled Web 的 Phase C/F 额外交互式/agent 实跑：

```bash
pnpm test:e2e:compiled-web
```

最终 Phase F 执行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e:compiled-web
```

`pnpm format:check` / `pnpm preflight` 仍应执行并记录，但若它只命中实施前已存在、且本轮没有触及的 format baseline，则不得为了本功能机械改写无关文件。此时必须同时满足：本轮触及文件单独通过 Prettier、`git diff --check` 通过、验收文档记录 baseline 数量；这属于仓库级 release gate 的显式例外，不得写成“preflight 已通过”。

真实 TUI PTY 流程和真实 serve 进程测试另外记录运行命令、隔离目录、退出码、用户可见输出摘要和脱敏后的 JSONL 样例。

## 11. 完成定义

只有同时满足以下条件才能判定通过：

- [x] `logging-policy.md` 的 MUST/MUST NOT 均有实现或自动门；
- [x] TUI 与 serve 默认 level=`info`、本地 JSONL、无终端 logger 输出；
- [x] `trace` 负向正文/凭据测试通过；
- [x] 每进程独占文件、权限、轮转、保留和 bounded queue 通过；
- [x] CLI TUI/fresh serve 默认启用、公开 library factory 缺省 no-op、serve reuse 不创建伪文件；
- [x] config/data migration 的 CLI 路径无 `process.emitWarning` 旁路，config 用户提示只来自显式 `onWarning` startup buffer，JSONL 只含 report 四类计数而不含 warning/report 字符串；
- [x] logger 初始化/运行/flush/dispose 失败按合同退化且只提示一次；
- [x] command recorder 独立合同未回归；
- [x] 真实构建产物的 TUI backend/serve 子进程测试通过；
- [x] 真实 TUI PTY 交互无画面/输入污染；
- [x] compiled Web E2E 行为与日志安全同时通过；
- [x] lint、typecheck、全量 test、build 通过；本轮触及文件通过 format check；repo-wide preflight 若仅受已记录历史 format baseline 阻断，按上节显式例外处理；
- [x] `05-implementation-acceptance.md` 记录实际证据、已知限制和与方案的偏差；
- [ ] 用户审查后再决定 merge/push。
