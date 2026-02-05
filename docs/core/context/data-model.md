# context 模块 data-model.md

本文档定义 `context` 模块的核心概念与数据模型。重点是统一"认知模型"，而非冻结实现细节。

---

## 一、Core Concepts（核心概念）

### 概念 1: AssembledContext（组装后的上下文）

**定义**：AssembledContext 是从多个来源收集并组装后的上下文，准备传递给 LLM 使用。

**特点**：
- 包含系统提示词、记忆内容、历史消息
- 提供 token 使用量估算
- 是 LLM 调用的输入数据源

### 概念 2: CompressionResult（压缩结果）

**定义**：CompressionResult 是上下文压缩操作的返回值，包含压缩状态和统计信息。

**特点**：
- 标识压缩是否成功
- 提供压缩前后的 token 对比
- 包含错误信息（如压缩失败）

### 概念 3: ContextUsage（上下文使用情况）

**定义**：ContextUsage 描述当前上下文的 token 使用情况，用于判断是否需要压缩。

**特点**：
- 包含当前 token 数和模型限额
- 计算使用率百分比
- 提供剩余可用空间

### 概念 4: CompressionSnapshot（压缩快照）

**定义**：CompressionSnapshot 是压缩后生成的结构化摘要，使用 XML 格式存储关键信息。

**特点**：
- 包含用户目标、关键知识、文件状态等
- 结构化格式便于 LLM 理解
- 替代被压缩的历史消息

### 概念 5: PruneResult（Prune 结果）

**定义**：PruneResult 是 Prune 操作的返回值，包含被标记的 tool output 统计。

**特点**：
- 标识被 Prune 的 Part 数量
- 提供释放的 token 估算
- 是可逆操作的结果

---

## 二、Entity / Value Object 区分

| 概念 | 分类 | 理由 |
|------|------|------|
| AssembledContext | Value Object（值对象） | 临时组装的数据，无持久化身份 |
| CompressionResult | Value Object（值对象） | 操作结果，无独立身份 |
| ContextUsage | Value Object（值对象） | 统计数据，无独立身份 |
| CompressionSnapshot | Value Object（值对象） | 嵌入在 Message Part 中 |
| PruneResult | Value Object（值对象） | 操作结果，无独立身份 |

**说明**：Context 模块主要处理临时数据和操作结果，不维护持久化实体。持久化由 Message 模块负责（summary Message、compacted Part）。

---

## 三、类型定义

### 3.1 AssembledContext（组装后的上下文）

```typescript
interface AssembledContext {
  // ======== 内容 ========
  /** 系统提示词 */
  systemPrompt: string
  
  /** 记忆内容（来自 Memory 模块） */
  memory: {
    global: string
    project: string
    merged: string
  }
  
  /** 历史消息（来自 Message 模块） */
  history: MessageWithParts[]
  
  // ======== 统计 ========
  /** 预估 token 数 */
  estimatedTokens: number
  
  /** 是否已包含压缩后的 summary */
  hasSummary: boolean
  
  // ======== 元数据 ========
  /** 组装时间戳 */
  assembledAt: number
  
  /** 关联的 sessionId */
  sessionId: string
}
```

### 3.2 ContextUsage（上下文使用情况）

```typescript
interface ContextUsage {
  /** 当前 token 数 */
  currentTokens: number
  
  /** 模型 context limit */
  contextLimit: number
  
  /** 使用率（0-1） */
  usageRatio: number
  
  /** 剩余可用 token */
  remainingTokens: number
  
  /** 是否需要压缩 */
  shouldCompress: boolean
  
  /** 使用的模型 ID */
  modelId: string
}
```

### 3.3 CompressionResult（压缩结果）

```typescript
interface CompressionResult {
  /** 压缩状态 */
  status: CompressionStatus
  
  /** 压缩前 token 数 */
  originalTokens: number
  
  /** 压缩后 token 数 */
  newTokens: number
  
  /** 节省的 token 数 */
  savedTokens: number
  
  /** 创建的 summary Message ID（成功时） */
  summaryMessageId?: string
  
  /** 错误信息（失败时） */
  error?: string
}

type CompressionStatus = 
  | 'compressed'     // 压缩成功
  | 'skipped'        // 跳过（不需要压缩或历史太短）
  | 'failed'         // 压缩失败
  | 'inflated'       // 压缩后反而变大（失败）
```

### 3.4 PruneResult（Prune 结果）

