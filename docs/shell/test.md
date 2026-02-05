# shell 模块 test.md

本文档描述 `shell` 模块的测试范围与验证策略。

---

## 一、Test Scope（测试范围）

### 覆盖的职责

| 职责编号 | 职责描述 | 测试覆盖 |
|----------|----------|----------|
| D1 | 提供首选 Shell 路径 | 单元测试 |
| D2 | 提供兼容 Shell 路径 | 单元测试 |
| D3 | 维护 Shell 黑名单 | 单元测试 |
| D4 | 跨平台进程树清理 | 集成测试 |
| D5 | Windows Git Bash 检测 | 单元测试 (mock) |

### 不在测试范围内的内容

- Bash Tool 的命令执行逻辑（属于 Tools 模块）
- 超时管理逻辑（属于 Bash Tool）
- 实际的 shell 语法兼容性（已知事实，非运行时行为）

---

## 二、Critical Scenarios（关键场景）

### 2.1 Shell 检测

#### 场景 1：preferred() 使用 $SHELL 环境变量

- **前置条件**：`$SHELL` 设置为 `/bin/zsh`
- **操作**：调用 `Shell.preferred()`
- **预期结果**：返回 `/bin/zsh`

#### 场景 2：preferred() 无 $SHELL 时回退

- **前置条件**：`$SHELL` 未设置，平台为 macOS
- **操作**：调用 `Shell.preferred()`
- **预期结果**：返回 `/bin/zsh`

#### 场景 3：acceptable() 过滤 fish

- **前置条件**：`$SHELL` 设置为 `/usr/bin/fish`
- **操作**：调用 `Shell.acceptable()`
- **预期结果**：不返回 fish，返回 fallback shell

#### 场景 4：acceptable() 过滤 nu

- **前置条件**：`$SHELL` 设置为 `/usr/bin/nu`
- **操作**：调用 `Shell.acceptable()`
- **预期结果**：不返回 nu，返回 fallback shell

#### 场景 5：acceptable() 接受 bash

- **前置条件**：`$SHELL` 设置为 `/bin/bash`
- **操作**：调用 `Shell.acceptable()`
- **预期结果**：返回 `/bin/bash`

#### 场景 6：acceptable() 接受 zsh

- **前置条件**：`$SHELL` 设置为 `/bin/zsh`
- **操作**：调用 `Shell.acceptable()`
- **预期结果**：返回 `/bin/zsh`

### 2.2 Windows Git Bash 检测

#### 场景 7：检测到 Git Bash

- **前置条件**：
  - 平台为 Windows
  - `which git` 返回 `C:\Program Files\Git\cmd\git.exe`
  - `C:\Program Files\Git\bin\bash.exe` 存在
- **操作**：调用 `Shell.acceptable()`
- **预期结果**：返回 `C:\Program Files\Git\bin\bash.exe`

#### 场景 8：未安装 Git 时回退 cmd

- **前置条件**：
  - 平台为 Windows
  - `which git` 返回空
- **操作**：调用 `Shell.acceptable()`
- **预期结果**：返回 `cmd.exe`

#### 场景 9：Git 安装但 bash.exe 不存在

- **前置条件**：
  - 平台为 Windows
  - `which git` 返回路径
  - 推导的 `bash.exe` 路径不存在
- **操作**：调用 `Shell.acceptable()`
- **预期结果**：返回 `cmd.exe`

### 2.3 黑名单检查

#### 场景 10：fish 在黑名单中

- **操作**：检查 `/usr/bin/fish` 是否在黑名单
- **预期结果**：返回 `true`

#### 场景 11：nu 在黑名单中

- **操作**：检查 `/usr/bin/nu` 是否在黑名单
- **预期结果**：返回 `true`

#### 场景 12：nushell 在黑名单中

- **操作**：检查 `/usr/bin/nushell` 是否在黑名单
- **预期结果**：返回 `true`

#### 场景 13：bash 不在黑名单中

- **操作**：检查 `/bin/bash` 是否在黑名单
- **预期结果**：返回 `false`

#### 场景 14：Windows 路径大小写处理

- **操作**：检查 `C:\...\Fish.exe` 是否在黑名单
- **预期结果**：返回 `true`（大小写不敏感）

### 2.4 进程树清理

#### 场景 15：正常进程终止 (Unix)

- **前置条件**：平台为 Unix/macOS
- **操作**：
  1. spawn 一个长时间运行的子进程
  2. 调用 `Shell.killTree(proc)`
- **预期结果**：进程被终止

#### 场景 16：带子进程的终止 (Unix)

- **前置条件**：平台为 Unix/macOS
- **操作**：
  1. spawn 一个创建子进程的命令（如 `bash -c "sleep 100 & sleep 100"`）
  2. 调用 `Shell.killTree(proc)`
- **预期结果**：主进程和所有子进程都被终止

#### 场景 17：已退出进程的处理

- **前置条件**：进程已自然退出
- **操作**：调用 `Shell.killTree(proc, { exited: () => true })`
- **预期结果**：不发送任何信号，直接返回

#### 场景 18：SIGTERM 后进程退出

- **前置条件**：进程能响应 SIGTERM 并退出
- **操作**：调用 `Shell.killTree(proc)`
- **预期结果**：只发送 SIGTERM，不发送 SIGKILL

