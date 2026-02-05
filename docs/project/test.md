# project 模块 test.md

本文档描述 `project` 模块的测试策略和测试用例。

---

## 一、Testing Goals（测试目标）

### 1.1 核心测试目标

1. **项目识别准确性**：确保 Git 项目和非 Git 目录都能正确识别
2. **ID 稳定性**：确保同一仓库多次调用返回相同 ID
3. **错误处理健壮性**：确保任何异常情况都能优雅降级
4. **边界条件覆盖**：覆盖各种特殊目录和边界情况

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
| 单元测试 | 70% | 核心函数逻辑 |
| 集成测试 | 20% | Git 命令执行 |
| 边界测试 | 10% | 特殊情况处理 |

### 2.2 Mock 策略

| 依赖 | Mock 方式 | 原因 |
|------|----------|------|
| fs 模块 | 完全 Mock | 控制文件系统状态 |
| child_process | 完全 Mock | 避免真实 Git 命令 |
| Git CLI | 输出 Mock | 模拟各种 Git 响应 |

---

## 三、Test Cases（测试用例）

### 3.1 fromDirectory 测试

#### TC-001: Git 项目识别

```typescript
describe('Project.fromDirectory', () => {
  describe('Git 项目', () => {
    it('应正确识别 Git 仓库根目录', async () => {
      // Given: 目录 /path/to/repo 包含 .git
      mockFs({
        '/path/to/repo/.git': mockDirectory(),
      })
      mockGitRevList('abc123def456')
      
      // When
      const result = await Project.fromDirectory('/path/to/repo')
      
      // Then
      expect(result.id).toBe('abc123def456')
      expect(result.rootPath).toBe('/path/to/repo')
      expect(result.vcs).toBe('git')
    })
    
    it('应从子目录向上查找 Git 根', async () => {
      // Given: /path/to/repo 是 Git 根，当前在 /path/to/repo/src/components
      mockFs({
        '/path/to/repo/.git': mockDirectory(),
        '/path/to/repo/src/components': mockDirectory(),
      })
      mockGitRevList('abc123def456')
      
      // When
      const result = await Project.fromDirectory('/path/to/repo/src/components')
      
      // Then
      expect(result.id).toBe('abc123def456')
      expect(result.rootPath).toBe('/path/to/repo')
    })
    
    it('多个 root commit 时应返回排序后的第一个', async () => {
      // Given: 仓库有多个 root commit（合并了不相关历史）
      mockGitRevList('zzz999\naaa111\nmm222')
      
      // When
      const result = await Project.fromDirectory('/path/to/repo')
      
      // Then
      expect(result.id).toBe('aaa111')
    })
  })
})
```

#### TC-002: 非 Git 目录处理

```typescript
describe('非 Git 目录', () => {
  it('应返回 global 项目', async () => {
    // Given: 目录不包含 .git
    mockFs({
      '/tmp/random-dir': mockDirectory(),
    })
    
    // When
    const result = await Project.fromDirectory('/tmp/random-dir')
    
    // Then
    expect(result.id).toBe('global')
    expect(result.rootPath).toBe('/tmp/random-dir')
    expect(result.vcs).toBeUndefined()
  })
  
  it('用户主目录应返回 global', async () => {
    // Given: 用户主目录通常不在 Git 仓库内
    vi.spyOn(os, 'homedir').mockReturnValue('/home/user')
    mockFs({
      '/home/user': mockDirectory(),
    })
    
    // When
    const result = await Project.fromDirectory('/home/user')
    
    // Then
    expect(result.id).toBe('global')
  })
})
```

#### TC-003: 错误降级处理

```typescript
describe('错误降级', () => {
  it('目录不存在时应返回 global', async () => {
    // Given: 目录不存在
    mockFs({})
    
    // When
    const result = await Project.fromDirectory('/nonexistent/path')
    
    // Then
    expect(result.id).toBe('global')
  })
  
  it('Git 命令失败时应返回 global', async () => {
    // Given: .git 存在但 Git 命令失败
    mockFs({
      '/path/to/repo/.git': mockDirectory(),
    })
    mockGitRevListError(new Error('git: command not found'))
    
    // When
    const result = await Project.fromDirectory('/path/to/repo')
    
    // Then
    expect(result.id).toBe('global')
  })
  
  it('Git 命令超时时应返回 global', async () => {
    // Given: Git 命令超时
    mockGitRevListTimeout()
    
    // When
    const result = await Project.fromDirectory('/path/to/repo')
    
    // Then
    expect(result.id).toBe('global')
  })
  
  it('空仓库（无 commit）应返回 global', async () => {
    // Given: Git 仓库没有任何 commit
    mockFs({
      '/path/to/repo/.git': mockDirectory(),
    })
    mockGitRevList('')  // 空输出
    
    // When
    const result = await Project.fromDirectory('/path/to/repo')
    
    // Then
    expect(result.id).toBe('global')
  })
})
```

### 3.2 getProjectRoot 测试

```typescript
describe('Project.getProjectRoot', () => {
  it('应返回 .git 所在目录', async () => {
    mockFs({
      '/path/to/repo/.git': mockDirectory(),
    })
    
    const root = await Project.getProjectRoot('/path/to/repo/src')
    
    expect(root).toBe('/path/to/repo')
  })
  
  it('未找到 .git 时应返回 null', async () => {
    mockFs({
      '/tmp/random': mockDirectory(),
    })
    
    const root = await Project.getProjectRoot('/tmp/random')
    
    expect(root).toBeNull()
  })
  
  it('应在文件系统根目录停止', async () => {
    // Given: 从深层目录开始，无 .git
    mockFs({
      '/a/b/c/d/e': mockDirectory(),
    })
    
    // When
    const root = await Project.getProjectRoot('/a/b/c/d/e')
    
    // Then
    expect(root).toBeNull()
    // 确保不会无限循环
  })
})
```

