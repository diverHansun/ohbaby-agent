# 04 · 多项目 runtime（反多后端的结构保证）

> 这是用户最在意的一条：`ohbaby serve` 绝不能重蹈 daemon「按 cwd 起一堆后台、不可管理」的覆辙。本文定义一个 server 如何**用单进程承载多项目**、如何**全局唯一可发现可停**，并把 G5「单写者」细化为「每 workspace scope 一个 backend」。
>
> 前置：[`01`](./01-app-assembly-and-transport.md)、`docs/problem-lists/daemon-workspace-scope/`（病根）、父目录 [`../goals-duty.md`](../goals-duty.md) G5。

---

## 1. 病根回顾（不要重蹈）

旧 daemon 的不可管理来自：**state/pid/workdir 默认绑 `process.cwd()`** → 不同目录启动自然得到不同 daemon →

```
C:\Users\X        daemon pid=7864
D:\Projects       daemon pid=36448
D:\Projects\repo  daemon stopped pid=29852
```

N 个 cwd = N 个后台进程 = 没人能统一查看/停止。修复必须保证：**project 是请求维度，不是进程维度**；**一台机器同一时刻一个 server**。

---

## 2. 三个项目的共同解法（复核结论）

| | 单进程多项目 | 全局发现/管理 |
|---|---|---|
| **opencode** | `serve` `instance:false` 不绑启动 cwd；每请求带 `x-opencode-directory` → 中间件 → `InstanceStore.load({directory})` **懒加载** per-directory instance；`disposeAll()` 回收 | 单 server |
| **kimi** | 默认 in-process 不开 server | **全局单锁** `~/.kimi-code/server/lock`（非 per-cwd）；`server status/stop`；`server ps` → `GET /api/v1/connections` 列连接 |
| **claude-code** | 单 server + in-memory store，session/env 按 id 路由 | 单 server |

ohbaby 采两者之合：**opencode 的请求级 workspace 路由 + kimi 的全局单锁 + ps**。

---

## 3. workspace 路由（project = 请求维度）

`middleware/workspace.ts`（[`01`](./01-app-assembly-and-transport.md) 管线第 4 步）：

```
请求 header: x-ohbaby-directory: <client 当前目录>
  → getProjectRoot(directory)   // 复用 packages/ohbaby-agent/src/project
      ├─ 命中 git root → scopeKey = git root（同 repo 任意子目录归一到此）
      └─ 非 git 目录   → scopeKey = canonical path
  → InstanceStore.load(scopeKey) → 注入 InstanceRef（该 scope 的 backend + coordination）
```

- `ohbaby serve` 启动时**不绑** cwd（对齐 opencode `instance:false`）；它是个多项目宿主。
- web/app 端在每个请求带 `x-ohbaby-directory`（或在 `POST /v1/clients` 建立时带，之后绑定到 clientId）。
- jsonrpc `/api/rpc`、`/v1/events` 一律经同一中间件解析 scope。

### scope 规则（落实用户选择：git-root 感知）

| 启动目录 | scopeKey | 同 backend？ |
|------|------|------|
| `repo/`、`repo/sub/a`、`repo/sub/b` | repo 的 git root | ✅ 三者共享 |
| `repo/`（git）vs `/tmp/scratch`（非 git） | git root vs canonical path | ❌ 各自独立 |

> 这是 `docs/problem-lists/daemon-workspace-scope` §5.2 当时被刻意留为产品决策的那条，现已定为 **git-root 感知**。复用既有 `project` 模块的 `getProjectRoot()`，语义＝「一个项目一个 runtime」。

---

## 4. InstanceStore 与生命周期

`instance/instance-store.ts`：

| 行为 | 语义 |
|------|------|
| `load(scopeKey)` | 已有则返回；无则**懒加载**：建该 scope 的 backend（`createPersistentUiBackendClient`）+ coordination（prompt-queue / permission-router / event-bus / client-view） |
| `dispose(scopeKey)` | 该 scope 无连接且空闲一段时间后回收（停 backend、清缓冲） |
| `disposeAll()` | server 停止时回收所有 scope |

