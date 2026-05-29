# tokenCounting 模块的目标与职责

## 设计目标（Design Goals）

1. **轻量级的同步 Token 估算**
   - 提供无需外部依赖、无网络 I/O 的文本 Token 估算能力
   - 同步执行，适合实时上下文规划场景

2. **可注入的上下文估算器**
   - 通过 `createHeuristicTokenCounter()` 产出符合 `core/context` `TokenCounter` 端口的实现
   - 由 `core/context` 决定如何使用估算值（如是否压缩），本模块不持有策略

3. **模型限额与预算的统一出口**
   - 借 `modelProfiles` 注册表，按模型标识解析 context 窗口与输出预算
   - 为未知模型提供保守默认值

## 职责（Duties）

1. **文本 Token 估算**
   - 根据字符是否为 ASCII 进行启发式加权估算（`estimateTokensForText`）

2. **构造可注入的 HeuristicTokenCounter**
   - `estimateTokens`：复用文本估算原语
   - `getLimit`：委托 `modelProfiles` 解析模型 context 窗口
   - `getBudget`：委托 `modelProfiles` 计算输入/输出预算

## 非职责（Non-Duties）

1. **不做对话级估算与告警**
   - 不估算消息历史、不计算使用率、不产出 warning 严重程度
   - 对话历史的 Token 估算与压缩决策由 `core/context` 负责（见 `core/context/token-estimation.ts` 的 anchor 策略）

2. **不执行精确 Token 计数**
   - 仅提供启发式估算值；精确计数由 LLM API 响应的真实 `TokenUsage` 提供

3. **不管理对话历史**
   - 不负责消息的截断、删除或缓存，不参与对话流程决策

4. **不持久化统计数据**
   - 不存储 Token 使用、不提供历史分析或成本统计

5. **不调用外部 API**
   - 所有计算基于本地启发式与本地模型 profile 表，不依赖第三方服务
