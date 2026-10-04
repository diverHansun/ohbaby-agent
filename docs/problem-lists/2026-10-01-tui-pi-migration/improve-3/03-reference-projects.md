# improve-3：参考项目与取舍

2026-10-03。本地源码调研，不是对参考产品运行效果的验收。用户选择的参考是 Pi、OpenCode 和本地 claude-code 目录；不额外套用 Web 营销页设计语言。

## 1. 来源

| 来源                   | 本地入口                                                                                                                                       | 核实范围                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Pi                     | `/Users/hansun025/Projects/code-cli/pi/packages/tui/src/index.ts`、`components/markdown.ts`；`packages/coding-agent/src/core/tools/renderers/` | 官方包公开 API、工具显示与全局展开               |
| OpenCode               | `/Users/hansun025/Projects/code-cli/opencode/packages/tui/src/routes/session/index.tsx`                                                        | Read/搜索摘要、Edit diff、Bash 有界输出          |
| 本地 claude-code / CCB | `/Users/hansun025/Projects/code-cli/claude-code/packages/builtin-tools/src/tools/`、`src/components/shell/OutputLine.tsx`                      | 工具输出和紧凑预览；这是恢复工程，不声称官方源码 |

Pi 调研快照 `5fd446ca1`，本地 tui 标记 `0.87.1`；OpenCode `16c56fe5`；CCB `77a7934e`。实施时重新核实精确源码与所选发布包，不把本地目录版本当作已安装依赖。

## 2. 采用与调整

| 做法                                      | ohbaby 决定                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| Pi 的 Ctrl+O 全局工具展开                 | 采用用户语义；控制已加载工具块，不改变历史补载、reasoning 或输入历史             |
| Pi Bash 末尾短预览，展开显示结果          | 采用方向，约 5 显示行作为初值；ohbaby 没有的数据或日志通道不假造                 |
| Pi Write 约 10 行内容预览、Edit 内联 diff | 采用内联层级；只在 ohbaby 的事实可信时展示，不复制参数流中的猜测预览             |
| Pi Markdown.render(width) 返回 ANSI 行    | 用公开组件与主题接口接入 Ink；验证 padding/tab/链接/能力检测，而非声称完全纯函数 |
| OpenCode 按工具用途区分密度               | 读/搜索简短，修改/命令给正文；不引入 Solid/OpenTUI 或全屏布局                    |
| CCB 有限输出、错误和后台状态区分          | 采用信息语义，不照搬其复杂转录/快捷键体系                                        |

Pi 具体锚点：`packages/coding-agent/src/core/keybindings.ts` 的 `app.tools.expand`；`modes/interactive/interactive-mode.ts` 的 `toggleToolOutputExpansion` 与 `toolOutputExpanded`；`core/tools/renderers/bash.ts`、`write.ts`、`edit.ts`。这些工具 renderer 属于 coding-agent，只作行为参考，不能作为 pi-tui SDK 的导出导入。

## 3. 明确不采用

Pi 的终端宿主、Editor、overlay、coding-agent 依赖；OpenCode 的全屏交互与侧栏；CCB 的内部框架；通用工具列表或阅读页；为追求同款而复制所有快捷键。

不把“像 Pi”解释成绕过 Ink 直接写 stdout，也不假定 Pi 的历史重绘语义适用于 Ink。02 Stage 1 专门验证这项差异。

## 4. 对计划的影响

先接入不需要终端接管的文本能力，再交付 Bash 的数据到界面纵切，随后补真实修改 diff，最后接全局展开与组合验收。恢复来自 ohbaby 现有协议和用户决定，不照搬任何参考产品的请求重试策略。

## 5. 本机安装版本的补充核对（2026-10-03）

Pi 审查后，主代理核实 `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/package.json` 为 1.0.0；这与前述本地源码目录 0.87.1 是两份独立快照，项目尚未选定依赖版本。

安装包 `dist/tui-main-screen.js` 的 fullRender(true) 发出 `\x1b[2J\x1b[H\x1b[3J`，在 firstChanged < prevViewportTop 时会调用它。这条路径会清屏并清 scrollback 后重印，不代表每次 Ctrl+O 都无条件这样做。在明确说明该代价后，用户已确认学习 Pi：Ctrl+O 展开详情，再按恢复正常 TUI，允许主动切换时必要的一次清屏重印。本轮 02 Stage 1 继续验证该行为在 Ink 下的实际实现与后续刷新稳定性，不因 Pi 源码存在就宣称 ohbaby 已通过。
