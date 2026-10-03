# improve-1：实施与验收记录

2026-10-03。对应 02 的 Stage 1–3；实施分支 `codex/tui-improve-1`，本地开发基线 `codex/tui`，共同起点 `5c2adab564b522226373135fe123e8690d43f7f4`。仅本地提交，等待用户审核，不 merge、不 push。

## 1. 实施结论与边界

采用官方 Ink 8 + React 19.3，保留 React/Ink、SDK/store/recovery 及既有输入、队列、审批语义。稳定历史以 Static 追加；实际显示投影发生修正、前插、删除、会话或宽度变化时，一次清屏重放当前已加载历史。普通等价通知不重放。显示指纹以不可变消息对象、宽度和主题缓存，避免测量变化时再次解析全部 Markdown。显式子代理浏览器返回也进行一次重放，防止 Static 重新挂载重复追加。

清屏重放会替换终端原有 scrollback，仅保留当前已加载投影；这是保证修正可见的明确取舍，不等同于普通输出稳定性。没有采用 AltScreen、Gemini 的私有 renderer、修改 node_modules 或另一份业务状态。

**自动化验证与真实终端验收分开记录。Ghostty 真机上滚、复制、IME、深浅主题观感未验证，不能将本轮整体验收写成通过。** Computer Use 拒绝访问 `com.mitchellh.ghostty`（safety restriction），未绕过限制。实际 PTY 进程测试可验证输入/输出/退出路径，不能替代 T04。

## 2. 为什么升级 Ink

本机隔离探针结果（80×12，40 行动态内容，连续三次等价 render）：

| 版本 | 三次更新的 CSI 3 J | Static 重挂后 resize 旧缓存 | 结论 |
| --- | ---: | --- | --- |
| 6.6.0 原版本 | 3 | 可重现 | 长动态帧清回滚，直接改 Static 又冻结修正 |
| 6.8.0 | 3 | 可重现 | 不解决本轮问题 |
| 7.1.1 | 3 | 不重现 | 修缓存，仍清回滚 |
| 8.0.0 | 0 | 不重现 | 可作为候选，但未限制长动态帧时仍发生 viewport 重置 |

