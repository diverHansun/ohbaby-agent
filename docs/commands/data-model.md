# commands 模块 data-model.md

本文档描述 `commands` 模块的核心抽象与数据模型，用于统一"概念语言"，确保 commands 模块与调用层（CLI/UI）对齐认知。

**模块特点**：commands 模块采用无状态设计，本文档中的概念均为 Value Object，不涉及实体生命周期管理。

---

## 一、Core Concepts（核心概念）

### SlashCommand

Slash 命令的定义结构，支持子命令树。

**用途**：描述一个命令"是什么"以及"如何执行"。用于命令注册、查找和执行。

**设计意图**：
- 支持子命令嵌套（如 `/model list`、`/model switch`）
- 统一内置命令、文件命令、MCP 命令的格式
- 便于生成帮助信息和 Tab 补全

---

### CommandResult

命令执行后的统一返回结构。

**用途**：作为 commands 模块与调用层之间的"契约"，调用层根据此结构决定如何渲染输出或执行后续动作。

**设计意图**：
- 解耦命令逻辑与 UI 渲染
- 支持多种结果类型（数据、消息、动作、交互）
- 统一成功与失败的返回格式

---

### CommandContext

命令执行时的上下文信息。

**用途**：传递命令执行所需的环境信息，如当前会话 ID、项目路径等。由调用层构建并传入。

**设计意图**：
- 避免命令实现内部获取全局状态
- 使命令逻辑可测试
- 明确命令执行的依赖边界
- 不包含 UI 相关内容，保持接口无关性

---

### CommandCategory

命令的分类标签。

**用途**：将命令按功能域分组，便于 Help 命令分类展示，提升用户体验。

**当前分类**：
- `model` - 模型相关命令
- `context` - 上下文相关命令
- `session` - 会话相关命令
- `tools` - 工具相关命令
- `system` - 系统相关命令

---

### ICommandLoader

命令加载器接口。

**用途**：定义从不同来源加载命令的统一契约，支持扩展。

**设计意图**：
- 分离命令发现与命令实现
- 便于未来扩展（文件命令、MCP 命令）
- 符合开放封闭原则

---

## 二、Entity / Value Object 区分

本模块中的所有概念均为 **Value Object**：

| 概念 | 类型 | 说明 |
|------|------|------|
| SlashCommand | Value Object | 启动时加载，运行期只读 |
| CommandResult | Value Object | 一次性创建，不可变，无身份标识 |
| CommandContext | Value Object | 调用时创建，用后即弃 |
| CommandCategory | Value Object | 枚举值，不可变 |

**无 Entity 的原因**：commands 模块不持有状态，不管理任何具有生命周期的实体。所有状态由各功能模块（Session、Message 等）管理。

---

## 三、Key Data Fields（关键数据字段）

### SlashCommand 关键字段

| 字段 | 含义 |
|------|------|
| name | 命令名称，作为唯一标识（如 "model"） |
| description | 命令描述，用于 Help 展示 |
| category | 命令分类，用于分组展示 |
| hidden | 是否在 help 中隐藏 |
| action | 执行函数，叶子命令必须有 |
| subCommands | 子命令列表，父命令可以有 |

**子命令树结构示例**：

```typescript
const modelCommand: SlashCommand = {
  name: 'model',
  description: '模型管理',
  category: 'model',
  subCommands: [
    {
      name: 'list',
      description: '列出所有可用模型',
      category: 'model',
      action: async (ctx, args) => { /* ... */ }
    },
    {
      name: 'switch',
      description: '切换模型',
      category: 'model',
      action: async (ctx, args) => { /* ... */ }
    }
  ]
}
```

---

### CommandResult 关键字段

| 字段 | 含义 |
|------|------|
| success | 命令是否执行成功 |
| type | 结果类型，决定调用层如何处理 |
| data | 结构化数据，由调用层决定渲染方式 |
| message | 简单文本消息，直接展示给用户 |
| prompt | 需要提交给 LLM 的 Prompt 文本 |
| action | 指示调用层执行特定动作 |
| interactive | 需要交互式 UI 的信息 |
| error | 失败时的错误信息 |

**type 字段的语义**：

| type | 语义 | CLI 层处理 |
|------|------|-----------|
| `data` | 结构化数据 | 格式化渲染（表格、列表） |
| `message` | 简单消息 | 直接打印 |
| `prompt` | Prompt 文本 | 提交给 LLM 处理 |
| `action` | 动作指令 | 执行相应动作（退出、切换会话） |
| `interactive` | 需要交互 | 打开对话框（模型选择、确认） |

**error 字段的语义**：

| 字段 | 含义 |
|------|------|
| code | 错误码（COMMAND_NOT_FOUND、INVALID_ARGS 等） |
| message | 错误描述 |
| suggestion | 命令建议（拼写错误时的纠正） |

---

### CommandContext 关键字段

| 字段 | 含义 |
|------|------|
| sessionId | 当前会话 ID，部分命令需要此信息 |
| workingDirectory | 当前工作目录，用于项目级操作 |
| signal | 可选，取消信号，用于中断长时间命令 |

**不包含的内容**：
- UI 相关信息（终端宽度、颜色支持等）
- 渲染函数或回调

---

## 四、概念间的关系

```
                    ┌─────────────────┐
                    │ ICommandLoader  │
                    │   （加载器）     │
                    └────────┬────────┘
                             │ 加载
                             ▼
                    ┌─────────────────┐
                    │  SlashCommand   │
                    │   （命令定义）   │
                    │  ┌───────────┐  │
                    │  │subCommands│  │  ← 递归嵌套
                    │  └───────────┘  │
                    └────────┬────────┘
                             │
     CommandContext ─────────┼─────────▶ 命令执行
          │                  │               │
          │                  ▼               │
          │         ┌─────────────────┐      │
          │         │ CommandCategory │      │
          │         │   （命令分类）   │      │
          │         └─────────────────┘      │
          │                                  │
          └──────────────────────────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ CommandResult   │
                    │   （执行结果）   │
                    └─────────────────┘
```

**关系说明**：
- `ICommandLoader` 加载 `SlashCommand` 列表
- `SlashCommand` 可以包含嵌套的 `subCommands`
- `CommandContext` 是执行输入，`CommandResult` 是执行输出
- `CommandCategory` 是 `SlashCommand` 的分类属性

---

## 五、与其他文档的关系

- **architecture.md**：包含这些概念的实现细节（目录结构、设计模式），本文档聚焦语义
- **dfd-interface.md**：描述这些概念在数据流中如何流动，本文档解释概念本身的含义
- **goals-duty.md**：定义 commands 模块的职责边界，本文档中的概念服务于这些职责

---

## 六、文档自检

- [x] 所有概念都能用自然语言解释
- [x] 不存在"为了设计而设计"的抽象
- [x] 所有概念在架构或数据流中都有使用
- [x] 概念数量保持克制（5 个核心概念）
- [x] 描述聚焦"含义"而非"类型"
- [x] 子命令树结构有清晰的示例
