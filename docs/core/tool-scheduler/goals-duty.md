# tool-scheduler 模块 goals-duty.md

本文档定义 `tool-scheduler` 模块的设计目标与职责边界。

**模块位置**：
- 代码：`src/core/tool-scheduler/`
- 文档：`docs/core/tool-scheduler/`

---

## 一、Design Goals（设计目标）

### G1: 提供统一的工具调度入口

作为工具执行的唯一入口，接收来自 Agent/LLM 的工具调用请求，协调权限检查、并发控制和工具执行。

### G2: 实现智能的并发控制

支持读操作并行执行以提高效率，同时确保写操作的串行执行以保证数据一致性。

### G3: 维护完整的执行状态

通过状态机管理工具调用的完整生命周期，提供可观测的执行状态和进度。

### G4: 与 Policy/Permission 无缝集成

在执行工具前查询 Policy 获取决策，根据决策调用 Permission 进行用户确认，确保权限控制的完整性。

### G5: 统一管理多来源工具

管理来自不同来源的工具注册和调用：
- Core Tools（核心工具）
- Module-Owned Tools（模块内置工具）
- Extension Tools（扩展工具）
- MCP Tools（MCP 工具）

---

## 二、工具来源架构

ToolScheduler 负责管理四种来源的工具：

```
┌─────────────────────────────────────────────────────────────┐
│                    ToolScheduler                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  初始化时注册：                                              │
│                                                             │
│  1. Core Tools（静态导入）                                   │
│     └── 从 src/tools/ 导入并注册                            │
│     └── source: 'core'                                      │
│                                                             │
│  2. Module-Owned Tools（模块注册）                           │
│     └── Memory.registerTools(scheduler)                     │
│     └── source: 'module'                                    │
│                                                             │
│  3. Extension Tools（按配置加载）                            │
│     └── 读取用户配置，实例化对应 Provider                    │
│     └── 未配置时禁用或提示用户配置                           │
│     └── source: 'extension'                                 │
│                                                             │
│  4. MCP Tools（运行时发现）                                  │
│     └── MCP Manager 发现并注册                               │
│     └── source: 'mcp'                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**ToolSource 类型**：
```typescript
type ToolSource = 'core' | 'module' | 'extension' | 'mcp'
```

---

## 三、Duties（职责）

### D1: 管理工具注册表

维护所有可用工具的注册表，支持多来源注册：
- Core Tools：启动时静态注册
- Module-Owned Tools：模块初始化时调用 `registerTools()`
- Extension Tools：根据配置动态加载
- MCP Tools：运行时动态注册

### D2: 维护工具类别映射

维护工具名称到类别的映射表：
- readonly：只读操作（read, glob, grep, list, todo_read）
- write：写入操作（write, edit, todo_write）
- dangerous：危险操作（bash）
- network：网络操作（web_search, web_fetch）**来自 extension/tools**
- memory：记忆操作（memory_*，默认 ALLOW）
- skill：技能加载操作（skill，只读级别权限）
- subagent：子代理调用（task，子代理禁用）

### D3: 提供模式感知的工具列表

根据当前工作模式和 Agent 配置返回可用工具：
- Ask/Plan 模式：只返回 readonly、network、memory 类别的工具
- Agent 模式：返回所有类别的工具
- 同时根据当前 Agent 的 tools 配置过滤

### D4: 执行工具调用

接收工具调用请求，完成以下流程：
1. 验证工具存在性和配置有效性
2. 查询 Policy 获取决策
3. 根据决策处理（直接执行/调用 Permission/拒绝）
4. 并发控制检查
5. 执行工具
6. 返回结果

### D5: 管理并发执行

实现并发控制策略：
- 读操作（readonly/network/skill）：最多 5 个并行
- 写操作（write/dangerous）：必须串行，且无其他操作时才能执行
- 记忆操作（memory）：始终可并行，不受读写锁限制
- 子代理操作（subagent）：最多 3 个并行（由 SubagentExecutor 控制）

### D6: 管理执行状态

通过状态机管理每个工具调用的状态：
- pending → checking_policy → queued/awaiting_approval → executing → success/error/rejected/cancelled

### D7: 发布状态变化事件

工具执行状态变化时，通过 Bus 发布事件，供 UI 和其他模块订阅。

### D8: 支持执行取消

支持取消工具调用：
- **单个取消**：取消指定的工具调用
- **批量取消**：取消所有正在执行的工具调用
- **中断响应**：收到 AbortSignal 中断信号后，阻止启动新的工具调用

### D9: 处理未配置的 Extension Tools

当 Extension Tool（如 web_search）未配置 Provider 时：
- 选项 A：禁用该工具，不返回给 LLM
- 选项 B：返回工具，但执行时提示用户需要配置 API Key

### D10: 传递 AbortSignal 给工具

执行工具时构建 `ToolExecutionContext` 并传递给工具：
```typescript
interface ToolExecutionContext {
  signal: AbortSignal
  sessionId: string
  messageId: string
}
```

**中断时的行为**：
- 收到中断信号后，阻止启动新的工具调用
- 对正在执行的工具：
  - readonly/write/memory/skill：软中断，等待完成
  - dangerous (bash)：硬中断，终止进程
- 已完成的工具调用不受影响

---

## 四、Non-Duties（非职责）

### N1: 不负责工具实现

具体工具的执行逻辑由各工具模块实现，ToolScheduler 只负责调度。

### N2: 不负责策略决策

是否需要确认、是否允许执行由 Policy 模块决定，ToolScheduler 只查询并执行决策。

### N3: 不负责确认流程

用户确认的 UI 显示和响应收集由 Permission 模块处理，ToolScheduler 只调用 Permission.ask()。

### N4: 不负责模式管理

当前工作模式由 Policy 模块管理，ToolScheduler 只查询模式。

### N5: 不负责 Extension 配置管理

Extension Tools 的配置（Provider 选择、API Key）由 Config 模块管理，ToolScheduler 只读取配置。

### N6: 不负责 LLM 交互

与 LLM 的通信由 Agent 模块处理，ToolScheduler 只接收工具调用请求。

---

## 五、与其他模块的关系

| 模块 | 代码位置 | 关系 | 说明 |
|------|----------|------|------|
| Lifecycle | `src/core/lifecycle/` | 被依赖 | Lifecycle 调用 execute() 执行工具 |
| AgentManager | `src/agents/` | 依赖 | 获取当前 Agent 的工具配置 |
| Policy | `src/policy/` | 依赖 | 查询工作模式和执行决策 |
| Permission | `src/permission/` | 依赖 | 请求用户确认 |
| Core Tools | `src/tools/` | 依赖 | 调用核心工具实现 |
| Extension Tools | `src/extension/tools/` | 依赖 | 加载扩展工具实现 |
| Memory | `src/core/memory/` | 依赖 | 注册 Memory Tools |
| Skill | `src/skill/` | 依赖 | 注册 SkillTool，加载用户定义的技能 |
| MCP | `src/mcp/` | 依赖 | 注册 MCP 工具 |
| Bus | `src/bus/` | 依赖 | 发布状态变化事件 |
| Config | `src/config/` | 依赖 | 读取 Extension 配置 |

---

## 六、Extension Tools 配置

Extension Tools 需要用户配置才能使用：

### 配置位置

1. **API Key**：存放在 `.env` 文件中
   ```
   EXA_API_KEY=xxx
   TAVILY_API_KEY=xxx
   ```

2. **Provider 选择**：存放在配置文件中
   - 全局配置：XDG 标准目录 (`~/.config/iris-code/config.yaml`)
   - 调试配置：`.iris-code/extension/tools/` 目录

### 配置示例

```yaml
# config.yaml
extension:
  tools:
    web_search:
      provider: "tavily"   # 或 "exa", "google", "zhipu"
    web_fetch:
      provider: "direct"   # 或 "jina"
```

### 未配置处理

当 Extension Tool 未配置 Provider 或 API Key 时：
- 工具仍然注册到 ToolScheduler
- 执行时返回友好的错误提示，引导用户配置

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义：ToolScheduler 是工具执行的调度中心，统一管理多来源工具
- [x] 可以清楚回答"这个模块不该做什么"：不做工具实现、不做策略决策、不做确认流程、不做模式管理
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 工具来源分层（core/module/extension/mcp）架构清晰
- [x] Extension Tools 配置和未配置处理机制明确
