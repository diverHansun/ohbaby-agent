# improve-3：实施与验收记录

2026-10-04。分支 `improve-3` 从 improve-2 的 `4a28eb4c` 创建。仅本地分批提交，等待用户审核；不 merge、不 push。开始时已有的未跟踪规划文档保留，不纳入实施提交。

实现分两批提交：`005242f8`（工具事实、真实 diff、共享 DTO 与依赖）、`a8bf83ed`（TUI 工具展开/排版、自动恢复及端到端验收入口）。本记录与前端 09 为第三批文档提交。两批代码提交钩子的 lint 与 typecheck 也通过。

## 交付边界

保留 React/Ink、现有 store、MainScreen 和统一终端输出层。pi-tui 仅用于公开 Markdown、显示宽度、换行和截断 API；未启用其 TUI/Editor、输入、终端生命周期、overlay 或业务模块。

- 精确锁定 CLI `@earendil-works/pi-tui@1.0.1`（MIT、Node >=22.19.0，项目 Node >=24）及 Agent `diff@8.0.2`。没有引入第二个 renderer 或语法高亮平台。
- 工具结果从执行事实，经统一白名单投影进入 SDK 可选 `details`。scheduler 写入实际注册来源，第三方 metadata 不能自行声明 builtin。旧记录保持可信原始结果后备。
- 读/搜索默认摘要；Bash 预览尾部，Write 成功新建显示调用内容，覆盖与 Edit 使用执行层保存的真实 diff。失败保留部分 output，dry-run、后台启动、采集限制与预览省略分开表达。
- 行 diff 使用实际 hunk 和上下文；保留 256 KiB 输入、32 KiB 保存输出预算，算法限时 1 秒。Write 在既有锁、mtime/取消保护内有界读取 before；预览失败形成原因，不改变实际写入成败。没有数据库迁移。
- Ctrl+O 是当前会话的工具显示布尔状态；不请求历史、不改变 reasoning/Tasks/审批/草稿。沿 ReplayableTranscript 的投影指纹重建，主动变化最多一次必要重建，无显示差异不清屏；普通刷新不重印稳定历史。保留 improve-1 的真实修正、历史前插与 resize 契约。
- Markdown 使用现有主题 token。显示边界仅允许 SGR 样式，移除 OSC/剪贴板/光标控制；每行闭合样式，1 列视口的宽字素使用单列占位。输入编辑器原有字素/tab 契约未替换。Markdown 行内代码保留反引号，URL 以文字保留，便于无色识别和终端复制。
- 自动恢复替代 Ctrl+R：只补身份、索引、control、同步和原请求 receipt 的缺口；不重新发送未知提交。恢复读取有 10 秒期限及实际 signal，单类在途；CLI 冷却接续，远端 bootstrap 沿原连接循环退避。切换/断线/dispose 取消对应工作，旧 epoch 维持真实未知。

## SWE 与审查取舍

改动沿现有 tools → lifecycle → adapters → SDK → store → render 的职责，不建立工具展示注册平台、第二份结果库或全局重试服务。共享投影避免实时/历史分别猜测；展示状态不写回业务事实。输入、审批和 Tasks 不因工具展开重做。

Opus 5.5 初审原始正文已完整呈现在实施对话中。采用长路径保留操作对象、紧凑 diff 段间省略、搜索完整性提示、真实恢复文案和无色行内代码的建议。未采用新的阅读页或配置。其“超过 32 KiB diff 静默丢弃”的担忧经生产 boundedDiff → 投影探针核实：实际生产者会保存明确 omission 原因，不作为生产缺陷。对性能的担忧以多工具 PTY 测量和稳定输出断言验证，不以模型意见代替证据。

独立恢复初审复现两项 P2：在途读取吞掉后续 invalidation、bootstrap 403 每 50ms 重试。修复要求为请求结束后的单次尾随读取，以及既有 transport 内的逐步退避；对应回归与最终复核结果见下文。

## 验证入口

```sh
VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 pnpm preflight
python3 scripts/run-tui-improve3-pty.py
python3 scripts/run-tui-improve2-pty.py
pnpm exec vitest run tests/integration/tui/main-chain.integration.test.tsx
```