[Ink 8 官方发布说明](https://github.com/vadimdemedes/ink/releases/tag/v8.0.0)及本地公共 API 验证支持本次选择。升级本身不等于修复：实际方案同时限制动态输出高度并明确处理可变历史。Ink 8 的 React peer 为 19.3，仓库原有 Node >=24 满足要求；CLI React、Web React/React DOM 同步到 19.3，避免共享 Vitest React alias 下 renderer 版本不匹配。Web 无产品逻辑变更。CLI 生命周期的 `waitUntilExit` 返回类型适配为 `Promise<unknown>`，原调用不使用返回值。

本地 Gemini CLI 调查：`/Users/hansun025/Projects/code-cli/gemini-cli` 使用 `npm:@jrichman/ink@6.6.9`；默认 `useAlternateBuffer=false`、`terminalBuffer=false`，依赖 Static + history remount。其 `useHistoryManager` 明确指出旧 Static 历史不能直接更新。实验性 terminal buffer 使用 fork 专有组件，不作为本轮解决方案。借鉴了控制区预算与稳定输出原则，没有复制 fork。

## 3. 改动范围

- 内容：按 `runtimeInputKind` 在显示时间线拆分前过滤内部 subagent-status/result，保留模型输入和持久化数据；普通 system、user-steer、用户原文和 assistant 引用仍显示。隐藏 reasoning/Thought，子代理浏览器复用相同显示规则；reasoning-only 消息不留空标题。浏览器根据实际可用高度显示详情/列表，原方向键与 PgDown 可访问完整正文，PgUp 先向上翻页，顶部仍补载旧历史。子代理工具摘要不泄露完整委托 prompt。
- 历史：无保留旧页时不制造不可清除 stale；仅在实际保留旧页时标记待刷新；恢复成功清理对应历史错误，保留真实运行错误。移除 TUI stale 与缺失 reasoning 的占位文案。
- 输出：`ReplayableTranscript` 保存显示指纹和渲染代次，不复制业务消息；根子代理订阅按实际可见摘要比较，浏览器仍订阅完整状态；隐藏等待组件不运行计时器。
- 视觉：中性用户背景与侧线、少量工具类别色、参数保持中性，保存失败有明确错误样式。活动短句按 runId 确定，跨重试、审批和浏览器卸载/重挂保持，一种 shimmer 效果，按 grapheme 处理中文/emoji。
- 底栏：当前会话路径 + mode/level，当前模型 + compatible effort + 后端 context。数字保留小百分比，不从旧 usage.modelId 推断当前模型，不前端估算 token。异步请求按身份和代次隔离。
- 输入与组合：轻边界、两行底栏；编辑器仅限制显示的物理行，完整草稿/提交与既有键位不变；上方有隐藏草稿时用同宽暗色 ↑ 提示；小窗口审批时 Tasks 临时显示摘要，退出恢复展开状态。超高 Tasks 用局部物理行窗口和 Alt+PgUp/PgDn 查看，普通 PgUp 历史键不变，不隐藏无法访问的任务；前景弹窗打开时暂停 Tasks 按键监听，避免同键同时作用于两处。context 查询等待初始 view 安装，避免快查询被迟到空快照覆盖。

## 4. 验证记录

以下命令均在本地执行，未启用真实模型 smoke：

| 命令 | 结果 |
| --- | --- |
| `pnpm test:unit` | 319 文件通过，3,803 项通过，2 项跳过（中途检查点；后续新增用例由全量 preflight 覆盖） |
| `pnpm test:contract` | 26 文件、442 项通过（同上） |
| `pnpm test:integration` | 140 文件、1,144 项通过；后续浏览器和 Tasks 增补另跑完整 App 组合 |
| `pnpm preflight` | exit 0；format、lint、typecheck、全量 test、全仓 build 全部成功；496 文件通过 / 6 跳过，5,497 项通过 / 17 跳过 |
| 收尾修复的 6 个相关文件 | 25 项通过；包括三个完整 App 集成文件的 8 项、活动短句重挂稳定性、真实 Ink 动画输出 |

preflight 的 lint 为 0 errors / 98 warnings，构建有 Web 大于 500 kB 的 chunk 提示，均未被当成错误掩盖。全量 preflight 后，最后两个窄修复（弹窗/Tasks 按键归属、同 run 组件重挂短句稳定）另补先红后绿回归，上表 25 项为最终源码结果；随后再次执行 format、lint、typecheck、build，均 exit 0。没有将较早全量检查冒充这两项新增用例的结果。

- 基线：初始相关 5 文件 42 测试通过；旧版实际长帧三次清回滚已复现。
- 真实进程：`pnpm exec tsx --tsconfig tsconfig.base.json tests/integration/cli/fixtures/tui-improve1-process.ts`，由根进程创建真实 PTY，在 80×24 / 60×20 各运行一次。合成历史、中文草稿、fake 审批和退出全部走真实 App。两次 exit 0；stdout 分别 8,427 / 7,687 bytes，CSI 3 J 均 0，审批与草稿文本存在、光标恢复、内部消息未出现。审批只作用于合成后端。
- 动画隔离样本：Ink 8、80×24、同一秒 settled 观察窗口，默认 8 次可见更新 / 24 次原始 write / 988 bytes；无动画对照仅时长更新 1 次 / 3 write / 64 bytes。Ink 8 同步输出 start/content/end 各占一次 write，不能将该计数直接当作与旧调查 28 次/秒完全相同的测量口径。隐藏、结束、卸载后分别观察 1.1 秒，零写入。

| 验收项 | 证据与状态 |
| --- | --- |
| T01 | 实际默认 TTY 输出 contract：3/40 行等价通知静默，未使用全局 Static override 掩盖默认行为 |
| T02 | 完整 SDK/store/recovery/App 合成后端组合，120×40、80×24、60×20；包含两行底栏、Tasks、notice、30 行草稿、审批、真实等价轮询；最终结果见上方命令 |
| T03 | 修正、前插、追加、重复、切会话、宽度变化与 resize 旧缓存 contract；浏览器 Ctrl+G/Esc 返回集成 |
| T04 | **未验证**：需要 Ghostty 五种状态各上滚至少 10 秒并复制 |
| T05–T08 | 来源过滤/时间线/恢复/错误可见性自动测试；真实模型输入和持久化路径未改 |
| T09–T10 | 短句跨重渲染/重试/审批，同 run 保持；实际输出计数、无动画与隐藏/结束/卸载测试 |
| T11 | 颜色/token/字符宽度自动测试；**真机深浅主题截图未验证** |
| T12–T14 | 两行字段、数字边界、能力兼容与旧请求晚返回；Web React 消费路径回归 |
| T15 | 编辑器/队列/历史/slash/审批/Tasks 自动回归；**Ghostty IME 与滚轮体验未验证** |
| T16 | public Ink PTY 退出、raw mode/cursor、resize 与 Windows 路径模拟测试；**Windows 真机、Ghostty 重入/异常交互未验证** |

## 5. 独立审查与取舍

三个子代理分别负责内容/视觉、底栏/输入、输出策略；随后交叉检查组合边界，并将确认问题写成回归测试。根代理独立运行完整 App、真实 PTY 和全仓检查，不以子代理报告替代验收。

通过 calling-pi-agent 调用 `github-copilot/claude-opus-5.5`，会话 `codex-tui-improve1-20261003`，工作目录为项目根。第一轮接受并修复：reasoning 缺失提示掩盖真实错误、model invalidation 短暂 unknown、真实 web 工具名称分类、保存错误对比度、grapheme shimmer。未接受 binary capability + 显式 effort 展示 on 的建议，因为后端拒绝该配置；也没有伪造跨请求的 run 时钟。保留真实 request duration，只稳定活动短句。升级后追加只读复审：未发现阻断问题，提出长历史重复投影、连续 resize 重放、长草稿缺少视口提示。前两次调用的原始正文均在对话中完整呈现。已用 200 条 Markdown 消息测试确认等价渲染重复解析，并以 WeakMap 显示缓存修复；草稿 ↑ 提示已加入。resize 每次宽度改变当前仍明确重放，100ms 合并是尚无真机证据的建议，本轮保留即时正确性，待 Ghostty 观测后再决定，避免额外异步状态。

SWE 复核：只提取本轮显示逻辑，不引入通用 renderer/策略框架；三个完整 App 集成场景复用一个 FakeTTY fixture，避免复制输入协议；底栏简写与状态面板原格式保持各自职责；不为后续 improve-2/3 提前实现 Ctrl+O、完整工具卡片或审批/Tasks 重设计。仍需人工验收的部分明确列出，不用绿测试掩盖终端观感缺口。

## 6. 审核与后续验收

用 `git diff codex/tui...codex/tui-improve-1` 查看整轮提交。优先看 `ReplayableTranscript` 的真实历史变化判定与明确重放、AppShell 的实际高度预算、Prompt 两行底栏和物理行预览，以及 Tasks/子代理浏览器的内容可访问性。

本地可运行上述 `tui-improve1-process.ts` 进入合成场景：2 秒后出现 fake 审批，12 秒后退出，无真实模型或工具操作。Ghostty 的持续上滚、复制、IME 和深浅主题观感继续按 04 的步骤验收；连续拖拽 resize 的视觉体验仍需观察。当前只对已测三尺寸和自动化场景作结论，不将极小窗口或其他终端的未测组合写成通过。

本轮提交仅包含实施代码、相关测试和本记录。开始任务时已存在的其他未跟踪规划文档及 `.playwright-mcp/` 保留原状。开发分支保持基线，待用户审核后再决定后续阶段与合并。
