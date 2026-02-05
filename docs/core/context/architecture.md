# context 模块 architecture.md

本文档描述 `context` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

context 模块采用**功能分离架构**，将不同职责分配到独立的子组件：

```
                        lifecycle / Commands
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Context Manager（对外接口层）                                    │
│                                                                  │
│ 职责：                                                           │
│ - 提供统一的上下文管理 API                                        │
│ - 协调各子组件完成组装、压缩、Prune                               │
│                                                                  │
│   ┌──────────────────────────────────────────────────────┐      │
│   │ ContextAssembler（上下文组装器）                      │      │
│   │                                                      │      │
│   │ 职责：                                               │      │
│   │ - 从 Memory、SystemPrompt、Message 收集内容          │      │
│   │ - 合并成 LLM 可用的格式                              │      │
│   └──────────────────────────────────────────────────────┘      │
│                                                                  │
│   ┌──────────────────────────────────────────────────────┐      │
│   │ ContextCompressor（上下文压缩器）                     │      │
│   │                                                      │      │
│   │ 职责：                                               │      │
│   │ - 判断是否需要压缩                                    │      │
│   │ - 调用 LLM 压缩历史                                   │      │
│   │ - 创建 summary Message                                │      │
│   └──────────────────────────────────────────────────────┘      │
│                                                                  │
│   ┌──────────────────────────────────────────────────────┐      │
│   │ ContextPruner（上下文裁剪器）                         │      │
│   │                                                      │      │
│   │ 职责：                                               │      │
│   │ - 扫描旧的 tool output                               │      │
│   │ - 标记 compacted 时间戳                              │      │
│   └──────────────────────────────────────────────────────┘      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
    ┌──────────┐        ┌──────────┐        ┌──────────┐
    │ Memory   │        │ Message  │        │ LLMClient│
    │ 模块     │        │ 模块     │        │ 模块     │
    └──────────┘        └──────────┘        └──────────┘
```

### 主要组件及职责

| 组件 | 职责 |
|------|------|
| **ContextManager** | 对外 API 入口，协调各子组件 |
| **ContextAssembler** | 从多个来源收集并组装上下文 |
| **ContextCompressor** | 执行上下文压缩，创建 summary |
| **ContextPruner** | 执行 Prune 策略，标记旧 tool output |

### 组件间依赖关系

```
ContextManager
    ├── ContextAssembler（调用）
    ├── ContextCompressor（调用）
    └── ContextPruner（调用）

ContextAssembler
    ├── Memory 模块（依赖）
    ├── Message 模块（依赖）
    └── SystemPrompt 模块（依赖）

ContextCompressor
    ├── Message 模块（依赖）
    ├── LLMClient 模块（依赖）
    └── tokenCounting 模块（依赖）

ContextPruner
    └── Message 模块（依赖）
```

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. 功能分离架构

**使用理由**：
- 职责分离：组装、压缩、Prune 各有独立子组件
- 便于测试：可独立 mock 各子组件
- 符合单一职责原则（SRP）

**不采用 Provider 模式的理由**：
- MVP 阶段只有 Memory + History 两个上下文源
- 不需要复杂的扩展机制
- 待未来增加 IDE、RAG 等来源时再考虑

### 2. 策略模式（简化版）

**使用理由**：
- 压缩策略可能有多种实现（如不同的保留比例）
- 当前版本只实现一种策略，但结构上预留扩展点

**实现方式**：
```typescript
// context-compressor.ts
const COMPRESSION_THRESHOLD = 0.85      // 触发阈值
const PRESERVE_THRESHOLD = 0.3          // 保留比例

// 未来可扩展为配置或策略对象
```

### 3. 未使用的模式

**未使用工厂模式**：
- 上下文对象的创建逻辑简单，直接构造即可
- 不需要根据类型创建不同的上下文实例

**未使用观察者模式**：
- 压缩完成通过 Bus 事件通知
- 不需要内部订阅机制

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/core/context/
├── index.ts                  # 模块入口，导出公共 API
├── context-manager.ts        # ContextManager 类实现
├── context-assembler.ts      # ContextAssembler 类实现
├── context-compressor.ts     # ContextCompressor 类实现
├── context-pruner.ts         # ContextPruner 类实现
├── types.ts                  # 类型定义
├── constants.ts              # 常量定义（阈值配置）
├── compression-prompt.ts     # 压缩提示词模板
└── __tests__/
    ├── context-manager.test.ts
    ├── context-assembler.test.ts
    ├── context-compressor.test.ts
    └── context-pruner.test.ts
