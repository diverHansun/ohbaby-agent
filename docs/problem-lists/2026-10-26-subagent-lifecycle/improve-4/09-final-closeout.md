# 9. 最终收尾：D54、Web 回归与发布检查

日期：2026-10-31。执行与复审：Codex。

**结论：本次范围通过，无未解决的 P1/P2。** D54 的所有新子代理执行统一后台运行；普通主会话 Stop 保留子代理。08 中的 R5、R6 和 B5 均已关闭。用户本轮明确要求检查后推送 main、清理临时分支，按此执行；旧文档中的“暂不 push”不是本轮的发布约束。

## 范围

- 起点：本地 `main=352971ed`，工作分支 `codex/postmerge-ui-review=6e561732`。复核 Claude 的 `8c3f681d` 审批样式和 `6e561732` 发送跟随修复，以及用户尚未提交的 D54、SDK 连接重试改动。
- 补充最小修复：查询 slash 命令不触发滚动；中断事实在实时和持久化 UI 投影中排到正文之后；恢复模式迁移时遗漏的持久化读回断言。没有引入新前端协调器、队列或通用框架。
- 同步当前权威文档、SDK 历史字段注释和验收表。保留历史决策与历轮 05–08，不把旧的前台验收结果改写成后台实现证据。
- UI 沿用既有简洁布局、留白、弱分隔线和单一主操作；本轮没有扩大为视觉重设计。

## Standards 复审

| 项目 | 结论与处理 |
| --- | --- |
| D54 生命周期 | 通过。schema 不再暴露 mode；旧调用中的 background 可兼容，foreground 明确拒绝。新执行始终存为 background，旧 foreground 仅作历史读取。删除前台等待及主 Stop 向前台 child 传递的路径。 |
| Stop 的职责 | 通过。普通主 Stop 只停止主 run 和自己的 shell；Goal 整体暂停、取消、预算终止按所属 root runs 清理，dispose 仍清理会话全部资源。Goal 中的普通用户 Stop 仍保留后台 child。 |
| R5 残余问题 · P2，已修复 | Claude 的修复已覆盖面板型命令，但 `/status`、`/skills` 等透传查询仍触发 onSend。复现为：滚到历史上方 → 提交查询 → 页面打开结果面板但消息区滚到底部。现在只有接受了 prompt 的回执或成功的带参数 resume 才触发跟随；保留 generation 隔离迟到回执。回归测试修复前 6 项失败，修复后通过。 |
| B5 · P2，已修复 | 主/子会话中断事实没有 sourceOrder，旧排序把它放到正文前。统一使用 metadata.kind 判断终止事实并排最后，普通部件顺序不变。覆盖主/子会话、有/无正文、reasoning 延迟存储、实时提交和持久化重读。新增 4 项修复前均失败，修复后通过。没有让 Web 识别提示文案。 |
| SDK 网络重试 | 通过。识别 OpenAI、Anthropic SDK 的连接错误类型；上下文溢出和 abort 不被误重试。独立复核 4 个文件、90 项测试通过；作为单独提交处理。 |
| 持久化覆盖 | 已补回。后台结果处理后 dispose client、关闭 SQLite，再打开新的 facade；验证只读历史、执行锚点、结果和 environment reminder。没有用同一个内存对象冒充恢复测试。 |

独立后端、前端、契约/文档子代理完成复查。最终后端与前端只读复核均未发现剩余 P1/P2；中断排序实现亦由独立审查确认。根代理负责统一构建及浏览器操作，避免并行测试覆盖 dist。

## Spec 与浏览器验收

先完成全量测试、类型检查和构建，再运行真实编译产物。浏览器经过 Web → CLI/daemon → Host/SDK/SSE → SQLite → read/bash 工具；模型响应由本地 fixture 提供。