### 3.3 isGitProject 测试

```typescript
describe('Project.isGitProject', () => {
  it('Git 仓库内应返回 true', async () => {
    mockFs({
      '/path/to/repo/.git': mockDirectory(),
    })
    
    expect(await Project.isGitProject('/path/to/repo/src')).toBe(true)
  })
  
  it('非 Git 目录应返回 false', async () => {
    mockFs({
      '/tmp/random': mockDirectory(),
    })
    
    expect(await Project.isGitProject('/tmp/random')).toBe(false)
  })
})
```

### 3.4 ID 稳定性测试

```typescript
describe('ID 稳定性', () => {
  it('同一仓库多次调用应返回相同 ID', async () => {
    mockFs({
      '/path/to/repo/.git': mockDirectory(),
    })
    mockGitRevList('abc123')
    
    const result1 = await Project.fromDirectory('/path/to/repo/src')
    const result2 = await Project.fromDirectory('/path/to/repo/tests')
    const result3 = await Project.fromDirectory('/path/to/repo')
    
    expect(result1.id).toBe(result2.id)
    expect(result2.id).toBe(result3.id)
    expect(result1.rootPath).toBe(result2.rootPath)
  })
  
  it('不同非 Git 目录都应返回 global', async () => {
    const result1 = await Project.fromDirectory('/tmp/dir1')
    const result2 = await Project.fromDirectory('/home/user/downloads')
    
    expect(result1.id).toBe('global')
    expect(result2.id).toBe('global')
  })
})
```

---

## 四、Test Utilities（测试工具）

### 4.1 Mock 工具

```typescript
// test/project/helpers.ts

import { vi } from 'vitest'

/**
 * Mock 文件系统结构
 */
export function mockFs(structure: Record<string, any>) {
  vi.mock('fs/promises', () => ({
    lstat: vi.fn(async (path: string) => {
      if (structure[path]) {
        return { isDirectory: () => true }
      }
      throw new Error('ENOENT')
    }),
  }))
}

/**
 * Mock Git rev-list 命令输出
 */
export function mockGitRevList(output: string) {
  vi.mock('child_process', () => ({
    exec: vi.fn((cmd, opts, callback) => {
      if (cmd.includes('rev-list')) {
        callback(null, { stdout: output, stderr: '' })
      }
    }),
  }))
}

/**
 * Mock Git 命令失败
 */
export function mockGitRevListError(error: Error) {
  vi.mock('child_process', () => ({
    exec: vi.fn((cmd, opts, callback) => {
      callback(error, null)
    }),
  }))
}

/**
 * Mock Git 命令超时
 */
export function mockGitRevListTimeout() {
  vi.mock('child_process', () => ({
    exec: vi.fn((cmd, opts, callback) => {
      // 不调用 callback，模拟超时
    }),
  }))
}

/**
 * Mock 目录
 */
export function mockDirectory() {
  return { type: 'directory' }
}
```

### 4.2 测试数据

```typescript
// test/project/fixtures.ts

export const TEST_COMMITS = {
  singleRoot: 'abc123def456789012345678901234567890abcd',
  multipleRoots: [
    'zzz999888777666555444333222111000fffeeedd',
    'aaa111222333444555666777888999000abcdefgh',
    'mmm555666777888999000111222333444abcdefgh',
  ],
}

export const TEST_PATHS = {
  gitRepo: '/path/to/git-repo',
  gitRepoSubdir: '/path/to/git-repo/src/components',
  nonGitDir: '/tmp/random-directory',
  homeDir: '/home/user',
  nonExistent: '/path/that/does/not/exist',
}
```

---

## 五、Integration Tests（集成测试）

### 5.1 真实 Git 仓库测试

```typescript
describe('Integration: Real Git Repository', () => {
  let tempDir: string
  
  beforeEach(async () => {
    // 创建临时目录并初始化 Git
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-test-'))
    await execAsync('git init', { cwd: tempDir })
    await execAsync('git commit --allow-empty -m "Initial commit"', {
      cwd: tempDir,
    })
  })
  
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })
  
  it('应识别真实 Git 仓库', async () => {
    const result = await Project.fromDirectory(tempDir)
    
    expect(result.vcs).toBe('git')
    expect(result.rootPath).toBe(tempDir)
    expect(result.id).toMatch(/^[a-f0-9]{40}$/)
  })
  
  it('从子目录应返回相同的项目信息', async () => {
    const subdir = path.join(tempDir, 'src', 'components')
    await fs.mkdir(subdir, { recursive: true })
    
    const result = await Project.fromDirectory(subdir)
    
    expect(result.rootPath).toBe(tempDir)
  })
})
```

---

## 六、Execution（执行方式）

### 6.1 运行命令

```bash
# 运行所有 project 模块测试
npm run test -- src/project

# 运行并显示覆盖率
npm run test -- src/project --coverage

# 监听模式
npm run test -- src/project --watch
```

### 6.2 CI 集成

```yaml
# .github/workflows/test.yml
- name: Test Project Module
  run: npm run test -- src/project --coverage
  
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

- 测试用例覆盖所有公开接口
- 包含正常和异常场景
- 提供了完整的 Mock 工具
- 包含集成测试方案
- 明确了覆盖率目标
