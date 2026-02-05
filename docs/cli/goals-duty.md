# cli 模块 goals-duty.md

本文档定义 `cli` 模块的设计目标与职责边界。

**模块位置**：
- 代码：`src/cli/`
- 文档：`docs/cli/`

---

## 一、模块定位

**一句话说明**：cli 模块是 iris-code 的程序入口，负责命令行参数解析、程序初始化、全局错误处理和运行模式控制。

**如果没有这个模块**：
- 程序没有统一的入口点，启动流程混乱
- 命令行参数无法被解析和验证
- 全局异常和信号无法被统一处理
- 交互模式和非交互模式的切换缺乏统一管理

---

## 二、Design Goals（设计目标）

### G1: 简洁入口

入口点代码保持简洁，单文件不超过 100 行。采用中间件模式组织初始化步骤，职责清晰可追踪。

### G2: 分类错误处理

全局异常按类型分类处理，使用语义化退出码。各子模块继承 `utils/error.ts` 中的 `IrisError` 基类定义自己的错误类型。

### G3: 模式分离

清晰区分交互模式和非交互模式的启动流程，两种模式共享初始化逻辑，仅在最终执行环节分流。

### G4: 最小启动参数

MVP 阶段仅支持必要的命令行参数，避免参数膨胀。复杂配置通过配置文件管理，不通过命令行参数暴露。

### G5: 可测试

各子模块职责单一，便于独立测试。启动流程可通过 mock 外部依赖进行验证。

---

## 三、Duties（职责）

### D1: 程序入口

提供 iris-code 的主入口函数 `main()`，是程序启动的唯一入口点。

### D2: 命令行参数解析

解析启动时的命令行参数，MVP 阶段支持以下参数：

| 参数 | 短选项 | 类型 | 说明 |
|------|--------|------|------|
| `--help` | `-h` | boolean | 显示帮助信息 |
| `--version` | `-v` | boolean | 显示版本号 |
| `--prompt <text>` | `-p` | string | 非交互模式，执行指定 prompt |

### D3: 初始化顺序管理

按以下顺序初始化各模块：
1. 解析命令行参数
2. 初始化日志系统（调用 `Log.init()`）
3. 注册全局异常处理器
4. 加载配置（调用 config 模块）
5. 初始化核心模块（MCP、Agent 等）
6. 根据模式启动 REPL 或执行 prompt

### D4: 运行模式判断

根据参数和环境判断运行模式：

| 条件 | 模式 | 行为 |
|------|------|------|
| 有 `-p` 参数 | 非交互 | 执行一次 prompt 后退出 |
| stdin 有管道输入 | 非交互 | 读取 stdin 作为 prompt |
| stdin 是 TTY 且无参数 | 交互 | 启动 REPL |

**stdin 读取**：由 `bootstrap.ts` 负责检测 `!process.stdin.isTTY` 并读取管道输入。

### D5: 全局异常处理

统一处理未捕获的异常和信号：
- `unhandledRejection`：Promise 拒绝
- `uncaughtException`：同步异常
- `SIGINT`：用户中断信号
- `SIGTERM`：终止信号

### D6: 退出码管理

定义语义化退出码常量 `EXIT_CODES` 和映射函数 `getExitCodeForError()`：

| 退出码 | 含义 | 场景 |
|--------|------|------|
| 0 | 成功 | 正常执行完成 |
| 1 | 一般错误 | 未分类错误 |
| 2 | 参数错误 | 参数解析失败 |
| 3 | 配置错误 | 配置文件错误 |
| 4 | 认证错误 | API Key 无效 |
| 5 | 网络错误 | API 调用失败 |
| 130 | 用户中断 | Ctrl+C (128 + SIGINT) |

### D7: 生命周期清理

程序退出前执行清理：
- 调用 `runSyncCleanup()` 执行同步清理
- 调用 `runExitCleanup()` 执行异步清理
- 确保 MCP 连接、临时文件等资源被正确释放

### D8: 错误类型定义

定义 CLI 层错误类型，继承 `utils/error.ts` 中的 `IrisError` 基类：

```typescript
// CLI 参数错误
class CliArgumentError extends IrisError

// CLI 配置错误
class CliConfigError extends IrisError
```

---

## 四、Non-Duties（非职责）

### N1: 不负责业务逻辑

具体的业务逻辑由 `commands` 和 `lifecycle` 模块负责。cli 模块只负责启动和协调。

### N2: 不负责 UI 渲染

终端 UI 渲染由独立的 `ui` 模块负责。cli 模块只负责启动 UI 或执行非交互逻辑。

