# utils 模块 data-model.md

本文档描述 utils 模块的核心概念与数据模型。由于 utils 是工具函数集合，本文档采用极简形式。

---

## 一、Core Concepts（核心概念）

### Logger

日志记录器实例，由各模块通过工厂函数创建。

```typescript
interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
  tag(key: string, value: string): Logger
  time(message: string): Disposable
}
```

说明：
- 每个 Logger 实例携带自己的标签（如 service=bash）
- tag() 方法返回新的 Logger，支持链式调用
- time() 方法返回 Disposable，用于自动记录操作耗时

### IrisError

错误基类，所有业务错误应继承此类。

```typescript
class IrisError extends Error {
  readonly code: string           // 错误码，如 'PERMISSION_DENIED'
  readonly data?: Record<string, unknown>  // 附加数据
}
```

说明：
- code 用于程序化错误识别
- data 用于携带上下文信息
- 提供 toObject() 方法支持序列化

### CleanupFn

清理函数类型，支持同步和异步。

```typescript
type CleanupFn = (() => void) | (() => Promise<void>)
```

说明：
- 同步清理函数用于简单资源释放
- 异步清理函数用于需要等待的操作（如关闭连接）

---

## 二、Key Data Types（关键数据类型）

### Log.Level

日志级别枚举。

```typescript
type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
```

优先级：DEBUG < INFO < WARN < ERROR

### Log.InitOptions

日志系统初始化选项。

```typescript
interface InitOptions {
  print?: boolean      // true: 仅输出到 stderr；false: 写入文件
  level?: Level        // 全局日志级别
  maxFiles?: number    // 保留的日志文件数量，默认 10
}
```

### FormatOptions

文本格式化选项。

```typescript
interface FormatOptions {
  startLine?: number      // 起始行号，默认 1
  maxLineLength?: number  // 单行最大长度，默认 10000
}
```

---

## 三、Design Notes（设计说明）

### 为什么 data-model 极简

utils 模块的特点：
- 工具函数集合，不管理复杂状态
- 数据模型简单，主要是类型定义
- 核心概念少且稳定

因此本文档仅列出关键类型，不做过度展开。

### 类型定义的位置

- Logger、IrisError 等类型定义在各自的源文件中
- index.ts 统一导出类型
- 使用模块不需要单独导入类型文件

---

## 四、与后续文档的关系

- dfd-interface.md 中的接口使用这里定义的类型
- test.md 中的测试用例验证这些类型的行为
