# improve-1～6 整体验收

> 日期：2026-10-13。代码审查基线：`844af9fc`；六批实施收尾：`b6d79e2d`；本轮三个修复后：`41b52d3e`。自动测试、真实 API／Web 验收和 Pi 终审完成；已快进合入本地开发分支，六个阶段分支已删除；main 未动，等待用户审查。原始讨论、固定决策和各批 05 保留，不用本记录改写历史。

## 1. 验收口径

对照 [原始讨论 01](./plan/raw-discussion-01.md)、[原始讨论 02](./plan/raw-discussion-02.md)、[固定决策](./plan/discussion-notes.md)及 improve-1～6 的 02／04；冲突以最后确认的 §17 和 improve-6 范围为准。撤回的 40K／比例尾段、冷热分流、工具配额、摘要专表、mask／prune、次数帽和永久失败锁没有作为要求重新加回。

三个子代理分别审主子实例 Spec、请求／缓存 Spec、SWE Standards；主审复核发现、补实网验证。Spec 与 Standards 分开判断，单纯测试绿不等于方案完整落地。

| 契约 | 当前实现与验证 | 结果 |
| --- | --- | --- |
| 主、子代理共用 Context／Lifecycle，实例用 session＋scope 隔离 | composition 创建共享 Context；subagent-host→instance→runner→lifecycle 透传身份；context-subagent-scope 与 lifecycle 定向覆盖主／子／兄弟材料、标定和缓存键 | 通过；并非只接主代理 |
| 计数和输出预留面向实际准备发送的请求 | token-estimation、serializer、summary-request 覆盖消息／tools／native 数据，usage 校准按 scope；普通完整 maxTokens、摘要独立正文＋thinking 预算 | 通过；仍是可校准估算，非精确计费值 |
| 工具结果稳定回放、错误与引用不变形 | serializer.integration、MCP 适配、Read／分页／子代理引用回归；未新增第二份预览和二次缩短 | 通过 |
| 摘要从正常 prepared 请求分叉，保留完整前缀与身份 | prepared-summary、三协议 wire；实网校验普通请求消息是摘要请求前缀，system／tools／reasoning／cache identity 一致 | 通过；末尾追加摘要指令 |
| 90% 默认线，容量不足可提前触发 | summary-request 边界、普通完整输出预留、thinking 预算测试；Web 子代理真实压力触发 | 通过 |
| 固定 20K 合法完整组；单滚动摘要；Mode A／B | compaction-plan 覆盖保护最新／未闭合依赖组、旧摘要更新、一次按缺口收尾、精确遗漏、两后端事务；Chat 实网连续三轮始终一份 active summary | 通过；最新大组可超过 20K，不能等同于机械截断 |
| Stop／并发冲突不得半提交；失败结束本次 run | inprocess、run-manager、context concurrency、事务边界与 lifecycle 集成；原历史、摘要、用量记录、遗漏 metadata 一起处理 | 通过；原始数据保留 |
| 统一重试，force 每步一次，成功 floor 按 scope | sdk-retry、lifecycle、scoped compaction-plan；故障注入补测覆盖停用子代理恢复／去除 floor scope 必须变红 | 通过；本轮另补终态后断流反例 |
| 手动入口只在空闲执行，默认绕过阈值，不伪造 run | busy／Stop／不自动续跑契约；Web 手动压缩；显式 `force:false`／`--no-force` 仍尊重原有选择 | 通过；默认 force，不代表忽略显式 false |
| Web／CLI 子代理压缩标记可重开、分页回放 | 两 store、两 reader、三次压缩、兄弟 scope、未启动 execution 与游标回归；本轮 Web 重启 serve 后从最新执行加载旧页找回标记 | 通过；摘要正文不作为 UI 会话正文展示 |
| agent 层四个静态模型字段明确拒绝 | schema、registry、AgentService、subagent-host；own 字段为 undefined 也报错；运行时 modelId／reasoning 与全局 LLM 配置保留 | 通过 |
| 子代理压缩失败走通用失败交付 | 前景 tool 文本、后台 execution/result/coordinator 到父请求的集成，Web／CLI Failed 与原因展示 | 通过；没有新增压缩专用通知 |

子代理独立选模型与跨 provider、子代理占用视图、会话资源回收继续按已确认决定延期。UI 的 `contextWindowUsage` 本轮仍仅服务主会话。

## 2. 本轮发现与最小修复

| 来源 | 问题与修复 | 红→绿证据 | 提交 |
| --- | --- | --- | --- |
| Spec／缓存审查 | 摘要已收到 length／content_filter，随后断流会误获网络重试。summary adapter 记住已知失败终态，继续 drain usage；Stop 优先，纯 partial 断流仍可重试一次 | summary-completion 先 3 红；生产 Context＋Anthropic raw stream 的 length→ECONNRESET 从 2 次变 1 次，旧历史不变。四文件 83 项通过 | `a87158fd` |
| Spec／输出字段审查 | 官方 OpenAI Chat 固定发送旧 max_tokens，未落实已规划的输出字段兼容。沿用已有 active probe 的 provider 判断，openai 发 max_completion_tokens，其他兼容 provider 保留 max_tokens | 普通／摘要、OpenAI／兼容端点参数化，先 2 红；三文件 47 项通过。没有新增模型名前缀表 | `33cae268` |
| Standards／公开选项审查 | manual compact 写死 force=true，让现有显式 false／--no-force 失效。改为 input.force ?? true | 先 3 红；默认／true 低占用及 floor 豁免、false 阈值／floor／容量压力均覆盖，四文件 133 项通过 | `41b52d3e` |

