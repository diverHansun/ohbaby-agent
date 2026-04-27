# utils 模块 test.md

本文档描述 utils 模块的测试策略与验证方案。

---

## 一、测试范围

### 核心测试目标

| 组件 | 测试优先级 | 说明 |
|------|-----------|------|
| logger.ts | 高 | 日志输出格式、级别过滤、文件管理 |
| error.ts | 高 | 错误类继承、类型守卫、序列化 |
| cleanup.ts | 高 | 清理函数注册与执行顺序 |
| paths.ts | 高 | 路径规范化、包含检查 |
| lazy.ts | 中 | 懒加载行为、缓存机制 |
| defer.ts | 中 | Disposable 协议 |
| format.ts | 中 | 行号格式化、超长行处理 |
| truncate.ts | 中 | 截断逻辑、边界条件 |
| file-type.ts | 低 | 现有测试覆盖 |
| summary.ts | 低 | 现有测试覆盖 |

---

## 二、单元测试

### 2.1 logger.ts 测试

#### 测试文件

`src/utils/__tests__/logger.test.ts`

#### 测试用例

```typescript
describe('Log', () => {
  describe('create', () => {
    it('应该创建带有 service 标签的 logger', () => {
      const log = Log.create({ service: 'test' })
      // 验证 logger 实例包含正确的标签
    })

    it('应该支持无标签创建', () => {
      const log = Log.create()
      // 验证可以正常使用
    })
  })

  describe('级别过滤', () => {
    it('INFO 级别应该过滤 DEBUG 日志', () => {
      Log.setLevel('INFO')
      // 验证 debug 日志不输出
    })

    it('ERROR 级别应该只输出 ERROR 日志', () => {
      Log.setLevel('ERROR')
      // 验证只有 error 日志输出
    })
  })

  describe('日志格式', () => {
    it('应该包含时间戳', () => {
      // 验证日志输出包含 ISO 格式时间戳
    })

    it('应该包含耗时', () => {
      // 验证日志输出包含 +Xms 格式耗时
    })

    it('应该包含标签', () => {
      const log = Log.create({ service: 'test', module: 'foo' })
      // 验证日志输出包含 service=test module=foo
    })
  })

  describe('time 方法', () => {
    it('应该记录操作耗时', async () => {
      const log = Log.create({ service: 'test' })
      using timer = log.time('operation')
      await sleep(100)
      // 验证输出包含 duration>=100
    })
  })

  describe('tag 方法', () => {
    it('应该返回新的 logger 实例', () => {
      const log1 = Log.create({ service: 'test' })
      const log2 = log1.tag('key', 'value')
      // 验证 log1 !== log2
      // 验证 log2 包含新标签
    })
  })
})
```

#### 文件管理测试

```typescript
describe('日志文件管理', () => {
  it('应该在初始化时创建日志文件', async () => {
    await Log.init({ print: false })
    const logPath = Log.file()
    // 验证文件存在
  })

  it('应该自动清理旧日志文件', async () => {
    // 创建超过 maxFiles 数量的日志文件
    await Log.init({ print: false, maxFiles: 5 })
    // 验证旧文件被删除
  })
})
```

### 2.2 error.ts 测试

#### 测试文件

`src/utils/__tests__/error.test.ts`

#### 测试用例

