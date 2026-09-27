# improve-2.2 实施与验收记录

## 范围与结论

2026-09-27，在本地分支 `codex/improve-2.2` 实施。规划路径按约定保留在本目录 improve-2.1 和 [Web improve-3](../../../ohbaby-web/improve-3/README.md)，不另复制方案。基线为 `3ac9a6b3880e1228b3d80f0ef63b379acf789650`，接续原分支 `codex/improve-2-execution-progress`，同时收纳开始时已有的 31 个修改/未跟踪文件。初始文件、patch 和校验清单位于本机 `/tmp/ohbaby-improve22-baseline/`。

**代码实施、完整自动化测试、编译 Web 和默认 TUI 验收已完成，保留本地分支等待用户审查；未 merge、未 push。** T14 的 reduced-motion 真机仿真受锁屏限制未完成，不能把这一项记作浏览器实测通过。其他验证结果和既有样式限制分别记录如下。

最终产品代码及 runner 检查点为 `b5bf2794`。其后的提交仅补本文、索引与证据。环境：macOS arm64，Node `26.3.1`，pnpm `9.15.0`。验收依据为本轮 [02 阶段方案](02-optimization-plan-and-change-scope.md)、[04 唯一验收矩阵](04-test-and-acceptance.md)和 [Web 拆分规格](../../../ohbaby-web/improve-3/02-change-spec.md)。

## 分批交付

| 提交 | 结果 |
| --- | --- |
| `e9fdff57` | 收纳规划并补齐经审查确认的行为、准入、状态归属和验收合同 |
| `a5f679af` | 完整 New session 复用链路：权威空判断、客户端占用与保留期分离、创建/选择/提交保护、REST/RPC/in-process 接线及同步恢复 |
| `957dccc5` | 按功能提取 App 和 runtime，保持组件挂载位置与原实现；App 从 4864 行降至 137 行 |
| `42814ff5` | 收窄功能接口；草稿、租约、slash 状态归 Composer，异步结果校验 scope、generation、revision 和当前租约身份 |
| `06c411e2` | 修复 Tab 补全绕过草稿持久化和 edit revision 的遗漏 |
| `51f75c49` | 按原顺序归位样式、迁移 8 个测试、更新权威 Web 文档，并扩展编译 runner 的数据库判据 |
| `b5bf2794` | 补齐 `/new` 参数在真实命令 catalog 中的准入；修正 runner 对 macOS 实际项目路径的比较 |

New session 的“空”不再由标题或消息计数猜测，而是核对持久消息、run、全部 prompt 状态和会话关系。最后一条 SSE 断开时立即释放候选占用，路由清理仍保留原宽限；在途操作用 pin 保护。并发同策略请求共享操作，返回窗口冲突有界失败/重选，fresh-create 冲突不会再创建一条。`created` 只属于创建结果，不进入 session index 持久态。

Web 保留既有 store、client 和事件流。SessionScreen 负责组合，Composer 持有输入状态；TodoDock 和权限控件通过 slot 接入。没有新增状态库、通用 controller、事件总线或第二份草稿镜像。SessionScreen 与 Composer 仍保留各自连贯的交互流程，不为减少行数继续切成大量小文件。计时 hook 归入 `conversation/use-execution-duration.ts`，同步提示和 Stop 归入 `session/`。

## 自动化、审查与失败反馈

最终在 `b5bf2794` 的干净代码树上顺序执行测试和构建：

