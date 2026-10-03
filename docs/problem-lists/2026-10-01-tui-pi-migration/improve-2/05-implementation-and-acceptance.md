# improve-2：实施与验收记录

2026-10-04。实施分支 `improve-2`，起点是 improve-1 的 `5c788e74`。仅本地分批提交；不 merge、不 push，等待用户审核。开始时已有的未跟踪规划文档保留原状。

代码分两批提交：`1705a6cf`（字素输入、显示投影与提交归属）、`07d686c6`（审批、Tasks/App 集成与进程回归）；本验收记录单独提交。

## 1. 交付范围

保留 React/Ink、SDK/store/recovery 和两行底栏，未引入 pi SDK、第二个终端宿主或后端协议变更。

- 输入按完整字素移动和删除；草稿保持原文，发送仍沿用原有 trim 规则。显示投影处理 tab stop、软换行、完整光标及窄列占位，长输入随光标移动并显示行范围。普通键盘 Return 与粘贴文本分开处理。
- 提交在异步模型准备前固定输入、来源和创建代次；快速连续首发维持顺序并绑定同一新会话。切换取消尚未交给 recovery 的准备，明确拒收的原文通过既有输入历史恢复，不覆盖新草稿；普通 unknown 继续查询原回执，不重发。
- 队列取消恢复编辑前草稿，retained unknown 保持原 operationId 和首次文本，允许只读导航。租约和晚到结果按来源处理。
- 审批首屏优先显示真实操作描述，标题/来源过长时全文进入同一阅读区。纵向选项按 choiceId 保持身份；有 deny 的 Esc 拒绝，无 deny 不提交。长正文/选项/错误均可翻页，小到必要操作区放不下时暂停提交。Always 明确为请求所属会话的匹配授权。
- 审批时保留底栏、收起 Prompt 正文及辅助 Tasks；已有子代理浏览器先保持，显示审批等待提示，关闭后进入审批。停止/同步错误仍可见，现有恢复键不被伪装成已交付的 improve-3 自动恢复。
- Tasks 在可信当前 run 中默认展开，同一 run 手动收起保持；确认结束后隐藏，Ctrl+T 可回看当前会话现存数据并标注 Stopped。复用 improve-1 的 Alt+PgUp/PgDn 阅读路径，审批往返保留页码，计数来自完整列表，不改 Todo 状态。

## 2. 与规划的具体对齐

Stage 0 确认 improve-1 已有长 Tasks 的局部阅读窗口，因此无需新增任务导航。本轮验证 20 项以及长续行的完整可达性。前轮 Ghostty 人工验收缺口继续保留，不将它写成已通过。

输入宽度直接声明使用 `string-width@8.3.0`，这是 Ink 8 已安装的同版本依赖。原因是自有宽度函数把单个区域指示符按 2 列处理，Ink 实际按 1 列处理。本次只增加 CLI manifest 和 lockfile importer 的三行引用，不升级该依赖，也不访问 Ink 私有测量文件、不动态建立 CommonJS loader。这是对原计划“不改 lockfile”的窄幅调整，用已有标准依赖减少另一套宽度语义。

保留 improve-2 的原有恢复路径：improve-3 自动恢复尚未实施，不能提前删掉可工作的 Ctrl+R。无跨进程草稿持久化、通用 controller/焦点框架、完整工具详情或新的任务管理系统。

## 3. 验证入口与证据

```sh
VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 pnpm preflight
pnpm exec vitest run tests/integration/cli/tui-improve2.integration.test.tsx tests/integration/cli/tui-tasks-overflow.integration.test.tsx
python3 scripts/run-tui-improve2-pty.py
```

进程测试通过独立控制管道驱动合成后端，stdin 完整交给实际 Ink。不会调用真实模型或执行真实审批操作。脚本输出原始 ANSI 文件与 JSON 汇总的临时目录，可重复运行。

已建立并执行的反馈环包括：完整字素编辑/分片粘贴、模型准备期间切会话、明确拒收不覆盖新草稿、普通 unknown 不误报可重发、旧 null 创建上下文的未发送记录、retained 只读浏览、无 deny 的 Esc、同请求 choices 重排、过期/晚到审批回应、Tasks 确认停止与未知状态、会话往返与新 run、审批与子代理浏览器输入归属。

四尺寸完整 App 场景为 `120×40`、`80×24`、`60×20`、`80×12`。组合 200 行中文/家庭 emoji/组合音标草稿、45 行审批、活跃 run 和 notice；断言实际输出首屏含操作说明与两行底栏、帧高度小于终端高度，最终提交文本与原草稿一致。既有 Tasks 测试覆盖 20 项和超长续行、普通 PgUp 不被 Tasks 翻页抢占、审批往返页码保留。