```typescript
describe('IrisError', () => {
  describe('构造函数', () => {
    it('应该正确设置 code 和 message', () => {
      const error = new IrisError('TEST_ERROR', 'Test message')
      expect(error.code).toBe('TEST_ERROR')
      expect(error.message).toBe('Test message')
    })

    it('应该支持附加数据', () => {
      const error = new IrisError('TEST_ERROR', 'Test', { key: 'value' })
      expect(error.data).toEqual({ key: 'value' })
    })

    it('应该支持 cause 链', () => {
      const cause = new Error('Original error')
      const error = new IrisError('WRAPPED', 'Wrapped', undefined, { cause })
      expect(error.cause).toBe(cause)
    })
  })

  describe('isInstance', () => {
    it('应该识别 IrisError 实例', () => {
      const error = new IrisError('TEST', 'Test')
      expect(IrisError.isInstance(error)).toBe(true)
    })

    it('应该识别子类实例', () => {
      class MyError extends IrisError {}
      const error = new MyError('TEST', 'Test')
      expect(IrisError.isInstance(error)).toBe(true)
    })

    it('应该拒绝普通 Error', () => {
      const error = new Error('Test')
      expect(IrisError.isInstance(error)).toBe(false)
    })

    it('应该拒绝非 Error 值', () => {
      expect(IrisError.isInstance(null)).toBe(false)
      expect(IrisError.isInstance('string')).toBe(false)
      expect(IrisError.isInstance({})).toBe(false)
    })
  })

  describe('toObject', () => {
    it('应该正确序列化', () => {
      const error = new IrisError('CODE', 'Message', { key: 'value' })
      expect(error.toObject()).toEqual({
        code: 'CODE',
        message: 'Message',
        data: { key: 'value' }
      })
    })
  })
})

describe('formatError', () => {
  it('应该格式化 IrisError', () => {
    const error = new IrisError('TEST', 'Test message')
    expect(formatError(error)).toBe('[TEST] Test message')
  })

  it('应该格式化普通 Error', () => {
    const error = new Error('Test message')
    expect(formatError(error)).toBe('Test message')
  })

  it('应该处理非 Error 值', () => {
    expect(formatError('string error')).toBe('string error')
  })
})
```

### 2.3 cleanup.ts 测试

#### 测试文件

`src/utils/__tests__/cleanup.test.ts`

#### 测试用例

```typescript
describe('cleanup', () => {
  beforeEach(() => {
    // 清空已注册的清理函数
  })

  describe('registerCleanup', () => {
    it('应该注册同步清理函数', () => {
      const fn = vi.fn()
      registerCleanup(fn)
      // 验证函数被注册
    })

    it('应该注册异步清理函数', () => {
      const fn = vi.fn().mockResolvedValue(undefined)
      registerCleanup(fn)
      // 验证函数被注册
    })
  })

  describe('runExitCleanup', () => {
    it('应该执行所有清理函数', async () => {
      const fn1 = vi.fn()
      const fn2 = vi.fn().mockResolvedValue(undefined)
      registerCleanup(fn1)
      registerCleanup(fn2)

      await runExitCleanup()

      expect(fn1).toHaveBeenCalled()
      expect(fn2).toHaveBeenCalled()
    })

    it('应该先执行同步清理再执行异步清理', async () => {
      const order: number[] = []
      registerSyncCleanup(() => order.push(1))
      registerCleanup(async () => order.push(2))

      await runExitCleanup()

      expect(order).toEqual([1, 2])
    })

    it('应该忽略清理函数中的错误', async () => {
      const fn1 = vi.fn().mockRejectedValue(new Error('fail'))
      const fn2 = vi.fn()
      registerCleanup(fn1)
      registerCleanup(fn2)

      await runExitCleanup()

      expect(fn2).toHaveBeenCalled()
    })

    it('应该清空清理函数列表', async () => {
      const fn = vi.fn()
      registerCleanup(fn)

      await runExitCleanup()
      await runExitCleanup()

      expect(fn).toHaveBeenCalledTimes(1)
    })
  })
})
```

### 2.4 paths.ts 测试

#### 测试文件

`src/utils/__tests__/paths.test.ts`

#### 测试用例

```typescript
describe('paths', () => {
  describe('normalizePath', () => {
    it('应该规范化路径分隔符', () => {
      // Windows 特定测试
      if (process.platform === 'win32') {
        expect(normalizePath('C:\\Users\\test')).toMatch(/^C:/)
      }
    })

    it('应该处理不存在的路径', () => {
      // 应该回退到 path.normalize
      expect(normalizePath('/nonexistent/path')).toBe('/nonexistent/path')
    })
  })

  describe('contains', () => {
    it('应该识别子路径', () => {
      expect(contains('/project', '/project/src/file.ts')).toBe(true)
    })

    it('应该拒绝非子路径', () => {
      expect(contains('/project', '/other/file.ts')).toBe(false)
    })

    it('应该拒绝相同路径', () => {
      expect(contains('/project', '/project')).toBe(false)
    })

    it('应该处理尾部斜杠', () => {
      expect(contains('/project/', '/project/src')).toBe(true)
    })

    it('应该防止路径遍历攻击', () => {
      expect(contains('/project', '/project/../etc/passwd')).toBe(false)
    })
  })

  describe('overlaps', () => {
    it('应该识别包含关系', () => {
      expect(overlaps('/project', '/project/src')).toBe(true)
      expect(overlaps('/project/src', '/project')).toBe(true)
    })

    it('应该拒绝无关系路径', () => {
      expect(overlaps('/project', '/other')).toBe(false)
    })
  })

  describe('ProjectPaths', () => {
    it('应该返回正确的配置目录名', () => {
      expect(ProjectPaths.CONFIG_DIR).toBe('.ohbaby-agent')
    })

    it('应该生成正确的全局配置路径', () => {
      const globalPath = ProjectPaths.getGlobalConfigPath()
      expect(globalPath).toContain('.ohbaby-agent')
      expect(globalPath).toContain('config.json')
    })
  })
})
```