独立子代理再次复审以上三处，7 文件 180 项通过，无新增缺陷。三个修复没有引入新配置、框架、数据表或备用执行路径。

## 3. 本次离线检查

| 检查 | 新执行结果 |
| --- | --- |
| 修改前全量 `pnpm test` | 536 文件通过、6 文件跳过；6,096 项通过、17 项跳过 |
| 修复后全量 `pnpm test` | **536 文件通过、6 文件跳过；6,114 项通过、17 项跳过**；240.74 秒 |
| `pnpm build` | SDK／agent／server／Web／CLI 构建及打包通过 |
| `pnpm run typecheck` | 通过；三个提交 hook 也执行类型检查 |
| `pnpm run lint` | 0 error，109 条既有 warning；新改文件无剩余 lint 错误 |
| `git diff --check` | 通过 |

全量包含 unit／contract／integration、CLI 编译运行和 npm packed 安装 smoke。没有把 skip 项说成通过，也没有把网络请求混算进 6,114 项。真实 API 单独执行如下。完整本地日志在 ignored `.ohbaby/context-overall-*.log`。

## 4. 三协议真实 API

使用 `tests/models-4-tests.md` 指定的真实服务和本机密钥，独立临时 HOME／SQLite，实际 daemon＋remote backend＋生产 provider。所有输入均为合成 Cedar 事实和标记清楚的只读填充，没有发送仓库私有源码或凭据。

| 协议／真实模型 | HTTP 请求 | 摘要 cache read／input | 压后首次 cache read／input | 后续 warm cache read／input |
| --- | --- | --- | --- | --- |
| Chat／DeepSeek deepseek-flash | 9 次，全 200；连续 3 轮 compact | 32,512／32,961；32,896／33,276；32,768／33,172 | 最终回忆 8,320／9,038 | 9,088／9,311，97.60% |
| Responses／DeepSeek deepseek-flash | 5 次，全 200；1 轮 compact | 32,512／32,961，98.64% | 8,320／9,167 | 9,216／9,419，97.84% |
| Anthropic／Dashscope qwen3.8-flash | 5 次，全 200；1 轮 compact | 34,816／35,208，98.89% | 8,192／9,605 | 9,216／9,864，93.43% |

这些协议测试关闭 thinking，普通 output cap 8,192，摘要 cap 16,384；实际正文远低于上限。预留与最终 wire 一致；没有工具执行、隐藏 SDK 重试或短 system 回退。校验每次成功摘要的 modelRequests 与 usage 归属、manual 无 runId、只有一份活动摘要、旧标记保留。

Chat 连续三轮替换摘要，正文保留了负责人 Lin→Mia 的更正，以及 job-47 未完成、E_CHECK_41、测试未运行、部署未批准。其余两协议保留原始 Lin 事实。验收脚本断言与人工检查结合，不宣称任意模型的任意摘要都语义无损。

本机脱敏报告：`/tmp/ohbaby-context-overall-live.json`、`/tmp/ohbaby-context-overall-live-anthropic.json`。这两组临时 daemon 结束后已关闭并清理临时目录。

## 5. 编译后 serve 的真实 Web E2E

进程由本轮启动，独立临时配置和数据库；地址 `http://127.0.0.1:59668`，模型 DeepSeek deepseek-flash，128,000 窗口，reasoning high。使用 Codex 浏览器真实操作，未用脚本代替 DOM 行为；窗口为当前应用面板的 319×613，未另做桌面尺寸排版改造。

测试路径：Web 新建会话→主代理创建一个 generic 子代理并实际 read cedar.txt→同 scope 注入 16 条合成压力历史→Web 续跑同一子代理触发自动压缩→打开详情→刷新重开→主会话加入 8 条合成历史并正常请求预热→`/compact` 确认→压后事实回忆与 warm 请求→再次续跑同一子代理→重启 serve→从最近 execution 加载旧页找回标记→打开主会话占用组成。

16 次真实 HTTP 请求全部 200、全部完成，包括 1 次标题请求；与上一节 19 次独立服务请求分开，总计 35 次。注入历史用于可重复触发容量分支，真实摘要和续跑都来自服务，不把注入文本冒充真实工作历史。

