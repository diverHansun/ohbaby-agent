# ohbaby-sdk 模块 goals-duty.md

本文档定义 `ohbaby-sdk` 模块的设计目标与职责边界。

**模块位置**：
- 代码：`packages/ohbaby-sdk/`
- 文档：`docs/ohbaby-sdk/`

---

## 一、模块定位

**一句话说明**：`ohbaby-sdk` 是前端 surface 与后端 agent 之间的稳定 wire protocol，负责共享 DTO、事件类型、slash command 纯解析与 catalog resolver。

**如果没有这个模块**：
- TUI、非交互 CLI、remote/headless surface 会各自定义协议，行为容易分叉。
- UI 可能直接 import backend 的 Bus、lifecycle、commands 等内部模块，破坏前后端分离。
- Slash command 的解析、补全、事件命名和 interaction 协议缺少统一契约。

---

## 二、Design Goals（设计目标）

### G1: 稳定协议边界

为 UI surface 与 backend adapter 提供稳定、可版本化的通信契约。协议变化必须显式体现在 SDK 类型中。

### G2: 零业务依赖

SDK 不依赖 `ohbaby-agent`、`ohbaby-cli` 或任何业务模块。它只包含类型定义和纯函数，能够在 Node、Worker、WebAssembly 或测试环境中运行。

### G3: 一致的命令语法

为所有 surface 提供一致的 slash command 词法解析、catalog 匹配和补全过滤能力。执行语义仍由后端负责。

### G4: 事件优先

命令结果、运行状态、interaction 和 permission 都通过事件回流。SDK 的 client 方法只表示请求已提交，不承诺同步返回业务结果。

### G5: 可扩展但克制

为 user command、MCP prompt、plugin command、remote UI 等未来扩展预留字段，但 V1 不引入 schema 执行、业务校验或复杂 runtime。

---

## 三、Duties（职责）

### D1: DTO 定义

定义 UI 与 backend 之间传输的稳定数据结构，包括 snapshot、runtime state、message、run、permission、interaction、command catalog 和 command invocation。

### D2: UiBackendClient 契约

定义 frontend surface 调用 backend 的 client 接口，包括：
- 获取 snapshot。
- 订阅事件。
- 提交 prompt。
- 提交 command invocation。
- 响应 permission 和 interaction。
- 中断运行。
- 按需拉取 command catalog。

### D3: Slash command 纯解析

提供 `parseSlashInput()`，只做词法解析：
- 判断输入是否为 slash command。
- 分离 command line 与多行 body。
- 保留 `rawArgs`。
- 按 `argumentMode` 生成 `argv`。

### D4: Catalog resolver

提供 `resolveCommand()` 和 `filterCommandCatalog()`：
- 基于后端下发的 catalog 做 exact match 和 longest catalog match。
- 支持 catalog 声明的 alias。
- 支持补全过滤和下一 segment 提示。

### D5: 事件命名空间

统一 SDK 事件命名，避免各 surface 自行发明事件名称。事件使用点分命名，如 `command.started`、`interaction.requested`。

---

## 四、Non-Duties（非职责）

### N1: 不执行命令

SDK 不包含任何 command handler，不调用 session、message、lifecycle、permission、model provider 或 MCP。

### N2: 不校验业务参数

SDK 可以把 `rawArgs` 切成 `argv`，但不运行 zod/schema 校验。参数合法性由后端 command 执行层判断。

### N3: 不维护 command catalog 真相

Command catalog 由 backend 创建、分类、过滤和版本化。SDK 只消费 catalog。

### N4: 不渲染 UI

SDK 不输出文本表格，不打开 dialog，不依赖 Ink 或 React。

### N5: 不直接暴露内部 Bus

SDK 事件是 wire protocol，不等同于 backend 内部 Bus。backend adapter 负责把内部事件转换为 SDK 事件。

---

## 五、设计约束与假设

### 约束

1. **零 runtime 业务依赖**：不得 import `ohbaby-agent` 或 `ohbaby-cli`。
2. **纯函数优先**：parser/resolver 不读取文件、不访问网络、不依赖全局状态。
3. **事件流统一**：`executeCommand()` 和 `submitPrompt()` 不同步返回业务结果。
4. **协议版本可演进**：DTO 增加字段时优先使用可选字段，避免破坏旧 surface。

### 假设

1. Backend adapter 会实现 `UiBackendClient`。
2. UI surface 会订阅 SDK 事件并维护自己的本地视图状态。
3. Command catalog 低频变化，适合按需拉取并通过事件通知刷新。

---

## 六、文档自检

- [x] 可以用一句话说明 SDK 的存在意义。
- [x] 明确排除了业务执行、UI 渲染和参数校验。
- [x] 命令语法共享与后端执行职责没有重叠。
