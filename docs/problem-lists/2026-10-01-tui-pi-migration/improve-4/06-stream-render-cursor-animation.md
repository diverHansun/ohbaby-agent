# improve-4 补充：逐 token 输出、光标导航与等待动画

> 状态说明：本文记录 Pi 两轮中间实施及当时测试结果。后续用户实测仍有覆盖问题，Markdown 分段和 ANSI 擦除改写已撤下；最终方案与语义验收见 [07 独立输出区](07-independent-transcript-viewport.md)。

用户再次实测反馈：LLM 文字生成阶段仍高频闪烁，工具阶段不闪；输入框需要 PgUp/PgDn；working phrases 的光效与移动需优化。此记录接续 05，不把此前 PTY 通过视为真实终端“不闪屏”的证据。

## 1. 排查结论与参考依据

- 项目实际依赖是 `ink@8.0.0` / `react@19.3.0`；Ink 开启了 `incrementalRendering`，默认帧率上限 30。普通增量差分与 `<Static>` 追加是两条输出路径。前者按变化行更新，后者仍先调用 `log.clear()` 擦掉整个动态帧，再输出 Static 和动态帧。
- 临时测量以真实 App、假 TTY、25ms/字符喂入混合 Markdown；7.34 秒捕获 216 次同步输出，其中 14 次出现整帧擦除前缀。**这里的输入是逐字符快照刷新，不是实际供应商 token 事件链，也不是 GUI 闪烁频率测量。** 初版仅统计 `2K` 的数量会把逐行覆盖也误记为整帧擦除；正式回归改为识别擦除顺序并校验终端状态。
- 上一轮合并 `write()` / 限制 `CSI 3J` 不充分：即使没有清 scrollback，输出中仍可能先把动态区变成空白。不支持或未有效执行 synchronized output 的终端尤其容易暴露中间态；不能据此断言用户具体终端缺少该能力。
- 本地 Gemini CLI `packages/cli/package.json` 使用 `ink: npm:@jrichman/ink@6.6.9`、React 19.2.4，并以 `@xterm/headless` 做终端测试。它不是“升级 React 就解决闪烁”的证据。`ui/components/LoadingIndicator.tsx` 将提示截断和计时区隔离，避免长文案挤动状态布局。
- 本地 Pi `packages/tui/src/tui-main-screen.ts` 用 first/last changed row 做差分、逐行 `2K + text`、同步输出与有界写缓冲。**Pi 也使用擦行，不是完全不擦除**；借鉴的是不先擦空整个动态区域、只清理自身旧行。
- 本地 `claude-code` 实际是 Claude Code Best 复原工程（见其 README），不是 Anthropic 官方开源实现。参考 `src/components/Spinner/SpinnerAnimationRow.tsx` 的动画叶子隔离、共享时钟、reduced-motion 设计；该文件使用 `@anthropic/ink`。未复制其实现或把其源码视为官方保证。

## 2. 输出层调整

`packages/ohbaby-cli/src/tui/terminal-output.ts` 保持 Ink 为唯一布局/输入所有者：

1. 保留每个完整 DEC 2026 帧的单次写入。
2. 对固定 Ink 8 的 Static 追加序列，把“自下而上整帧擦空，再打印”改为“定位到旧帧首行，逐行擦写”。
3. 改写只接受完整、以 LF 结束、只含 SGR/LF/可打印文本、行宽符合当前尺寸的帧；不匹配就原样透传。缩小帧专用序列、显式历史清屏、硬件光标移动、嵌套同步、OSC/图像、超宽或不完整输出不改写。
4. 缩短时只清旧帧拥有的剩余行，使用 cursor-down 而不是换行，不使用无界 `eraseDown`，不清除帧下方的其他内容。保留最终光标坐标及 scrollback。

没有替换 React/Ink，没有修改 `node_modules`，没有新增第二个 renderer，也没有启用 alternate screen 或鼠标捕获。新增 `@xterm/headless@5.5.0` **仅为根项目开发/测试依赖**。

## 3. 输入键位

补全菜单、审批、Tasks、队列选择等既有输入归属优先级不变。编辑器接管普通输入时：

| 键 | 行为 |
| --- | --- |
| PgUp / PgDn | 多个逻辑行的草稿向上一行/下一行移动；到首行/末行后定位行首/行尾 |
| 单行 PgUp / PgDn | 行首/行尾；长单行的自动折行仍属于同一逻辑行 |
| ↑ / ↓ | 多行草稿内部移动，首/末行边界沿用历史输入导航 |
| Home / End、Ctrl+A / Ctrl+E | 当前逻辑行首/行尾 |
| 空输入框 PgUp | 沿用“加载更早会话历史”入口 |

非空草稿在行首重复按 PgUp 不再触发历史重放。上下移动按终端显示列而非 UTF-16 长度对齐，经过短行保留期望列；中文、组合字符、emoji、Tab 均不在字素中间落光标。水平移动/编辑后重置期望列。等待队列保存确认时仍只允许导航，不改变保留的提交正文。

## 4. 等待文案动画

保持 `working-phrases.ts` 的全部文案及“每回合固定一句”规则。原先 150ms、5 字素硬边光带改为：

- 100ms（10fps）一个局部动画时钟，同时驱动等宽脉动符号和柔边渐变；文字自身不移动。
- 5 档余弦亮度渐变，左右各 6 字素，扫过后短暂停留。
- 不逐帧切换粗体，避免光带顺带改变字重造成跳闪。
- 动画状态仅留在 `ShimmerText`，色阶缓存；真实 elapsed timer 保留原有 1 秒时钟。
- 长文案单行截断，计时区不被挤走；开始正文输出、审批、结束后卸载等待动画。
- `OHBABY_TUI_NO_ANIM=1` 保留静态符号/文案，不启动动画时钟。

