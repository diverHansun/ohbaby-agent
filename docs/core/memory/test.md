# memory 模块 test.md

本文档描述 `memory` 模块的测试策略和测试用例。

---

## 一、Testing Goals（测试目标）

### 1.1 核心测试目标

1. **文件操作准确性**：确保 IRIS.md 文件的读写操作正确无误
2. **向上查找逻辑**：验证从子目录向上查找 IRIS.md 的行为
3. **记忆合并正确性**：确保全局和项目记忆正确合并并添加来源标记
4. **条目解析准确性**：验证 AI 添加区域的条目解析逻辑
5. **错误处理健壮性**：确保各种异常情况都能优雅处理

### 1.2 覆盖率目标

| 指标 | 目标 |
|------|------|
| 行覆盖率 | ≥ 90% |
| 分支覆盖率 | ≥ 85% |
| 函数覆盖率 | 100% |

---

## 二、Test Strategy（测试策略）

### 2.1 测试类型分布

| 类型 | 占比 | 重点 |
|------|------|------|
| 单元测试 | 60% | 核心函数逻辑（parseEntries, computeNewContent） |
| 集成测试 | 30% | 文件系统操作、向上查找 |
| 边界测试 | 10% | 特殊情况处理（文件不存在、索引越界） |

### 2.2 Mock 策略

| 依赖 | Mock 方式 | 原因 |
|------|----------|------|
| fs/promises | 部分 Mock | 单元测试时 mock，集成测试时使用真实文件系统 |
| Project.fromDirectory | 完全 Mock | 避免依赖 Project 模块实现 |
| Bus.publish | 完全 Mock | 验证事件发布，不依赖 Bus 实现 |

---

## 三、Test Cases（测试用例）

### 3.1 Memory.load 测试

#### TC-001: 加载全局和项目记忆

```typescript
describe('Memory.load', () => {
  it('应正确加载并合并全局和项目记忆', async () => {
    // Given: 全局和项目 IRIS.md 都存在
    mockFs({
      '~/.config/iris-code/IRIS.md': '# Global Rules\n\n## Iris Added Memories\n- 2026-01-01 20:00:00: 全局记忆',
      '/project/IRIS.md': '# Project Context\n\n## Iris Added Memories\n- 2026-01-01 21:00:00: 项目记忆'
    })
    mockProject({ rootPath: '/project' })
    
    // When
    const result = await Memory.load('/project/src')
    
    // Then
    expect(result.global).toContain('Global Rules')
    expect(result.project).toContain('Project Context')
    expect(result.merged).toContain('<!-- Global Memory')
    expect(result.merged).toContain('<!-- Project Memory')
    expect(result.merged).toContain('---')
  })
  
  it('只有全局记忆时应正确返回', async () => {
    mockFs({
      '~/.config/iris-code/IRIS.md': 'Global content'
      // 项目记忆不存在
    })
    mockProject({ rootPath: '/project' })
    
    const result = await Memory.load('/project')
    
    expect(result.global).toBe('Global content')
    expect(result.project).toBe('')
    expect(result.merged).toContain('Global content')
    expect(result.merged).not.toContain('Project Memory')
  })
  
  it('记忆文件不存在时应返回空字符串', async () => {
    mockFs({})  // 无文件
    mockProject({ rootPath: '/project' })
    
    const result = await Memory.load('/project')
    
    expect(result.global).toBe('')
    expect(result.project).toBe('')
    expect(result.merged).toBe('')
  })
})
```

#### TC-002: 向上查找项目记忆

