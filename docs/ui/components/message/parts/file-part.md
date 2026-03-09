# FilePart 文件附件组件

## 一、职责

FilePart 渲染文件附件信息。FilePart 可以作为独立 Part 出现在消息中，也可以作为 ToolPart 的 attachments 嵌套出现。

## 二、视觉结构

```
  [file] README.md (text/markdown)
```

单行显示：文件图标 + 文件名 + MIME 类型。使用弱化颜色，不喧宾夺主。

## 三、数据输入

| 字段 | 类型 | 来源 | 说明 |
|------|------|------|------|
| id | string | Part 基础字段 | Part 唯一标识 |
| mime | string | FilePart 字段 | MIME 类型（如 text/plain、image/png） |
| filename | string（可选） | FilePart 字段 | 文件名 |
| url | string | FilePart 字段 | 文件 URL（file:// 本地路径或 data:// 内联数据） |
| source | string（可选） | FilePart 字段 | 来源标识 |

### 显示优先级

- 优先显示 `filename`（如果存在）
- 如果 `filename` 不存在，从 `url` 中提取文件名（file:// 协议取路径最后一段）
- MIME 类型用括号附在文件名后面

## 四、设计约束

1. **只显示元信息**：不显示文件内容（终端中无法预览图片、PDF 等）
2. **不可点击**：终端中文件链接不支持点击打开（不像 Web 浏览器）
3. **单行渲染**：保持轻量，不占用额外空间
4. **不参与流式更新**：FilePart 通常一次性完整创建，不需要增量更新

## 五、文档自检

- [x] 视觉结构简洁（单行文件信息）
- [x] 数据字段与 message 模块 data-model 一致
- [x] 显示优先级规则已说明
- [x] 约束明确（只显示元信息、不可点击）
