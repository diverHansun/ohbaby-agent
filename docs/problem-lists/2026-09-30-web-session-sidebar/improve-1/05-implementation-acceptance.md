# 实施验收

## 元信息

2026-09-30；分支 `codex/web-session-sidebar`，基线 `b13c9376`，用户已授权提交、合并至本地 main 并删除临时分支。
结论：本轮 Web 侧栏范围通过代码与受控浏览器验收，用户完成视觉反馈并授权合并；未操作用户真实会话的归档。

## 与方案对照

| Stage | 实际实现 | 证据 |
|---|---|---|
| 1 偏好 | `session-pins.ts` 独立 store，origin/项目 key，后 pin 优先，同页失败缓冲、跨标签页同步 | 16 项单元测试 |
| 2 行/菜单 | SessionRow、SessionActionsMenu；hover …/右键共享；左侧实心 pin 可 Unpin；archive 返回 boolean | 7 项侧栏组件测试，App 172 项回归 |
| 3 动效/样式 | sidebar.css 局部变量；WAAPI 重排及溢出标题；菜单 portal/翻转/边缘限制 | [浏览器验收](frontend/09-implementation-acceptance.md) |
| 4 审查 | 文档自检、独立子代理、Pi 设计审查、代码复审 | 下述发现已修复；用户已授权合并 |

## 实际调整

- 偏好用独立 store + useSyncExternalStore，未额外增加仅转发的 hook 文件，减少间接层。
- 存储审核发现读失败而写成功可能覆盖未知记录：实际用按 ID 的待保存修改，读取失败不写，读取恢复后与最新值合并；写失败仍保留本页结果。不是额外的跨设备同步系统。
- 标题滚完取消右缘淡出，保证末尾可完整阅读；速度维持恒速，不采用 Pi 提议的强制十秒上限。
- 菜单内边距实际 4px、宽 176px、高 74px、圆角 9px，与参考项目比例一致。
- App 回归测试从原生 title 定位改为 accessible name/文字定位，因为用户明确移除挡标题的 Select tooltip。

## 测试与审查

Vitest：`SessionSidebar.unit.test.tsx` 7/7、`session-pins.unit.test.ts` 16/16、`App.unit.test.tsx` 172/172，共 195 项。
提交前全量 `pnpm test`：479 个测试文件通过、6 个跳过；5360 项通过、17 项跳过。
Web `typecheck` 与 `build` 通过；改动 TS/TSX ESLint 通过，格式与 diff 空白检查通过。
已有测试在 Node 环境报告 localStorage experimental warning（App fake runtime 环境）；没有失败断言，真实浏览器无相关警告/错误。

子代理审查提出的两项 P2 已通过先失败后通过的回归验证：
1. 归档 Promise 先成功、索引后移除时焦点掉到 body：改为监听实际移除，只在同 scope 且用户未转移焦点时回下一行/New session。
2. 后台重排让菜单停旧位置、暂空恢复后菜单自动重开：有序 ID 改变就清除菜单状态。
复审未发现阻断验收的显著缺陷。
Pi `github-copilot/claude-sonnet-5.5` / high 已审核前端设计。完整原文在本聊天展示，未把模型原文作为未经核实的事实报告入库。

## SWE 评估与边界

改动限定 Web UI、浏览器偏好和只读 serverUrl 标识，SDK/server/core/TUI 无改动；会话数据仍走原链路。动画与存储分离，没有新增依赖、通用菜单注册或新网络协议。局部复杂度来自真实的焦点、异步索引与存储失败场景，测试覆盖这些边界。
跨标签页严格同时修改仍按最后写入者胜；不同浏览器/origin 不同步；Safari/Firefox 和手机触控专项未验。本轮没有实际 LLM 对话或服务端恢复入口验收，相关功能不在范围内。

## 主要文件

- `apps/ohbaby-web/src/ui/session/SessionSidebar.tsx`：列表装配、菜单目标、归档后焦点。
- `SessionRow.tsx` / `SessionActionsMenu.tsx` / `use-session-reorder.ts` / `sidebar.css`：交互、动效与样式。
- `session-pins.ts`：本地偏好与排序。
- `SessionScreen.tsx` / `apps/ohbaby-web/src/runtime.ts`：成功回执与服务标识。
- 同目录测试、`ui/App.unit.test.tsx`、UI 文档权威链接已同步。