| 检查 | 实测证据 |
| --- | --- |
| 主 Stop 保留子代理 | PANEL_START 后独立运行 PANEL_HOLD，排队并 Steer PANEL_FAIL，再 Stop run。只有 PARENT_HOLD 流关闭；tick 的 delivered=1，Runner 仍 Running 并显示 PANEL_STREAM_TICK_1。随后在详情 Stop 才结束 Runner。 |
| 实例入口 | 运行中 send 返回 started:false，没有新入口；失败 send 只有工具错误；七个并发 spawn 得到六个 Running 实例和六条入口，第七个明确拒绝。 |
| Reader 定位 | 列表重新打开前后 scrollTop 均约 7036 px；再次点击同一派遣入口回到约 20 px。第二轮入口定位到 FOLLOWUP；第一轮入口仍定位第一轮。 |
| Tab 生命周期 | 两个 Subagents Tab，关闭当前详情 Tab 后剩余列表可重新打开 Runner，并收到 PANEL_STREAM_TICK_2。单 watch 的准确释放另由自动回归覆盖；浏览器结果不冒充服务端订阅计数。 |
| R5、R6 | `/status`、`/skills` 不新增用户消息；skills 前后主流 scrollTop=0、scrollHeight=1768。旧阅读位置点击 Resend 后产生第二条 PANEL_FAIL 用户消息，距底部约 0.33 px。 |
| B5 | 主 Stop 与子代理 Stop 后，Thought、正文、流式 tick 在前，中断提示在后。刷新重开 Runner 后顺序保持。 |
| Close 与刷新 | Reader 关闭后详情退回列表、两个入口撤下；刷新后分别展开两组原工具记录，Reader 入口仍为 0，工具卡仍保留。 |
| 会话隔离 | 在可见工作区导航创建新会话，确认欢迎页后发送 OTHER_SESSION；新会话列表只有自己的 Other reader。 |
| 审批与布局 | 桌面双栏、390 px 窄屏均可查看审批问句、原始命令及 Allow once；窄屏可从详情返回主会话完成审批。没有遮挡、重叠或无法操作的主要控件。 |
| 编译 Web E01–E05 | read 输出成功；续聊与刷新后 session 不变，两个最终答案与 followup 用户消息各 1 条，内部运行上下文未进入标题或消息。 |

核心场景单独运行，脚本输出 `backend-pass`、`cleanup-pass`、`verified:true`，退出码 0。扩展场景用于 HOLD、重发、查询、多个 Tab 和满额检查，以 quit 清理，日志中的 verified:false 表示没有调用核心 finish，不能计为核心验证成功。扩展轮一度在未展开的侧栏点击新会话没有导航成功；展开侧栏、确认欢迎页后再发消息完成隔离检查，并在独立核心轮重新验证。没有修改脚本断言来接受误操作的数据。

所有本轮测试 daemon、provider、端口和临时数据均已清理；浏览器临时 Tab 已关闭，视口覆盖已恢复。按用户补充要求，也清理本议题历轮验收目录内的 48 个截图、日志和文本附件，将文档引用改成文字说明；回归测试源码和验收结论保留。

## 自动化结果

| 命令 / 范围 | 结果 |
| --- | --- |
| pnpm test | **643 files passed，7540 passed，17 skipped，0 failed**；共 649 files / 7557 tests，耗时 224.28 秒。 |
| pnpm typecheck | 通过。 |
| pnpm build | 通过，包含 Web assets 复制进 CLI。 |
| pnpm lint | 0 errors，109 warnings；未在收尾中扩展为全库 warning 清理。 |
| pnpm format:check | 通过；两个既有 Web 测试文件仅格式调整。 |
| pnpm test:smoke | 命令成功退出，4 files / 12 tests 全部因真实外部服务环境未启用而跳过；不算真实模型验证通过。 |
| B5 定向验证 | 3 files / 39 tests 通过；reasoning 保存完成后的增强断言再次 4/4 通过。 |
| Web 定向验证 | 7 files / 265 tests 通过。 |
| D54 独立定向验证 | 13 files / 203 tests 通过；持久化重启用例另行通过。 |
| git diff --check | 通过。各批提交继续执行仓库 pre-commit 的 lint、typecheck，不跳过 hook。 |

验证环境为本机 macOS。远程 CI 的跨平台结论以推送后 Actions 的实际结果为准；本记录不将本机结果等同于 Linux/Windows 验证。

## Windows CI 补充修正

