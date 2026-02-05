# ToolPart 工具调用组件

> 待撰写：ToolPart 详细设计

## 职责

渲染工具调用信息，显示执行状态和结果。

## 显示内容

- 工具名称
- 执行参数
- 执行状态（pending / running / completed / error / aborted）
- 执行结果

## 状态颜色

- pending: 黄色
- running: 蓝色 + Spinner
- completed: 绿色
- error: 红色
- aborted: 灰色

## 加载状态

参考 gemini-cli 的加载状态设计：

```
✦ Thinking...
  [Spinner] Executing tool: read_file
```