```

### 各文件职责

| 文件 | 定位 | 说明 |
|------|------|------|
| `index.ts` | 公共接口 | 导出 ContextManager 和类型 |
| `context-manager.ts` | 核心逻辑 | 实现 assemble、compress、prune 等 API |
| `context-assembler.ts` | 组装逻辑 | 从多个来源收集并合并上下文 |
| `context-compressor.ts` | 压缩逻辑 | 调用 LLM 压缩历史，创建 summary |
| `context-pruner.ts` | Prune 逻辑 | 扫描并标记旧的 tool output |
| `types.ts` | 类型定义 | AssembledContext、CompressionResult 等 |
| `constants.ts` | 常量定义 | 阈值配置 |
| `compression-prompt.ts` | 提示词 | 压缩时使用的提示词模板 |

### 对外稳定接口

以下内容构成模块的公共 API，修改需谨慎：
- `ContextManager` 类及其公共方法
- `AssembledContext` 类型
- `CompressionResult` 类型
- `ContextUsage` 类型

### 内部实现

以下内容为内部实现，可自由重构：
- `ContextAssembler`、`ContextCompressor`、`ContextPruner` 的内部实现
- 压缩提示词模板
- 阈值计算逻辑

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 约束 1: 固定阈值 vs 可配置阈值

**当前选择**：使用固定阈值（85% 触发，30% 保留）

**代价**：
- 不同场景无法调整策略
- 某些模型可能需要不同阈值

**理由**：
- MVP 阶段追求简单
- 固定值基于 Gemini 和 OpenCode 的成熟实践
- 未来可扩展为配置项

### 约束 2: Prune 只标记不删除

**当前选择**：Prune 只标记 `time.compacted`，不删除 Part

**代价**：
- 存储空间不会因 Prune 而释放
- 历史数据会持续增长

**理由**：
- 保持历史完整，便于调试和审计
- 可逆操作，清除标记即可恢复
- 存储空间不是当前瓶颈

### 约束 3: 依赖 LLM 进行压缩

**当前选择**：压缩摘要由 LLM 生成

**代价**：
- 压缩操作有额外的 API 成本
- 压缩质量依赖 LLM 能力

**理由**：
- LLM 能够理解语义，生成高质量摘要
- 人工规则难以覆盖复杂场景
- 这是业界的通用做法（Gemini、OpenCode 都如此）

### 约束 4: 同步组装 vs 缓存

**当前选择**：每次 assemble 都重新收集数据，不使用缓存

**代价**：
- 每次调用都有 IO 开销
- 高频调用时可能影响性能

**理由**：
- 简单可靠，避免缓存一致性问题
- IO 开销可接受（单会话场景）
- 未来需要时可加入缓存层

---

## 五、核心流程

### 5.1 上下文组装流程

```
Context.assemble(sessionId, directory)
    │
    ├─1─► Memory.load(directory)
    │         └─► 获取全局 + 项目记忆
    │
    ├─2─► SystemPrompt.build(...)
    │         └─► 获取系统提示词
    │
    ├─3─► Message.getMessages(sessionId)
    │         └─► 获取历史消息（自动过滤 compacted output）
    │
    ├─4─► 合并成 AssembledContext
    │
    └─5─► 返回 AssembledContext
```

### 5.2 压缩流程

```
Context.compress(sessionId, force)
    │
    ├─1─► Context.getUsage(...)
    │         └─► 计算当前 token 使用情况
    │
    ├─2─► 判断是否需要压缩
    │         ├─► force = true：强制压缩
    │         └─► usage >= 85%：自动触发
    │
    ├─3─► Context.prune(sessionId)
    │         └─► 先执行 Prune，释放空间
    │
    ├─4─► 分割历史
    │         ├─► historyToCompress：更早的 70%
    │         └─► historyToKeep：最近的 30%
    │
    ├─5─► LLMClient.generateContent(...)
    │         └─► 用压缩提示词生成 XML snapshot
    │
    ├─6─► Message.updateMessage({ summary: true })
    │         └─► 创建 summary Message
    │
    ├─7─► Message.updatePart({ type: 'text', text: snapshot })
    │         └─► 存储压缩结果
    │
    └─8─► Bus.publish(Context.Event.Compressed)
              └─► 发布压缩完成事件
```

### 5.3 Prune 流程

```
Context.prune(sessionId)
    │
    ├─1─► Message.getMessages(sessionId)
    │         └─► 获取所有消息
    │
    ├─2─► 从最新消息向后遍历
    │         └─► 累计 tool output 的 token 数
    │
    ├─3─► 保护最近的 PRUNE_PROTECT tokens（约 40k）
    │
    ├─4─► 对更早的 tool output：
    │         └─► Message.updatePart({ time.compacted: Date.now() })
    │
    └─5─► Bus.publish(Context.Event.Pruned)
              └─► 发布 Prune 完成事件
```

---

## 六、扩展预留点

虽然当前版本不实现，但架构预留了以下扩展点：

| 扩展功能 | 预留方式 |
|----------|----------|
| IDE 上下文 | ContextAssembler 可增加 IDE 上下文源 |
| RAG 集成 | ContextAssembler 可增加 RAG 结果源 |
| 可配置阈值 | constants.ts 可改为从配置读取 |
| 多种压缩策略 | ContextCompressor 可扩展为策略模式 |

---

## 七、文档自检

- [x] 每个组件存在的理由可以清楚说明
- [x] 所有结构可追溯到 goals-duty.md 中的职责
- [x] 没有为了"优雅"而增加的复杂度
- [x] 明确说明了被放弃的方案及其代价
- [x] 架构支持 KISS 和 YAGNI 原则
- [x] 核心流程清晰描述