### 2.5 lazy.ts 测试

#### 测试文件

`src/utils/__tests__/lazy.test.ts`

#### 测试用例

```typescript
describe('lazy', () => {
  describe('同步懒加载', () => {
    it('应该延迟执行初始化函数', () => {
      const init = vi.fn(() => 'value')
      const getter = lazy(init)

      expect(init).not.toHaveBeenCalled()
      getter()
      expect(init).toHaveBeenCalledTimes(1)
    })

    it('应该缓存初始化结果', () => {
      const init = vi.fn(() => 'value')
      const getter = lazy(init)

      getter()
      getter()
      getter()

      expect(init).toHaveBeenCalledTimes(1)
    })

    it('应该返回初始化结果', () => {
      const getter = lazy(() => ({ key: 'value' }))
      expect(getter()).toEqual({ key: 'value' })
    })
  })

  describe('异步懒加载', () => {
    it('应该延迟执行异步初始化', async () => {
      const init = vi.fn().mockResolvedValue('value')
      const getter = lazyAsync(init)

      expect(init).not.toHaveBeenCalled()
      await getter()
      expect(init).toHaveBeenCalledTimes(1)
    })

    it('应该复用同一个 Promise', async () => {
      const init = vi.fn().mockResolvedValue('value')
      const getter = lazyAsync(init)

      const p1 = getter()
      const p2 = getter()

      expect(p1).toBe(p2)
      expect(init).toHaveBeenCalledTimes(1)
    })

    it('应该正确处理初始化错误', async () => {
      const getter = lazyAsync(async () => {
        throw new Error('init failed')
      })

      await expect(getter()).rejects.toThrow('init failed')
    })
  })
})
```

### 2.6 defer.ts 测试

#### 测试文件

`src/utils/__tests__/defer.test.ts`

#### 测试用例

```typescript
describe('defer', () => {
  it('应该在作用域结束时执行清理', () => {
    const cleanup = vi.fn()

    {
      using _ = defer(cleanup)
    }

    expect(cleanup).toHaveBeenCalled()
  })

  it('应该支持异步清理函数', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined)

    {
      using _ = defer(cleanup)
    }

    expect(cleanup).toHaveBeenCalled()
  })
})
```

### 2.7 format.ts 测试

#### 测试文件

`src/utils/__tests__/format.test.ts`

#### 测试用例

```typescript
describe('format', () => {
  describe('formatWithLineNumbers', () => {
    it('应该添加行号', () => {
      const result = formatWithLineNumbers('line1\nline2\nline3')
      expect(result).toContain('1')
      expect(result).toContain('line1')
    })

    it('应该支持自定义起始行号', () => {
      const result = formatWithLineNumbers('line1', { startLine: 10 })
      expect(result).toContain('10')
    })

    it('应该处理超长行', () => {
      const longLine = 'a'.repeat(15000)
      const result = formatWithLineNumbers(longLine, { maxLineLength: 10000 })
      // 验证行被分割
      expect(result).toContain('1.1')
      expect(result).toContain('1.2')
    })

    it('应该处理字符串数组输入', () => {
      const result = formatWithLineNumbers(['line1', 'line2'])
      expect(result).toContain('1')
      expect(result).toContain('2')
    })
  })

  describe('checkEmptyContent', () => {
    it('应该检测空内容', () => {
      expect(checkEmptyContent('')).not.toBeNull()
      expect(checkEmptyContent('   ')).not.toBeNull()
    })

    it('应该通过非空内容', () => {
      expect(checkEmptyContent('content')).toBeNull()
    })
  })
})
```

### 2.8 truncate.ts 测试

#### 测试文件

`src/utils/__tests__/truncate.test.ts`

#### 测试用例