```typescript
describe('Memory.load - 向上查找', () => {
  it('应从子目录向上查找 IRIS.md', async () => {
    // Given: 项目根目录有 IRIS.md，当前在子目录
    mockFs({
      '/project/IRIS.md': 'Project memory',
      '/project/src/components': {}  // 当前目录
    })
    mockProject({ rootPath: '/project' })
    
    // When: 从 components 目录加载
    const result = await Memory.load('/project/src/components')
    
    // Then: 应找到项目根的 IRIS.md
    expect(result.project).toBe('Project memory')
  })
  
  it('应找到第一个 IRIS.md 即停止', async () => {
    // Given: 多个目录都有 IRIS.md
    mockFs({
      '/project/IRIS.md': 'Root memory',
      '/project/src/IRIS.md': 'Src memory',
      '/project/src/components': {}
    })
    mockProject({ rootPath: '/project' })
    
    // When: 从 components 向上查找
    const result = await Memory.load('/project/src/components')
    
    // Then: 应返回 src/IRIS.md（第一个找到的）
    expect(result.project).toBe('Src memory')
  })
})
```

---

### 3.2 Memory.add 测试

#### TC-003: 添加全局记忆

```typescript
describe('Memory.add', () => {
  it('应添加记忆到全局文件', async () => {
    mockFs({
      '~/.config/iris-code/IRIS.md': 'Old content\n\n## Iris Added Memories\n- 2026-01-01 20:00:00: Old fact'
    })
    mockTimestamp('2026-01-01 22:00:00')
    
    await Memory.add({
      scope: 'global',
      fact: 'New fact'
    })
    
    const written = getWrittenContent('~/.config/iris-code/IRIS.md')
    expect(written).toContain('Old fact')
    expect(written).toContain('- 2026-01-01 22:00:00: New fact')
  })
  
  it('首次添加时应创建文件和 Header', async () => {
    mockFs({})  // 文件不存在
    mockTimestamp('2026-01-01 22:00:00')
    
    await Memory.add({
      scope: 'global',
      fact: 'First fact'
    })
    
    const written = getWrittenContent('~/.config/iris-code/IRIS.md')
    expect(written).toContain('## Iris Added Memories')
    expect(written).toContain('- 2026-01-01 22:00:00: First fact')
  })
  
  it('应发布 Added 事件', async () => {
    mockFs({})
    const busPublish = vi.spyOn(Bus, 'publish')
    
    await Memory.add({ scope: 'global', fact: 'Test' })
    
    expect(busPublish).toHaveBeenCalledWith(
      Memory.Event.Added,
      { scope: 'global', text: 'Test' }
    )
  })
})
```

---

### 3.3 Memory.listEntries 测试

#### TC-004: 解析记忆条目

```typescript
describe('Memory.listEntries', () => {
  it('应正确解析 AI 添加区域的条目', async () => {
    mockFs({
      '~/.config/iris-code/IRIS.md': `
用户手写内容

## Iris Added Memories

- 2026-01-01 20:00:00: First fact
- 2026-01-01 20:05:00: Second fact
- 2026-01-01 20:10:00: Third fact
      `.trim()
    })
    
    const entries = await Memory.listEntries('global')
    
    expect(entries).toHaveLength(3)
    expect(entries[0]).toEqual({
      index: 0,
      timestamp: '2026-01-01 20:00:00',
      text: 'First fact'
    })
    expect(entries[2]).toEqual({
      index: 2,
      timestamp: '2026-01-01 20:10:00',
      text: 'Third fact'
    })
  })
  
  it('应忽略非列表格式的内容', async () => {
    mockFs({
      '~/.config/iris-code/IRIS.md': `
## Iris Added Memories

这是一些说明文字（不是列表）

- 2026-01-01 20:00:00: Valid fact

更多非列表内容
      `.trim()
    })
    
    const entries = await Memory.listEntries('global')
    
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe('Valid fact')
  })
  
  it('Header 不存在时应返回空数组', async () => {
    mockFs({
      '~/.config/iris-code/IRIS.md': '用户手写内容，没有 Header'
    })
    
    const entries = await Memory.listEntries('global')
    
    expect(entries).toEqual([])
  })
})
```

---

### 3.4 Memory.update 测试

#### TC-005: 更新记忆条目

