# improve-4：实施与验收记录

2026-10-04。基线 `improve-3` / `7d802c4f`，本地分支 `improve-4`。用户明确授权实施、Pi 审查、子代理审查、端到端测试和分批提交；不 merge、不 push。开始时已有的未跟踪 improve-1～3 规划文档保持原状，不纳入本轮提交。

代码分两批提交：`f79d09d7`（权限与工具输出降噪）、`9918bc0d`（流式回滚区、Markdown 延迟排版和进程回归）；本记录为第三批文档提交。

## 需求与实现

- 截图中的上方 `Option:` 是只读描述，下方才是可选择列表。普通选项现在只显示一次；授权选项解释匹配请求作用于当前会话或当前子代理会话，不显示冗长 session ID。只有被截断的标签、标题、来源和错误保留完整阅读入口。短审批不显示翻页提示或页码；切换普通选项回到操作描述；错误不会因为附加页码而永久截断。审批策略、响应身份、拒绝、停止和过期恢复行为不变。
- `subagent_status` 成功结果不显示内部 JSON/ID，Ctrl+O 也不展开；显式工具错误仍显示。没有改变模型结果或持久化事实。`subagent_run/close` 的失败可能只存在正文，因此本轮保留其既有有界正文，不无条件隐藏所有 subagent 工具输出。
- `list` 默认摘要、展开看内容；Bash 默认保留末五行有用输出，后台启动不重复打印“仍在运行且无输出”，紧凑模式不展示启动 job ID；`task_output` 取尾部五行，标题不再打印 block/wait_ms。真实失败、退出码、截断和部分输出保留。
- TTY 的长文本按渲染后物理行逐步追加到同一个 Static，最后四行留作可变尾部。此前整个未完成 text part 都在裁剪尾窗，前文在生成中没有进入 scrollback；此次修复这一根因。工具仍走原有生命周期，不冻结 pending/approval/elapsed。
- 会话切换、真实前缀修正、Ctrl+O 和宽度变化保留既有重放语义。重建前给 Static 保留旧数据，避免新投影较长时先错误追加后缀再清屏。没有新增第二个 renderer、鼠标捕获、冻结阅读模式或流式 Markdown 解析器。

## 参考与设计取舍

本地 Pi `packages/coding-agent/src/core/tools/renderers/bash.ts` 使用五行末尾预览、按需展开；OpenCode `packages/tui/src/routes/session/permission.tsx` 将操作说明与选项分开，持久许可另说明作用范围。采用其有限披露原则，保留 ohbaby 的既有授权语义和按键，没有移植全屏布局或另加确认步骤。

Pi 三次调用使用 `github-copilot/claude-opus-5.5`、medium，同一会话 `codex-tui-improve4-20261004`，启动目录为本仓库。第一轮建议流式前文进入 scrollback、权限去重和 subagent 语义展示。第二轮复现表格/列表中途重排、每帧历史行重新序列化、短错误跳位和通知顺序变化，逐项补回归修复。第三轮确认这些修复，并指出延迟排版阶段需明确提示；已采用不带猜测行数的临时提示。没有采用新增 subagent DTO、缩放防抖或只按空行提交 Markdown：本次优先修复截图中的 status；长代码块也需要生成中可读；真实投影修正仍以正确性为先。Pi 第一次无法读取兄弟参考仓库，主代理已直接核对上述本地源码，未将其未核实的比较当成证据。

## 已复现并修正的问题

1. 权限单测先红：同帧 `Allow once` 出现两次；修复后只有一组选项。
2. 真实 Ink 输出先红：40→80→120 行生成时首行始终未输出；修复后逐步追加，完成不重复首行。
3. 根进程工具 PTY 检出 Ctrl+O 展开顺序错误：逐行 Static 在重建前先追加较长新投影的后缀。补真实输出回归，修复后展开顺序与单次重建恢复。
4. 独立审查复现短错误加页码后截断且全文不可达；错误状态栏移除页码，expired 错误保留阅读入口。
5. 独立审查复现尾窗不足四行时 Yoga 挤压丢失最新行；按实际尾窗预算显式裁剪并保留最新行。
6. 逐字符表格列宽增长和紧凑列表变松散会在流式中重复清屏。仅对同一 live text 的源文本追加延后排版修正；保持既有前缀和最新尾部，封存/完成时一次正确对齐。不会冻结已封存历史的修正、源文本替换、切会话或主动展开/缩放。
7. 200 条历史三次等价刷新额外序列化 1,800 次；复用同一 WeakMap 中的行指纹后为 0 次，没有新增通用缓存系统。

## 验证

测试入口：

```sh
VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 pnpm preflight
python3 scripts/run-tui-improve4-stream-pty.py
python3 scripts/run-tui-improve3-pty.py
python3 scripts/run-tui-improve2-pty.py
```

