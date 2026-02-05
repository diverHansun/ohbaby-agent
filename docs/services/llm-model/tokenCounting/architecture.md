# tokenCounting 模块架构设计

## 架构概览（Architecture Overview）

tokenCounting 模块由两个独立的职责区域组成：

```
tokenCounting Module
├── Estimator（估算器）
│   └── 负责 Token 的字符级估算
│
└── ModelLimits（模型限额库）
    └── 负责维护模型与 Token 限额的映射
```

**各部分的协作方式：**

1. **Estimator** 接收文本或消息，根据启发式规则计算 Token 数
2. **ModelLimits** 提供指定模型的 Token 限额
3. 两者结合，对外提供高层接口（如 calculateContextTokens）

## 设计模式与理由（Design Pattern & Rationale）

### 1. 无状态设计
**模式：** Stateless Service
**理由：** Token 估算是纯计算操作，无需维持内部状态。每次调用都独立且可预测。

### 2. 数据驱动的模型配置
**模式：** Configuration Map
**理由：** 使用配置表（而非硬编码或动态查询）维护模型限额。简化维护，易于扩展新模型。

### 3. 关注点分离
**模式：** Separation of Concerns
**理由：**
- 分离估算逻辑和模型配置
- 分离底层计算和高层接口
- 便于各部分独立演进

## 模块结构与文件组织（Module Structure & File Layout）

```
src/services/llm-model/tokenCounting/
├── types.ts                  # 类型定义（Token相关的接口）
├── tokenCalculation.ts       # 核心估算逻辑
├── tokenLimits.ts           # 模型限额配置表
├── index.ts                 # 公开接口导出
└── __tests__/
    └── tokenCounting.test.ts # 单元测试
```

**各文件职责：**

- **types.ts**：定义 ContextTokens、TokenWarning 等核心数据结构
- **tokenCalculation.ts**：实现 Token 估算的所有函数（estimateTokensForText、calculateContextTokens 等）
- **tokenLimits.ts**：维护模型-限额的映射表和查询函数
- **index.ts**：导出所有公开的函数和类型

## 架构约束与权衡（Architectural Constraints & Trade-offs）

### 1. 使用启发式算法，而非精确计数
**权衡：** 估算快速但不精确 vs 精确但需依赖外部库
**选择：** 启发式估算
**代价：** ±5-15% 的误差范围
**收益：** 零依赖、同步执行、适合实时场景

### 2. 固定模型限额配置，而非动态查询
**权衡：** 静态配置易维护 vs 动态配置更灵活
**选择：** 静态配置表
**代价：** 新模型需修改代码；不支持运行时调整
**收益：** 简化实现、无需网络调用、性能最优

### 3. 保守的估算策略
**权衡：** 高估 Token 数（可能浪费空间）vs 低估（可能超限）
**选择：** 高估
**代价：** 可用对话空间比实际偏少
**收益：** 避免意外的 API 错误或中断

### 4. 仅提供估算，不强制使用结果
**权衡：** 被动提供vs主动干预
**选择：** 被动提供
**代价：** 上层模块需自行决定是否应用警告
**收益：** 高内聚低耦合，上层有决策自由度

## 与 goals-duty 的对应关系

| Architecture 要素 | 对应目标/职责 |
|------------------|------------|
| Estimator（字符权重计算） | Duty 1：Token 数量估算 |
| ModelLimits（限额表） | Duty 2：模型 Token 限额管理 |
| calculateContextTokens 函数 | Duty 3：会话 Token 使用情况计算 |
| isApproachingTokenLimit 函数 | Duty 4：Token 限制警告 |
| 无状态设计 | Goal 1：轻量级同步 |
| 简单的启发式算法 | Non-Duty 1：不精确计数 |
