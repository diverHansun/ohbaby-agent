# useHistory 输入历史 Hook

本文档定义 useHistory 的职责、接口和导航逻辑。

useHistory 管理用户输入历史，支持上/下箭头键导航。纯本地状态，不依赖任何 Context。

---

## 一、职责

- 记录用户提交的输入
- 支持上/下箭头键在历史记录中导航
- 保存用户当前未提交的输入（临时缓存）
- 去重相邻的重复输入

---

## 二、签名

```typescript
function useHistory(): {
  addToHistory: (input: string) => void
  navigateUp: () => string | undefined
  navigateDown: () => string | undefined
  currentIndex: number
  historyLength: number
}
```

**返回值**：
- `addToHistory`：将输入添加到历史记录
- `navigateUp`：获取上一条历史记录（返回文本，无记录时返回 undefined）
- `navigateDown`：获取下一条历史记录（返回文本或当前输入缓存）
- `currentIndex`：当前历史索引（-1 表示不在历史导航中）
- `historyLength`：历史记录总数

---

## 三、调用位置

**Prompt 组件**（唯一调用位置）

```tsx
function Prompt() {
  const { addToHistory, navigateUp, navigateDown } = useHistory()
  const { handleSubmit } = useInput()

  // 上箭头 -> navigateUp() -> 设置输入框内容
  // 下箭头 -> navigateDown() -> 设置输入框内容
  // Enter -> handleSubmit(text) + addToHistory(text)
}
```

---

## 四、导航逻辑

### 4.1 状态模型

```typescript
// 内部状态
history: string[]          // 历史记录数组（最新的在末尾）
currentIndex: number       // -1 = 未导航，0..n = 历史位置
savedInput: string         // 进入导航前保存的当前输入
```

### 4.2 导航行为

```
历史记录: ['hello', 'world', 'foo']
索引:       0        1        2

用户当前输入: "bar"（未提交）

按 上箭头:
  1. savedInput = "bar"（保存当前输入）
  2. currentIndex = 2（指向最新一条）
  3. 返回 "foo"

再按 上箭头:
  currentIndex = 1
  返回 "world"

再按 上箭头:
  currentIndex = 0
  返回 "hello"

再按 上箭头:
  currentIndex 已经是 0，不变
  返回 undefined（到顶了）

按 下箭头:
  currentIndex = 1
  返回 "world"

继续按 下箭头 到底:
  currentIndex = -1（退出导航）
  返回 savedInput（"bar"，恢复用户未提交的输入）
```

### 4.3 边界处理

| 场景 | 行为 |
|------|------|
| 历史为空时按上箭头 | 返回 undefined，不操作 |
| 已在最顶部按上箭头 | 返回 undefined，不操作 |
| 已退出导航按下箭头 | 返回 undefined，不操作 |
| 用户开始输入新字符 | currentIndex 重置为 -1（退出导航） |

### 4.4 去重

连续相同的输入不重复记录：

```typescript
addToHistory('hello')   // history = ['hello']
addToHistory('hello')   // history = ['hello']（不重复添加）
addToHistory('world')   // history = ['hello', 'world']
addToHistory('hello')   // history = ['hello', 'world', 'hello']（非相邻可重复）
```

---

## 五、容量限制

历史记录保留最近 100 条（可配置），超出时移除最旧的记录。

历史记录仅保存在内存中，不持久化。会话结束后清空。

---

## 六、依赖关系

useHistory 是完全独立的 Hook：
- 不依赖任何 Context
- 不订阅任何 Bus 事件
- 不调用任何外部模块
- 纯本地 React 状态

这使它成为最容易测试的 Hook。

---

## 七、文档自检

- [x] 签名完整（参数 + 返回值）
- [x] 调用位置已明确（Prompt，唯一）
- [x] 导航逻辑有状态模型和行为示例
- [x] 边界处理已覆盖
- [x] 去重规则已说明
- [x] 容量限制已说明
- [x] 独立性（无依赖）已说明
