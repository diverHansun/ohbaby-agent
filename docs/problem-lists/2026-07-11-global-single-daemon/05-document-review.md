# 5. 文档自审、实施状态与方案对抗性检查

> 对 `00-discussion.md`–`04-test-and-acceptance.md` 的交叉审查与红队视角。日期：2026-07-11。

---

## 5.1 文档自审

### 5.1.1 完整性

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 讨论结论是否落入方案 | 通过 | 00 与 02 一致：Option B、双文件 registry、全局面板、TUI in-process、session loop 铺垫 |
| 现状是否有代码锚点 | 通过 | 01 列出 main.ts、create-app.ts、scope.ts、run-ledger |
| 改动面是否可执行 | 通过 | 02 按包拆分，含新增文件路径 |
| 测试是否对应风险 | 通过 | 04 覆盖 pid/state、InstanceStore、fail-closed scope、版本、legacy、双写、回归 |
| 参考项目是否可验证 | 通过 | 03 含 kimi/claude 本地路径 |
| 与 04-multi-project-runtime 冲突 | 通过 | 02 显式对齐 hono-app/04，08 标为过渡态 |

### 5.1.2 一致性问题（已修正或需实施时注意）

| 项 | 处理 |
|----|------|
| `database/goals-duty` G1 写「daemon 模式单写者」 | 改为：全机一个 serve、serve 内每 scope 一个 runtime；TUI+serve 是合法 SQLite 多写进程，同 session 靠 claim |
| `scheduler_job` 在目标态文档中存在但表已 drop | 明确为未来目标态；本批不恢复，loop 批次与 SchedulerStore 同 PR 落地 |
| `problem-lists/server` 陈旧 | README 已增加历史/superseded 顶注，当前契约指向本目录与 hono-app/04 |

### 5.1.3 遗漏项（非阻塞，已记入 00 §7）

- per-scope dispose 已确认本批不做；长期后台模式前再补资源 ownership 与回收策略。
- 端口策略已确认：4096 优先，冲突则 `port:0`；用户级 state 为端口真相源（2026-07-11）。
- `scheduler_job` 已确认本批不恢复 migration（2026-07-11）。

### 5.1.4 实施状态

| 阶段 | 状态 | 内容 |
|------|------|------|
| Phase 1a 基础纵切 | 已完成 | 用户级 pid/state、readiness、版本门禁、legacy 检测、InstanceStore、fail-closed routing、per-scope app 隔离、directory header、foreground 无 idle-exit |
| Phase 1b 面板与发布门 | 已完成 | known/loaded/switch UI、切换后 client/SSE 重绑、TUI+serve 双写集成、真实双进程单 listen、serve-awareness、`serve ps` / connections |
| Phase 2 | 未开始 | App 鉴权/CORS、per-scope 自动回收、全局面板高级体验 |
| Phase 3 | 未开始 | session 级 `/loop`、Scheduler、Heartbeat lane、`scheduler_job` migration |

---

## 5.2 对抗性检查（红队）

### 5.2.1 攻击面：「TUI 与 serve 并存 + 共享 DB」

**攻击**：用户同时在 Web 与 TUI 操作同一 session，导致重复 tool 执行、审批丢失、消息交错。

**防御（文档要求）**

- `claimPendingRun` 硬互斥（已有）。
- `owner_pid` + 孤儿恢复（已有）。
- 启动提示（已落地，且 CLI 轻量发现层不加载 server 包）。
- **残余风险**：claim 成功后一端崩溃，另一端在 recover 前仍可能 resume 同一 run 上下文；依赖 `recoverOrphanedRuns` 在下次 submit 前执行。**对抗性结论**：可接受，与 kimi 同 session 双进程类似，但 ohbaby 有 claim 更严。

**建议加强（可选，不阻塞 Phase 1）**

- Web 展示 session 时若存在 `running` 且 `owner_pid !== serve.pid`，显示「可能在终端中运行」。

### 5.2.2 攻击面：「两个 serve 进程」

**攻击**：用户级 pid/state 迁移错误，仍出现双 serve。

**防御**

- 沿用现有 `FilePidFile` 的 `O_EXCL` + ownership token；state 在 listen 后写入；health + packageVersion 校验；集成测试「第二 serve 不 listen」。
- **对抗性结论**：pid lock 必须是发布门；不得新造并行的单文件 lock 真相源。

### 5.2.3 攻击面：「InstanceStore 内存泄漏」