#### 场景 19：SIGTERM 后进程未退出

- **前置条件**：进程忽略 SIGTERM
- **操作**：调用 `Shell.killTree(proc)`
- **预期结果**：发送 SIGTERM，等待 200ms，发送 SIGKILL

#### 场景 20：Windows 进程终止

- **前置条件**：平台为 Windows
- **操作**：
  1. spawn 一个长时间运行的子进程
  2. 调用 `Shell.killTree(proc)`
- **预期结果**：taskkill 被调用，进程被终止

### 2.5 缓存行为

#### 场景 21：preferred() 结果缓存

- **操作**：
  1. 调用 `Shell.preferred()` 获取结果
  2. 修改 `$SHELL` 环境变量
  3. 再次调用 `Shell.preferred()`
- **预期结果**：返回缓存的第一次结果（lazy 初始化）

#### 场景 22：acceptable() 结果缓存

- **操作**：与场景 21 类似
- **预期结果**：返回缓存的第一次结果

---

## 三、Integration Points（集成点测试）

### 3.1 与 Bash Tool 的集成

**验证重点**：
- Bash Tool 能正确获取 shell 路径
- Bash Tool 能正确清理超时进程

**测试场景**：
- 执行简单命令，验证 shell 路径正确
- 执行超时命令，验证进程被正确终止
- 执行创建子进程的命令，验证子进程也被终止

**失败处理预期**：
- Shell 模块返回的路径不存在：Bash Tool spawn 失败
- killTree 失败：进程可能残留

### 3.2 与操作系统的集成

**验证重点**：
- 环境变量读取正确
- 进程信号发送正确
- Windows taskkill 调用正确

**跨平台测试**：
- 在 Windows/macOS/Linux 上运行完整测试套件
- 验证各平台的 fallback 逻辑正确

---

## 四、Verification Strategy（验证策略）

### 4.1 单元测试

**适用场景**：
- Shell 检测逻辑
- 黑名单检查
- 路径推导逻辑

**策略**：
- Mock 环境变量和文件系统
- Mock `which` 命令结果
- 覆盖各平台分支

```typescript
describe('Shell.acceptable()', () => {
  beforeEach(() => {
    // Mock 环境变量
    process.env.SHELL = '/bin/bash'
  })

  it('should return $SHELL if not blacklisted', () => {
    expect(Shell.acceptable()).toBe('/bin/bash')
  })

  it('should fallback if $SHELL is fish', () => {
    process.env.SHELL = '/usr/bin/fish'
    expect(Shell.acceptable()).not.toContain('fish')
  })
})
```

### 4.2 集成测试

**适用场景**：
- 进程树清理
- 真实的 shell 检测

**策略**：
- 使用真实的子进程
- 验证进程确实被终止
- 使用 `ps` 或类似命令验证子进程也被清理

```typescript
describe('Shell.killTree()', () => {
  it('should kill process and children', async () => {
    const proc = spawn('bash', ['-c', 'sleep 100 & sleep 100'], {
      detached: true,
    })

    await Shell.killTree(proc)

    // 验证进程已终止
    expect(proc.killed).toBe(true)
  })
})
```

### 4.3 跨平台测试

**适用场景**：
- 平台特定的检测逻辑
- 平台特定的进程清理

**策略**：
- CI 中在 Windows/macOS/Linux 运行测试
- 条件跳过不适用的测试

```typescript
describe('Windows Git Bash detection', () => {
  // 只在 Windows 上运行
  const itWindows = process.platform === 'win32' ? it : it.skip

  itWindows('should detect Git Bash', () => {
    // ...
  })
})
```

### 4.4 Mock 策略

| 组件 | Mock 方式 | 用途 |
|------|-----------|------|
| 环境变量 | 直接设置 `process.env` | 单元测试 |
| `which` 命令 | Mock 模块 | Git Bash 检测测试 |
| 文件存在检查 | Mock `fs.existsSync` | Git Bash 检测测试 |
| 子进程 | 真实进程 | 集成测试 |

---

## 五、Edge Cases（边界情况）

### 5.1 环境变量边界

| 情况 | 预期行为 |
|------|----------|
| `$SHELL` 为空字符串 | 使用 fallback |
| `$SHELL` 路径不存在 | 仍返回该路径（由调用方处理） |
| `$SHELL` 包含空格 | 正确处理路径 |

### 5.2 进程边界

| 情况 | 预期行为 |
|------|----------|
| `proc.pid` 为 undefined | 直接返回，不发送信号 |
| 进程已退出 | `exited()` 返回 true 时跳过 |
| 进程组杀死失败 | 降级到单进程杀死 |

### 5.3 Windows 边界

| 情况 | 预期行为 |
|------|----------|
| Git 安装在非标准路径 | 可能检测失败，回退 cmd |
| taskkill 命令失败 | 错误被捕获，静默处理 |

---

## 六、文档自检

- [x] 所有关键职责都有对应的测试场景
- [x] 跨平台行为验证完整
- [x] 边界情况覆盖
- [x] 集成点测试明确
- [x] 验证策略与场景匹配
- [x] 不依赖具体实现细节
