# ohbaby-server · test（测试设计）

> 围绕职责与交互边界验证，不围绕代码结构。前置：[`goals-duty.md`](./goals-duty.md)、[`dfd-interface.md`](./dfd-interface.md)、[`use-case.md`](./use-case.md)。
>
> **项目级测试规则现状**：仓库**尚无**正式 test-blueprint 文档，但有事实约定——测试 colocated 于源文件旁，三级命名 `.unit.test.ts` / `.integration.test.ts` / `.e2e.test.ts`，root `vitest`。本模块遵循该约定。**建议后续用 `test-blueprint` skill 补一份项目级规则**，本文按现有约定先行。

---

## 1. Test Scope（测试范围）

**覆盖**（本包职责）：
- 传输与路由（auth/CORS 中间件生效、jsonrpc/web 路由可达）。
- 协议适配（信封解析、RPC 请求-响应正确）。
- 多客户端协调（事件打号、SSE replay、审批路由、prompt FIFO）。
- remote client ↔ server 契约一致性。
- foreground 生命周期（启动打印 address/token、Ctrl+C 优雅关闭）。

**不覆盖**（外部职责）：
- agent run 实际执行、工具调用、持久化正确性（属 `ohbaby-agent`）。
- local/remote 模式选择逻辑（属 agent 的 core-api-factory）。
- UI 渲染（属 cli/web 前端）。
- detached 后台常驻细节（降级抽屉，仅冒烟级）。

---

## 2. Critical Scenarios（关键场景，不可接受失败）

| 场景 | 预期结果 |
|------|---------|
| 正常 RPC 往返 | 经鉴权的 RPC 调用得到正确结果信封 |
| **SSE 断线重连补发** | 带 `Last-Event-ID` 重连后，收到 `(id, now]` 区间全部事件，无缺、无重复、有序 |
| **重连早于缓冲窗** | 返回明确"需全量重同步"信号，绝不静默丢（核心正确性） |
| auth fail-closed | token 缺失/错误一律拒绝，绝不放行 |
| CORS 白名单 | 白名单内 origin 放行，非白名单预检被拒 |
| 审批路由 | 审批事件只投发起方 client，不广播给其他 client |
| prompt FIFO | 同 session 多 prompt 严格按序执行 |
| 优雅关闭 | Ctrl+C 后端口释放、连接收尾、无残留 |

---

## 3. Integration Points（集成点）

| 集成对象 | 验证重点 | 失败时预期 |
|---------|---------|-----------|
| agent backend（`createPersistentUiBackendClient`） | 本包能正确驱动真实 backend 并回流 UiEvent | backend 错误以 RPC 错误信封返回，不崩 server |
| remote client ↔ server | 二者在 `UiBackendClient` 契约上行为一致 | 契约偏差应被契约测试捕获 |
| 多客户端并发 | 两个 client 各自订阅/审批/排队互不串扰 | 隔离失效即测试失败 |
| in-process vs http 两条路径 | 同一 `UiBackendClient` 契约下行为等价 | 行为分叉即失败 |

> **契约测试参数化**：建议把 `UiBackendClient` 契约测试套件参数化，同一套用例分别跑 in-process 与 http 两种 driver——保证迁移前后、两条路径行为一致（呼应文档 04 风险缓解）。

---

## 4. Verification Strategy（验证策略）

- **单元（`.unit.test.ts`）**：event-bus 序号/缓冲淘汰/replay 区间计算、auth fail-closed + 常量时间、CORS 判定、prompt-queue lane 顺序、permission-router 归属——这些纯逻辑用真实实现、不需网络。
- **集成（`.integration.test.ts`）**：启动真实 server（绑随机端口）+ 真实 backend，用 remote client 跑完整 RPC/SSE/replay/审批/FIFO 流程。沿用现有 `server.integration.test.ts` / `client.integration.test.ts` 迁移并扩充。
- **mock 边界**：只在需要制造"断线/弱网/缓冲淘汰"等难复现场景时 mock 传输层；backend 尽量用真实实例（领域真相不该被 mock 掩盖）。
- **回归红线**：
  - `docs/problem-lists/terminal-daemon/` 的终端闪烁修复不得回退。
  - `docs/problem-lists/sessions-ui-backend/` 的 session 切换修复不得回退。
  - 默认 CLI（in-process）路径不得因本包变更被拖入 server 依赖。
- **人工验证**：`npm pack` + 本机全局安装，分别验证默认 `ohbaby`（不建 daemon 状态）与 `ohbaby serve`/`attach` 两条路径。

---

## 自检

- 关键职责都有验证场景？✅ §2 覆盖传输/协议/协调/生命周期。
- 外部交互失败预期明确？✅ §3 backend 错误、契约偏差、隔离失效。
- 是否绑定实现细节？否——按行为与契约描述，不绑类名。
- 待补：项目级 test-blueprint（建议后续单独立项）。