**攻击**：多 repo 切换导致 N 个 backend 永不 dispose，OOM。

**防御**

- 本批明确只做 `disposeAll()`，不声称 per-scope 自动回收。
- Phase 2 增加 scopes/连接数/资源观测，再设计 MCP、watcher、SSE 的单 scope ownership。
- **对抗性结论**：首版接受访问 scope 数增长；长期后台或 `/loop` 上线前必须补自动回收。

### 5.2.4 攻击面：「scope 解析错误」

**攻击**：`x-ohbaby-directory` 伪造路径访问他人 project session。

**防御**

- loopback + token auth；directory 仅映射 scopeKey，**不**绕过 `listByProjectRoot`。
- workspace 路由 fail-closed：缺 header/非法目录直接 400，无 query/cwd fallback。
- 本地威胁模型：同用户同机，与 kimi/opencode 一致。
- **对抗性结论**：远程 App 立项时需再加租户隔离（父目录 N4）。

### 5.2.5 攻击面：「恢复全局 backend lease」

**攻击**：实施者为省事恢复 `persistentUiBackendLease`，再次全局串行。

**防御**

- 00/02 明确禁止；04 回归确认 migration 已删。
- **对抗性结论**：PR review 必查。

### 5.2.6 攻击面：「/loop 与多 serve 遗留」

**攻击**：Phase 3 做 loop 时用户仍用旧脚本多 scope serve。

**防御**

- 文档废弃 Option A；`serve` 复用用户级 pid/state；保留一个版本 legacy 检测。
- **对抗性结论**：loop 上线前应加 doctor：`ohbaby serve status` 只能有一个实例。

### 5.2.7 对立方案再评估：TUI attach serve

**主张**：统一 coordination，消除双写。

**反驳（文档立场）**

- kimi/claude 未采用；增加 TUI 网络失败面；违背 ADR-001。
- 双写可用 claim 约束；实时协同非当前产品承诺。
- **结论**：维持 TUI in-process。

### 5.2.8 对立方案再评估：gateway + worker

**主张**：每项目子进程，崩溃隔离。

**反驳**

- SQLite 多写者；Scheduler IPC；参考项目未采用。
- **结论**：维持 Option B。

---

## 5.3 方案可证伪条件（若失败应回滚设计）

| 条件 | 信号 |
|------|------|
| lock 无法阻止双 listen | 集成测试失败 → 阻塞发布 |
| 双写测试可插入两行 active run | claim 回归 → 阻塞发布 |
| InstanceStore 导致默认 remote client 全断 | 契约测试失败 → 修 workspace routing/dispatcher 再发 |
| TUI 默认路径 import ohbaby-server | bin.ts 测试失败 → 违反 N2 |
| 缺 workspace header 仍落到某个 cwd | fail-closed 回归 → 阻塞发布 |
| packageVersion 不一致仍复用或自动 kill | 版本安全回归 → 阻塞发布 |
| 全局面板 repoA/repoB 串 session/SSE/permission | scope 隔离回归 → 阻塞发布 |
| foreground serve 无客户端后自行退出 | 生命周期语义回归 → 阻塞发布 |

---

## 5.4 审查结论

| 维度 | 判定 |
|------|------|
| 文档内部一致性 | Phase 1a/1b 已与代码、测试和手动 E2E 证据对齐 |
| 与已确认讨论对齐 | 通过；未改变双文件、fail-closed、无 idle-exit、session loop 等决策 |
| 双写预防 | claim 机制与真实跨进程同 session 集成测试均已落地；提示仅作感知层 |
| 风险可接受性 | TUI+serve 并存残余风险已披露，与 kimi 对齐且 claim 更强 |
| 建议 | Phase 1 发布门已关闭；后续按独立议题推进 Phase 2 资源治理与 Phase 3 session 级 `/loop` |

---

## 5.5 文档跟进状态

1. ✅ `hono-app/08` 已标为 v0.1.6 历史过渡态。
2. ✅ `docs/problem-lists/server/README.md` 已标为早期迁包/ADR 历史文档。
3. ✅ `docs/services/database/goals-duty.md` 已改为“进程内单连接、TUI+serve 合法多进程、事务 claim 保证业务不变量”。
4. ✅ `docs/ohbaby-web/goals-duty.md` 已记录 selected directory 与 `x-ohbaby-directory` 依赖。
5. ⏳ loop 批次恢复 `scheduler_job` 时，同步 `scopeKey + sessionId`、coalesced pending 与 migration 编号。