```typescript
interface PruneResult {
  /** 被标记的 Part 数量 */
  prunedCount: number
  
  /** 释放的 token 估算 */
  freedTokens: number
  
  /** 保护的 Part 数量（未被 Prune） */
  protectedCount: number
  
  /** 总扫描的 Part 数量 */
  totalScanned: number
}
```

### 3.5 CompressionSnapshot（压缩快照）

压缩快照使用 XML 格式，存储在 summary Message 的 TextPart 中：

```xml
<state_snapshot>
    <overall_goal>
        <!-- 用户的高层目标 -->
    </overall_goal>

    <key_knowledge>
        <!-- 关键知识点（列表） -->
        - 构建命令: `npm run build`
        - 测试框架: Vitest
    </key_knowledge>

    <file_system_state>
        <!-- 文件系统状态 -->
        - CWD: `/home/user/project/src`
        - MODIFIED: `services/auth.ts`
    </file_system_state>

    <recent_actions>
        <!-- 最近的重要动作 -->
        - 执行了 `npm test`，发现 3 个测试失败
    </recent_actions>

    <current_plan>
        <!-- 当前计划（标记完成状态） -->
        1. [DONE] 分析代码结构
        2. [IN PROGRESS] 修复测试
        3. [TODO] 重构模块
    </current_plan>
</state_snapshot>
```

---

## 四、常量定义

```typescript
// constants.ts

/** 自动压缩触发阈值（context limit 的百分比） */
export const COMPRESSION_THRESHOLD = 0.85

/** 压缩时保留的历史比例（最新的 N%） */
export const COMPRESSION_PRESERVE_RATIO = 0.3

/** Prune 保护的 token 数（保护最近的 N tokens） */
export const PRUNE_PROTECT_TOKENS = 40_000

/** Prune 最小释放 token 数（低于此值不执行） */
export const PRUNE_MINIMUM_TOKENS = 20_000
```

---

## 五、与其他模块类型的关系

### 5.1 与 Message 模块的类型关联

| Context 类型 | Message 类型 | 说明 |
|--------------|--------------|------|
| `AssembledContext.history` | `MessageWithParts[]` | 使用 Message 模块的消息类型 |
| Summary Message | `AssistantMessage` with `summary: true` | 压缩结果存储在 Message 中 |
| Prune 标记 | `ToolPart.state.time.compacted` | 使用 Part 中的 compacted 时间戳 |

### 5.2 与 Memory 模块的类型关联

| Context 类型 | Memory 类型 | 说明 |
|--------------|-------------|------|
| `AssembledContext.memory` | `MergedMemory` | 直接使用 Memory 模块的返回类型 |

### 5.3 与 tokenCounting 模块的类型关联

| Context 类型 | tokenCounting 类型 | 说明 |
|--------------|--------------------|------|
| `ContextUsage.contextLimit` | `TokenLimit` | 使用 tokenCounting 的限额类型 |

---

## 六、Lifecycle & Ownership（生命周期与归属）

### AssembledContext 生命周期

```
创建（Context.assemble）
    │
    ├── 从各模块收集数据
    ├── 计算 token 估算
    │
    ▼
使用中
    │
    ├── 传递给 lifecycle
    ├── 用于 LLM 请求
    │
    ▼
生命周期结束
    │
    └── 临时对象，使用后丢弃（不持久化）
```

### CompressionResult 生命周期

```
创建（Context.compress 返回）
    │
    ├── 返回压缩状态和统计
    │
    ▼
使用中
    │
    ├── UI 显示压缩结果
    ├── 日志记录
    │
    ▼
生命周期结束
    │
    └── 临时对象，使用后丢弃
```

### 数据归属

| 数据 | 创建者 | 管理者 | 持久化 |
|------|--------|--------|--------|
| AssembledContext | ContextAssembler | Context 模块 | 否 |
| CompressionResult | ContextCompressor | 调用方 | 否 |
| Summary Message | ContextCompressor | Message 模块 | 是 |
| Compacted 标记 | ContextPruner | Message 模块 | 是 |

---

## 七、文档自检

- [x] 每个概念都能用自然语言解释
- [x] 不存在"为了设计而设计"的抽象
- [x] 所有概念在后续接口和数据流中都有使用场景
- [x] 与 Message、Memory、tokenCounting 模块的类型关系明确
- [x] 生命周期和归属清晰
- [x] 压缩快照格式参考 Gemini 实践
