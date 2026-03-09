# PermissionDialog 权限确认弹窗

## 一、职责

PermissionDialog 显示工具执行的权限确认请求，收集用户的授权决策。它是使用频率最高的弹窗类型，优先级为 high。

对应职责追溯：goals-duty.md D7（弹窗管理）、N4（权限决策由 permission 模块负责，UI 只收集响应）。

## 二、视觉结构

```
+-- Permission Required ---------------+
|                                      |
|  read_file                           |
|  path: src/auth/index.ts             |
|                                      |
+--------------------------------------+
|  > Allow once                        |      ← 焦点项（高亮）
|    Allow always                      |
|    Deny                              |
|    Suggest alternative               |
+--------------------------------------+
```

### 信息展示

- **标题**：固定为 "Permission Required"
- **工具名称**：粗体显示 `data.toolName`
- **操作详情**：显示 `data.description`，包含关键参数（文件路径、命令内容等）

### 选项列表

| 选项 | 含义 | 对应响应值 |
|------|------|-----------|
| Allow once | 本次允许 | `{ action: 'allow', scope: 'once' }` |
| Allow always | 始终允许该类操作 | `{ action: 'allow', scope: 'always' }` |
| Deny | 拒绝 | `{ action: 'deny' }` |
| Suggest alternative | 拒绝并提供替代建议 | `{ action: 'suggest', suggestion: string }` |

## 三、交互设计

PermissionDialog 有两种内部状态模式：

### 3.1 选择模式（默认）

| 按键 | 行为 |
|------|------|
| Up / Down | 在 4 个选项间移动焦点 |
| Enter | 确认当前焦点选项 |
| Esc | 等同于选择 Deny |

选择 Allow once / Allow always / Deny 时，直接调用 `onRespond` 回调并关闭弹窗。

### 3.2 输入模式（Suggest alternative）

当焦点在 "Suggest alternative" 上按 Enter 时，进入输入模式：

```
+-- Permission Required ---------------+
|                                      |
|  read_file                           |
|  path: src/auth/index.ts             |
|                                      |
+--------------------------------------+
|    Allow once                        |
|    Allow always                      |
|    Deny                              |
|  > Suggest alternative               |
|    [输入替代建议...]                   |   ← 输入框出现在弹窗内部
+--------------------------------------+
```

输入模式的交互：

| 按键 | 行为 |
|------|------|
| 文本输入 | 在输入框中输入替代建议 |
| Enter | 提交替代建议，调用 `onRespond` |
| Esc | 退回到选择模式（不关闭弹窗） |

关键设计决策：输入框在弹窗内部渲染，不使用原始的 Prompt 输入框。这样保持弹窗的独立性和焦点封闭。

## 四、Esc 键分层

| 当前状态 | Esc 行为 |
|---------|---------|
| 选择模式 | 等同 Deny，关闭弹窗 |
| 输入模式 | 退回选择模式（清空输入） |

两层 Esc 操作提供渐进式退出体验，避免误操作直接关闭。

## 五、数据输入

```typescript
interface PermissionDialogData {
  type: 'permission'
  permissionId: string           // 权限请求 ID
  sessionId: string              // 会话 ID
  title: string                  // 操作标题
  description: string            // 详细描述
  toolName: string               // 工具名称
  metadata?: Record<string, unknown>
}
```

数据由 `usePermission` hook 监听 `Permission.Event.Updated` Bus 事件后构造，通过 `enqueueDialog()` 入队。

## 六、回调传递

PermissionDialog 不直接调用 `Permission.respond()`。它调用 `onRespond(result)`，result 的具体处理由请求方（usePermission hook）在创建 DialogRequest 时定义的 onRespond 回调中完成。

## 七、设计约束

1. **不做权限判断**：只收集用户选择，不决定是否允许
2. **不直接调用 permission 模块**：通过 DialogRequest 回调间接传递
3. **输入框在弹窗内**：suggest 模式的输入不使用 Prompt 组件
4. **焦点闭合**：弹窗存在时，外部组件不响应键盘事件

## 八、文档自检

- [x] 4 个选项及对应响应值已定义
- [x] 选择模式和输入模式的交互已完整描述
- [x] Esc 分层行为已明确
- [x] 输入模式在弹窗内部渲染（不使用 Prompt）
- [x] 数据来源和回调传递路径清晰
- [x] 使用 Up/Down 导航，不使用字母键选择
