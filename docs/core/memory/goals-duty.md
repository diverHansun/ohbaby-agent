# memory 模块 goals-duty.md

本文档定义 `memory` 模块的设计目标与职责边界。

**模块位置**：
- 代码：`src/core/memory/`
- 文档：`docs/core/memory/`

---

## 一、模块定位

**一句话说明**：memory 模块负责加载、管理和持久化全局与项目级的 IRIS.md 记忆文件，为 AI 提供长期记忆能力。

**如果没有这个模块**：
- AI 无法记住用户的偏好、项目规则和重要上下文
- 每次会话都需要用户重新说明背景信息
- 无法在团队中共享项目级的 AI 使用规则
- 用户手动编辑的记忆文件无法被系统识别和使用

---

## 二、Design Goals（设计目标）

### G1: 分层记忆管理

支持全局和项目级两层记忆：
- **全局记忆**：存储用户通用的偏好、习惯和规则
- **项目记忆**：存储特定项目的上下文、约定和知识
- 自动合并两层内容，优先级明确

### G2: 简单可靠

记忆文件使用纯文本 Markdown 格式：
- 用户可以直接编辑，无需特殊工具
- 版本控制友好，便于团队协作
- 格式清晰，人类可读，AI 可理解

### G3: AI 自主管理

AI 可以自主添加、更新和删除记忆条目：
- 无需用户确认（系统内部操作）
- 提供 Tools 接口供 AI 调用
- 保持用户手写区域不被 AI 修改

### G4: 职责聚焦

Memory 模块只负责文件的读写和管理：
- 不负责决定何时使用记忆（由 lifecycle 决定）
- 不负责记忆内容的格式化（返回原始内容）
- 不负责记忆与 System Prompt 的合并（由调用方处理）

### G5: 向上查找策略

项目记忆支持向上查找：
- 从当前目录开始，向上查找 IRIS.md
- 找到第一个即停止，避免内容重复
- 确保子目录也能访问项目级记忆

---

## 三、Duties（职责）

### D1: 记忆文件加载

加载全局和项目级的记忆内容：
- 从 XDG 配置目录读取全局 IRIS.md
- 从项目根目录向上查找 IRIS.md
- 合并两层内容并添加来源标记
- 返回原始 Markdown 文本

**核心接口**：`Memory.load(directory: string): Promise<MergedMemory>`

### D2: 记忆条目添加

向记忆文件追加新的条目：
- 支持添加到全局或项目级
- 使用 `## Iris Added Memories` 作为分隔 Header
- 自动添加时间戳和内容
- 不存在时自动创建文件

**核心接口**：`Memory.add(input: AddMemoryInput): Promise<void>`

### D3: 记忆条目更新

更新已有的记忆条目：
- 按索引定位要更新的条目
- 只修改 AI 添加区域（Header 下方）
- 不修改用户手写区域（Header 上方）
- 保持文件其他部分不变

**核心接口**：`Memory.update(input: UpdateMemoryInput): Promise<void>`

### D4: 记忆条目删除

删除过时或错误的记忆条目：
- 按索引定位要删除的条目
- 只删除 AI 添加区域的条目
- 删除后自动调整剩余条目索引

**核心接口**：`Memory.remove(input: RemoveMemoryInput): Promise<void>`

### D5: 记忆条目列表

列出所有 AI 添加的记忆条目：
- 解析 `## Iris Added Memories` 下方的列表
- 返回索引、时间戳和内容
- 供 AI 查询和选择修改/删除目标

**核心接口**：`Memory.listEntries(scope, directory?): Promise<MemoryEntry[]>`

### D6: 记忆刷新

重新加载记忆文件：
- 在用户明确要求时调用
- 发布 `Memory.Event.Refreshed` 事件
- 供会话中途更新记忆使用（手动触发）

**核心接口**：`Memory.refresh(directory: string): Promise<void>`

### D7: 提供 Memory Tools

定义 AI 可调用的 Memory Tools：
- `memory_list`: 查看当前记忆（操作类型：read）
- `memory_add`: 添加新记忆（操作类型：write）
- `memory_update`: 更新已有记忆（操作类型：write）
- `memory_remove`: 删除过时记忆（操作类型：write）

