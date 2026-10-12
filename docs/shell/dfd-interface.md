# shell 模块 dfd-interface.md

本文档描述 `shell` 模块的数据流与对外接口。

---

## 一、Context & Scope（上下文与范围）

### 模块位置

Shell 模块位于 ohbaby-agent 架构的底层，是 Tools 模块（特别是 Bash Tool）的基础设施依赖。

### 交互模块

| 外部模块 | 交互方向 | 交互内容 |
|----------|----------|----------|
| **Tools (Bash)** | 输入 | 请求可用 shell 路径，请求进程清理 |
| **OS / child_process** | 输出 | 检测 shell 路径，发送进程信号 |

### 本文档范围

- 描述 Shell 模块如何接收请求
- 定义 Shell 模块的对外接口
- 说明与调用方的交互方式

---

## 二、Data Flow Description（数据流描述）

### 2.1 Shell 路径获取流程

```
Bash Tool                           Shell 模块                         OS
    │                                   │                               │
    │  1. Shell.acceptable()            │                               │
    │──────────────────────────────────>│                               │
    │                                   │                               │
    │                      2. 检查环境变量 $SHELL                         │
    │                                   │───────────────────────────────>│
    │                                   │                               │
    │                                   │  3. 环境变量值                  │
    │                                   │<───────────────────────────────│
    │                                   │                               │
    │                      4. 黑名单检查                                  │
    │                                   │                               │
    │                      [如果在黑名单或不存在]                          │
    │                      5. Fallback 检测                              │
    │                                   │                               │
    │                                   │  [Windows] which git           │
    │                                   │───────────────────────────────>│
    │                                   │                               │
    │                                   │  6. git 路径                   │
    │                                   │<───────────────────────────────│
    │                                   │                               │
    │                      7. 推导 bash.exe 路径                          │
    │                                   │                               │
    │  8. Shell 路径                    │                               │
    │<──────────────────────────────────│                               │
```

### 2.2 进程树清理流程 (Unix/macOS)

```
Bash Tool                           Shell 模块                         OS
    │                                   │                               │
    │  1. Shell.killTree(proc, opts)    │                               │
    │──────────────────────────────────>│                               │
    │                                   │                               │
    │                      2. 检查 opts.exited()                         │
    │                          [已退出] ─→ 返回                          │
    │                                   │                               │
    │                                   │  3. kill(-pid, SIGTERM)       │
    │                                   │───────────────────────────────>│
    │                                   │                               │
    │                      4. 等待 200ms                                 │
    │                                   │                               │
    │                      5. 检查 opts.exited()                         │
    │                          [已退出] ─→ 返回                          │
    │                                   │                               │
    │                                   │  6. kill(-pid, SIGKILL)       │
    │                                   │───────────────────────────────>│
    │                                   │                               │
    │  7. Promise<void>                 │                               │
    │<──────────────────────────────────│                               │
```

### 2.3 进程树清理流程 (Windows)

```
Bash Tool                           Shell 模块                         OS
    │                                   │                               │
    │  1. Shell.killTree(proc, opts)    │                               │
    │──────────────────────────────────>│                               │
    │                                   │                               │
    │                      2. 检查 opts.exited()                         │
    │                          [已退出] ─→ 返回                          │
    │                                   │                               │
    │                                   │  3. spawn taskkill            │
    │                                   │───────────────────────────────>│
    │                                   │                               │
    │                                   │  4. taskkill 完成              │
    │                                   │<───────────────────────────────│
    │                                   │                               │
    │  5. Promise<void>                 │                               │
    │<──────────────────────────────────│                               │
```

---

## 三、Interface Definition（接口定义）

### 3.1 对外提供的接口

#### Shell.preferred()

**语义**：返回用户首选的 shell 路径

**输入**：无

**输出**：`string` - Shell 可执行文件的绝对路径

**特性**：
- 同步函数
- 结果被缓存（lazy 初始化）
- 不做黑名单过滤

**检测优先级**：
1. `$SHELL` 环境变量
2. 平台默认 shell

**用途**：未来 PTY 或用户直接执行命令场景

---

#### Shell.acceptable()

**语义**：返回 Bash Tool 可用的 shell 路径

**输入**：无

**输出**：`string` - Shell 可执行文件的绝对路径

**特性**：
- 同步函数
- 结果被缓存（lazy 初始化）
- 过滤黑名单中的 shell

**检测优先级**：
1. `$SHELL` 环境变量（排除黑名单）
2. Git Bash（Windows）
3. 平台默认 shell

**用途**：Bash Tool 执行 AI 生成的命令

---

#### Shell.killTree()

**语义**：终止进程及其所有子进程

**输入**：
```typescript
proc: ChildProcess     // Node.js 子进程对象
opts?: {
  exited?: () => boolean  // 检查进程是否已退出的回调
}
```

**输出**：`Promise<void>`

**异步特性**：异步，进程终止后 resolve

**行为**：
- Windows: 使用 `taskkill /f /t` 递归杀死进程树
- Unix/macOS: 先 SIGTERM，等待 200ms，再 SIGKILL
- 如果 `opts.exited()` 返回 true，跳过杀死操作