真实 PTY 场景覆盖上述四尺寸、20 项 Tasks 末项、长审批末尾、无 deny 的 Esc 与显式 allow/deny、原始 4,689 字符草稿提交、resize、停止后 Tasks 回看、退出 raw mode/光标恢复。普通交互不清 scrollback；主动宽度改变按 improve-1 既有契约重放历史一次。该证据不等同于 GUI 上滚和复制体验。

最终受控并发全仓测试：501 文件通过、6 文件跳过；5545 测试通过、17 测试按配置跳过。格式检查与类型检查通过，lint 为 0 errors / 106 warnings。全量构建通过，受控并发 `pnpm preflight` 退出码为 0；Web 构建仍报告大于 500 kB 的产物体积提示。最终日志为 `/tmp/tui-improve2-preflight-bounded.log`。已完成的独立检查：TUI 与 CLI 集成 70 文件、577 测试通过；真实 in-process 主链 8 测试通过；SDK/Agent recovery 契约 185 测试通过。真实 PTY 四尺寸全部通过，最终原始证据目录为 `/var/folders/md/0szgsv_x3bsdgk_fzj9qb6lh0000gn/T/tui-improve2-pty-k61c_vym/`（临时文件，脚本可重新生成）。

综合检查曾发现旧 Ctrl+C 提示断言和三项 effort 首发测试失败。Ctrl+C 更新为当前可见提示后，保留停止及再次提交断言，主链 8/8 通过。effort 的面板关闭帧早于 React 输入订阅 effect；仅等帧时三个模拟 stdin 用例稳定失败。测试改用 React `act` 完成面板保存与 effect，再等待可见状态及实际提交调用，三个用例通过。快速 first/second 仍在同一 tick 连续输入，并在释放延迟模型查询前确认查询已启动；没有放宽 payload、reasoning、顺序或 session 断言，没有增加固定睡眠或改动生产输入逻辑。

另一次默认并发全仓运行中，TUI App 140/140 通过，但未改动的 Web `command-lifecycle.integration.test.ts` 中 sidebar title 用例在 `abortSession` 处报“exact running task has not been verified”；该文件独立复跑 8/8 通过。本轮不扩展修改 Web；最终全仓检查限制为 4 workers，保留全部测试范围。

## 4. 审查与 SWE 取舍

输入/提交、审批、Tasks/App 分别实施并交叉审查，再由新的独立代理检查整个改动。根进程运行完整 App 与真实 PTY，不以代理报告代替结果。

通过 calling-pi-agent 调用 `github-copilot/claude-opus-5.5`，会话 `codex-tui-improve2-20261004`，启动目录为项目根。首轮和复核原始正文已完整呈现在本次对话中。已采纳：保留 trim 兼容、审批描述优先、选项标签准确、错误优先及语义色、选中项强调、恢复提示真实、去除重复未发送记录、Tasks 绑定从纯推导后再保存。

独立审查补充检查分片旗帜插入已有文本前方的顺序，以及队列编辑保存期间 A→B→A 后晚到结果的归属。两项均先独立复现再修正，并由审查代理使用真实 Prompt/Ink 复测通过；新增对应 contract 回归。已评审的最终实现没有剩余 P1/P2 发现。

本轮保留原有 sessionDrafts、recovery、租约和回执职责；没有为了拆短文件再建通用状态平台。原文和显示投影分离，审批不推导后端授权规则，Tasks 不复制后端事实。保留既有长列表导航，避免改变 Ctrl+T 的展开/收起语义。

## 5. 明确未验证项与用户审核

验证环境为 macOS、本机 Ghostty 1.3.1（build 15212）、Node v26.3.1、pnpm 9.15.0，无 tmux/SSH。Computer Use 对 `com.mitchellh.ghostty` 返回安全限制拒绝，未绕过。Ghostty 的真实中文 IME、持续上滚、复制、深浅背景、低色彩和关闭动画观感仍需人工验收；Windows 真机也未测试。自动化输入、颜色 token 和 PTY 通过不能替代这些结果，因此本轮**不标整体人工验收通过**。

审核时优先查看输入分片/异步来源、无 deny 的 Esc、短屏正文与动作、停止后 Tasks 回看。按规划 04 和 frontend/08 补真机验收后，再决定 improve-3 与最终合并。当前开发分支和 main 均未合并此次改动。