**工具类别**：
- Memory Tools 属于独立的 `memory` 类别（而非 `readonly`/`write`）
- 默认策略为 ALLOW（所有模式下均允许执行）
- 无需用户确认（系统内部操作）
- 不受读写锁限制，始终可并行执行

**职责边界**：Tools 定义在 Memory 模块内部，由 ToolScheduler 统一调度执行。

### D8: 事件发布

通过 Bus 发布记忆变更事件：
- `Memory.Event.Added`：添加条目后
- `Memory.Event.Updated`：更新条目后
- `Memory.Event.Removed`：删除条目后
- `Memory.Event.Refreshed`：刷新记忆后

---

## 四、Non-Duties（非职责）

### N1: 不负责决定使用时机

何时加载记忆、何时传递给 LLM，由 lifecycle 模块决定。Memory 模块只提供读取接口。

### N2: 不负责与 System Prompt 合并

记忆内容如何与系统提示词组合，由调用方（lifecycle）处理。Memory 模块返回原始 Markdown 文本。

### N3: 不负责内容格式化

Memory 模块返回原始文件内容，不进行格式转换（如转为 JSON、XML）。调用方按需使用。

### N4: 不负责记忆内容的语义理解

记忆条目的去重、冲突检测、语义分析，不在 Memory 模块职责范围。AI 自行判断。

### N5: 不维护内存缓存

每次调用 `load()` 都重新读取文件，确保内容最新。不实现缓存机制（当前版本 YAGNI）。

### N6: 不支持 @import 语法

当前版本不支持在 IRIS.md 中使用 `@import` 引入其他文件（YAGNI）。

### N7: 不处理并发写入冲突

依赖文件系统的原子性写入，不实现文件锁或冲突检测（概率极低，暂不复杂化）。

### N8: 不自动刷新会话中的记忆

会话开始时加载记忆后，会话中途的记忆变更不会自动刷新到当前会话。新记忆在下次会话生效。

---

## 五、设计约束与假设

### 约束

1. **依赖 Project 模块**：使用 `Project.fromDirectory()` 获取项目根路径
2. **依赖 Bus 模块**：使用 Bus 发布记忆变更事件
3. **不依赖 Storage 模块**：直接使用 Node.js `fs` API 读写文件（非结构化文本）
4. **文件编码**：统一使用 UTF-8 编码
5. **XDG 标准**：全局记忆路径遵循 XDG Base Directory 规范

### 假设

1. IRIS.md 文件大小合理（< 1MB），读取性能可接受
2. 同一时刻只有一个进程修改 IRIS.md（并发冲突概率极低）
3. 用户理解并遵守 `## Iris Added Memories` Header 的约定
4. 文件系统的写入操作是原子性的

---

## 六、与其他模块的关系

| 模块 | 代码位置 | 关系 | 调用接口 | 说明 |
|------|----------|------|----------|------|
| Project | `src/project/` | 依赖 | `Project.fromDirectory()` | 获取项目根路径定位 IRIS.md |
| Context | `src/core/context/` | 被依赖 | `Memory.load()` | Context 组装上下文时加载记忆 |
| lifecycle | `src/lifecycle/` | 被依赖 | `Memory.load()` | lifecycle 通过 Context 间接使用 |
| ToolScheduler | `src/core/tool-scheduler/` | 被依赖 | Memory Tools | 调度执行 Memory 工具，工具类别为 `memory` |
| Agent | `src/agents/` | 被依赖 | Memory Tools | AI 通过 Tools 添加/更新/删除记忆 |
| Bus | `src/bus/` | 依赖 | `Bus.publish()` | 发布记忆变更事件 |
| system-prompt | `src/system-prompt/` | 独立 | - | 各自管理，Memory 不直接调用 SystemPrompt |
| Commands | `src/commands/` | 被依赖 | `Memory.add/refresh` | 用户命令（如 `/memory add`）调用 Memory |

**重要说明**：
- Memory 与 SystemPrompt 是**独立**的，不直接交互
- Context 模块调用 `Memory.load()` 获取记忆内容，并与其他上下文一起组装


---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
- [x] 设计目标服务于 KISS 和 YAGNI 原则
- [x] 与 Project、lifecycle、Agent 的关系明确
- [x] Tools 定义在模块内部，职责清晰