**用途**：Bash Tool 清理超时或被用户取消的命令

---

### 3.2 内部辅助函数（不对外暴露）

#### isBlacklisted()

**语义**：检查 shell 是否在黑名单中

**输入**：`shellPath: string`

**输出**：`boolean`

---

#### fallback()

**语义**：获取平台默认 shell 路径

**输入**：无

**输出**：`string`

---

## 四、Data Ownership & Responsibility（数据归属与责任）

### 4.1 数据归属

| 数据 | 归属方 | 说明 |
|------|--------|------|
| Shell 路径 | Shell 模块 | 检测并缓存 |
| 进程对象 | Bash Tool | 创建并传递给 Shell |
| 环境变量 | OS | Shell 模块只读取 |

### 4.2 责任边界

| 职责 | 负责模块 | 不负责模块 |
|------|----------|------------|
| Shell 路径检测 | Shell | Bash Tool |
| 黑名单维护 | Shell | Bash Tool |
| 进程创建 | Bash Tool | Shell |
| 进程清理 | Shell | - |
| 超时管理 | Bash Tool | Shell |
| 命令执行 | Bash Tool | Shell |

---

## 五、使用示例

### 5.1 Bash Tool 中的典型使用

```typescript
// bash.ts
import { Shell } from '@/shell'
import { spawn } from 'child_process'

async function executeBash(command: string, timeout: number) {
  // 1. 获取可用 shell
  const shell = Shell.acceptable()

  // 2. 创建子进程
  const proc = spawn(command, {
    shell,
    detached: process.platform !== 'win32',  // Unix 需要创建进程组
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let exited = false

  // 3. 设置超时处理
  const timeoutTimer = setTimeout(async () => {
    await Shell.killTree(proc, { exited: () => exited })
  }, timeout)

  // 4. 等待进程完成
  await new Promise<void>((resolve) => {
    proc.once('exit', () => {
      exited = true
      clearTimeout(timeoutTimer)
      resolve()
    })
  })

  return proc.exitCode
}
```

### 5.2 用户取消命令的处理

```typescript
// bash.ts
const abortHandler = () => {
  void Shell.killTree(proc, { exited: () => exited })
}

ctx.abort.addEventListener('abort', abortHandler, { once: true })
```

---

## 六、文档自检

- [x] 可以清楚说明每一条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 数据责任边界清晰
- [x] 接口定义与 data-model.md 中的类型一致
- [x] 使用示例覆盖主要使用场景

## Bash 启动网络配置

Bash Tool 在 `registry.start()` 前构造并验证代理环境；错误时不创建 running job、不 spawn，并释放已经 retain 的 environment。普通命令环境继续覆盖非交互默认值，`OHBABY_CALL_ID` / `OHBABY_MESSAGE_ID` / `OHBABY_SESSION_ID` / `OHBABY_WORKDIR` 由执行上下文最后写入。取消、并发和 cleanup 继续由现有机制管理。

网络配置错误只阻止本次 Bash / stdio 启动；Read / Glob / Grep 的本地工作和内部 rg 不进入这道门禁。代理端口不可达由实际命令原生返回失败，不增加启动探活、重试或直连回退。

### 子进程代理环境契约

Shell 和 MCP stdio 在每次新启动时读取 `network-proxy` 当前已完成的配置快照。安装时捕获的进程显式代理变量作为基础，该次 `context.env` / `config.env` 的非空同名逻辑键优先；同层小写优先大写。`ALL_PROXY` 补齐缺少的协议，只要存在显式 HTTP / HTTPS / ALL 代理，就整组使用环境配置，不从系统补另一协议。空白覆盖值恢复继承，普通环境变量空串保持原值。

只有 `NO_PROXY` 时仍跟随系统；`NO_PROXY=*` 明确全部绕过，允许在系统读取失败时启动。POSIX 输出同值大小写代理别名；Windows 按大小写不敏感键处理并输出单一逻辑键。构造时先清除旧代理别名；系统值不会写回 `process.env`。显式外部客户端原生代理协议保留，HTTP(S) URL 继续校验；这不新增主 Node SOCKS 支持。

自动系统 bypass 支持字面 IP 和规范化 IPv4 CIDR（curl 7.86+）；固定绕过包含 localhost、127.0.0.1、::1 和 127/8。映射 IPv6 系统字面规则生成 curl 的点分与十六进制两种别名。IPv6 CIDR、精确裸域、仅子域、通配域、host:port 与 `<local>` 无法保证等价，本次启动明确失败。常见 `*.local` / `<local>` 配置在自动系统路径下必然失败；错误提示显式设置所需协议的 `HTTP_PROXY` / `HTTPS_PROXY`（可附加 `NO_PROXY`），或选择 `NO_PROXY=*`。只设置普通 `NO_PROXY` 不能绕开转换失败。不执行 PAC，不丢弃规则，不启动本地转发服务。

刷新完成后原子替换快照；系统关闭或读取失败不继续沿用旧成功值。已有子进程保留启动环境，重连或新启动使用新快照。卸载清空安装快照；嵌入方未安装时只继承显式 env，不自动读取系统设置。变量传递不构成网络沙箱；不读取变量的程序不在透明接管承诺内。
