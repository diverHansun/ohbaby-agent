# DiffRenderer 文件差异渲染器

## 一、职责

DiffRenderer 将 unified diff 格式的文本渲染为带颜色标注的差异视图，用于展示 edit_file 工具的执行结果。

## 二、Props 定义

```typescript
interface DiffRendererProps {
  diff: string                   // unified diff 格式文本
  maxHeight?: number             // 最大显示高度（行数），超出时使用 MaxSizedBox 截断
  showLineNumbers?: boolean      // 是否显示行号，默认 true
}
```

## 三、视觉结构

```
  10   │ - const oldValue = getValue();     ← 红色（删除行）
  10   │ + const newValue = getNewValue();  ← 绿色（添加行）
  11   │   return newValue;                 ← 默认色（上下文行）
```

### 颜色规则

| 行类型 | 前缀 | 颜色 |
|--------|------|------|
| 删除行 | `-` | 红色 |
| 添加行 | `+` | 绿色 |
| 上下文行 | 空格 | 默认文本色 |
| hunk 头 | `@@` | 蓝色 dimColor |

### 行号显示

- 删除行显示原文件行号
- 添加行显示新文件行号
- 上下文行显示新文件行号
- 行号右对齐，用空格填充

## 四、diff 解析

DiffRenderer 接收标准 unified diff 格式文本，解析规则：

1. 跳过文件头（`---` 和 `+++` 行）
2. 解析 hunk 头（`@@ -start,count +start,count @@`）获取起始行号
3. 按前缀字符（`-`、`+`、空格）分类行内容
4. 按行号递增渲染

## 五、高度限制

当 diff 内容超过 maxHeight 时，使用 MaxSizedBox 组件截断显示。默认不限制高度。

## 六、使用场景

| 场景 | 说明 |
|------|------|
| ToolPart (edit_file completed) | 显示文件修改的差异 |

ToolPart 中 edit_file 工具的 completed 状态如果包含 diff 信息，可在结果摘要下方使用 DiffRenderer 渲染。

## 七、设计约束

1. **零 Context 依赖**：通过 Props 接收 diff 文本
2. **只读展示**：不提供交互（无展开/折叠、无行选择）
3. **解析简单**：只支持 unified diff 格式，不支持 side-by-side 视图
4. **依赖 MaxSizedBox**：溢出截断复用已有组件

## 八、文档自检

- [x] 颜色规则完整（删除/添加/上下文/hunk 头）
- [x] 行号显示规则已说明
- [x] diff 解析流程已描述
- [x] 高度限制兜底方案已说明
- [x] 使用场景已列举
