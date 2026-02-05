# ThemeManager 主题管理器

> 待撰写：主题管理器详细设计

## 职责

管理主题切换和主题配置（为未来扩展预留）。

## 当前状态（MVP）

MVP 阶段只支持单一主题，ThemeManager 提供：

- 获取当前主题颜色
- 语义化颜色访问接口

## 未来扩展

预留的扩展能力：

- 多主题支持（深色/浅色/自定义）
- 运行时主题切换
- 主题持久化

## 参考设计

参考 gemini-cli 的主题系统：

```typescript
// 通过 getter 访问，为切换预留
export const theme: SemanticColors = {
  get text() { return themeManager.getSemanticColors().text; },
  // ...
};
```

## API 设计

待补充...
