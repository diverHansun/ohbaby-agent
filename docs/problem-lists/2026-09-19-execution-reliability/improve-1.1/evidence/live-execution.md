# 实际页面与进程验证

测试日期：2026-09-25。均由本任务启动隔离服务和临时数据库；凭据只从仓库 `.env` 读取，没有写入本记录。

## 构建页面与确定性提供方

执行 `pnpm --filter ohbaby-cli build` 后运行 `node scripts/run-compiled-web-e2e.mjs`，通过 Codex in-app browser 在实际 CLI 内置静态页面操作：提交读文件任务、展开 read 工具结果、继续一轮对话、刷新。

观测：两次 assistant 终态和后续 user 消息刷新前后各一次；工具实际读到 fixture sentinel；页面中不出现模型运行时提示；活动会话不变。脚本最终 exit 0，报告 UI_EVIDENCE_PASS、BACKEND_PASS（3 个主模型请求、工具结果被消费）、CLEANUP_PASS（pid/port 释放）和 DIAGNOSTICS_PASS。

## 真实模型 Web

模型：清单中的 Zenmux `deepseek/deepseek-v4.1-flash`，`openai-compatible`。真实请求由页面提交，服务与数据库在临时目录；额外 loopback 代理用于真实切断浏览器网络，后端进程保持运行。

- 请求 150 条测试建议，在思考/正文持续输出时刷新。刷新前 assistant 文本长度 15,597，刷新恢复后的后续观测为 32,310，且 Stop 仍显示，输出继续。
- 代理断开现有连接并返回 503；草稿仍可编辑，发送按钮禁用。恢复网络后，两个页面最终完整 assistant 文本均为 36,122 字符，逐字相同，只有一个 user 消息，正文以 `RECOVERY_REAL_DONE` 结束。断网期间输入的草稿保持原文，未自动提交。
- 第三个真实请求输出 120 条恢复要求：确认 Stop 存在、一个 assistant 正在增长（6,221 字符）后关闭最后一个页面。重新打开并恢复会话后，只有一条 user/assistant，正文以 `NO_PAGE_DONE` 结束，Stop 消失，证明无页面时运行继续。
- 测试中修复了侧栏错误使用当前聊天窗口代替会话索引；首次索引失败恢复另作 fresh/resume 语义区分及竞态回归，见后续记录。

## 默认 TUI

通过真实 PTY 启动编译的 `ohbaby` 默认入口，使用独立 OHBABY_HOME/SQLite 与同一真实模型，没有指定 remote 或连接守护进程。

首轮真实请求暴露 host 克隆 AbortSignal 为普通对象的问题：后台模型继续，聊天显示 `input.signal?.throwIfAborted is not a function`。此项记录为发现的问题，不计通过；修复后的实际进程复测将在下方补齐。

### 后续构建复测

- 服务停止并重启，沿用隔离 SQLite；页面第一次 reload 即恢复 `NO_PAGE_DONE`，仍为一条 user/assistant，无 Stop，已保存 Thought 可用。
- 通过实际项目 rail 切到 other-workspace，页面为空且没有原项目内容；切回恢复原会话。展开侧栏后选择第一轮会话，显示两条 user/assistant，含 `RECOVERY_REAL_DONE`，不含另一会话的 `NO_PAGE_DONE`。侧栏收起时 DOM 中仍有隐藏条目，测试改为先展开再点击真实可见按钮；不是产品切换缺陷。
- 真实模型调用 bash 写入隔离目录的 `approved.txt`，产生默认权限审批。仅让 view/history 返回 503 后刷新，聊天显示 unavailable，但审批与 Stop 仍可用。点击 Allow once 后审批消失，文件实际内容为 `APPROVAL_OK`，后台运行 succeeded；恢复聊天后可见两步 assistant 和 `APPROVAL_DONE`。截图已在当前任务中显示。
- 随后启动真实长输出，再使 view/history 失败并刷新；此时输入草稿 `Unsent recovery draft stays here.`，Stop 仍 enabled。实际点击 Stop 后，SQLite 目标 run 为 cancelled，保存 4,014 字符 reasoning，结束原因 interrupted。恢复聊天后仍恰好两条 user，草稿原文保留，Stop 消失，无自动提交。
- 上述 Stop 场景发现页面顶部在已有独立运行 control 时仍显示 idle；已交给选择器回归修正并将在最终构建复核。此问题影响状态标签，不影响本次 Stop 的确切目标及数据库结果。最终构建再次真实触发 view/history 503、刷新，页面已正确显示 running 和可用 Stop，点击后正常停止。

### 默认 TUI 修复后复测

重建后从默认入口重新运行真实 PTY，未指定 remote。提交 200 项恢复不变量请求后正常显示真实 user 与持续增长的思考，不再出现 AbortSignal/Sync failed 错误。生成期间先后两次 Esc，第一下显示再次按 Esc 提示，第二下显示 Interrupted 并停止 spinner。

