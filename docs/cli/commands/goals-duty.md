# cli/commands 退役说明 goals-duty.md

`cli/commands` 不再是活动模块。

---

## 一、模块定位

旧设计中，`cli/commands` 负责 slash command 的 parser、renderer、interactive wrapper。前后端分离后，这些职责已经拆分：

| 旧职责 | 新归属 |
|--------|--------|
| 识别 slash 输入、提取路径和参数 | `ohbaby-sdk` |
| catalog resolver 和 alias 解析 | `ohbaby-sdk` + backend catalog |
| 命令目录、分类、执行 | `commands` backend 模块 |
| 终端渲染和 dialog | `ohbaby-cli` |
| 非交互文本输出 | `docs/cli` 中的 stdout renderer |

---

## 二、Design Goals（设计目标）

### G1: 防止旧边界回流

保留本文档的目的，是明确 `cli/commands` 不应重新成为 UI/backend 的中间耦合层。

### G2: 迁移历史说明

为旧文档链接和历史讨论提供迁移说明，避免后续实现按旧 parser/renderer 方案落地。

---

## 三、Duties（职责）

### D1: 无活动职责

`cli/commands` 没有 V1 实现职责。

---

## 四、Non-Duties（非职责）

### N1: 不负责 parser

Parser 属于 `ohbaby-sdk`。

### N2: 不负责 renderer

Renderer 属于具体 surface：TUI 或 stdout renderer。

### N3: 不负责 command execution

Command execution 属于 backend `commands` 模块。

### N4: 不负责 interactive dialog

DialogManager 属于 `ohbaby-cli`。

---

## 五、文档自检

- [x] 明确说明该模块退役。
- [x] 给出旧职责迁移去向。
