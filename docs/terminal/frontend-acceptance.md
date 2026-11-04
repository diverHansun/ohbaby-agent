# Terminal 前端验收

> 记录前端实现、前后端联合验收及合并前检查。前端最初在 `codex/terminal-frontend-temp` 实施，随后汇集到 `codex/terminal-temp`。设计依据见 [goals-duty](goals-duty.md)、[dfd-interface](dfd-interface.md) 和 [test](test.md)。

## 实现要点

- **入口**：右侧面板 `+` 菜单和入口页的 Terminal 都先请求新建，成功后才打开并选中 tab；等待期间没有转圈或占位 tab，重复点击会被忽略（D1）。
- **tab**：终端图标加服务端给的 `title`（目录名，主目录为 `~`），悬停显示完整路径和 shell 名；终端铺满内容区，上方不加标题栏（D6、D9）。
- **同步**：网页加载和窗口获得焦点时读取终端列表，补齐缺少的 tab，不展开面板、不切换选中项；新建结果与同步结果按终端 id 去重（F1b）。
- **画面**：xterm.js 6，按需加载；配色取自 `tokens.css` 的颜色和终端 ANSI token，与 Codex、Cursor 的浅色终端一致。快照恢复前先等旧连接的写入排空，尺寸调整与输出共用一条写入队列（F3–F5）。
- **关闭**：按钮和键盘 Delete 走同一流程；有程序在运行时用 `ConfirmDialog` 确认；清理失败用 `Banner` 提示并可重试；关闭后焦点按面板原有规则移动（D7、F6）。
- **提示**：新建失败用 `NoticeStack`，重连、关闭失败、已结束用 `Banner`，进程退出在终端末尾写一行灰字。

## 自动化结果

环境：macOS 27.0.1、arm64、Node 24.20.0、pnpm 9.15.0。

| 检查 | 结果 |
| --- | --- |
| `pnpm exec vitest run apps/ohbaby-web packages/ohbaby-server/src packages/ohbaby-sdk/src` | 140 个文件、1,620 项通过，零跳过 |
| `pnpm exec tsc -b` | 通过 |
| `pnpm run lint` | 0 错误，109 条既有警告（与改动前相同） |
| `pnpm build` | 通过；xterm 及插件拆为按需加载的独立文件 |

新增测试：`apps/ohbaby-web/src/api/daemon/terminals.unit.test.ts`（输入切块、token 子协议、目录头只在新建时发送、忙碌程序名），`apps/ohbaby-web/src/ui/side-panel/terminal/terminal.integration.test.tsx`（新建、同步、去重、关闭确认、清理失败重试、快照与输出顺序、本地积压重连与退避、4404 不重连）。

## 浏览器端到端走查（2026-11-04）

用 `ohbaby serve --port 4519 --web-assets-dir apps/ohbaby-web/dist` 启动，在内置浏览器中逐项操作：

| 项目 | 结果 |
| --- | --- |
| 无 workspace 时新建 | 在主目录打开，tab 标题 `~` |
| workspace 内新建 | 在项目根目录打开，tab 标题 `ohbaby-agent`，`git branch` 正常 |
| 输入命令、中文、颜色 | 正常；`which node pnpm` 指向 Homebrew，登录 shell 生效 |
| 刷新网页 | tab 自动恢复，画面完整，持续输出的循环未中断 |
| 收起再展开面板 | 重新接回，可继续输入 |
| vim 运行中刷新 | 备用屏幕和已输入内容完整恢复 |
| 有程序在运行时关闭 | 弹出确认并显示程序名；取消保留，确认后 shell 与后台 `sleep` 均已退出 |
| 空闲终端关闭、键盘 Delete 关闭 | 直接关闭，不弹确认；焦点移到入口页 |
| shell 自己 `exit` | 显示退出码，tab 保留；同步后不被改写；关闭时不弹确认 |
| 页面外新建两个终端后获得焦点 | 自动补齐 tab，未切换选中项 |
| 第 17 个终端 | 右上角提示上限，不新增 tab |
| 双击新建 | 只建一个终端、一个 tab |

## 已知限制

- 自动化浏览器发出的组合键事件 `keyCode` 为 0，xterm 无法识别其中的 Ctrl+C；用标准键盘事件验证可正常发送 `\u0003`。真实键盘不受影响。
- 后续联合验收已通过页面启动真实 HTTP 服务，分别验证主动关闭和自然退出后进程结束、端口可重新绑定、登记表清空。
- Linux、Windows、macOS x64 未真机验收。Windows 的 `Path/PATH/path` shell 查找已补兼容和单元回归，但不等于 ConPTY 与后台清理已通过；这些平台的真实启动、关闭、复制／中断快捷键仍待专门验收。

## 跨包修正

web 新增 `@xterm/xterm` 后，pnpm 的提升会让 server 依赖的 `@xterm/addon-serialize` 类型解析到它，并把 DOM 类型库带进 server 的编译（`Response.json()` 等类型随之改变）。`packages/ohbaby-server/tsconfig.json` 把 `@xterm/xterm` 映射到只导出 headless 类型的 `src/terminal/xterm-headless-types.d.ts`，server 编译中不再出现 DOM 类型库。

## 联合验收与合并前修正（2026-11-04）

在隔离的真实 daemon 和编译后的 Web 页面上，使用内置浏览器及原生 Chrome 复核：

- 命令执行、中文和彩色输出、选区复制、输出链接在新标签打开。
- 持续运行的 HTTP 服务经过刷新、收起再展开后仍为原 PID；接回后可以继续输入。
- 忙时取消关闭保留服务；确认关闭及 shell 自然退出都能结束忽略 HUP 的后台程序，原端口可重新绑定，登记表删除记录。空闲关闭后名额可再次使用，其他终端仍能执行命令。
- Vim 备用屏幕和中文内容在刷新后恢复；桌面、320 像素面板和 390 像素窄屏未发现遮挡。实际 PTY 列数随面板宽度变化。
- 98,290 字节的中文、emoji、引号和反斜杠长粘贴，接收长度与 SHA-256 均一致。
- 页面身份、内容渲染及控制台检查正常，没有框架错误遮罩或相关错误／警告。

合并前独立审查补齐了四个前端问题，并为原先失败的场景补回归：同步恢复不抢聊天焦点；快照恢复完成前不发送尺寸；自然退出后的清理状态不抹掉已显示的退出码；面板受 CSS 限宽时，键盘调整从实际可见宽度开始。Windows shell 查找只补大小写兼容，未新增依赖或扩展架构。

临时测试脚本、隔离数据库与工作目录在复验后清理；真实测试未因依赖加载失败而跳过。必要的缺陷回归保留在现有测试文件中。

最终检查：

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | 657 个文件、7,659 项通过；另有 6 个文件、17 项仓库既有跳过项 |
| `pnpm build` | 全仓构建通过 |
| `pnpm run lint` | 0 错误，109 条既有警告 |
| 改动代码的 Prettier 检查、`git diff --check` | 通过 |
| 独立审查 | 前端、后端与 SDK 无剩余阻止合并项 |

修正后再次使用隔离 daemon 和编译后的页面复验：新建后焦点在终端，中文和彩色输出、工作目录正确；刷新后 shell PID 不变，仍可输入命令。将窗口缩窄，使面板记录宽度为 481、实际显示宽度为 432，再按一次右箭头，面板立即缩到 408，没有按键死区；聊天输入区与终端均可见。控制台未发现相关错误或警告。
