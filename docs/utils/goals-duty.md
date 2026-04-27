# utils 模块的目标与职责

本文档定义 utils 模块的设计目标与职责边界。

---

## 一、Design Goals（设计目标）

### 1. 提供统一的基础设施

为 ohbaby-agent 各模块提供统一的底层基础设施，包括日志系统、错误处理基类、生命周期清理机制，确保全局行为一致。

### 2. 消除跨模块代码重复

提取各模块共用的工具函数，避免重复实现，遵循 DRY 原则。包括路径操作、文件类型检测、文本格式化等。

### 3. 保持极致简洁

每个工具函数遵循单一职责原则，最小化外部依赖，避免过度抽象。遵循 KISS 和 YAGNI 原则。

### 4. 支持模块化使用

各模块可按需引用 utils 中的特定功能，utils 不强制依赖关系，不产生循环依赖。

---

## 二、Duties（职责）

### 1. 日志系统（logger.ts）

负责：
- 提供 Logger 工厂函数，各模块创建自己的 logger 实例
- 支持日志级别过滤（DEBUG、INFO、WARN、ERROR）
- 支持标签化日志输出（service、module 等标签）
- 支持时间追踪（记录操作耗时）
- 管理日志文件输出和自动清理

说明：
- 各模块拥有自己的 logger 实例，utils 提供创建和管理机制
- 借鉴 OpenCode 的 Log 命名空间设计

### 2. 错误处理基类（error.ts）

负责：
- 提供 IrisError 基类，支持错误码和元数据
- 提供错误格式化函数
- 提供类型守卫函数（isInstance）

说明：
- 各模块继承 IrisError 定义自己的错误类型
- utils 仅提供基类，不定义具体业务错误
- 遵循分布定义 + 基类共享模式

### 3. 生命周期清理（cleanup.ts）

负责：
- 提供清理函数注册机制
- 支持同步和异步清理函数
- 在程序退出时按序执行清理
- 忽略清理过程中的错误，确保所有清理函数都能执行

说明：
- 借鉴 Gemini-CLI 的 cleanup 设计
- 用于资源释放、临时文件清理、连接关闭等

### 4. 路径操作（paths.ts）

负责：
- 项目路径管理（配置目录、权限文件等）
- 路径规范化（处理 Windows 路径大小写问题）
- 子路径包含检查（用于权限验证）
- 路径交集检查

说明：
- 合并现有 paths.ts 和新增的规范化功能
- 借鉴 OpenCode 的 Filesystem 工具

### 5. 文件类型检测（file-type.ts）

负责：
- 基于扩展名判断文件是否为文本文件
- 基于内容判断文件是否为文本文件
- MIME 类型解析

说明：
- 保留现有实现，无需大改动

### 6. 懒加载（lazy.ts）

负责：
- 提供懒加载函数，延迟初始化高开销资源
- 支持同步和异步懒加载
- 确保初始化函数只执行一次

说明：
- MCP 模块使用懒加载模式初始化客户端
- 借鉴 OpenCode 的 lazy 设计

### 7. 资源释放（defer.ts）

负责：
- 提供 defer 函数，支持 Symbol.dispose 协议
- 确保资源在作用域结束时自动释放

说明：
- 借鉴 OpenCode 的 defer 设计
- 需要 TypeScript 5.2+ 支持

### 8. 文本格式化（format.ts）

负责：
- 为文件内容添加行号（类似 cat -n）
- 处理超长行的分割显示
- 检查空内容并返回提示

说明：
- 借鉴 DeepAgentsJS 的 formatContentWithLineNumbers
- 用于文件读取工具的结果展示

### 9. 智能截断（truncate.ts）

负责：
- 根据 token 限制截断过长结果
- 支持字符串和数组的截断
- 添加截断提示信息

说明：
- 借鉴 DeepAgentsJS 的 truncateIfTooLong
- 用于防止工具结果超出 LLM 上下文限制

### 10. 会话总结（summary.ts）

负责：
- 构建会话总结提示
- 格式化会话历史

说明：
- 保留现有实现

### 11. 测试辅助（testHelpers.ts）

负责：
- 提供测试用临时项目创建
- 提供测试用权限配置

说明：
- 保留现有实现

### 12. 命令解析（command-parser/）

