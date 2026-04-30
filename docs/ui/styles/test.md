# styles/ 测试说明

本文档说明如何验证 styles/ 模块的正确性。

styles/ 是纯数据模块（三层静态映射），没有副作用、没有异步操作、不依赖外部服务。**测试以纯单元为主，全部同步，无需 mock。**

对应职责追溯：styles/non-functional.md §四（SemanticTokens 类型完整性）、§二（禁止硬编码）。

---

## 一、测试策略

| 维度 | 策略 |
|---|---|
| 测试类型 | 纯单元（vitest / jest），无 mock，无异步 |
| 测试粒度 | 函数/对象级别，不测 React 渲染 |
| 覆盖重点 | 类型完整性（编译期）+ getter 代理行为（运行时）+ token 映射正确性 |
| 不测什么 | 色值是否"好看"（主观）、终端渲染效果（环境依赖）、React 组件消费颜色的视觉正确性 |

---

## 二、编译期测试（TypeScript 类型检查）

这是 styles/ 最重要的"测试"——在代码通过 `tsc` 编译时自动执行，不需要写额外用例。

### 2.1 darkTokens 字段完整性

```typescript
// 只需要这一行声明就足够 —— 若 darkTokens 缺字段，tsc 报错
const _typeCheck: SemanticTokens = darkTokens
```

覆盖：所有 7 分组 / 30 个 token 都有值，不存在 undefined。

### 2.2 theme getter 类型对齐

```typescript
// getter 代理对象类型声明为 SemanticTokens，缺分组时 tsc 报错
export const theme: SemanticTokens = { get text() { ... }, ... }
```

关键意义：新增 token 分组时，若遗漏 getter（例如只加了 `dialog` token 定义但未加 `get dialog()`），编译报错，不会漏到运行时。

---

## 三、运行时单元测试

### 3.1 palette 完整性

确保 darkTokens 引用的每个 palette key 都实际存在，防止 token 映射到已删除的色值。

```typescript
describe('palette 完整性', () => {
  it('darkTokens 引用的所有 palette key 都存在', () => {
    // 遍历 darkTokens 的所有 token，断言对应色值为非空字符串
    const allTokenValues = Object.values(darkTokens).flatMap(group =>
      Object.values(group as Record<string, string>)
    )
    for (const value of allTokenValues) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it('所有色值格式为合法 hex（#RRGGBB 或 #RGB）', () => {
    const hexRegex = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/
    const allTokenValues = Object.values(darkTokens).flatMap(group =>
      Object.values(group as Record<string, string>)
    )
    for (const value of allTokenValues) {
      expect(value).toMatch(hexRegex)
    }
  })
})
```

### 3.2 getter 代理行为

验证 theme getter 能正确透传当前 themeManager 的 tokens，以及 setTheme 切换后立刻生效。

```typescript
describe('theme getter 代理', () => {
  it('theme.text.primary 返回当前主题的值', () => {
    expect(theme.text.primary).toBe(darkTokens.text.primary)
  })

  it('setTheme 后 getter 立即反映新主题', () => {
    const originalTokens = themeManager.getTokens()
    const mockTokens: SemanticTokens = {
      ...darkTokens,
      text: { ...darkTokens.text, primary: '#112233' },
    }
    themeManager.setTheme(mockTokens)
    expect(theme.text.primary).toBe('#112233')
    // 恢复
    themeManager.setTheme(originalTokens)
  })

  it('所有 7 个分组都可通过 theme 访问', () => {
    const groups = ['text', 'tool', 'diff', 'ui', 'status', 'message', 'dialog'] as const
    for (const group of groups) {
      expect(theme[group]).toBeDefined()
      expect(typeof theme[group]).toBe('object')
    }
  })
})
```

### 3.3 dialog token 分组映射正确性

dialog 分组是最新加入的，单独验证其 tone 五值、focusBg、currentMark 均有明确色值。

```typescript
describe('dialog token 分组', () => {
  const dialogKeys: Array<keyof typeof darkTokens.dialog> = [
    'toneDefault', 'toneMuted', 'toneAccent', 'toneWarning', 'toneDanger',
    'focusBg', 'currentMark',
  ]

  it.each(dialogKeys)('dialog.%s 为非空 hex', (key) => {
    const value = darkTokens.dialog[key]
    expect(value).toMatch(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/)
  })

  it('toneDanger 与 toneDefault 颜色不同（有区分度）', () => {
    expect(darkTokens.dialog.toneDanger).not.toBe(darkTokens.dialog.toneDefault)
  })

  it('focusBg 与 toneDefault 颜色不同（焦点行需可见）', () => {
    expect(darkTokens.dialog.focusBg).not.toBe(darkTokens.dialog.toneDefault)
  })
})
```

---

## 四、不需要测试的内容

| 内容 | 原因 |
|---|---|
| 色值是否"好看" | 主观审美，不可量化 |
| 终端实际渲染效果 | 依赖终端环境，不适合单元测试 |
| React 组件中 theme 颜色的视觉正确性 | 属于组件测试范畴，不属于 styles/ |
| palette 里的 hex 是否符合 WCAG 对比度 | MVP 不做无障碍校验 |
| ThemeManager.setTheme() 触发 React 重渲染 | MVP 不调用 setTheme，此路径不激活 |

---

## 五、测试文件位置

```
packages/ohbaby-tui/src/styles/
├── __tests__/
│   ├── tokens.test.ts        # palette 完整性 + hex 格式 + dialog 分组
│   └── theme-manager.test.ts # getter 行为 + setTheme 切换
```

测试不需要 DOM 环境，直接在 vitest 的 node 环境下运行。

---

## 六、文档自检

- [x] 测试策略明确：纯单元，无 mock，无异步
- [x] 编译期测试（tsc）与运行时测试（vitest）分开说明
- [x] 覆盖三个核心场景：palette 完整性 / getter 行为 / dialog 分组
- [x] 不测什么已明确列出，避免无意义测试
- [x] 测试文件位置已指定