### N3: 不负责配置管理

配置的加载、验证、持久化由 `config` 模块负责。cli 模块只调用 config 接口获取配置。

### N4: 不实现复杂参数

以下参数在 MVP 阶段不实现：
- `--verbose`、`--debug`：调试选项
- `--json`：输出格式控制
- `--model`：模型选择
- `--resume`：会话恢复

如需这些功能，使用配置文件或 Slash 命令。

### N5: 不负责 Slash 命令业务逻辑

Slash 命令的解析和渲染由 `cli/commands` 子模块负责，业务逻辑由 `commands` 模块负责。

---

## 五、文件结构

cli 模块采用扁平化结构，仅 commands 保留子目录：

```
src/cli/
├── index.ts          # 模块入口，导出 main()
├── bootstrap.ts      # 初始化流程编排
├── handlers.ts       # 全局异常/信号处理
├── args.ts           # 参数解析 + isInteractive()
├── error.ts          # CliArgumentError, CliConfigError
├── exit-codes.ts     # EXIT_CODES + getExitCodeForError()
└── commands/         # Slash 命令（复杂度高，保留子目录）
    ├── index.ts
    ├── parser.ts
    ├── renderer.ts
    └── formatters/
```

**设计理由**：
- cli 模块代码量小（约 300 行），不需要过多子目录
- 扁平结构 import 路径更短，更直观
- commands 有多个组件和格式化器，复杂度高，保留子目录

---

## 六、设计约束与假设

### 约束

1. **依赖 utils 基础设施**：使用 `Log`、`IrisError`、`registerCleanup` 等
2. **单文件行数限制**：各文件不超过 100 行，保持简洁
3. **最小外部依赖**：仅依赖 yargs 进行参数解析

### 假设

1. Node.js 运行环境支持 ES Modules
2. 终端支持 TTY 检测（`process.stdin.isTTY`）
3. 配置文件已由 config 模块正确加载

---

## 七、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| utils | 依赖 | 使用 Log、IrisError、cleanup 等基础设施 |
| config | 依赖 | 调用加载配置 |
| ui | 依赖 | 交互模式下启动 UI |
| lifecycle | 依赖 | 非交互模式下调用执行 prompt |
| commands | 间接 | 通过 cli/commands 子模块调用 |
| bus | 依赖 | 订阅事件进行响应 |

### 依赖方向图

```
┌─────────────────────────────────────────────────────────────┐
│                         cli 模块                             │
│  ┌────────────┐ ┌────────┐ ┌────────┐ ┌───────────────────┐ │
│  │bootstrap.ts│ │args.ts │ │error.ts│ │    commands/      │ │
│  │handlers.ts │ │        │ │exit-   │ │ (Slash 命令处理)  │ │
│  │            │ │        │ │codes.ts│ │                   │ │
│  └─────┬──────┘ └───┬────┘ └───┬────┘ └────────┬──────────┘ │
└────────┼────────────┼──────────┼───────────────┼────────────┘
         │            │          │               │
         ▼            ▼          ▼               ▼
┌─────────────────────────────────────────────────────────────┐
│                     utils (基础设施)                         │
│         Log  /  IrisError  /  cleanup  /  paths             │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────┬────────────────┬────────────────────────────┐
│     config     │       ui       │         lifecycle          │
│    (配置加载)   │   (交互模式)    │       (非交互执行)          │
└────────────────┴────────────────┴────────────────────────────┘
```

---

## 八、交互模式 vs 非交互模式

### 模式边界

| 判断条件 | 模式 | 启动行为 | 退出行为 |
|----------|------|----------|----------|
| `stdin.isTTY && !args.prompt` | 交互 | 启动 UI REPL | 用户输入 `/exit` 或 Ctrl+C |
| `args.prompt` 存在 | 非交互 | 执行 prompt | prompt 完成后退出 |
| `!stdin.isTTY` | 非交互 | 读取 stdin 执行 | 执行完成后退出 |

### 共享逻辑

两种模式共享以下初始化逻辑：
1. 参数解析
2. 日志初始化
3. 异常处理器注册
4. 配置加载
5. 核心模块初始化

### 分流点

在初始化完成后，根据 `isInteractive` 标志分流：

```
初始化流程（共享）
    │
    ├── isInteractive = true
    │       │
    │       └── startInteractive() → UI.render()
    │
    └── isInteractive = false
            │
            └── executePrompt() → Lifecycle.run()
```

---

## 九、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
- [x] 设计目标服务于 KISS 和 YAGNI 原则
- [x] 子模块结构清晰，文档位置明确