每个 `WorkspaceInstance` = `{ scopeKey, backend, coordination }`，是该 scope 的**单写者**。

新增概念（更新到父目录 [`../data-model.md`](../data-model.md)）：
- **WorkspaceInstance**：一个 workspace scope 的 backend + 协调状态集合，按 scopeKey 隔离。
- **ServerRegistry**：机器级的「当前运行的 server」记录（见 §5）。

---

## 5. 全局单一 server（发现 / 管理 / 防重复）

`instance/lock.ts` —— **全局单锁，非 per-cwd**：

- 锁文件落 `~/.ohbaby/server/lock`（用户级，不随启动目录漂移），记 `{ pid, host, port, token, version, startedAt }`。
- `ohbaby serve` 启动前检查锁：
  - 锁存活且健康 → **不再起第二个**，打印「已有 server 在 `url`」并退出（或按 flag attach）。
  - 锁过期/不健康 → 抢锁、启动、写锁。
- 客户端发现：`ohbaby attach`、`serve status` 读全局锁定位唯一 server。

管理命令（CLI 层，对标 kimi）：

| 命令 | 行为 |
|------|------|
| `ohbaby serve` | 前台启动唯一 server，打印 url + token + 停止方式（G4） |
| `ohbaby serve status` | 读全局锁 + health，报运行状态/地址 |
| `ohbaby serve stop` | 停唯一 server，释放锁 |
| `ohbaby serve ps` | `GET /v1/connections` 列当前连接（clientId/连接时长/scope/订阅）——可观测，对标 kimi `ps` |

> 注意区分既有 `runtime/daemon/{state-file,pid-file}`：那是 **detached 降级抽屉**（N6，per-server 进程态）。本文的**全局锁**是「一台机器一个 foreground server」的发现机制，是 foreground 主路径的一部分，不是 detached 复活。

---

## 6. G5 细化（与父目录对账）

父目录 [`../goals-duty.md`](../goals-duty.md) G5：「后面只有一个 backend……单写者」。多项目宿主下细化为：

> **每 workspace scope 一个 backend、一个单写者**。跨 scope 是多个互不共享状态的 backend（由 InstanceStore 隔离），不是「网关聚合多服务」——依赖方向仍 `protocols → coordination → CoreApiHost`，仍无环，单写者不变量在每个 scope 内成立。

这不破坏 G5 的本意（「不做多服务聚合网关」），只是把「一个 backend」的量词从「全局」精确到「per scope」。指针更新见 [`00`](./00-scope-and-deltas.md) §4。

---

## 7. 顺手修 S8 / S9（Δ10）

| 缺陷 | 修法 |
|------|------|
| **S8** `__fresh__` lane 跨客户端串行 | lane key 改为 `(scopeKey, sessionId ?? clientId)`：不同客户端各自开新会话不再互相串行；同会话仍 FIFO |
| **S9** `disconnectClient` 空 stub | 断连时清该 client **已排队未启动**的 prompt；**已启动的不取消**（N3：不重复执行/扣费），并清其 permission/command 归属 |

---

## 8. 约束与权衡

| 决策 | 放弃的方案 | 代价 |
|------|-----------|------|
| 单 server 多项目（请求级路由） | 每项目一个 server 进程 | 单进程要管多 backend 生命周期；换来「一台机器一个可管理 server」，根除多后端 |
| 全局用户级锁 | per-cwd state 文件（旧 daemon） | 锁要处理过期/抢占；换来发现不随目录漂移 |
| git-root 感知 scope | canonical-cwd 隔离 | 同 repo 子目录共享 backend（多数时候是期望）；若想强隔离需另开非 git 目录 |
| 懒加载 + 空闲回收 | 启动即全量加载 | 首次访问某项目有冷启动；换来不为没人用的项目占内存 |

---

## 自检

- project 是请求维度而非进程维度？✅ §3。
- 一台机器是否保证单一可管理 server？✅ §5 全局锁 + status/stop/ps。
- G5 的细化是否与父目录显式对账？✅ §6 + 00 §4。
- S8/S9 有明确修法且不违反 N3？✅ §7。
