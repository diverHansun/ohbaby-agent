# 实施与验收记录

## 结论与范围

2026-09-29 在本地分支 `codex/web-run-process-collapse` 实施，基线为 `3dc4b72f`。用户明确要求本会话实施、测试、浏览器验收、子代理审查及分批提交，不创建 worktree，不合并或推送。

核心功能和已执行回归通过。Web 37 个测试文件、499 项测试通过，改动文件 ESLint、类型检查和构建通过；正式打包页面 E2E 与真实模型请求均已执行。触屏设备、200% 缩放及减少动态效果模式未做设备级实测，不能把窄屏结果等同于这些项目全部通过。

## 实际改动与规划对账

| 项目 | 实施结果 |
| --- | --- |
| 资格与归属 | `run-process.ts` 从当前 session 的既有 prompt/message 推导，不新增业务状态；同时检查成功、定稿、正文、steer 和可折叠过程 |
| 消息呈现 | 保持原顺序与 key，用 hidden 控制明确属于该 run 的过程；最终消息内只隐藏 reasoning，全部 text 保留 |
| Total | 移到最终正文前；有过程时为原生按钮，无过程时为普通文本，计时含义不变 |
| 视觉 | lucide 线条箭头，Thought 12px、整轮 16px、gap 8px；隐藏箭头保留位置，hover/键盘聚焦可见 |
| 交互 | 手动展开按 session/run 隔离；显式锚点先展开；折叠时迁移过程焦点和阅读位置，长行负偏移不传给 Total |
| reasoning 保留 | 前端 eventReducer 的旧 reasoning 事件路径在终态由清空改为折叠保留；snapshot 重建仍按既有瞬时状态语义清理，持久消息 parts 按原路径恢复 |
| 协议与依赖 | 后端、SDK、数据库、模型请求协议、TUI 和依赖均未修改 |

相对粗略文件清单，额外调整了前端 eventReducer：不修此处，旧事件路径在 run 结束时会把用户需要重新展开的内容清掉。根 ConversationStream 也增加本地阅读位置，复用原有滚动保护逻辑。二者均为本轮呈现所需的小范围变更。

规划 04 原本不安排新的收费模型调用；本次用户明确要求真实请求验收，因此使用已有隔离 smoke 环境及 `.env` 的环境变量引用执行。密钥未写入代码、截图或本文档。

## 测试证据

| 04 场景 | 结果与证据 |
| --- | --- |
| T1–T5 | unit 与 reducer→组件 integration 验证流式/定稿、事件先后顺序、空过程/空尾消息、混合 reasoning/text；真实 GPT 和 DeepSeek 请求完成后自动折叠 |
| T6 | unit 验证 failed/cancelled/interrupted；真实 DeepSeek 流式输出中点击 Stop，工具和已有正文保持可见，保留 interrupted 耗时 |
| T7–T9 | unit 验证 steer 消息与先到 receipt、普通 queued、未知归属、跨 session；本轮未额外做真实 steer 请求 |
| T10 | 两条 reasoning 呈现路径由组件与 reducer 回归覆盖；真实 DeepSeek 完成后展开 Thought，内容仍可读取 |
| T11 | 组件测试验证手动展开经 rerender/snapshot 保留；整轮状态按 session/run 键隔离；正式页面刷新后恢复默认折叠 |
| T12、T15 | 工具恢复通过 integration 和浏览器；原有工具、委派、SubagentView 回归全部通过。本轮未新增真实子代理派遣的浏览器请求 |
| T13 | 资格判断仅依赖已加载事实，未知消息不收；既有 session recovery/restore 集成测试通过，未额外手工造分页边界 |
| T14 | 既有 PromptDuration/App 计时回归通过，仅将成功正文相邻位置断言改为正文之前 |
| T16 | 显式定位、输入框焦点不被抢、长行负偏移有回归；真实长输出期间上滚可继续阅读，完成后仍保留阅读位置。单条长过程正处于视口中段时自动折叠由受控几何测试验证，未单独完成该时刻的浏览器截图 |

主要执行入口：

