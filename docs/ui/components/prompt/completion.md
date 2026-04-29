# Completion — Inline 自动补全

本文档定义 Prompt 的 inline 自动补全行为。

---

## 一、定位

Completion 是 Prompt 的辅助子组件，在用户输入 slash command 时，在光标后显示单个灰色建议文本。按 Tab 接受建议。

它不直接访问 backend；所有候选都来自 TuiStore catalog，经 SDK `filterCommandCatalog()` 过滤后由 `useInput` 提供。

---

## 二、数据来源

```typescript
interface CompletionResult {
  text: string         // 接受补全后的完整文本
  displayText: string  // 光标后显示的灰色文本
}
```

`useInput.getCompletions(prefix)` 返回 `CompletionResult | null`。

输入数据流：

```text
TuiStore.catalog
   │
   └─ filterCommandCatalog({ prefix, surface: 'tui' })
          │
          ▼
     useInput.getCompletions()
          │
          ▼
       Completion
```

---

## 三、触发条件

- 输入必须以 `/` 开头。
- catalog 已加载。
- 当前存在至少一个匹配的 command spec。
- 当前输入不是 exact full match（否则不显示剩余文本）。

---

## 四、交互规则

| 按键 | 行为 |
|---|---|
| Tab | 接受当前补全建议，填充到输入框 |
| 继续输入 | 重新计算建议 |
| Esc | 清除当前建议 |

示例：

```text
用户输入: /mod
候选命令: /model
显示: /mod|el
按 Tab 后: /model
```

---

## 五、设计约束

1. **单建议显示**：只显示当前最优候选，不展示下拉列表。
2. **只用于 slash**：普通文本不补全。
3. **不决定执行**：Completion 只辅助输入，不触发 command resolve 或提交。
4. **不持有 catalog**：候选通过 Props / hook 返回值传入。

---

## 六、文档自检

- [x] 数据来源已对齐 TuiStore catalog + SDK 过滤函数。
- [x] 触发条件和交互规则完整。
- [x] 只作为输入辅助，不参与执行决策。
