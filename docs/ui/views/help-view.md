# HelpView 帮助视图

## 一、职责

HelpView 展示快捷键和可用命令的帮助信息，采用双栏布局。左栏展示键盘快捷键（静态），右栏展示 slash 命令列表（数据驱动）。

对应职责追溯：goals-duty.md D2（视图管理 - HelpView）、D8（键盘快捷键）。

## 二、视觉结构

```
+-------------------------------------------------------------+
|                                                             |
|   Shortcuts                     Commands                    |
|   --------------------          --------------------         |
|   Ctrl+C x2   Interrupt         model                      |
|   Shift+Tab   Cycle mode          /model     Manage models  |
|   Esc         Close / Back      session                     |
|   Tab         Complete /cmd       /session   Manage sessions|
|   Up/Down     History             /clear     Clear context  |
|                                 context                     |
|                                   /compact   Compress ctx   |
|                                   /stats     Token usage    |
|                                 system                      |
|                                   /help      Show help      |
|                                   /status    System info    |
|                                   /exit      Exit program   |
|                                                             |
|   Press Esc to go back                                      |
|                                                             |
+-------------------------------------------------------------+
|  > _                                                        |
+-------------------------------------------------------------+
|  StatusBar                                                  |
+-------------------------------------------------------------+
```

## 三、双栏设计

### 3.1 左栏：快捷键（ShortcutsColumn）

静态内容，硬编码在组件内部。展示全局键盘快捷键：

| 快捷键 | 说明 | 备注 |
|--------|------|------|
| `Ctrl+C x2` | Interrupt | 500ms 双击窗口中断执行 |
| `Shift+Tab` | Cycle mode | 在 ask/plan/agent 之间切换 |
| `Esc` | Close / Back | 关闭弹窗或返回上一视图 |
| `Tab` | Complete /cmd | 仅在 `/` 前缀后生效，补全 slash 命令 |
| `Up/Down` | History | 输入历史导航 |

注意：Tab 补全仅对 slash 命令生效（用户输入 `/` 后按 Tab 补全命令名），不是用户 prompt 的自动补全。

### 3.2 右栏：命令列表（CommandsColumn）

数据驱动渲染。命令列表从 TuiStore command catalog 获取，按 category 分组展示。

**数据来源**：`useCommandCatalog()` selector 读取由 `client.listCommands({ surface: 'tui' })` 拉取的 catalog。catalog 变化时由 `command.catalog.updated` → `catalogInvalidation` → `useCatalog` 刷新。

**分组展示**：每个 category 作为一个小标题（如 model、session、context、system），该分类下的命令缩进列出。

**命令分类参考**（来自 commands 模块文档）：

| 分类 | 包含命令 |
|------|---------|
| model | /model |
| session | /session, /clear |
| context | /compact, /stats |
| tools | /tools, /mcp |
| system | /status, /init, /exit, /approval-mode, /agents, /memory |

### 3.3 底部提示

页面底部用弱化颜色显示 `Press Esc to go back`，提示用户如何返回。Esc 按键由 useKeyboard hook 全局处理，HelpView 不需要自行监听。

## 四、可扩展性

### 4.1 命令自动同步

当 backend CommandService 新增或移除命令并发布 catalog 更新时，HelpView 的右栏自动反映变化，无需修改 View 代码。新增命令只需在 catalog 中注册并声明 category，HelpView 即可展示。

### 4.2 快捷键维护

左栏快捷键为静态内容。如果新增全局快捷键，需要同步更新 ShortcutsColumn 和 useKeyboard hook 文档。快捷键数量预期稳定（5-8 个），不需要数据驱动。

## 五、组件组合

| 组件 | 位置 | 数据依赖 |
|------|------|---------|
| ShortcutsColumn | HelpView 内部组件 | 无（静态数据） |
| CommandsColumn | HelpView 内部组件 | TuiStore command catalog |

ShortcutsColumn 和 CommandsColumn 是 HelpView 的内部子组件，不对外导出，不在其他视图中复用。

## 六、Context 依赖

HelpView 不读取 backend 或旧 Context。

- 命令数据通过 `useCommandCatalog()` 获取，不通过 backend 模块
- 快捷键数据为硬编码静态内容
- Esc 返回操作由 useKeyboard hook 在 App 层全局处理

## 七、设计约束

1. **不处理键盘事件**：Esc 返回由 useKeyboard 全局处理，HelpView 不监听按键
2. **不滚动**：MVP 阶段内容量可控（5 个快捷键 + 10-15 个命令），不需要滚动。终端高度不足时由 Ink overflow 截断
3. **不展示每个命令的专属 help 子命令**：仅展示命令名、描述和 `argsHint`，避免为所有命令膨胀 help 变体
4. **不硬编码命令列表**：右栏命令全部通过 TuiStore catalog 获取

## 八、文档自检

- [x] HelpView 的职责可以用一句话说明（展示快捷键和命令帮助）
- [x] 双栏设计清晰：左静态、右动态
- [x] Tab 补全说明已修正为仅 slash 命令补全
- [x] 命令列表可扩展性已说明（数据驱动，零 backend 耦合）
- [x] 不依赖旧 Context 或 cli/commands
- [x] 命令分类参考来源已标注（commands 模块文档）
