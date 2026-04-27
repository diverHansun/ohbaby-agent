# shell 模块 architecture.md

本文档描述 `shell` 模块的内部架构与设计决策。所有设计基于 `goals-duty.md` 中定义的职责。

---

## 一、Architecture Overview（总体架构）

### 模块定位

Shell 模块是 ohbaby-agent 的底层基础设施，为 Bash Tool 提供跨平台的 shell 检测和进程管理能力。

### 核心架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Shell 模块                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                    Shell (对外接口)                    │   │
│  │                                                        │   │
│  │  - preferred(): string      首选 shell 路径            │   │
│  │  - acceptable(): string     兼容 shell 路径            │   │
│  │  - killTree(proc, opts)     进程树清理                 │   │
│  └──────────────────────────────────────────────────────┘   │
│                          │                                   │
│           ┌──────────────┼──────────────┐                   │
│           │              │              │                   │
│           ▼              ▼              ▼                   │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐        │
│  │  Detector  │  │  Blacklist │  │ ProcessKiller  │        │
│  │            │  │            │  │                │        │
│  │ - fromEnv  │  │ - fish     │  │ - Windows      │        │
│  │ - fallback │  │ - nu       │  │ - Unix/macOS   │        │
│  │ - gitBash  │  │ - nushell  │  │                │        │
│  └────────────┘  └────────────┘  └────────────────┘        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
               ┌──────────────────────────┐
               │   OS / child_process     │
               └──────────────────────────┘
```

### 组件职责划分

| 组件 | 职责 |
|------|------|
| Shell | 对外暴露的统一接口 |
| Detector | Shell 路径检测逻辑（环境变量、平台默认、Git Bash） |
| Blacklist | 不兼容 shell 的过滤列表 |
| ProcessKiller | 跨平台进程树清理实现 |

---

## 二、Core Components（核心组件）

### 2.1 Shell 检测流程

#### preferred() - 首选 Shell

```
preferred()
    │
    ├─ 1. 检查 $SHELL 环境变量
    │      └─ 存在 → 返回
    │
    └─ 2. Fallback 逻辑
           ├─ Windows → Git Bash 或 cmd.exe
           ├─ macOS → /bin/zsh
           └─ Linux → /bin/bash 或 /bin/sh
```

#### acceptable() - 兼容 Shell

```
acceptable()
    │
    ├─ 1. 检查 $SHELL 环境变量
    │      ├─ 存在且不在黑名单 → 返回
    │      └─ 在黑名单中 → 进入 Fallback
    │
    └─ 2. Fallback 逻辑（同 preferred）
```

### 2.2 平台检测逻辑

#### Windows

```
Windows 检测顺序：
1. 查找 git.exe 路径 (which git)
2. 推导 bash.exe 路径
   git.exe: C:\Program Files\Git\cmd\git.exe
   bash.exe: C:\Program Files\Git\bin\bash.exe
3. 验证 bash.exe 存在
4. 如不存在，返回 cmd.exe (%COMSPEC%)
```

#### macOS

```
macOS 检测顺序：
1. $SHELL 环境变量
2. 回退到 /bin/zsh（macOS 默认）
```

#### Linux

```
Linux 检测顺序：
1. $SHELL 环境变量
2. which bash
3. 回退到 /bin/sh
```

### 2.3 进程树清理

#### Windows 实现

```typescript
// 使用 taskkill 命令
spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore" })
// /f: 强制终止
// /t: 终止子进程树
```

#### Unix/macOS 实现

```typescript
// 第一步：发送 SIGTERM 到进程组（负 PID）
process.kill(-pid, "SIGTERM")

// 第二步：等待 200ms
await sleep(SIGKILL_TIMEOUT_MS)

