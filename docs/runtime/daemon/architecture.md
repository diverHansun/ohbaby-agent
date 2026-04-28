# daemon 模块 architecture.md

本文档描述 `runtime/daemon` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

daemon 是**装配层**，内部结构围绕"初始化顺序"和"关闭顺序"展开。它不包含业务逻辑，只做依赖注入和生命周期协调。

```
┌──────────────────────────────────────────────────────────────────┐
│ Supervisor（进程级生命周期管理）                                    │
│                                                                  │
│ 职责：                                                           │
│ - 进程单例保护（pid 文件 + 文件锁）                               │
│ - 按依赖顺序初始化所有子系统                                       │
│ - 监听 SIGTERM / SIGINT，按反向顺序关闭子系统                      │
│ - 维护 state 文件（running / stopping / crashed）                 │
│ - 写 daemon.log 进程级日志                                        │
└──────────────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
┌──────────────────────┐     ┌────────────────────────────┐
│ Bootstrap（装配层）   │     │ app-events.ts（内部文件）   │
│                      │     │                            │
│ 职责：               │     │ 职责：                     │
│ - 构建 RunDefaultsPolicy   │ - 订阅 app 级 Bus 事件      │
│ - 按顺序创建子系统实例│     │ - 翻译为 StreamBridge       │
│ - 注入依赖关系        │     │   app.* 事件               │
│ - 返回 dispose 函数   │     │ - 返回 dispose() 供关闭    │
└──────────────────────┘     └────────────────────────────┘
```

### 初始化顺序（依赖拓扑）

```
database
profileRegistry
runDefaultsPolicy (← config + profileRegistry validation)
runLedger         (← database)
sandboxManager
streamBridge
hookExecutor
taskManager       (← sandboxManager, storage/database as needed)
scheduler         (← database, bus)
runManager        (← streamBridge, runLedger, hookExecutor, sandboxManager, profileRegistry, RunDefaultsPolicy)
heartbeat         (← runManager, scheduler, bus)
appEvents         (← bus, streamBridge)
```

这份顺序是装配顺序，不表示模块层级。`scheduler` 与 `runManager` 都依赖已经初始化的基础设施，但二者彼此不直接依赖；它们通过 `heartbeat` 和 Bus 事件协作。

### 关闭顺序（反向）

```
heartbeat.stop()
scheduler.stop()
runManager.cancelAll()
taskManager.stopAll()
appEvents.dispose()
streamBridge.close()
database.close()
pidFile.release()
```

### 主要组件

| 组件 | 职责 |
|---|---|
| **Supervisor** | 进程单例保护、信号监听、state 文件、日志 |
| **Bootstrap** | 子系统装配、RunDefaultsPolicy 构建、依赖注入 |
| **app-events.ts** | daemon 内部文件，app 级 Bus 事件 → StreamBridge 翻译 |

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. Composition Root（装配根）

Bootstrap 是整个进程的 Composition Root：所有子系统在这里被创建并注入依赖，不使用全局单例或服务定位器。

**使用理由**：
- 依赖关系在一个地方可见，初始化顺序错误会在编译期或启动时立即暴露
- 测试时可以创建不同的 Bootstrap 配置（如 CLI in-process 模式、测试模式），不需要 mock 全局状态

**不使用 IoC 容器的理由**：
- 子系统数量有限（约 8 个），手动装配的代码量可控
- IoC 容器引入额外依赖和学习成本，YAGNI

### 2. Facade（Supervisor）

Supervisor 对外提供 `start()` / `stop()` 两个接口，隐藏内部的初始化顺序、信号处理、pid 文件管理等细节。

**使用理由**：
- 进程入口（`main.ts`）只需要调用 `supervisor.start()`，不需要了解内部装配细节
- 优雅退出逻辑集中在 Supervisor，不分散到各子系统

### 3. app-events.ts 作为内部文件而非独立模块

`daemon/app-events.ts` 是 daemon 的内部实现文件，不作为独立 runtime 子模块。

**使用理由**：
- 当前翻译逻辑简单（Bus 事件 → bridge.publish），不需要独立测试矩阵
- 升级条件已在 goals-duty.md 中明确：超过约 100 行、需要独立测试、或被 server/SDK 复用时，再提升为 `runtime/app-event-bridge`

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/runtime/daemon/
├── index.ts              # 公共接口：导出 Supervisor 类
├── supervisor.ts         # Supervisor 类：进程单例保护、信号处理、state 文件、日志
├── bootstrap.ts          # Bootstrap 函数：子系统装配、RunDefaultsPolicy 构建
├── app-events.ts         # 内部文件：app 级 Bus 事件 → StreamBridge 翻译
├── pid-file.ts           # PidFile 工具：pid 文件读写和文件锁
├── state-file.ts         # StateFile 工具：daemon state 文件读写
└── __tests__/
    └── supervisor.test.ts
```

### 各文件职责

| 文件 | 定位 | 说明 |
|---|---|---|
| `index.ts` | 公共接口 | 仅导出 Supervisor |
| `supervisor.ts` | 进程管理 | 单例保护、信号监听、state 文件、日志；调用 bootstrap |
| `bootstrap.ts` | 装配逻辑 | 创建所有子系统实例，构建 RunDefaultsPolicy，返回 dispose 函数集合 |
| `app-events.ts` | 内部翻译 | 不对外导出；只被 bootstrap.ts 调用 |
| `pid-file.ts` | 工具 | 跨平台 pid 文件和文件锁，可独立测试 |
| `state-file.ts` | 工具 | state 文件读写，可独立测试 |

### 对外稳定接口 vs 内部实现

- **对外稳定**：`Supervisor` 的 `start()` / `stop()` 接口
- **内部实现**：bootstrap 装配顺序、app-events 翻译逻辑、pid 文件格式

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 1. 初始化顺序是硬编码的

bootstrap.ts 中的初始化顺序是显式的顺序代码，不是依赖图自动推导。

**代价**：新增子系统时需要手动确定插入位置。但对于当前规模（约 8 个子系统），显式顺序比自动推导更易理解和调试。依赖图自动推导（如 topological sort）是过度工程。

### 2. 关闭超时兜底

优雅退出设置 10 秒超时，超时后强制 `process.exit(1)`。

**代价**：强制退出可能导致某些子系统未完成清理（如 run-ledger 的最后一次写入）。这是可用性优先于完整性的取舍：卡死的进程比不干净的退出危害更大。

### 3. 放弃的方案：daemon 作为独立进程（fork 模式）

可以让 daemon 以 fork 子进程的方式运行，父进程作为监督者。这样父进程可以检测子进程崩溃并自动重启。

**放弃理由**：自动重启由系统级工具（systemd / pm2 / launchd）承担，daemon 不做进程监督器。fork 模式引入了 IPC 通信复杂度，且与"单一进程写 SQLite"的约束冲突。
