# ohbaby-web · non-functional（非功能约束）

> 让功能之外、但决定工程质量的约束前置显性化。只写对本模块真正重要的少数几项，不写通用最佳实践清单。
>
> 前置：已了解 web 的调用场景（同源、本地、流式）与依赖（daemon `/v1`）。

---

## 1. Quality Priorities（质量优先级，有先后）

1. **流式渲染流畅 > 功能丰富**：高频 `message.part.delta` 必须无卡顿——这正是选 `useSyncExternalStore` 精准订阅、不用 Context 广播的原因（见 architecture §4）。
2. **安全（本地可信但不放任）> 便利**：token 只存内存、不进 localStorage/URL；agent/工具输出渲染须防 XSS。
3. **轻量产物 > 生态堆叠**：bundle 要小到能被 daemon 同源轻量伺服——因此不上 SSR/路由框架。

---

## 2. Operational Constraints（运行约束）

- 同源、localhost 优先；不引入会显著增重的依赖。
- 单次 SSE 增量渲染不得阻塞输入框交互（发话/中断随时可点）。
- reconnect 退避有上界，不得无限紧循环空转。
- 构建依赖 server 的 `openapi.json`（生成 `wire.ts`）——构建期接线，不在运行时引入对 server 源码的依赖。

---

## 3. Reliability & Observability（可靠性与可观测性）

- **不静默失败**：`401` / `403` / 网络错都要在 UI 可见（状态条 / 通知）。
- **异步状态可区分**：ConnectionState 五态 + run 的 idle/running/interrupted 必须对用户可见。
- **输出渲染安全**：agent/工具输出按 **markdown 渲染 + 消毒**（如 DOMPurify）防 XSS；语法高亮（如 shiki）列入暂缓。
- **命令输出安全**：slash 命令的 markdown/text/data 输出走与消息相同的安全渲染或保守文本格式化；不得直接注入 HTML。
- **诊断信息不进 UI（简洁优先）**：`seqNum / clientId / lastEventId / 端口` 是开发者信息，不在界面呈现；正确性（基线对齐、续传、resync）在内部强制执行，对用户只通过 **ConnectionState 五态** 可见，开发者从 devtools/console/日志查看。见 [`ui/states.md`](./ui/states.md) §5。
- v0.1.6 可观测性止于"用户可见的状态与错误"——不做指标 / trace 上报。

---

## 4. Trade-offs & Deferred Requirements（权衡与暂缓项）

刻意暂缓（非遗漏）：

- **重型语法高亮（shiki 等）**：先 markdown+消毒保证安全与基本可读，观感优化后置。
- **i18n、深度 a11y、移动端适配、多标签页同步、离线**：v0.1.6 不做。
- **完整 slash command panel**：候选列表、Tab 补全、分页、交互式 command panel 后置；v0.1.6 只保留文本 slash passthrough。
- **长会话性能优化（虚拟滚动等）**：先正确，量大再优化，避免过早优化。
- **远程/多用户鉴权升级**：N4，远程 app 立项再做（ND6）。

> 这些是刻意延后，不是缺陷。其中"安全优先"与"轻量优先"会直接约束 architecture 的依赖选择，不可在实现期悄悄反转。
