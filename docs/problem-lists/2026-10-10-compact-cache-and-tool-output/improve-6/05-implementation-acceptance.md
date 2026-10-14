# 第 6 批：实施与验收记录

> 2026-10-13；本地分支 `codex/context-improve-6`，起点为 improve-5 的 `16737a72`。本文记录实际实施，不改写 02／04 的原始验收契约。本批实施与验收完成，等待用户审查；未 merge、未 push。

## 1. 实际改动

- S1：Web conversation 与 CLI execution 共用按 run 分页的摘要补齐规则。查询仍限定 session／scope；真正的 runless summary 与普通 run 消息一起参与 keyset 分页，退场摘要继续投影为压缩标记，正文不显示。
- 标记归属使用已有 `modelRequests` 中首个 `context-summary` 请求的开始时间，结合执行开始／完成及下一次真实启动的执行边界。排序和游标仍使用消息的 `createdAt + id`，没有给摘要或请求伪造 run／step，也没有修改持久化结构。旧摘要缺请求记录时退回消息创建时间。
- SDK 在合并、重开及保留阅读窗口时识别这类标记的执行归属，避免将无 runId 的标记排到所有父用户消息前。复用既有 `UiMessage.modelRequests` 字段，只有子代理摘要需要附带；主会话输出保持原有规则。
- S3：复用既有测试设施补普通子代理请求的一次 force、同一步重入／新一步机会、父与兄弟继续运行、成功占用地板隔离、多次压缩、Mode A／B 内容集合和 20K 合法边界。
- X1：删除静态 `AgentConfig.model/maxTokens/temperature/topP`，文件 schema、Registry、主代理与子代理自定义 RuntimeAgent 消费入口均拒绝旧字段，包括显式 `undefined`。错误指出来源或 agent 与字段。保留全局 LLM 设置、运行时 `modelId` 和 reasoning；无自动迁移。
- S5：沿用通用失败通路。补后台错误进入父模型请求、Web Failed、CLI 原因详情的回归，未新增压缩专用通知。

用户授权的本机 agent 配置检查没有发现这四个旧字段，无需修改本机配置。

S2 独立选模型／跨 provider、S4 子代理占用视图、X2 归档资源回收均未实施。共享 child session 结构与主会话占用缓存不变。

## 2. 实施中的取舍

Pi 预审建议将摘要纳入一次数据库分页查询，已采用；没有采用给摘要加 runId 或另拉全量历史的做法。

单靠摘要提交时刻不能处理相邻执行在同一毫秒切换。曾考虑利用 `readIds`，独立复核发现它不是累计 lineage：长 run 多次压缩后可以不再包含初始 user。因此最终使用已经持久化的摘要请求开始时刻。历史数据若既没有请求记录，又只有无法区分的同毫秒时间戳，读取按稳定的半开时间窗口分配，不宣称能恢复当时未保存的因果顺序。缺少请求记录的旧摘要若在执行完成后才提交，也可能不落入任何执行时间窗；本批不添加数据猜测或迁移来恢复未保存的归属。

独立审查又发现“下一条已接受执行”可能只是排队后取消的记录，因此下一边界必须来自真正启动的执行；相关查询在 LIMIT 前过滤，避免逐页扫描大量取消记录。

C4 的具体证据：未增长历史已经收敛到尾段，自动路径被成功地板抑制；手动路径绕过地板并进入候选计算，随后按既有规则返回 `too-short`。这证明手动豁免，不能写成“同一份短历史再次成功生成摘要”。没有为了验收人为放宽压缩规则。

S5 新后台集成把实际 Lifecycle 失败结果交给真实 execution/result/coordinator，最终检查父模型请求。Lifecycle → execution finish 在该窄用例中显式接线；完整 host 路径另由既有前景 e2e 和 host 测试回归，不能将窄集成单独称为完整 host E2E。

## 3. 自动检查与故障注入

最终稳定代码的 `pnpm test`：536 文件通过、6 文件跳过；6096 测试通过、17 跳过（总数 6113），耗时 187.78 秒。该命令覆盖默认单元、契约、集成与构建产物烟测。首次全量运行与 SDK 补测交错，捕获了尚未完成修复的 legacy owner 用例，未将其算作通过；冻结改动后已重新完整运行。`pnpm build` 成功，包含正式 Web 与 CLI 产物；Vite 保留既有大 chunk 提示。