负责：
- 解析 Shell 命令，提取命令头部和参数
- 支持 bash 语法（Unix/macOS/Git Bash）使用 tree-sitter-bash
- 支持 PowerShell 语法（Windows）使用 PowerShell 原生 AST 解析
- 提供 `getCommandRoots(command)` 接口，提取命令头部列表
- 提供 `detectPaths(command)` 接口，检测命令中的路径参数

说明：
- 借鉴 gemini-cli 的 `shell-utils.ts` 设计
- 被 tools/bash、policy、permission 模块使用
- 根据 Shell 模块检测到的当前 shell 类型选择对应的解析器
- 不执行命令，只做语法解析

---

## 三、Non-Duties（非职责）

### 1. 不负责工具（Tool）实现

工具的实现（fileRead、grep、bash 等）由 tools 模块负责。utils 不包含任何具体工具逻辑。

### 2. 不负责 glob/grep 搜索

文件搜索功能由 tools/glob.ts 和 tools/grep.ts 提供。utils 的路径工具仅提供基础路径操作。

### 3. 不负责会话/消息 ID 生成

当前 sessions/types.ts 的 randomId 函数满足需求。utils 不提供额外的 ID 生成器。

### 4. 不负责 AsyncLocalStorage 上下文

当前 ohbaby-agent 使用显式参数传递上下文，无需隐式上下文管理。

### 5. 不负责配置管理

配置的加载、验证、持久化由 config 模块负责。utils 不涉及配置逻辑。

### 6. 不负责权限检查

权限检查由 permissions 模块负责。utils 的路径工具仅提供 contains 等辅助函数。

### 7. 不负责重试机制

重试机制与 LLM 调用紧密相关，由 llm-client 模块实现。

### 8. 不定义具体业务错误类型

具体的错误类型（如 PermissionDeniedError、ToolExecutionError）由各业务模块定义。utils 仅提供 IrisError 基类。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| agent | 被依赖 | 使用 logger、cleanup |
| tools | 被依赖 | 使用 paths、file-type、format、truncate、command-parser |
| permissions | 被依赖 | 使用 paths（contains 检查）、command-parser（Pattern 生成） |
| policy | 被依赖 | 使用 command-parser（关键操作检测） |
| sessions | 被依赖 | 使用 summary |
| llm | 被依赖 | 使用 logger、error |
| config | 被依赖 | 使用 paths |
| mcp | 被依赖 | 使用 lazy、logger |
| ui | 被依赖 | 使用 logger |

说明：
- utils 是底层模块，被上层模块依赖
- utils 不依赖任何业务模块，避免循环依赖

---

## 五、模块边界示例

### 5.1 职责内的示例

正确：utils 提供 logger 工厂
```typescript
// utils/logger.ts
export namespace Log {
  export function create(tags?: Record<string, string>): Logger
}

// tools/bash.ts 使用
const log = Log.create({ service: 'bash-tool' })
log.info('Command executed', { command, exitCode })
```

正确：utils 提供错误基类
```typescript
// utils/error.ts
export class IrisError extends Error {
  constructor(public code: string, message: string) { ... }
}

// permissions/errors.ts 继承
export class PermissionDeniedError extends IrisError {
  constructor(path: string) {
    super('PERMISSION_DENIED', `Access denied: ${path}`)
  }
}
```

### 5.2 职责外的示例

错误：utils 不应定义业务错误
```typescript
// 错误：不应该在 utils/error.ts 中
export class ToolExecutionError extends IrisError { ... }
export class LLMError extends IrisError { ... }

// 正确：由各模块自己定义
```

错误：utils 不应包含工具实现
```typescript
// 错误：不应该在 utils 中
export async function grepSearch(pattern: string, path: string) { ... }

// 正确：由 tools/grep.ts 实现
```

---

## 六、设计约束

### 1. 无外部依赖原则

utils 模块尽量不引入外部 npm 依赖，使用 Node.js 标准库实现功能。

例外：
- zod：如果错误系统需要 schema 验证（当前设计不需要）

### 2. 无循环依赖原则

utils 不依赖任何上层业务模块。如果发现需要依赖，应重新审视设计。

### 3. 向后兼容原则

utils 的公开 API 应保持稳定，修改需考虑对依赖模块的影响。

---

## 七、文档自检

- 可以用一句话说明该模块的存在意义：utils 模块为 ohbaby-agent 提供统一的底层工具函数和基础设施
- 能清楚回答"这个模块不该做什么"：不做工具实现、不做配置管理、不做权限检查、不做重试机制
- 职责与其他模块无明显重叠：与 tools（工具实现）、config（配置）、permissions（权限）边界清晰