```typescript
describe('Memory.update', () => {
  it('应更新指定索引的条目', async () => {
    mockFs({
      '~/.config/iris-code/IRIS.md': `
用户手写内容

## Iris Added Memories

- 2026-01-01 20:00:00: Old text 1
- 2026-01-01 20:05:00: Old text 2
- 2026-01-01 20:10:00: Old text 3
      `.trim()
    })
    
    await Memory.update({
      scope: 'global',
      index: 1,
      newText: 'Updated text 2'
    })
    
    const written = getWrittenContent('~/.config/iris-code/IRIS.md')
    expect(written).toContain('Old text 1')
    expect(written).toContain('Updated text 2')
    expect(written).toContain('Old text 3')
    expect(written).not.toContain('Old text 2')
    // 保持用户手写内容
    expect(written).toContain('用户手写内容')
  })
  
  it('索引越界时应抛出异常', async () => {
    mockFs({
      '~/.config/iris-code/IRIS.md': '## Iris Added Memories\n- 2026-01-01 20:00:00: Only one'
    })
    
    await expect(
      Memory.update({
        scope: 'global',
        index: 5,  // 越界
        newText: 'New'
      })
    ).rejects.toThrow(RangeError)
  })
})
```

---

### 3.5 Memory.remove 测试

#### TC-006: 删除记忆条目

```typescript
describe('Memory.remove', () => {
  it('应删除指定索引的条目', async () => {
    mockFs({
      '~/.config/iris-code/IRIS.md': `
## Iris Added Memories

- 2026-01-01 20:00:00: Fact 1
- 2026-01-01 20:05:00: Fact 2
- 2026-01-01 20:10:00: Fact 3
      `.trim()
    })
    
    await Memory.remove({
      scope: 'global',
      index: 1  // 删除 Fact 2
    })
    
    const written = getWrittenContent('~/.config/iris-code/IRIS.md')
    expect(written).toContain('Fact 1')
    expect(written).toContain('Fact 3')
    expect(written).not.toContain('Fact 2')
    
    // 验证剩余条目索引正确
    const entries = await Memory.listEntries('global')
    expect(entries).toHaveLength(2)
    expect(entries[0].index).toBe(0)
    expect(entries[1].index).toBe(1)
  })
})
```

---

### 3.6 错误处理测试

#### TC-007: 文件读写错误

```typescript
describe('Memory - 错误处理', () => {
  it('文件不可读时应返回空字符串并记录警告', async () => {
    mockFs({
      '~/.config/iris-code/IRIS.md': { readable: false }
    })
    const warnLog = vi.spyOn(console, 'warn')
    
    const result = await Memory.load('/project')
    
    expect(result.global).toBe('')
    expect(warnLog).toHaveBeenCalled()
  })
  
  it('写入失败时应抛出异常', async () => {
    mockFs({
      '~/.config/iris-code': { writable: false }
    })
    
    await expect(
      Memory.add({ scope: 'global', fact: 'Test' })
    ).rejects.toThrow()
  })
  
  it('文件过大时应记录警告但仍读取', async () => {
    const largContent = 'a'.repeat(2 * 1024 * 1024)  // 2MB
    mockFs({
      '~/.config/iris-code/IRIS.md': largeContent
    })
    const warnLog = vi.spyOn(console, 'warn')
    
    const result = await Memory.load('/project')
    
    expect(result.global).toBe(largeContent)
    expect(warnLog).toHaveBeenCalledWith(
      expect.stringContaining('large file')
    )
  })
})
```

---

## 四、Test Utilities（测试工具）

### 4.1 Mock 工具

