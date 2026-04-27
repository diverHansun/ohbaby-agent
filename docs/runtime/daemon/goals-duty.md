# daemon 模块 goals-duty.md

本文档定义 `runtime/daemon` 模块的设计目标与职责边界。

---

## 一、Design Goals（设计目标）

### 1. 提供进程级的供养能力，与业务逻辑完全解耦

daemon 不理解"agent"是什么，不知道"scheduler"在做什么，不关心"run"有没有在跑。它只负责一件事：让 ohbaby-agent 进程能在后台长期稳定运行，并在异常退出后具备可见性与可恢复的基础设施。

### 2. 确保同一时刻只有一个 ohbaby-agent 进程在运行

通过 pid 文件和文件锁防止重复启动。多实例并发会导致 session storage 冲突、event bridge 端口冲突等难以调试的问题。

### 3. 提供优雅退出与崩溃后的状态可见性

daemon 在收到退出信号（SIGTERM / SIGINT）时协调各子系统有序关闭。崩溃后，state 文件保留上次运行状态，供下次启动时的崩溃恢复逻辑使用。

---

## 二、Duties（职责）

### 1. 进程单例保护

负责：
- 启动时写入 pid 文件（含 pid 和启动时间戳）
- 获取跨平台文件锁，防止重复启动
- 检测到已有进程时，提供"连接已有实例"而非"拒绝启动"的选项

### 2. 子系统的初始化与持有

负责：
- 按依赖顺序初始化并持有以下实例：
  - `sandbox`（SandboxManager / adapter registry）
  - `runtime/stream-bridge`（InMemoryStreamBridge）
  - `runtime/run-manager`（RunManager）
  - `runtime/scheduler`（Scheduler）
  - `runtime/heartbeat`（HeartbeatMachine）
  - `runtime/tasks`（TaskManager）
  - `runtime/hooks`（HookExecutor）
  - app-event adapter（将 app 级 Bus 事件翻译为 StreamBridge 的 `app.*` 事件）
- 将实例注入到各子系统中（依赖注入，不使用全局单例）
- 负责把 SandboxManager 注入 run-manager、tasks 等需要执行上下文的子系统

### 3. 优雅退出

负责：
- 监听 SIGTERM / SIGINT 信号
- 按相反顺序关闭子系统（先停 scheduler / heartbeat，再取消所有 run，再关闭 bridge）
- 退出前清理 pid 文件和文件锁
- 设置超时兜底（默认 10 秒）：超时后强制退出，避免卡死

### 4. state 文件维护

负责：
- 记录 daemon 的运行状态（running / stopping / crashed）到 state 文件
- 进程正常退出时更新 state 为 `stopped`
- state 文件由 `runtime/run-manager` 的崩溃恢复逻辑在启动时读取

### 5. 日志基础设施

负责：
- 将进程级日志（启动、退出、信号、崩溃）写入 daemon.log 文件
- 不负责业务日志（run、tool call、model response）的格式或内容

---

## 三、Non-Duties（非职责）

### 1. 不负责业务逻辑

daemon 不知道 session、run、task 是什么。所有业务判断（是否启动新 run、是否触发 scheduler）由对应子系统自行决定。

### 2. 不负责崩溃后的自动重启

daemon 是进程级管理者，但不是进程监督器（supervisor）。崩溃后的自动重启（如果需要）应由系统级工具（systemd / pm2 / launchd）承担，daemon 只负责记录崩溃状态。

### 3. 不负责远程控制接口

daemon 不提供 HTTP API 或 RPC 接口供外部查询进程状态。这类接口由 `interfaces/server` 负责。

### 4. 不负责子系统的具体实现

scheduler、heartbeat、run-manager 的实现逻辑各自负责。daemon 只做"创建实例、注入依赖、协调关闭"，不内嵌业务代码。

### 5. 不负责配置加载

ohbaby-agent 的全局配置加载由 `config` 模块负责。daemon 使用已加载的配置对象，不直接读取配置文件。

### 6. 不负责执行环境策略本身

daemon 只负责装配 SandboxManager 与 adapter registry，不决定某个 session 应该使用原始目录、worktree 还是容器，也不实现这些后端逻辑。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `runtime/run-manager` | 持有并初始化 | daemon 创建 RunManager 实例并在关闭时协调取消所有 run |
| `sandbox` | 持有并初始化 | daemon 创建 SandboxManager 并注入到 run-manager、tasks 等子系统 |
| `runtime/stream-bridge` | 持有并初始化 | daemon 创建 StreamBridge 实例，注入到 run-manager |
| `runtime/scheduler` | 持有并初始化 | daemon 创建 Scheduler 实例并在退出时停止 |
| `runtime/heartbeat` | 持有并初始化 | daemon 创建 HeartbeatMachine 实例并在退出时停止 |
| `runtime/tasks` | 持有并初始化 | daemon 创建 TaskManager 实例并在退出时停止后台任务 |
| `runtime/hooks` | 持有并初始化 | daemon 创建 HookExecutor 并注册内置 runtime hook |
| app-event adapter | 持有并初始化 | daemon 负责 app 级事件的 Bus → StreamBridge 翻译，不让 scheduler 直接接触 bridge |
| `config` | 依赖 | 读取已加载的配置对象（工作目录、pid 文件路径等） |
| `interfaces/server` | 无直接依赖 | server 是独立进程或 daemon 的一个子服务，不由 daemon 内部管理 |

---

## 五、模块边界示例

### 5.1 职责内的示例

正确：daemon 按顺序初始化子系统
```typescript
// daemon/supervisor.ts 负责
const sandboxManager = new SandboxManager({ adapterRegistry, projectService })
const bridge = new InMemoryStreamBridge()
const hookExecutor = new HookExecutor()
const taskManager = new TaskManager({ sandboxManager })
const runManager = new RunManager({ bridge, sessionStorage, hookExecutor, sandboxManager })
const scheduler = new Scheduler({ bus })
const heartbeat = new HeartbeatMachine({ runManager, scheduler })
const appEvents = new AppEventAdapter({ bus, bridge })
```

正确：daemon 处理退出信号
```typescript
// daemon/supervisor.ts 负责
process.on('SIGTERM', async () => {
  await heartbeat.stop()
  await scheduler.stop()
  await runManager.cancelAll()
  await bridge.close()
  pidFile.release()
  process.exit(0)
})
```

### 5.2 职责外的示例

错误：daemon 不应包含业务判断
```typescript
// 错误：不应该在 daemon 中
if (scheduler.hasDueJobs()) {
  runManager.create({ trigger: 'scheduler', ... })
}

// 正确：由 scheduler 或 heartbeat 自行决定触发
```

错误：daemon 不应直接操作某个 session 的 sandbox 细节
```typescript
// 错误：不应该在 daemon 中
await dockerAdapter.exec(sessionId, command)

// 正确：daemon 只负责装配 sandbox 子系统，不执行具体后端逻辑
```

---

## 六、文档自检

- 可以用一句话说明该模块的存在意义：daemon 是 ohbaby-agent 的进程级供养层，负责单例保护、子系统初始化、优雅退出和崩溃状态记录，并装配 sandbox 等运行基础设施
- 能清楚回答"这个模块不该做什么"：不做业务判断、不做自动重启、不做远程控制、不做配置加载、不实现子系统后端逻辑、不决定执行环境策略
- 职责与其他模块无明显重叠：sandbox（执行环境）、run-manager（运行台账）、scheduler（时间触发）、heartbeat（状态机）、interfaces/server（远程接口）边界清晰