首次推送 `7059a792` 后，[CI 41160662710](https://github.com/diverHansun/ohbaby-agent/actions/runs/41160662710) 的 Linux、macOS 和最低 Node 版本检查通过。Windows 的 projection/transport 组为 353 通过、1 失败：旧用例 `clears pending permission when abortRun cancels a running prompt` 在等待第一次审批事件时超时（1017 ms），尚未执行 abortRun。其默认事件等待只有 1000 ms，D54 未修改该用例主体。

受控验证：临时将首次非标题 provider 请求延迟 1500 ms，原预算在 1022 ms 复现相同错误；仅给该用例首次事件等待传入 5000 ms，并在 finally 中 dispose client，同一探针在 1710 ms 通过。随后删除延迟探针。原有取消及队列继续的两个 1000 ms 上限和全部行为断言保持不变，没有改产品代码或全局超时。

移除探针后，该文件 **174/174**、CI 同六文件组 **354/354** 通过，格式与 diff 检查通过；独立子代理复核无 P1/P2。此补充仅修改测试及本节，前述全量与浏览器验收对应的产品代码保持一致。后续提交重新触发跨平台 CI，最终结果以远程运行记录为准。

## 证据与发布边界

上述截图和脚本原始输出已在验收及独立复查时查看。用户随后要求删除测试产物，因此本报告只保留操作步骤、测量值、测试计数和结论，附件不进入最终提交。

先分批提交 D54、SDK 重试、中断排序、Web 查询跟随和本报告，再合入 main 并正常 push，不强推。推送内容的新增文本与路径检查未发现凭据或私钥，未纳入临时数据库、构建产物或本机配置。

上一轮已清理已合并的临时分支及 subagent-frontend worktree，保留了 `claude/priceless-jennings-b88b8b` 和对应 worktree。当时尚未核对其补丁是否已被其他提交吸收，后续复查结论见下节。远程其他分支不在清理范围。

已接受的交互取舍仍成立：新 spawn 入口可能稍晚于执行记录；切换 Tab 后从派遣入口恢复时会重新定位。两者不影响实例身份、关闭语义或阅读器资源释放。

## 2026-10-31 补充：剩余分支与当前改动

**结论：无需再次合并 Claude 分支。** 它唯一未进入 main 提交图的提交是 `6f334142`，但 main 的 `f9183e82` 已明确记录 `Based-on: 6f334142`，完整吸收其五个文件的凭据隔离行为。main 还修正了原补丁的认证头冲突：环境头名与 Authorization / X-Api-Key 相同时，原来的 null 覆盖会删除显式配置的凭据；现有实现只在同步构造 SDK 时排除环境头，并在 finally 中恢复。独立 Standards、Spec 复审确认没有遗漏必要内容，可以删除干净的旧 worktree 和已被吸收的分支，不制造空合并提交。

本轮同时审查 `b3eaca0d..2fbee1be`：`bf09497c` 将直连、代理的流式 body timeout 交给已有 idle watchdog；`df06dd56` 增加六 Worker 场景；`2fbee1be` 提交用户暂存区和工作区的测试配置迁移，包含相对导入、runner 与文档路径三处同步。冻结提交的独立复审未发现 P1/P2。SDK 两处边界文档另补充了隔离环境头的有限例外，没有修改产品行为。

| 本轮验证 | 结果 |
| --- | --- |
| 全量 pnpm test | 644 files passed，7543 passed，17 skipped，0 failed；共 650 files / 7560 tests，223.25 秒。 |
| 凭据隔离与网络定向用例 | SDK 7/7；网络 3/3，包含默认超时对照及直连、代理六分钟静默。 |
| typecheck、build、format:check、diff --check | 均通过。提交钩子正常执行；lint 0 errors、109 warnings。 |
| 迁移后的 smoke 配置 | 显式设 OHBABY_RUN_REAL_RESPONSES_MIGRATION=0，正确发现目标文件，4/4 跳过；未发起真实模型请求，不算真实服务验收。 |
| 编译 Web 的 TEAM / TEAM_RETRY | 首轮 6 个实例及 6 条入口，第 7 次满额拒绝没有入口；六个结果自动唤醒主会话并汇总。完成后重试 Worker 7 成功，列表 Active 0 / Done 7；Worker 1、7 的详情可读。SQLite 独立断言 7 次后台执行全部完成、21 次真实 read 完成，fixture failures 为空。 |

浏览器检查了 1440×960 下的主会话、侧栏详情和输入框，主要控件没有遮挡。此轮专测新增 TEAM 场景，以 quit 清理，脚本输出 cleanup-pass、temporaryRootRemoved:true；verified:false 表示没有重跑原核心 finish 场景，其既有验收见上文。截图、页面快照及本轮临时测试数据按用户要求删除，仅保留步骤和结论。

最低 Node 24.0.0 的兼容性也做了源码复核：[官方 fetch dispatch](https://github.com/nodejs/node/blob/v24.0.0/deps/undici/undici.js#L11676-L11688) 不额外传入 bodyTimeout，不会覆盖 Agent 的显式 0。跨平台运行结果仍以本次推送触发的 CI 为准。
