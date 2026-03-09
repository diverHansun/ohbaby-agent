# ModelDialog 模型选择弹窗

## 一、职责

ModelDialog 显示可用的 LLM 模型列表，供用户切换当前使用的模型。通过 `/model` 命令触发。

## 二、视觉结构

```
+-- Select Model -----------------------+
|                                       |
|    gpt-4                              |
|  > claude-sonnet  (current)           |    ← 焦点项 + 当前使用标记
|    claude-haiku                       |
|    gemini-pro                         |
|                                       |
+---------------------------------------+
```

### 列表项显示

每个列表项显示模型名称。当前正在使用的模型显示 `(current)` 后缀标记。焦点项使用 `>` 前缀和高亮样式。

## 三、交互设计

| 按键 | 行为 |
|------|------|
| Up / Down | 在模型列表间移动焦点 |
| Enter | 选中当前焦点模型，调用 `onRespond` |
| Esc | 取消选择，调用 `onCancel` |

列表使用 shared/ScrollableList 组件，当模型数量超过可见区域时支持滚动。

## 四、数据输入

```typescript
interface ModelDialogData {
  type: 'model'
  models: ModelInfo[]            // 可用模型列表
  currentModel: string           // 当前使用的模型名
}
```

数据来源：
- `models` 列表来自 provider 模块提供的可用模型列表
- `currentModel` 来自 ConfigContext.modelName

## 五、响应值

```typescript
// onRespond 的参数
interface ModelDialogResult {
  selectedModel: string          // 用户选择的模型名
}
```

请求方（/model 命令处理逻辑）接收到响应后，调用 config/llm 模块的接口切换模型。

## 六、设计约束

1. **不直接切换模型**：只返回用户选择，由命令处理逻辑执行切换
2. **列表数据外部提供**：ModelDialog 不查询模型列表，通过 Props 接收
3. **打开时焦点定位到当前模型**：初始 selectedIndex 指向 currentModel 对应项

## 七、文档自检

- [x] 视觉结构已定义（标题 + 列表 + current 标记）
- [x] 交互规则符合统一规范（Up/Down + Enter + Esc）
- [x] 数据来源已说明
- [x] 响应值类型已定义
- [x] 使用 ScrollableList 组件