| 定向检查 | 已取得证据 |
| --- | --- |
| X1 agents／config | 15 文件、234 测试通过；独立审查含 C/S5 的 10 个文件 268 测试通过 |
| Context C3／C4／C5 | 5 文件、70 测试通过；保留与遗漏 ID 从合成输入独立列出，原 part 正文和工具状态留库 |
| Lifecycle 与通用失败 | 8 文件、178 测试通过；既有前景 fake-provider E2E 1 通过、7 个未选用例跳过 |
| Message 与两种 reader | 12 文件、134 测试通过；SQLite 关闭后重建存储、reader 与 projection |
| 静态检查 | lint 0 错误、109 条既有警告；最终 typecheck 与正式 build 均通过 |

故障注入只临时改对应实现，均已恢复；以下失败均来自目标断言，不是编译错误：

| 改坏行为 | 测试反应 |
| --- | --- |
| 子代理禁用 force | scoped force 次数、子代理新一步最终结果变红 |
| 同一步刷新机会／机会按整轮耗尽 | 重入应 1 次实际 2 次／新一步不再能恢复，分别变红 |
| 地板 key 去 scope | B 应成功压缩却被 A 的地板抑制，变红 |
| 手动入口重新受地板限制 | 手动不再进入候选计算，变红 |
| Web 或 CLI 任一 reader 不补摘要 | 内存和 SQLite 两变体均漏掉预期 marker，各 2 条红，恢复 6 条绿 |
| 去 scope／去执行边界 | 兄弟 marker 串入／跨 execution 重复 marker，分别 2 条红 |
| 漏旧页 marker／重复追加记录 | 精确消息 ID、页大小与顺序断言分别 2 条红，恢复 10 条绿 |
| schema 恢复接受 model | 文件拒绝断言 1 条红 |
| 去子代理每轮配置检查 | legacy value 和 explicit undefined 两变体红 |
| SDK 不识别 marker owner | 压缩标记排序用例变红，恢复通过 |

## 4. 真实 API 与 Web／CLI

### 4.1 环境与输入边界

在 `e22b2db1` 的正式构建上启动独立 `ohbaby serve`：`http://127.0.0.1:63781`，数据目录为临时目录 `ohbaby-improve6-web-KVhabG`。按 `tests/models-4-tests.md` 使用真实 DeepSeek `deepseek-flash`，主、子代理同模型。隔离验收配置窗口 50,000、普通输出上限 8,192，Web 请求使用 high reasoning；生产配置未改。凭据只在进程内读取；观察器只保存消息 hash、角色、长度、用量和测试回复，不记录凭据。

设置跨重启累计 24 次请求上限，实际 12 次，均 HTTP 200 并完成。包含一次标题请求；标题请求只输出 reasoning，标题沿用既有回退，不将其记成有效正文。没有重试风暴或上下文溢出错误。

先通过真实 Web 新建 `cedar-check` 子代理，再停服务，以正式 MessageManager 在该 scope 写入 16 条明确标注的合成长历史，重启后由 Web 续跑同一个子代理，实际调用模型生成摘要。后续分页另追加 105 条短消息作为展示填充，随后再次重启。**长历史与分页填充是人工测试输入；压缩摘要、模型回复和 UI 操作是真实链路。** 没有伪造摘要或摘要 runId。

### 4.2 请求、占用与缓存

| 真实请求 | Provider 输入 tokens | 缓存读取 tokens | 命中率 |
| --- | ---: | ---: | ---: |
| 首次子代理回复 | 4,509 | 0 | 0% |
| 子代理摘要 | 16,375 | 4,224 | 25.80% |
| 压缩后首次普通请求 | 16,317 | 4,224 | 25.89% |
| 同一子代理继续一轮 | 16,596 | 16,384 | 98.72% |

实际自动压缩提交的标记为 `116,646 -> 18,923 tokens; 19 parts omitted`（本地估算，不能等同 provider 输入 tokens）。摘要请求执行既有容量裁剪与输出预算规则，`maxTokens=16,365`；普通请求仍为 `8,192`。摘要与后两次普通请求的 system、tools、thinking、cache key hash 一致。压缩后首个普通请求为 system + 摘要 + 保留的完整 user/assistant 组 + 新 user，共 5 条；下一轮完整复用这 5 条消息前缀，增加 assistant/user 到 7 条。