进程 fixture 使用真实 App、Ink、PTY 和确定性合成后端，不调用真实 LLM；实际 in-process Write/审批/落盘链由既有 `tests/integration/tui/main-chain.integration.test.tsx` 验证。

## 最终验证结果

- 根进程 `pnpm preflight` 退出 0：格式、lint、typecheck、全仓测试和构建通过。505 文件通过 / 6 文件按配置跳过，5,637 项通过 / 17 项跳过；lint 为 0 errors / 109 条既有 warnings，Web 仍有大于 500 kB chunk 的既有提示。日志 `/tmp/tui-improve4-preflight-final.log`。
- 全仓检查运行期间最后补了临时排版提示，因此没有把前一检查点冒充包含该增量。最终源码另跑 transcript 全套 + permission + 真实 in-process 主链：10 文件、87 项通过，包括提示预算 1/2/3 行、完成后消失。最终格式、定向 lint 和 `tsc -b --force` 通过；分批提交仍执行仓库 lint/typecheck 钩子。
- 根进程最终流式 PTY：120×40、80×24、60×20 深色与 80×12 浅色无色，四场退出 0。120 行未闭合代码块的前文及时输出，首行只输出一次，生成/审批/完成转换不清屏；表格和列表各五次逐字符重排中途均为 0 次清屏，完成分别一次对齐。因此整场 `CSI 3J=2`，仅来自这两次最终对齐。草稿、拒绝、光标/raw mode 恢复均通过。日志 `/tmp/tui-improve4-stream-pty-root-final.log`，ANSI 与 summary：`/var/folders/md/0szgsv_x3bsdgk_fzj9qb6lh0000gn/T/tui-improve4-stream-pty-mf6urxym/`。
- 根进程工具 PTY：120×40、80×24、60×20，另含浅色和无色，共五场通过。验证 Ctrl+O 单次重建及原顺序、Subagent Status JSON/ID 在默认/展开都不出现、List 展开可达、真实错误保留、中文草稿和审批输入归属。日志 `/tmp/tui-improve4-tools-pty-root.log`，证据 `/var/folders/md/0szgsv_x3bsdgk_fzj9qb6lh0000gn/T/tui-improve3-pty-s5rg0dk8/`。
- 根进程 improve-2 控件 PTY：120×40、80×24、60×20、80×12 四场通过，45 行审批、无 deny 的 Esc 不提交、4,689 字符草稿、缩放和退出回归。日志 `/tmp/tui-improve4-controls-pty.log`，证据 `/var/folders/md/0szgsv_x3bsdgk_fzj9qb6lh0000gn/T/tui-improve2-pty-u4m1xngp/`。
- 独立子代理最终审查未留下可确认 P1/P2；其表格独立复现为流式 0 clear、完成 1 clear、等价刷新 0 bytes。Pi 三次原始正文已在对话完整展示；第三次指出的临时提示缺口已经修复，并由独立代理复核最后 14 项 flicker 回归。

初次类型检查遇到本地构建声明产物与 tsbuildinfo 不一致，强制重建后通过，没有修改编译配置规避错误。新多阶段流式 fixture 曾复用 run ID 和消息时间戳，使 list 排到旧消息前被当作已封存；改为真实递增消息时间、独立 run ID 与 run.updated 顺序，不放宽生产逻辑或断言。临时日志和 ANSI 可用上述脚本重建。

## 边界与用户审核

电脑控制尝试系统 Terminal 后明确返回 `Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons.`。没有绕过；本轮改用自己的 PTY 进程。真实 GUI 上滚停留、选中复制、触控板、中文 IME、Windows 真机仍未验收。工具脚本的深浅色/低色彩场景属于输出验证，不等于截图观感通过。

同一流式段的 Markdown 排版变动延迟到段落封存/完成对齐。在这段布局不稳定的时间内，保留已输出前缀与最新尾部，中间新增行可能等封存后才完整显示，尾部临时提示标明此状态；不按变化后的行索引猜测追加，以免漏字或重复。稳定正文/长代码块继续逐步进入 scrollback。封存对齐、真实内容修正、Ctrl+O、resize 仍可替换当前已加载历史的原生 scrollback。普通追加不清屏的测试结果不能扩大成“所有 Markdown 和终端配置下永不闪烁”。GUI 新输出是否将用户拉回底部仍受终端行为影响。

环境：macOS，Node 26.3.1，pnpm 9.15.0；未安装新的依赖。

SWE 取舍：展示层管理物理行与必要投影缓存，业务消息、授权和恢复状态仍只有现有 store 一份。测试覆盖真实控制序列、生命周期和内容可达性，不为此次修复重建终端框架。