## 5. 验证与边界

当前阶段已有：

- ANSI 单元测试：识别固定追加序列，未知/不完整序列透传，回调和背压处理。
- headless 终端：增高/缩短、顶部/底部、满宽中文、有色行、帧下方外部内容；逐帧比较字符、颜色、光标、wrap 标志和 scrollback。
- 80×24 / 40×12 的真实 Ink 逐字符 Markdown 回归，覆盖封存与完成状态，**上滚后在整个生成阶段逐次断言 viewportY 不变**；不使用“仅去掉 ANSI 后找子串”代替屏幕校验。
- PgUp/PgDn、↑/↓、Ctrl+A/E 的真实 Ink 输入回归；动画单时钟、停表、窄屏和字素边界回归。

已完成的专项结果：

- 输入/动画：13 个文件、74 项通过；真实 Ink 输出中，动画启用时 1 秒内 11 次内容更新（包括计时器），禁用动画时 1 次；隐藏、结束、卸载后均为 0 写入。
- ANSI 屏幕等价：5 项 headless + 15 项输出单元测试通过；上述生成中 scrollback 停留断言已执行。
- 最终 PTY：`run-tui-improve4-stream-pty.py` 的 4 个场景全部通过且 scrollback clears = 0；`improve3` 的 5 个场景、`improve2` 的 4 个场景全部通过。后两套包含显式 Ctrl+O / 历史修正 / 改变窗口宽度，不把这些必要的重放统计混同为普通生成阶段清屏。
- 首次全仓预检：格式、lint、typecheck 通过，测试为 5679 passed / 1 failed / 17 skipped；失败是 Tasks 测试仍沿用“非空草稿 PgUp 加载历史”的旧契约。补充验证实际插入行、原文提交、空草稿加载历史，并把旧的 150ms 常量断言改为共享动画周期；没有放宽产品行为或仅删除断言。
- 两个进程测试文件原来不在 TypeScript 项目服务中且动态导入 Ink 泄漏 `any`。`eslint.config.js` 仅将这两个文件加入 `allowDefaultProject`，保留严格类型规则；fixture 增加对应已安装 Ink 入口的类型断言，运行时仍走原来的 CLI 公开入口解析。定向 ESLint 0 错误/0 警告。

最终复验（任务 `bd7fdf4a0`，退出码 0）：

- Tasks 定向回归 3 项全部通过，包含上述旧契约修正后的断言。
- 完整 `pnpm preflight` 通过：format:check → lint → typecheck → test → build。全仓 510 个测试文件通过 / 6 个文件跳过，5680 项测试通过 / 17 项跳过，0 失败。
- lint 为 0 错误；仓库其他未改文件仍有 109 条已有警告。Web 构建保留大于 500kB 的 chunk 提示；没有为消除提示而关闭规则或改变构建阈值。
- SDK、Agent、Server、CLI、Web 全部构建成功；`packages/ohbaby-cli/dist/bin.js` 已重新生成，Web 资源已复制到 CLI 分发目录。本轮不是只运行声明文件 typecheck。
- 编译产物的 `--version` / `--help` 在临时隔离 HOME 中均通过（版本 0.1.13）。真实 HOME 下的额外 smoke 被沙箱以 `EPERM chmod ~/.ohbaby` 阻止；没有修改用户目录权限，也没有把隔离 HOME 的结果冒充用户配置下的交互启动验收。
- 最终文档格式检查及工作区代码/文档 `git diff --check` 通过；未把 `.pi/tasks` 的原始 ANSI 日志纳入格式检查。

证据日志位于 `.pi/tasks/01a10508-8a38-70de-a284-de1db7870745-10689/`：`bccb439e0.output`（输入/动画）、`b88e31ced.output`（13 个 PTY 场景）、`bc92dec9b.output`（首次失败及屏幕等价测试）、`bd7fdf4a0.output`（最终完整预检与构建）。这些是本机运行证据，不要求提交 `.pi/tasks`。

上述自动化不模拟 GUI 合成器、终端的 scroll-on-output 偏好、触控板惯性或字体渲染，**不能承诺所有终端完全不闪或强制保持原生滚动位置**。宽度改变、Ctrl+O、会话切换、真实历史修正仍保留原有主动重放语义。

## 6. 用户复测

本轮已构建；先退出旧进程，在仓库根目录运行：

```sh
pnpm start
# 或明确使用本轮生成的 CLI：
node packages/ohbaby-cli/dist/bin.js
```

1. 生成包含多段文字、列表、长代码块、表格的长回复；生成中上滚、停留、选中复制，观察输入框/底栏是否仍闪。
2. 单行输入中文、emoji，再按 PgUp/PgDn 确认行首/行尾；多行草稿确认上下移动、经过短行后的列保持；提交后内容完整。
3. 检查等待动画文案不位移、计时不挤换行；可用 `OHBABY_TUI_NO_ANIM=1 pnpm start` 对照区分动画与正文输出。

若仍闪，请记录终端名称/版本、是否通过 tmux/SSH/IDE、窗口行列及短录屏，这些比只记录 `CSI 3J` 更能定位残留问题。

本轮未 commit、merge 或 push，未重置已有暂存区。此前暂存的 `.pi` 工件与临时测量脚本条目仍需提交者人工检查；测量脚本已移出工作区，未把暂存区中的旧版本当作最终待提交版本。