// 第三步：如果进程仍在运行，发送 SIGKILL
if (!exited) {
  process.kill(-pid, "SIGKILL")
}
```

**关键点**：
- 负 PID (`-pid`) 表示进程组，可以杀死所有子进程
- 需要 spawn 时设置 `detached: true` 创建进程组
- 先 SIGTERM 给进程优雅退出机会，再 SIGKILL 强制终止

---

## 三、Design Pattern & Rationale（设计模式与理由）

### 3.1 Lazy 初始化模式

**应用场景**：Shell 路径检测

```typescript
const preferred = lazy(() => {
  const s = process.env.SHELL
  if (s) return s
  return fallback()
})
```

**选择理由**：
- Shell 路径在运行期间不会变化
- 避免重复执行检测逻辑
- 延迟到首次调用时执行

### 3.2 Namespace 模式

**应用场景**：API 组织

```typescript
export namespace Shell {
  export function preferred(): string { ... }
  export function acceptable(): string { ... }
  export async function killTree(...): Promise<void> { ... }
}
```

**选择理由**：
- 清晰的模块边界
- 避免命名冲突
- 与 opencode 保持一致的风格

### 3.3 未使用的模式

**未使用 Strategy 模式（平台适配）**：
- 平台差异逻辑简单，不需要抽象
- 直接 `if (process.platform === 'win32')` 更清晰
- 减少不必要的抽象层

**未使用 Plugin 模式（shell 扩展）**：
- MVP 阶段不需要用户自定义 shell
- YAGNI 原则

---

## 四、Module Structure & File Layout（模块结构与文件组织）

```
src/shell/
├── index.ts              # 模块入口，导出 Shell namespace
├── detector.ts           # Shell 路径检测逻辑
├── process.ts            # 进程树清理逻辑
└── constants.ts          # 常量定义（黑名单、超时时间）
```

### 文件职责说明

| 文件 | 职责 | 对外暴露 |
|------|------|----------|
| index.ts | 模块入口，组合各组件 | Shell namespace |
| detector.ts | preferred/acceptable 实现 | 内部 |
| process.ts | killTree 实现 | 内部 |
| constants.ts | BLACKLIST, SIGKILL_TIMEOUT | 内部 |

---

## 五、Architectural Constraints & Trade-offs（约束与权衡）

### 5.1 选择硬编码黑名单而非配置

**取舍**：
- 放弃：用户自定义黑名单的灵活性
- 获得：简单性，减少配置复杂度

**理由**：
- 黑名单是技术限制，不是用户偏好
- fish/nu 语法不兼容是客观事实
- 用户几乎没有自定义需求

### 5.2 选择自动检测而非配置 Shell 路径

**取舍**：
- 放弃：用户指定特定 shell 的能力
- 获得：零配置体验

**理由**：
- 自动检测覆盖 95%+ 场景
- MVP 阶段优先简单
- 后续可按需添加环境变量覆盖

### 5.3 Windows 优先 Git Bash 而非 cmd.exe

**取舍**：
- 放弃：与 Windows 原生工具的一致性
- 获得：与 Linux/macOS 更一致的命令语法

**理由**：
- 开发者通常安装 Git
- Bash 语法更通用，AI 生成的命令更可能兼容
- cmd.exe 语法差异大（`dir` vs `ls`，`%VAR%` vs `$VAR`）

### 5.4 SIGTERM → SIGKILL 两阶段终止

**取舍**：
- 放弃：立即终止的响应速度
- 获得：进程优雅退出的机会

**理由**：
- 给进程保存状态、清理资源的机会
- 200ms 等待时间是合理的折中
- 符合 Unix 进程管理的最佳实践

---

## 六、Dependencies（依赖关系）

### 6.1 外部依赖

| 依赖 | 用途 |
|------|------|
| Node.js child_process | spawn, ChildProcess 类型 |
| Node.js path | 路径处理 |
| Node.js process | 平台检测、kill 信号 |

### 6.2 被依赖

| 依赖方 | 调用接口 | 用途 |
|--------|----------|------|
| Tools (Bash) | acceptable(), killTree() | 获取 shell 路径，清理超时进程 |

---

## 七、文档自检

- [x] 架构服务于 goals-duty.md 中定义的职责
- [x] 组件职责单一，边界清晰
- [x] 设计模式选择有明确理由
- [x] 跨平台策略清晰（Windows/macOS/Linux）
- [x] 不存在为了"优雅"而增加的复杂性
- [x] 约束与权衡说明清楚