SQLite 验证：目标 session `session_1790316719086_9c3ky81` 的 run 为 cancelled；仅一个真实 reasoning part，长度 19,145 字符，`endReason=interrupted`。Ctrl+C 正常退出，未连接或留下 daemon。

随后从编译默认入口以 `--resume session_1790316719086_9c3ky81` 冷启动，真实 PTY 恢复 user、已保存 Thought 和取消结果，正常进入 ready，未重发模型请求；Ctrl+C 退出码 0。这里验证的是单目标停止及冷恢复；Pi 随后发现的 A→B 换目标竞态另补专门回归，不能用本次手测代替。

### 最终构建、分页与启动意图

- 最终全量 build 成功；全量 lint 零错误/警告、typecheck 成功。所有隔离服务均按测试需要启停，最终清理结果见 05。
- 隔离 SQLite 另植入 120 条固定分页 fixture（这是合成数据，不冒充真实模型输出）。页面最初显示 row070–119；点击 Load earlier messages 后显示 row020–119，共100条。切断连接并重连后仍是100条、first=row020，滚动容器 scrollTop 保持 6402。
- 对带真实 session hash 的恢复页，首次 index 连续503但 view/control 成功；恢复 index 并切断重连后，不再刷新也得到3条user、4条assistant，记录中的已保存思考与终态均可读。
- 无 session hash 的全新页面从真实 server bootstrap 获得明确 `startupSessionMode=fresh`，因此保持空选择属于现有启动契约，不能把它误判为未恢复记忆。此前空白现象经请求日志核对没有 select/view 请求，和该语义一致。不能为了恢复测试绕过明确 fresh 意图。
- 在非 fresh 的记忆恢复路径，补充自动测试还证实了一个窄竞态：成功 index 在 bootstrap 等待 scopes 时到达，被 restoringSession 锁略过；解除锁后必须继续同一代的恢复。该竞态由可控传输/延迟 scopes 验证，不声称真实 provider 触发了它。

### Pi 修复后的真实追加协议复测

最新编译服务、同一隔离 profile 和真实 Zenmux 模型，新建 `session_1790320037710_zs665n1` 请求 60 项说明并包含 `中😀`。页面流式接收后只有一条 user/assistant，助手 DOM 文本 5,859 字符，含 `APPEND_FINAL_DONE`。重新导航恢复后长度及 FNV 校验值 214897455 相同，无重复发送。该次结束很快，未声称刷新发生在活跃输出中；此前活跃刷新/断网另有记录。

此次同时证实 Pi 第二轮指出的性能缺陷：流式阶段代理日志记录 1,312 次 `/v1/model` 请求。修复前结果不计为性能验收通过；随后将 `ReasoningControl` 刷新限定为 `model.invalidated`，100 次追加加 metadata 变更从 102 次模型查询降为仅初始化一次，另一次显式模型失效增加一次。最终构建的真实请求计数另补。

### 真实请求计数与 React 流式异常追查

最终构建的真实 100 项输出得到 13,120 字符及 `MODEL_QUERY_FIXED_DONE`；对应请求窗口只有 1 次 `/v1/model`（同窗口 POST prompts 1、index 1、control 5、view 1）。证据窗口保存在本机 `/tmp/ohbaby-improve11-final-model-window.json`，代理日志不包含凭据或请求正文。

额外检查 console 发现 `store-listener` 异常。临时浏览器响应插桩捕获真实错误为 React `Maximum update depth exceeded`，堆栈是 SSE→SDK.receive→store.setSessionSync→React 外部 store listener。它不是 localStorage/history 错误，也不是 DOMPurify 内部被正常捕获的验证异常。旧版真实 100 项输出复现 6 次；另一次 80 项请求再次复现。

子代理指出 App 每个 snapshot 的 effect 都调用 `setLocalPromptAttempts`，即使数组为空、updater 最终返回原数组，也会在 React 已有排队更新时继续调度。浏览器 A/B 仅在此 effect 增加空数组提前返回，真实 100 项输出 15,003 字符、含 `GUARDED_DONE`，零 console/error 与零 listener 异常。这是临时诊断，不把 route 插桩当作最终产品修复；源代码修复及不带插桩的构建复测另记。

源码最终修复仅在本地提交记录确实需要清理时调用 setter，并保留基于最新 state 的 functional updater。可控回归用真实 SDK→store→React 连续 400 个微任务追加：旧代码 7 次 listener 失败，修后零错误；另覆盖等待接纳的并发提交保持不变，App 共 126 项通过。

不带 route 插桩的正式 bundle `index-W7YjxtOR.js` 再发真实 100 项请求，得到 14,581 字符及 `SOURCE_FIXED_DONE`，流式与刷新过程 console 错误为零，刷新后助手正文完全相等。该次从 reload 后立刻记录的窗口包含 3 次 model 查询（含启动/恢复），没有按 token 成倍请求；前一轮稳定页面的完整请求窗口为 1 次。服务关闭引起的 SSE 断开不计入正在运行页面的零错误结果。