PTY fixture 通过独立控制管道驱动合成后端，stdin 专属 Ink，不调用真实 LLM 或执行真实审批工具。实际 Write 链路由 `main-chain.integration.test.tsx` 使用真实 in-process backend、工具与文件系统，LLM 仅提供确定性事件；包含审批→执行→快照详情→Ctrl+O→核对落盘内容。

自动化证据与 Ghostty 人工体验分开：PTY 可验证控制序列、可达内容、顺序、输入归属、退出状态，不能证明 GUI 上滚位置、选择复制或中文 IME。

## 验证结果

最终受控并发 `pnpm preflight` 退出码为 0：格式与类型检查通过，lint 为 0 errors / 109 warnings；全仓 505 文件通过、6 文件按配置跳过，5,616 测试通过、17 测试按配置跳过。Agent/SDK/Server/CLI/Web 全量构建通过，Web 保留大于 500 kB 的既有产物体积提示。日志为 `/tmp/tui-improve3-preflight-final.log`。

根进程真实 PTY 五个场景通过：120×40、80×24、60×20 深色16色；80×24 浅色16色；60×20 无色。每场含20条混合工具、四份300行Bash、Write30行、新结果、旧结果修正、Markdown表格/代码/链接、审批和中文emoji草稿。断言每次Ctrl+O恰好一次必要清scrollback、历史原顺序、展开首尾可达、无变化通知不重印、审批不抢键、草稿原样提交、raw mode/光标恢复。修正和resize依旧沿前轮契约单次重建，因此每场总clear计数3或4不等于每次toggle多次清屏。原始ANSI与summary目录：`/var/folders/md/0szgsv_x3bsdgk_fzj9qb6lh0000gn/T/tui-improve3-pty-2jwawvbw/`。观察到展开完成窗口163–326ms，脚本每轮drain有160ms等待且同时运行全仓测试，此数值不是性能benchmark或SLA。

improve-2真实PTY四尺寸120×40、80×24、60×20、80×12均通过，包含20项Tasks、45行审批、无deny的Esc不提交、4,689字符草稿、resize与停止回看。证据目录：`/var/folders/md/0szgsv_x3bsdgk_fzj9qb6lh0000gn/T/tui-improve2-pty-y26i3ei2/`。临时证据可通过脚本重新生成。

真实in-process主链9项通过，其中新增实际Write纵切；根文本与主链联合6文件55项通过。数据事实独立审查11文件227项通过；App完整143项通过。最终独立审查另复现紧凑标题包含多行参数突破预算的P2，已仅在紧凑标题归一化行分隔/tab；5个新增测试先红后绿，相关190项通过，原审查代理复验紧凑一行、展开保留原文。恢复两项P2经回归与独立复核消除。最终评审范围无剩余已确认P1/P2。

全仓首次测试检出3个严格旧预期未包含新增source/outputAvailable字段。已逐项核对实际结果，仅补充新字段，保留旧内容/隐私/SQLite重开断言；两文件33项通过。另旧App假后端的索引固定为初始snapshot，会在新增自动读取后错误删除当前会话，已改为返回当前source snapshot，保留原业务断言。

Pi复核为同一会话 `codex-tui-improve3-20261004`，模型 `github-copilot/claude-opus-5.5`，启动目录为项目根。初审与复核原始正文均已完整呈现在实施对话。复核18文件140项通过，无新P1/P2；其P3“断线+sync错误两处提示优先级不一致”也已最小修正，相关3项测试通过。

环境：macOS26.6.2（25G83）、Node26.3.1、pnpm9.15.0；本机PTY无tmux/SSH。

## 真机限制与审核边界

Computer Use 对 `com.mitchellh.ghostty` 返回 “Computer Use is not allowed to use the app 'com.mitchellh.ghostty' for safety reasons.”，未绕过限制。Ghostty 人工上滚停留、复制、IME、深浅背景和动画观感仍待用户验收；Windows 真机未测。深浅主题/低色彩的 PTY 场景属于自动化数据，不替代真机视觉结论。

Ctrl+O 可替换 shell 与当前已加载会话的原生 scrollback、把阅读位置移到底部；这是既有确认取舍。不会删除业务历史，未加载历史仍走原入口。旧记录未保存的 diff/输出无法补回；旧 runtime 丢失的回执也不能靠自动恢复保证确认。因此本记录不宣称整体人工验收通过。