```typescript
describe('truncate', () => {
  describe('truncateIfTooLong', () => {
    it('应该不截断短内容', () => {
      const result = truncateIfTooLong('short content')
      expect(result).toBe('short content')
    })

    it('应该截断超长字符串', () => {
      const longContent = 'a'.repeat(100000)
      const result = truncateIfTooLong(longContent, 1000)
      expect(result.length).toBeLessThan(longContent.length)
      expect(result).toContain('truncated')
    })

    it('应该截断超长数组', () => {
      const longArray = Array(1000).fill('item')
      const result = truncateIfTooLong(longArray, 100)
      expect(Array.isArray(result)).toBe(true)
      expect((result as string[]).length).toBeLessThan(longArray.length)
    })

    it('应该使用默认 token 限制', () => {
      const longContent = 'a'.repeat(100000)
      const result = truncateIfTooLong(longContent)
      // 默认 20000 tokens * 4 chars = 80000 chars
      expect(typeof result === 'string' && result.length <= 80000 + 100).toBe(true)
    })
  })
})
```

---

## 三、集成测试

### 3.1 日志系统集成测试

```typescript
describe('日志系统集成', () => {
  it('多模块日志应该正确隔离', () => {
    const log1 = Log.create({ service: 'module1' })
    const log2 = Log.create({ service: 'module2' })

    log1.info('message1')
    log2.info('message2')

    // 验证日志包含正确的 service 标签
  })

  it('日志文件应该包含所有模块的日志', async () => {
    await Log.init({ print: false })

    const log1 = Log.create({ service: 'module1' })
    const log2 = Log.create({ service: 'module2' })

    log1.info('message1')
    log2.info('message2')

    // 验证日志文件内容
    const content = await fs.readFile(Log.file(), 'utf-8')
    expect(content).toContain('service=module1')
    expect(content).toContain('service=module2')
  })
})
```

### 3.2 清理系统集成测试

```typescript
describe('清理系统集成', () => {
  it('应该按正确顺序执行多模块清理', async () => {
    const order: string[] = []

    // 模拟多个模块注册清理
    registerCleanup(() => order.push('mcp'))
    registerCleanup(async () => order.push('llm'))
    registerSyncCleanup(() => order.push('temp-files'))

    await runExitCleanup()

    // 同步清理先执行
    expect(order[0]).toBe('temp-files')
  })
})
```

### 3.3 路径与权限集成测试

```typescript
describe('路径检查集成', () => {
  it('应该与 permissions 模块正确配合', async () => {
    const projectDir = process.cwd()
    const targetPath = path.join(projectDir, 'src', 'file.ts')

    // 项目内文件应该通过
    expect(contains(projectDir, targetPath)).toBe(true)

    // 项目外文件应该拒绝
    const outsidePath = '/etc/passwd'
    expect(contains(projectDir, outsidePath)).toBe(false)
  })
})
```

---

## 四、测试覆盖率目标

| 组件 | 行覆盖率目标 | 分支覆盖率目标 |
|------|-------------|---------------|
| logger.ts | 80% | 70% |
| error.ts | 90% | 85% |
| cleanup.ts | 90% | 85% |
| paths.ts | 85% | 80% |
| lazy.ts | 95% | 90% |
| defer.ts | 90% | 85% |
| format.ts | 85% | 80% |
| truncate.ts | 85% | 80% |

---

## 五、测试环境要求

### 5.1 测试框架

- Vitest：测试运行器
- @vitest/coverage-v8：覆盖率收集

### 5.2 模拟工具

- vi.fn()：函数模拟
- vi.spyOn()：方法监视
- vi.useFakeTimers()：时间模拟

### 5.3 文件系统测试

- 使用临时目录进行文件操作测试
- 测试后清理临时文件
- 使用 testHelpers.createTempProject() 创建测试环境

---

## 六、测试命令

```bash
# 运行所有 utils 测试
pnpm test src/utils

# 运行特定文件测试
pnpm test src/utils/__tests__/logger.test.ts

# 生成覆盖率报告
pnpm test:coverage src/utils

# 监视模式
pnpm test:watch src/utils
```

---

## 七、文档自检

- 测试范围覆盖 goals-duty.md 中定义的所有职责
- 单元测试验证各组件的独立功能
- 集成测试验证组件间的协作
- 覆盖率目标明确
- 测试环境和命令清晰