两次真实续跑均正确保留 Cedar release 17、owner Mia、job-47/E_CHECK_41、未执行测试、部署仅为提议。摘要持久化 ID 为 `e2668992-13ae-4be3-a2a4-47e57a1eebb6`，scope 为该子代理，`runId` 为空，保存了真实 `context-summary` 请求记录。

主页面占用继续显示主会话（运行后约 10.9K/50K），没有把子代理的 18,923 当作主会话用量。服务重启后占用重新按既有查询估算，见到约 11.5K/50K；不属于子代理占用视图。

### 4.3 Web 与 CLI 入口

真实 Web 首次打开目标子代理执行看见压缩标记；服务重启后从最新执行进入，初始页没有旧标记，加载第一批旧页仍无标记，第二批旧页出现且仅出现一次。页面重新加载后完整重复，仍为 `0 -> 0 -> 1`。摘要内部正文没有出现在页面。保留只读子代理页面供用户查看。

CLI 用正式编译入口、原生 yargs／Ink／SubagentBrowser，在真实 120×34 PTY 中执行 Ctrl+G → 目标 execution → Enter → PgUp。第一页 50 条无标记，两次 PgUp 分别返回 50 和 7 条，第三页看到相同摘要 ID 与提示；关闭重开详情后重复成功。107 个唯一 ID 与 105 条填充、1 条真实标记、1 条真实回复对齐，旧页标记仅出现一次，`hasMore` 最终为 false。观察的 RPC 是真实 UI 发出的请求，不用单独调用内部 reader 代替 UI 验收；未提交模型请求。

CLI 原生远程参数只有 argv token，为避免凭据进命令行，临时 launcher 仅注入正式远程 host，凭据在进程内读取。其余解析、渲染、键盘与分页链路为正式产物。终端图是实际 ANSI 的可见 cells 回放，不冒充原生 Terminal 截图。验收工具曾误包同步订阅、误匹配旧提示文案，校正后重新完整执行成功，生产代码没有为此修改。

浏览器捕获三条子代理刚启动时的 `duration-clock` 诊断。独立复核确认相关 hook、SDK duration、Web store、SessionScreen 与 `16737a72` 的 blob 相同；子代理每秒刷新而计时样本来自主会话，新执行可能晚于旧样本，现有实现夹到 0 并记日志，完成后改用起止时间。日志没有两端时间值，不能还原本次滞后量；这是符合数据流的解释。相关定向测试 3 条通过。未观察到执行或历史数据失败，本批不扩范围处理计时采样，不能写成浏览器零错误。

本地证据：隔离目录中的 `wire.jsonl`、`api-acceptance.json`、`inspection.json`、`web-marker-after-pagination.png`、`web-marker-reopened.png`；CLI 证据见 `.ohbaby/improve6-cli-evidence/`。这些临时证据不随代码提交。

## 5. 审查与提交

- Pi 预审：`opencode/claude-opus-5-5`，medium。已完成，只读检查方案；同任务会话后续用于最终审查。
- 子代理独立审查：X1／C／S5 无阻断缺陷；配置职责文档歧义已修。S1 发现取消队列边界问题，修复与验收记录见上。
- 最终 Pi：`github-copilot/claude-opus-5.5`、medium，只读审查完成，结论为无阻断问题；独立运行 8 文件、148 条定向测试通过。它核查代码和报告，但没有逐项复核实网证据／截图；实网证据由主任务及 CLI 子代理核验。建议保持当前实现，仅将文档待审状态更新为完成，已采纳。

| 本地提交 | 内容 |
| --- | --- |
| `1f09f77d` | 固定 improve-6 已确认范围与验收契约 |
| `db13de76` | 静态 agent 模型设置清理与明确拒绝 |
| `080dbae3` | 子代理恢复／地板／通用失败测试 |
| `e22b2db1` | 两端标记分页回放、SDK 顺序及取消队列边界 |
| 本记录所在提交 | 本批验收结果、模块索引与历史说明收尾 |

## 6. 整轮范围与后续

前五批结果各自保留，不因本批通过而重新宣称整轮验收完成：
[improve-1](../improve-1/05-implementation-acceptance.md)、[improve-2](../improve-2/05-implementation-acceptance.md)、[improve-3](../improve-3/05-implementation-acceptance.md)、[improve-4](../improve-4/05-implementation-acceptance.md)、[improve-5](../improve-5/05-implementation-acceptance.md)。

用户后续将进行 improve-1～6 的集中验收。本批结束后保留本地提交等待审查；独立模型与跨 provider、子代理占用视图、会话资源回收仍是后续议题。
