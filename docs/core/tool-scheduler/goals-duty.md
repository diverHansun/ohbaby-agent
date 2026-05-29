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
- Built-in Tools（内置工具，含网络工具）
- Module-Owned Tools（模块内置工具）
- Skill Tools（技能系统工具）
- MCP Tools（MCP 工具）

> `web_search` / `web_fetch` 是 `tools` 下的内置工具入口，后端走 `services/search-providers/` 对接 Tavily/Exa 等具体后端；它们对调度器而言仍是普通的 builtin 工具。

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
│  1. Built-in Tools（静态导入，含网络工具）                   │
│     └── 从 src/tools/ 导入并注册                            │
│     └── 包含 web_search / web_fetch（背后走 search-providers）│
│     └── source: 'builtin'                                   │
│                                                             │
│  2. Module-Owned Tools（模块注册）                           │
│     └── Memory.registerTools(scheduler)                     │
│     └── source: 'module'                                    │
│                                                             │
│  3. Skill Tools（技能系统注册）                              │
│     └── skill / skill_resource                              │
│     └── source: 'skill'                                     │
│                                                             │
│  4. MCP Tools（运行时发现）                                  │
│     └── MCP Manager 发现并注册                               │
│     └── source: 'mcp'                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**ToolSource 类型**：
```typescript
type ToolSource = 'builtin' | 'module' | 'skill' | 'mcp'
```

---

## 三、Duties（职责）

### D1: 管理工具注册表

维护所有可用工具的注册表，支持多来源注册：
- Built-in Tools：启动时静态注册（含 web_search / web_fetch）
- Module-Owned Tools：模块初始化时调用 `registerTools()`
- Skill Tools：runtime composition 注册 `skill` / `skill_resource`
- MCP Tools：运行时动态注册

### D2: 维护工具类别映射

维护工具名称到类别的映射表：
- readonly：只读操作（read, glob, grep, list, todo_read）
- write：写入操作（write, edit, todo_write）
- dangerous：危险操作（bash）
- network：网络操作（web_search, web_fetch）—— 内置工具入口，后端走 `services/search-providers/` 路由到具体厂商
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
- 记忆操作（memory）：始终可并行，不受读写锁限制，不参与 wave 分组
- 子代理操作（subagent）：最多 3 个并行（独立计数器），不参与 wave 分组（避免长时间运行阻塞后续 wave）

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

### D9: 处理未配置后端的网络工具

当内置网络工具（`web_search` / `web_fetch`）的 search-providers 后端未配置（例如 `TAVILY_API_KEY` 缺失）时：
- 选项 A：从工具列表中过滤掉 `web_search` / `web_fetch`，不暴露给 LLM
- 选项 B：保留工具注册，但 `execute()` 时返回友好错误，引导用户配置

调度器本身不做配置的解析或验证；具体策略由 `tools/web-search.ts` / `tools/web-fetch.ts` 与 `services/search-providers/registry` 协作决定。

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

### N5: 不负责网络工具的后端配置管理

`web_search` / `web_fetch` 的后端选择（Tavily / Exa / 未来其它 provider）由 `config/tools/{provider}` 与 `services/search-providers/registry` 负责，ToolScheduler 只调度统一的 Tool 接口，不感知背后是哪家厂商。

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
| Built-in Tools | `src/tools/` | 依赖 | 调用所有内置工具实现（含 web_search / web_fetch） |
| search-providers | `src/services/search-providers/` | 间接依赖 | `web_search` / `web_fetch` 工具内部使用，调度器不直接接触 |
| Memory | `src/core/memory/` | 依赖 | 注册 Memory Tools |
| Skill | `src/skill/` | 依赖 | 注册 SkillTool，加载用户定义的技能 |
| MCP | `src/mcp/` | 依赖 | 注册 MCP 工具 |
| Bus | `src/bus/` | 依赖 | 发布状态变化事件 |
| Config | `src/config/` | 间接依赖 | 工具自身读取所需配置；调度器不读取 |

---

## 六、网络工具的后端配置（与 ToolScheduler 的关系）

`web_search` / `web_fetch` 是 `tools` 入口，但其执行后端走 `services/search-providers/`。配置由 `config/tools/{provider}` 模块负责，ToolScheduler 不直接读取。

### 配置位置（参考）

1. **API Key**：存放在 `.env` 文件中
   ```
   TAVILY_API_KEY=tvly-xxx
   ```

2. **Provider 选择 / 默认参数**：存放在配置文件中
   - 全局配置：`~/.config/ohbaby-agent/tools/{provider}.yaml`
   - 项目配置：`.ohbaby-agent/tools/{provider}.yaml`

详见 `docs/config/tools/tavily/`、`docs/tools/search-providers/`。

### 未配置处理

当 search-providers 后端未配置（apiKey 缺失等）时，由 `web_search` / `web_fetch` 工具自身（而非调度器）决定：
- 选项 A：注册时跳过，不暴露给 LLM
- 选项 B：保留注册，执行时返回引导用户配置的错误信息

ToolScheduler 对此透明，只看到统一的 Tool 接口和正常/异常的执行结果。

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义：ToolScheduler 是工具执行的调度中心，统一管理多来源工具
- [x] 可以清楚回答"这个模块不该做什么"：不做工具实现、不做策略决策、不做确认流程、不做模式管理
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 工具来源分层（builtin / module / mcp）架构清晰
- [x] 网络工具的后端选择与未配置处理由工具与 search-providers 子模块负责，调度器对此透明