| 检查 | 实际结果 |
| --- | --- |
| `pnpm test` | **429 文件通过、6 文件跳过；4691 测试通过、17 跳过**，总计 435 文件 / 4708 项，184.72s |
| `pnpm build` | 成功；Web JS `index-ByVil5jG.js`，CSS `index-S1g-45RD.css` |
| `pnpm run lint`、`pnpm run typecheck` | 最后代码提交的 pre-commit 均通过，未跳过 hook |
| Web UI 回归 | 原 App 138 项全部保留，新增 10 项；Composer 3 项覆盖 prefill 身份/revision 和 Tab 补全，UI 共 253 项纳入全套 |
| 原测试迁移 | 8 个测试仅调整 import 路径，映射见 [Web test](../../../ohbaby-web/test.md#5-功能拆分后的测试归属)；App 跨功能流程继续留在根测试 |
| 机械提取检查 | S2 阶段 App 100 个顶层声明 AST 对照；runtime 类、factory 和 helper 保持原实现；45 个 Web 源码的本地 import 图（含 type import）无循环 |
| 样式顺序检查 | 源 CSS 482 rules / 1841 declarations / 19 at-rules 相同；编译 CSS 480 / 1834 / 19 相同，包含媒体条件和声明顺序；17 个原样式断言保留 |

17 个跳过项是已有的可选真实模型/外部服务用例和 2 个平台迁移用例。完整日志在本机 `/tmp/ohbaby-improve22-accepted-tests.log` 与 `accepted-build.log`（同前缀）；日志是本机留档，不承诺跨机器存在。本轮未改变 LLM 协议，按 04 使用受控 provider 验证接线，没有额外发起付费模型请求。

关键反馈均先复现再修复：

- 刷新旧 SSE 仍占用空 B 时，原用例实际返回另一 ID；保留[失败记录](evidence/2026-09-27/refresh-before-fix.txt)，最终同一判据通过。
- 原始异步 scope 用例 5 项失败、用户主动清空后的迟到恢复 1 项失败、租约 ABA/取消竞态 4 项失败，修复后全部进入 App 回归。独立审查提出的两处租约身份遗漏均限定复核关闭。
- Tab 补全先复现 `/sta` 在界面变成 `/status`、存储仍是 `/sta`，改走正常 `updateDraft` 后，持久化、revision 和旧回填拒绝均通过。
- 真实 TUI 暴露 `/new --no-reuse-empty-session` 被解析器拒绝。后端支持早已存在，catalog 漏了 `acceptsArguments`；新增真实 catalog + resolver 的三个 surface 用例先失败后通过，不再仅测试手工构造的 invocation。
- 首次并行启动全套测试与 build 争用了 `dist`；后续按顺序完整重跑成功。首次新 runner 的数据库比较误把 macOS `/var` 和 `/private/var` 当不同目录，真实路径规范化后从全新隔离环境复验成功，没有放宽会话数量或内容断言。

Pi 使用 `opencode/claude-opus-5-5`、`medium` 在 S3 边界只读给出建议，原文已在会话展示，未让 Pi 实施。采纳“保持局部 owner、避免新增 capture-handle 管理层”等建议；具体正确性由回归和原生子代理审查确认。S1、S2、S3、最终模块/样式和 TUI catalog 修复分别独立复核，最终无未关闭的 P1/P2。

## 浏览器与 TUI 实测

使用原生 Chrome 控制和本次编译的 `serve`，隔离 profile、workspace、SQLite、provider 和进程。runner 命令为：

```sh
node --no-warnings scripts/run-compiled-web-e2e.mjs --new-session-regression
```

最终 A 为 `session_1790484399036_awidpu1`，B 为 `session_1790484408960_itd3yk1`。初始 DB 为 0；从已使用 A 创建 B 后，六次顺序 New、切 A 后 New、三次刷新后切 A/New 均保持 B。三次刷新到复用完成为 **787 / 783 / 679ms**，都在 5s 保留窗口内。每次 ID 与时间保留在[浏览器观察](evidence/2026-09-27/new-session.json)，精确双 SSE、pin、timer 和 client 生命周期由真实网络集成覆盖；未把最终数据库快照冒充这些竞态的全部证据。

runner 直接只读 SQLite：最终只有两个 active root、没有 child；A 为 5 messages / 2 runs / 2 prompts，B 三者均 0。没有归档/删除来掩盖多建会话。两条用户输入与两次最终响应刷新前后各出现一次，工具 read 的实际结果进入下一次模型请求，标题不含内部 runtime 标记。受控 provider 收到 3 次主请求和 1 次独立标题请求。见[完整 runner 结果](evidence/2026-09-27/compiled-web.txt)。runner 退出 0，服务 PID/端口已释放，诊断检查通过。

浏览器另实测 Tab 补全刷新保存、Compact 弹窗、权限确认 Tab 焦点循环及 Escape 回焦、Open project 目录选择器打开/关闭。未点击授予 full-access。1360px 桌面下 App/Composer/textarea 的 display、position、font、color、padding、radius 与旧页面计算样式相同；阶段性同视口 1360×691 检查通过，最终截图视口为 1360×742。390×843 窄屏下长草稿可换行并内部滚动，输入框宽 277px、scrollWidth 277px，高 154px、scrollHeight 814px；临时视口已恢复。最终控制台错误为 0。

默认编译 TUI 使用独立 PTY 和另一隔离配置，未指定远程连接，也未启动 daemon：初始 0 → `/new` 后 1 → 再次 `/new` 仍为同一 ID → force-new 后 2 个不同 ID。消息/run/prompt 全为 0，空画布正常，Ctrl-C 退出 0。见 [TUI SQLite 证据](evidence/2026-09-27/tui.json)。

| 合同 ID | 验收落点 |
| --- | --- |
| T01 | 初始 manifest/patch、原测试基线 36 文件 / 510 项、分支及分批提交 |
| T02–T04 | `new-session-regression.integration.test.ts`、`tests/integration/web/new-session-lifecycle.integration.test.ts`；浏览器与 SQLite 复验 |
| T05–T07 | SDK/adapter/command/coordinator/REST/RPC 回归、权威 store、受控准入竞争；默认 TUI 参数入口 |
| T08、T13 | 同 scope 恢复、workspace/client/session/permission integration；SSE reader 取消/解锁回归 |
| T09–T12 | 原 App 接线及新增异步回归、Composer、conversation、permissions 与 Stop 用例；浏览器操作抽查 |
| T14 | CSS 源/产物、桌面计算样式、窄屏/焦点通过；reduced-motion 真机仿真未完成 |
| T15、T17 | 迁移映射、断言/AST/import 检查、完整测试/构建/lint/typecheck、独立审查 |
| T16 | 最终 compiled Web runner 退出 0，默认 compiled TUI PTY 复验通过 |

## 剩余限制与交接

- 锁屏阻止 Chrome 原生菜单控制，无法开启 reduced-motion 媒体仿真。既有 media 规则和 Typewriter reduced-motion 单测保留并通过，但不能替代该项真机检查。当前实际浏览器媒体值为 `false`。
- 窄屏下很长的连续无空格标记仍可能横向裁切，这是保留下来的原样式行为。本轮 CSS 源/编译序列完全不变，未混入视觉重设计；截图保留现状以便后续单独处理。
- 准入保护限于本进程 backend/server；不是多进程共享 SQLite 的分布式独占锁。全局 admission revision 在无关操作并发时可能保守返回可重试冲突，这是当前正确性优先的边界，未增加复杂的逐会话事务协调层。
- 一次未隔离的 CLI `--help` 触发既有启动迁移检查并更新用户目录的迁移标记；只核对文件元数据，`model.json` 及已有冲突备份均未变化，未读取/输出配置正文。之后的 Web/TUI 验收全部隔离，未清理或回滚用户配置。

本轮的架构收益是让变化集中到所属功能，而不是文件数本身：输入状态、消息展示、命令表单、权限交互各有实际 owner；接口只传需要的数据/能力；异步保护与状态放在同一处；CSS 迁移尊重级联语义。后续中央 improve-3 可基于这些边界继续接线，不应重新把整份 runtime/ViewModel 注入叶组件。

桌面与窄屏证据：

![最终桌面，两条会话与完整消息恢复](evidence/2026-09-27/desktop.png)

![390px 窄屏长草稿](evidence/2026-09-27/narrow-long-draft.png)