| 实网检查 | 观察到的结果 |
| --- | --- |
| 子代理自动压缩 | 114,421 → 18,998 estimated tokens，Mode A 明确标记 11 parts omitted |
| 主代理手动压缩 | 43,867 → 25,429 estimated tokens；没有自动发起下一普通请求 |
| 主代理摘要缓存 | request 11 包含 request 10 的完整 18 条消息前缀；system／tools／reasoning／cache identity 一致；41,600／42,042＝98.95% |
| 主代理压后缓存 | 首次 8,320／24,516＝33.94%；下一次 24,576／24,795＝99.12% |
| 子代理摘要与压后缓存 | 注入的压力材料此前未发给 provider，摘要 4,224／74,136＝5.70%；压后首次 4,224／16,760＝25.20%；继续同 scope 后 16,896／17,130＝98.63% |
| reasoning 预算 | 主摘要 32,768；子摘要 32,739，提前扣除了宿主后附文件账本文字的 29-token 正文额度，不是暗降 thinking |
| 持久化与回放 | 两个 scope 各一份活动摘要、runId 均为空；usage 归各自摘要；刷新／进程重启后标记仍在，子代理旧标记通过 Load earlier messages 找回 |
| 主会话占用 | 没有被子代理 114K 占用覆盖；进程重启后内存估算缓存为空，打开 Context Usage 后重测到约 29.3K（标定也随进程重建） |
| 页面健康 | ohbaby 标题与目标地址正确，页面非空、无框架错误覆盖层；对话、压缩确认、上下文组成和只读详情可操作 |

缓存比例是 provider 报告的 cache read / input，不是本地估算。冷启动、前缀改变、缓存过期和 provider 策略都会影响比例；不能要求每个请求都 99%。本次清楚观察到了“即将压缩时复用正常前缀、压缩后新前缀先冷后热”。

本机证据：`.ohbaby/context-overall-serve-state.json` 指向临时服务目录，内有 `wire.jsonl`、`inspection.json`、`serve.log`。root session `session_1791903547669_9or1yi1`；child scope `subagent_mv6t3ygw_0hlpyp43`。截图 `/tmp/ohbaby-context-overall-main-compact.png`、`/tmp/ohbaby-context-overall-child-reopened.png`、`/tmp/ohbaby-context-overall-composition.png`；重启后旧页文字 `/tmp/ohbaby-context-overall-restart-history.txt`。这些是本机临时证据，不是仓库内持久附件。

## 6. 诚实记录的边界

1. **有损输入后的来源断言**：Mode A 移除了子代理最早真实 read 的记录。摘要模型保住六项事实，却断言从未读过 cedar.txt；宿主后附 `<read-files>` 仍正确列出 cedar.txt，且明确写了遗漏 11 parts。父代理指出了来源矛盾。这是实际观察到的摘要质量边界，不能把“程序正确回放了摘要”写成“模型内容绝对准确”。Pi 复核同意这是有损兜底后的模型过度断言，非接入／原子性错误。采纳本轮只记录、不为单一样本改机制的建议；提示词补强和摘要质量评估另行处理。
2. **计时诊断**：新 Web 三个子代理 execution 各出现一条 `duration-clock` 诊断，与 [improve-6 既有记录](./improve-6/05-implementation-acceptance.md)相同；计时采样路径未被本轮修改。执行和历史都正常，不写成控制台零错误；不扩展为计时系统重构。
3. **覆盖范围**：本轮重新执行 Web＋三协议 API；CLI 真 PTY 大量分页／重启验收沿用 improve-6/05 的独立记录，本轮全量再次覆盖其自动测试。Mode B、Stop／冲突原子边界、force 重入和兄弟隔离主要用确定性测试／故障注入证明，不为制造每种服务端错误而重复付费。
4. **官方 OpenAI 输出字段**：本轮对真正的 OpenAI 参数契约做了本地 wire 回归，真实 Chat E2E 使用的是 DeepSeek；不能声称实调了 OpenAI o3。

## 7. Pi 审核与合入

DeepSeek 快速审核使用 `opencode-go/deepseek-v4.1-flash`，medium，检查旧机制清理、四字段拒绝、scope 透传和摘要入口，未发现可确证问题；原始回复已完整展示用户。

最终审核使用 `github-copilot/claude-opus-5.5`，medium，同一任务 Pi 会话 `1fd30830-2186-4968-ae56-52c78eff43b4`，只调用一次复杂终审。结论为可合入开发分支，无阻塞问题，三个修复符合 KISS。它独立重跑 86 项通过，另 1 项 SSE 测试因其审查沙箱禁止监听 localhost 而报 EPERM；不能写成 Pi 全绿。该项已在主审环境的定向和全量测试中通过。原文已完整展示用户，未把模型建议直接视为事实。

用户已授权验收完成后合入本地 `codex/context-optimization` 并删除本议题的六个阶段分支；`main` 保持 `844af9fc`，等用户审核后再处理，不 push。实际合入和清理结论为可合入开发分支，无阻塞问题，三个修复符合 KISS。它独立重跑 86 项通过，另 1 项 SSE 测试因其审查沙箱禁止监听 localhost 而报 EPERM；不能写成 Pi 全绿。该项已在主审环境的定向和全量测试中通过。原文已完整展示用户，未把模型建议直接视为事实。
