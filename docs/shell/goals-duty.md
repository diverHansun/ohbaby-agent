# shell 模块 goals-duty.md

本文档定义 `shell` 模块的设计目标与职责边界。

---

## 一、模块定位

**一句话说明**：shell 模块提供跨平台的 shell 检测与进程管理能力，是 Bash Tool 执行命令的底层基础设施。

**如果没有这个模块**：
- Bash Tool 需要自己处理跨平台 shell 检测逻辑
- Windows 上无法正确找到 Git Bash
- 不兼容 shell（fish/nu）的过滤逻辑散落在多处
- 进程树清理的跨平台差异处理复杂且容易出错

---

## 二、Design Goals（设计目标）

### G1: 跨平台 Shell 检测

自动检测当前系统可用的 shell，支持：
- Linux: bash、sh
- macOS: zsh、bash
- Windows: Git Bash、cmd.exe

### G2: 兼容性过滤

过滤不兼容 POSIX 语法的 shell（如 fish、nu），确保 Bash Tool 执行的命令能正确运行。

### G3: 进程树安全清理

提供跨平台的进程树清理能力，确保：
- 主进程和所有子进程都被正确终止
- 先尝试优雅退出（SIGTERM），再强制杀死（SIGKILL）
- Windows 使用 taskkill 递归杀死进程树

### G4: 简单可靠

API 保持最小化，只提供必要的能力。不做过度抽象，不引入不必要的配置项。

---

## 三、Duties（职责）

### D1: 提供首选 Shell 路径

`preferred()`: 返回用户首选的 shell 路径。

检测逻辑：
1. 环境变量 `$SHELL`
2. 平台默认 shell（macOS: /bin/zsh, Linux: /bin/bash）

用途：未来 PTY 或用户直接执行命令场景（MVP 阶段暂未使用）。

### D2: 提供兼容 Shell 路径

`acceptable()`: 返回 Bash Tool 可用的 shell 路径。

检测逻辑：
1. 环境变量 `$SHELL`（排除黑名单）
2. Windows 优先检测 Git Bash
3. 回退到平台默认 shell

用途：Bash Tool 执行 AI 生成的命令。

### D3: 维护 Shell 黑名单

硬编码不兼容 shell 列表：
- `fish`: 语法不兼容（不支持 `&&`、使用 `set` 替代 `export`）
- `nu` / `nushell`: 结构化 shell，语法完全不同

### D4: 跨平台进程树清理

`killTree(proc, opts?)`: 杀死进程及其所有子进程。

实现策略：
| 平台 | 方法 |
|------|------|
| Windows | `taskkill /pid <PID> /f /t` |
| Unix/macOS | `kill(-pid, SIGTERM)` → 等待 → `kill(-pid, SIGKILL)` |

### D5: Windows Git Bash 路径检测

在 Windows 上自动从 git.exe 位置推导 bash.exe 路径：
```
git.exe: C:\Program Files\Git\cmd\git.exe
bash.exe: C:\Program Files\Git\bin\bash.exe
```

---

## 四、Non-Duties（非职责）

### N1: 不执行命令

命令执行由 Bash Tool 负责。Shell 模块只提供 shell 路径和进程清理能力。

### N2: 不管理执行超时

超时逻辑由 Bash Tool 内部管理，Shell 模块只提供 `killTree` 供调用。

### N3: 不管理 PTY 会话

交互式终端（PTY）如有需要，由独立模块负责。Shell 模块只提供 shell 路径检测。

### N4: 不处理 Shell 配置加载

不同 shell 的配置文件加载（如 `.bashrc`、`.zshrc`）不在本模块职责内。如有需要，由调用方处理。

### N5: 不支持自定义 Shell 配置

MVP 阶段不支持用户自定义 shell 路径的配置项。自动检测逻辑覆盖绝大多数场景。

### N6: 不支持后台进程管理

后台运行的 shell 进程管理（如果需要）由其他模块负责。

### N7: 不负责命令解析

Shell 命令的语法解析（提取命令头部、检测路径参数等）由 `utils/command-parser` 模块负责。Shell 模块只提供 shell 路径检测和进程管理能力。

---

## 五、设计约束与假设

### 约束

1. **单进程假设**：Shell 模块在单进程环境中运行
2. **Node.js 依赖**：使用 Node.js 的 `child_process` 模块
3. **平台限制**：支持 Windows、macOS、Linux

### 假设

1. Windows 开发者通常安装了 Git（包含 Git Bash）
2. Linux/macOS 系统有 bash 或 sh 可用
3. 用户的 `$SHELL` 环境变量正确设置

---

## 六、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| Tools (Bash) | 被依赖 | Bash Tool 调用 Shell 获取可用 shell 和 killTree |
| ToolScheduler | 无关 | 不直接交互 |
| Permission | 无关 | Shell 不做权限检查 |

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
- [x] 设计目标服务于 KISS 和 YAGNI 原则
