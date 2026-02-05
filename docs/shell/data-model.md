# shell 模块 data-model.md

本文档定义 `shell` 模块的核心数据类型与概念。

---

## 一、Core Concepts（核心概念）

### 1.1 Shell Path（Shell 路径）

Shell 程序的可执行文件路径。

**示例**：
- Linux: `/bin/bash`, `/bin/sh`
- macOS: `/bin/zsh`, `/bin/bash`
- Windows: `C:\Program Files\Git\bin\bash.exe`, `C:\Windows\System32\cmd.exe`

### 1.2 Shell Blacklist（Shell 黑名单）

不兼容 POSIX 语法的 shell 列表，这些 shell 不能用于执行 AI 生成的命令。

**当前黑名单**：
- `fish`: 语法不兼容（不支持 `&&`、使用 `set` 替代 `export`）
- `nu` / `nushell`: 结构化 shell，语法完全不同

### 1.3 Process Tree（进程树）

主进程及其所有子进程构成的树形结构。清理进程时需要递归终止整个进程树。

```
主进程 (PID: 1234)
├── 子进程 A (PID: 1235)
│   └── 子进程 A1 (PID: 1237)
└── 子进程 B (PID: 1236)
```

### 1.4 Kill Options（终止选项）

控制进程终止行为的选项。

**exited 回调**：在尝试杀死进程前检查进程是否已退出，避免对已退出进程发送信号。

---

## 二、Data Types（数据类型）

### 2.1 核心类型

```typescript
// Shell 路径类型
type ShellPath = string

// 进程终止选项
interface KillTreeOptions {
  /**
   * 检查进程是否已退出的回调函数
   * 返回 true 表示进程已退出，无需发送信号
   */
  exited?: () => boolean
}
```

### 2.2 平台类型

```typescript
// 支持的平台
type Platform = 'win32' | 'darwin' | 'linux'

// 平台到默认 shell 的映射
const DEFAULT_SHELLS: Record<Platform, string> = {
  win32: 'cmd.exe',      // 回退值，优先使用 Git Bash
  darwin: '/bin/zsh',
  linux: '/bin/bash',
}
```

### 2.3 黑名单类型

```typescript
// Shell 黑名单（不可变集合）
const BLACKLIST: ReadonlySet<string> = new Set([
  'fish',
  'nu',
  'nushell',
])
```

---

## 三、Constants（常量定义）

```typescript
// SIGKILL 前的等待时间（毫秒）
// 给进程优雅退出的机会
const SIGKILL_TIMEOUT_MS = 200

// Shell 黑名单
const BLACKLIST = new Set(['fish', 'nu', 'nushell'])

// 平台默认 shell
const DEFAULT_SHELLS = {
  win32: 'cmd.exe',
  darwin: '/bin/zsh',
  linux: '/bin/bash',
}

// Git Bash 相对路径（从 git.exe 推导）
// git.exe: .../Git/cmd/git.exe
// bash.exe: .../Git/bin/bash.exe
const GIT_BASH_RELATIVE_PATH = '../../bin/bash.exe'
```

---

## 四、Shell 检测规则

### 4.1 preferred() 规则

| 优先级 | 来源 | 条件 |
|--------|------|------|
| 1 | `$SHELL` 环境变量 | 存在即使用 |
| 2 | 平台默认 | 按平台返回默认值 |

### 4.2 acceptable() 规则

| 优先级 | 来源 | 条件 |
|--------|------|------|
| 1 | `$SHELL` 环境变量 | 存在且不在黑名单 |
| 2 | Git Bash (Windows) | 检测到 git.exe 并推导出 bash.exe |
| 3 | 平台默认 | 按平台返回默认值 |

### 4.3 黑名单检查规则

```typescript
// 从 shell 路径提取 shell 名称
function getShellName(shellPath: string): string {
  if (process.platform === 'win32') {
    return path.win32.basename(shellPath, '.exe').toLowerCase()
  }
  return path.basename(shellPath).toLowerCase()
}

// 检查是否在黑名单
function isBlacklisted(shellPath: string): boolean {
  return BLACKLIST.has(getShellName(shellPath))
}
```

---

## 五、进程终止信号

### 5.1 Unix 信号

| 信号 | 含义 | 用途 |
|------|------|------|
| SIGTERM | 终止请求 | 请求进程优雅退出 |
| SIGKILL | 强制终止 | 立即杀死进程，不可被捕获 |

### 5.2 Windows 等效操作

| 操作 | 命令 |
|------|------|
| 强制终止进程树 | `taskkill /pid <PID> /f /t` |

参数说明：
- `/pid <PID>`: 指定进程 ID
- `/f`: 强制终止
- `/t`: 终止子进程树

---

## 六、Lifecycle（生命周期）

### 6.1 Shell 检测生命周期

```
应用启动
    │
    ├─ Shell.acceptable() 首次调用
    │      └─ 执行检测逻辑
    │      └─ 缓存结果 (lazy)
    │
    └─ 后续调用
           └─ 返回缓存结果
```

### 6.2 进程终止生命周期

```
killTree(proc) 调用
    │
    ├─ 检查 exited() 回调
    │      └─ 已退出 → 立即返回
    │
    ├─ [Windows] taskkill
    │      └─ 等待命令完成 → 返回
    │
    └─ [Unix/macOS]
           ├─ 发送 SIGTERM 到进程组
           ├─ 等待 200ms
           ├─ 检查 exited() 回调
           │      └─ 已退出 → 返回
           └─ 发送 SIGKILL 到进程组 → 返回
```

---

## 七、文档自检

- [x] 核心概念定义清晰，无歧义
- [x] 数据类型简洁，覆盖模块需求
- [x] 常量定义完整
- [x] 检测规则明确
- [x] 信号和生命周期说明清晰
- [x] 不存在"为了设计而设计"的抽象