```sh
pnpm exec vitest run apps/ohbaby-web --maxWorkers=4 --minWorkers=1
pnpm --filter ohbaby-web build
pnpm build
node scripts/run-compiled-web-e2e.mjs
```

全仓库构建通过；最后的前端调整再次完成 Web 构建与 CLI 静态资源复制。ESLint 对本轮修改的 TS/TSX 文件运行，零错误、零警告。提交钩子另执行全仓库 lint/typecheck，均通过；全仓库 lint 有 93 条未改动文件中的存量 warning。未运行与此改动无关的全仓库模型/工具测试。

正式页面 E2E 使用真实编译 CLI、HTTP、工具执行及数据库，模型端为脚本可控 HTTP provider。浏览器确认工具完成、续问、刷新后两条最终回复各出现一次、会话稳定、无运行时标记；脚本返回 `E2E_UI_EVIDENCE_PASS`、`E2E_BACKEND_PASS`（3 次 agent 请求，工具结果已消费）、`E2E_CLEANUP_PASS`、`E2E_DIAGNOSTICS_PASS`。

真实 provider 验收使用 `tests/smoke/real-web-dev.ts --run --hold-read` 的隔离目录，分别运行 GPT 只读请求、DeepSeek reasoning 请求、手动停止和长输出请求。`--hold-read` 本次未形成可控停顿，不将其当成事件时序证据。确定性时序由 integration 测试覆盖。

## 视觉与审查

桌面实测 1100×800；窄屏 390×844，body 宽度 390，消息容器 scrollWidth/clientWidth 均为 324，没有横向溢出。实际 computed style 验证 Thought 12px、Total 16px、gap 均为 8px。鼠标点击时间、键盘 Enter/Space、展开后 Thought 内容可恢复均通过；图标无双 marker，键盘焦点可见。浏览器控制台检查无 error/warn。

- [桌面：两档箭头、键盘焦点和工具行](../assets/implemented-desktop.png)
- [窄屏：成功轮次收起与正文保留](../assets/implemented-narrow.png)

保留 8px 初始间距，未为几像素调整引入配置。后续可按用户视觉反馈微调。

子代理完成只读审查与复查。发现并修复：Thought 图标类名与 Composer 冲突；离开过程进入输入框后仍被旧焦点引用抢回；长过程负阅读偏移导致替代入口落在视口外。最后复查无新增阻断项，布尔判断显式区分缺失值，diff 格式检查通过。

SWE 评估：改动集中在 Web 呈现层，资格判断为单个纯函数，显示状态只存用户展开选择；没有复制消息 DTO、工具配对或后端生命周期。主要复杂度来自保持滚动与焦点，已有针对性回归。此次没有引入通用折叠框架或接口层，符合小改动范围。

## 重要文件与后续复核

- [run-process.ts](../../../../apps/ohbaby-web/src/ui/conversation/run-process.ts)：成功轮次与过程推导。
- [ConversationStream.tsx](../../../../apps/ohbaby-web/src/ui/conversation/ConversationStream.tsx)：控制入口、稳定隐藏、阅读和焦点。
- [MessageRow.tsx](../../../../apps/ohbaby-web/src/ui/conversation/MessageRow.tsx)、[ExecutionProgress.tsx](../../../../apps/ohbaby-web/src/ui/conversation/ExecutionProgress.tsx)、[messages.css](../../../../apps/ohbaby-web/src/ui/conversation/messages.css)：局部 reasoning、Total 按钮和线条箭头。
- [eventReducer.ts](../../../../apps/ohbaby-web/src/api/daemon/eventReducer.ts)：旧 reasoning 终态保留。
- 同目录 unit/integration 与 App/eventReducer 测试补充回归；[组件规格](../../../ohbaby-web/ui/components.md)和[测试说明](../../../ohbaby-web/test.md)同步。

设备专项待复核：无 hover 的真实触屏/模拟器、200% 缩放、减少动态效果；目前实现了对应 CSS，但没有这些设备模式的浏览器证据。历史缺少完成事实或明确 runId 时正常显示，不增加未知提示或后端补数。手动展开选择不跨整页刷新持久化。
