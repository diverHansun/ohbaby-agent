# Prompt 输入框组件概述

## 一、定位

Prompt 是用户与应用交互的主要入口，负责文本输入、命令识别、历史导航和自动补全。它固定在 DefaultLayout 底部（StatusBar 上方），是用户最频繁交互的组件。

对应职责追溯：goals-duty.md D6（输入处理）。

## 二、组件结构

```
Prompt
├── TextInput（基于 Ink TextInput）     # 文本输入框
└── Completion                          # Inline 自动补全建议
```

Prompt 不自行实现文本缓冲区（TextBuffer）。基础文本编辑功能（光标移动、字符插入删除、复制粘贴等）依赖 Ink 的 TextInput 组件。

## 三、核心功能

### 3.1 文本输入与提交

- 用户在输入框中输入文本
- 按 Enter 提交输入，由 `useInput` hook 处理
- 提交后清空输入框

### 3.2 命令分流

`useInput` hook 根据输入内容分流到不同处理路径：

| 输入格式 | 处理路径 |
|---------|---------|
| 以 `/` 开头 | 作为 slash 命令，调用 cli/commands 模块执行 |
| 其他文本 | 作为用户对话，调用 lifecycle.execute() |

### 3.3 历史导航

通过 `useHistory` hook 实现：

| 按键 | 行为 |
|------|------|
| Up | 显示上一条历史记录 |
| Down | 显示下一条历史记录 |

历史记录在首项和末项之间线性导航，不循环。详见 [input-history.md](./input-history.md)。

### 3.4 Tab 自动补全（Inline 模式）

Tab 补全仅用于 slash 命令，不用于普通文本补全。

**触发条件**：输入以 `/` 开头时，`useInput` 调用 `cli.commands.getCompletions(prefix)` 获取匹配的命令列表。

**显示方式**：采用 Inline 模式 -- 在光标后显示单个灰色建议文本（Completion 子组件渲染）。

| 按键 | 行为 |
|------|------|
| Tab | 接受当前补全建议，填充到输入框 |
| 继续输入 | 补全建议随输入更新或消失 |
| Esc | 清除补全建议 |

## 四、冻结状态

当 `AppStateContext.dialog.current !== null` 时（有弹窗显示），Prompt 进入冻结状态：

- 不响应键盘输入
- 显示为灰色/不可用样式
- 弹窗关闭后自动恢复

实现方式：Prompt 读取 AppStateContext 的 dialog.current 字段，当其非 null 时跳过所有输入处理。

## 五、Hook 依赖

| Hook | 职责 | 说明 |
|------|------|------|
| useInput | 输入提交、命令分流、补全获取 | Prompt 专用 |
| useHistory | 历史记录导航 | Prompt 专用 |
| useKeypress | 键盘事件监听 | 通用 |

## 六、Context 依赖

| Context | 读取字段 | 用途 |
|---------|---------|------|
| AppStateContext | `dialog.current` | 冻结状态判断 |

Prompt 不直接读取 SessionContext 或 ConfigContext。

## 七、视觉结构

```
> user input here                     ← 正常状态，带 > 提示符
> user input here /mo|del             ← 补全状态，'del' 为灰色建议
                                      ← 冻结状态，灰色不可用
```

提示符 `>` 前缀固定显示，表示输入就绪。冻结时提示符也变为灰色。

## 八、设计约束

1. **不自行实现 TextBuffer**：依赖 Ink TextInput 处理光标和编辑
2. **不处理业务逻辑**：命令执行委托给 useInput hook
3. **补全仅限 slash 命令**：不做通用文本补全
4. **单实例**：整个应用只有一个 Prompt 实例（DefaultLayout 中固定）

## 九、文档自检

- [x] 命令分流规则已定义（slash 命令 vs 普通对话）
- [x] 历史导航已说明（含文档引用）
- [x] Tab 自动补全的触发条件和交互已定义
- [x] 冻结状态机制已描述（Context 标记法）
- [x] Hook 和 Context 依赖已列出