```typescript
// test/memory/helpers.ts

import { vi } from 'vitest'

/**
 * Mock 文件系统
 */
export function mockFs(files: Record<string, string | any>) {
  vi.mock('fs/promises', () => ({
    readFile: vi.fn(async (path: string) => {
      if (files[path]) {
        if (typeof files[path] === 'string') {
          return files[path]
        }
        if (files[path].readable === false) {
          throw new Error('EACCES: permission denied')
        }
      }
      throw new Error('ENOENT: no such file')
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      const dir = path.split('/').slice(0, -1).join('/')
      if (files[dir]?.writable === false) {
        throw new Error('EACCES: permission denied')
      }
      files[path] = content
    }),
    mkdir: vi.fn(async () => {}),
    access: vi.fn(async (path: string) => {
      if (!files[path]) throw new Error('ENOENT')
    })
  }))
}

/**
 * Mock Project 模块
 */
export function mockProject(projectInfo: { rootPath: string }) {
  vi.mock('@/project', () => ({
    Project: {
      fromDirectory: vi.fn(async () => ({
        id: 'test-project',
        rootPath: projectInfo.rootPath,
        vcs: 'git'
      }))
    }
  }))
}

/**
 * Mock 时间戳
 */
export function mockTimestamp(timestamp: string) {
  vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(
    timestamp.replace(' ', 'T') + '.000Z'
  )
}

/**
 * 获取写入的文件内容
 */
export function getWrittenContent(path: string): string {
  const writeFile = vi.mocked(fs.writeFile)
  const calls = writeFile.mock.calls.filter((call) => call[0] === path)
  return calls[calls.length - 1]?.[1] as string || ''
}
```

### 4.2 测试数据

```typescript
// test/memory/fixtures.ts

export const SAMPLE_GLOBAL_MEMORY = `
# Global Preferences

User prefers TypeScript over JavaScript.

## Iris Added Memories

- 2026-01-01 20:00:00: User prefers strict mode
- 2026-01-01 20:05:00: User likes detailed comments
`.trim()

export const SAMPLE_PROJECT_MEMORY = `
# Project Guidelines

This project uses Vitest for testing.

## Iris Added Memories

- 2026-01-01 21:00:00: Project uses shadcn/ui
- 2026-01-01 21:05:00: Project follows atomic design
`.trim()
```

---

## 五、Integration Tests（集成测试）

### 5.1 真实文件系统测试

```typescript
describe('Integration: Real Filesystem', () => {
  let tempDir: string
  
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-test-'))
  })
  
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })
  
  it('应正确读写真实 IRIS.md 文件', async () => {
    // 创建全局配置目录
    const globalDir = path.join(tempDir, '.config', 'iris-code')
    await fs.mkdir(globalDir, { recursive: true })
    const globalPath = path.join(globalDir, 'IRIS.md')
    
    // 添加记忆
    await Memory.add({
      scope: 'global',
      fact: 'Integration test fact'
    })
    
    // 验证文件存在
    const content = await fs.readFile(globalPath, 'utf-8')
    expect(content).toContain('Integration test fact')
    expect(content).toContain('## Iris Added Memories')
  })
})
```

---

## 六、Execution（执行方式）

### 6.1 运行命令

```bash
# 运行所有 memory 模块测试
npm run test -- src/core/memory

# 运行并显示覆盖率
npm run test -- src/core/memory --coverage

# 监听模式
npm run test -- src/core/memory --watch

# 集成测试
npm run test -- src/core/memory --integration
```

### 6.2 CI 集成

```yaml
# .github/workflows/test.yml
- name: Test Memory Module
  run: npm run test -- src/core/memory --coverage
  
- name: Check Coverage
  run: |
    COVERAGE=$(cat coverage/coverage-summary.json | jq '.total.lines.pct')
    if [ $(echo "$COVERAGE < 90" | bc) -eq 1 ]; then
      echo "Coverage $COVERAGE% is below 90%"
      exit 1
    fi
```

---

## 七、文档自检

- [x] 测试用例覆盖所有公开接口
- [x] 包含正常和异常场景
- [x] 提供了完整的 Mock 工具
- [x] 包含集成测试方案
- [x] 明确了覆盖率目标
- [x] 向上查找逻辑有专门测试
- [x] 条目解析和文件格式有详细测试
