# tools 模块 goals-duty.md

本文档定义 `tools` 模块的设计目标与职责边界。

**模块位置**：
- 代码：`src/tools/`
- 文档：`docs/tools/`

**模块定位**：本模块包含所有 **内置工具（Built-in Tools）**：包括文件、shell、agent、网络在内的全部默认工具，由本仓库直接维护。网络类（`web_search` / `web_fetch`）通过 `tools/search-providers/` 子模块对接 Tavily / Exa 等具体后端，不另设 `extension` 层。

---

## 一、工具来源（Tool Sources）

ohbaby-agent 的工具按"来源"分三类，本模块（`tools`）覆盖前者，并向 ToolScheduler 提供统一的 Tool 接口：

| 来源 | 位置 | 说明 |
|---|---|---|
| **内置工具（built-in）** | `src/tools/` | 本模块负责。包括文件、shell、agent、网络等 |
| **模块自带工具（module-owned）** | 各模块内部，如 `src/core/memory/memory-tools.ts` | 与模块紧耦合，由对应模块声明并向调度器注册 |
| **MCP 工具（mcp）** | 运行时动态注册 | 通过 MCP 协议发现，由用户配置 |

`docs/skill/` 描述的 Skill 工具属于"模块自带工具"中的一种，由 skill 模块负责。

**ToolSource 类型**：
```typescript
type ToolSource = 'builtin' | 'module' | 'mcp'
```

---

## 二、Design Goals（设计目标）

### G1: 提供标准化的工具接口

定义统一的工具接口规范，使所有核心工具具有一致的参数定义、执行方式和返回格式，便于 ToolScheduler 统一调度。

### G2: 实现核心文件操作能力

提供完整的文件系统操作工具集，包括读取、写入、编辑、搜索、列表等功能，满足代码开发场景的基本需求。

### G3: 保持工具的纯净性

每个工具只负责自身的执行逻辑，不包含权限检查、确认流程等业务逻辑，这些由 ToolScheduler 和 Permission 模块处理。

### G4: 网络工具收敛到统一接口

`web_search` / `web_fetch` 是内置工具，但其后端可切换。LLM 看到的是 `web_search` / `web_fetch`，背后的 Tavily / Exa 等具体厂商由 `tools/search-providers/` 子模块封装，配置驱动切换。详见 `docs/tools/search-providers/`。

---

## 三、Duties（职责）

### D1: 定义工具接口规范

定义 Tool 接口，包括：
- 工具名称和描述
- 参数 Schema（使用 Zod）
- 执行函数签名
- 返回值格式

### D2: 实现核心工具集

实现以下内置工具：

| 工具 | 类别 | 功能 | 实现位置 |
|------|------|------|----------|
| read | readonly | 读取文件内容（支持文本、图片、PDF） | `tools/read.ts` |
| write | write | 创建或覆盖文件 | `tools/write.ts` |
| edit | write | 替换文件中的文本内容 | `tools/edit.ts` |
| glob | readonly | 使用模式匹配搜索文件 | `tools/glob.ts` |
| grep | readonly | 在文件内容中搜索正则表达式 | `tools/grep.ts` |
| list | readonly | 列出目录结构 | `tools/list.ts` |
| bash | dangerous | 执行 Shell 命令 | `tools/bash.ts` |
| todo_write | write | 写入待办事项列表 | `tools/todo.ts` |
| todo_read | readonly | 读取待办事项列表 | `tools/todo.ts` |
| task | subagent | 调用子代理执行任务 | `tools/task.ts` |
| **web_search** | **network** | **语义 Web 搜索** | **`tools/web-search.ts` → `tools/search-providers/`** |
| **web_fetch** | **network** | **抓取 URL 内容并提取** | **`tools/web-fetch.ts` → `tools/search-providers/`** |

**注意**：
- `web_search` / `web_fetch` 是内置工具，但执行通过 `tools/search-providers/` 子模块调用具体厂商（当前激活 Tavily）
- `task` 工具是子代理的调用入口，子代理硬编码禁用此工具以防止递归

### D3: 处理输出限制和截断

- 对超出限制的输出进行截断
- 在输出中标注截断信息
- 提供分页或偏移量支持（如 read 工具）

### D4: 处理特殊文件类型

- 图片文件：返回 base64 编码
- PDF 文件：提取文本内容
- 二进制文件：检测并拒绝读取

### D5: 提供工具元数据

每个工具提供元数据供 ToolScheduler 使用：
- 工具名称
- 工具描述（供 LLM 理解）
- 参数 Schema（供 LLM 生成参数）
- 工具来源（source: 'core'）

### D6: 支持中断机制

所有核心工具需要支持中断机制：
- **统一执行签名**：接收 `ToolExecutionContext` 参数
  ```typescript
  interface ToolExecutionContext {
    signal: AbortSignal
    sessionId: string
    messageId: string
  }
  
  type ToolExecutor<P, R> = (
    params: P, 
    context: ToolExecutionContext
  ) => Promise<R>
  ```
- **中断策略**：
  | 工具类别 | 中断策略 |
  |----------|----------|
  | readonly | 软中断，等待当前操作完成 |
  | write | 软中断，等待当前操作完成（避免数据损坏） |
  | dangerous (bash) | **硬中断**，SIGTERM → 500ms → SIGKILL |

- **bash 工具特殊处理**：
  - 监听 `signal.abort` 事件
  - 调用 `Shell.killTree(proc, 'SIGTERM')` 终止进程树
  - 500ms 后如进程仍在运行，使用 SIGKILL 强制终止

---

## 四、Non-Duties（非职责）

### N1: 不负责权限检查（通用原则）

工具通常不检查当前模式是否允许执行，权限检查由 ToolScheduler 在调用工具前完成。

**例外：bash 工具**

bash 工具是唯一需要在内部进行权限相关操作的工具，原因是需要在执行前进行命令解析：

| 检查项 | 说明 | 实现方式 |
|--------|------|----------|
| 命令解析 | 提取命令头部和路径参数 | 调用 `utils/command-parser.getCommandRoots()` 和 `detectPaths()` |
| external_directory | 检查命令是否访问项目外目录 | 解析命令中的路径参数，调用 `utils/paths.contains()` |
| 关键操作 | 检查命令是否为关键操作（git push、rm -rf 等） | 调用 `Policy.isCritical()` |
| bash 权限模式 | 根据 Agent 配置的 bash 权限模式匹配 | 使用通配符匹配命令 |

### N2: 不负责工具分类管理

工具的类别（readonly/write/dangerous 等）由 ToolScheduler 的映射表管理，工具本身不声明类别。

### N3: 不负责并发控制

工具不关心是否有其他工具在执行，并发控制由 ToolScheduler 管理。

### N4: 不负责工具注册

工具只是纯函数/对象定义，注册到 ToolScheduler 的逻辑不在本模块。

### N5: 不直接对接 LLM 厂商搜索 SDK

`web_search` / `web_fetch` 工具本身不直接调用 Tavily / Exa SDK；具体厂商封装在 `tools/search-providers/` 子模块中，工具层只调用 `SearchProvider.search()` / `fetch()`。

### N6: 不负责执行状态管理

工具执行的状态（pending/executing/success 等）由 ToolScheduler 管理。

---

## 五、与其他模块的关系

| 模块 | 代码位置 | 关系 | 说明 |
|------|----------|------|------|
| ToolScheduler | `src/core/tool-scheduler/` | 被依赖 | ToolScheduler 调用工具执行函数 |
| search-providers | `src/services/search-providers/` | 依赖 | `web_search` / `web_fetch` 通过该模块调用 Tavily / Exa 等厂商 |
| utils | `src/utils/` | 依赖 | bash 工具依赖 `command-parser`（命令解析）、`paths`（路径检查） |
| Shell | `src/shell/` | 依赖 | bash 工具依赖 Shell 模块 |
| agents | `src/agents/` | 依赖 | task 工具依赖 SubagentExecutor |
| Permission | `src/permission/` | 依赖 | bash 工具调用 Permission.ask() |
| Policy | `src/policy/` | 依赖 | bash 工具调用 Policy.isCritical() |

### bash 工具与 Shell 模块的依赖关系

bash 工具依赖 Shell 模块的以下能力：

| 调用 | 用途 |
|------|------|
| `Shell.acceptable()` | 获取兼容的 shell 路径（过滤 fish/nu 等不兼容 shell） |
| `Shell.killTree(proc)` | 清理超时或被用户取消的命令进程（包括子进程） |

### task 工具与 agents 模块的依赖关系

task 工具是子代理的调用入口，依赖 agents 模块的以下能力：

| 调用 | 用途 |
|------|------|
| `SubagentExecutor.execute(params)` | 执行子代理任务 |
| `AgentManager.get(name)` | 获取子代理配置 |

---

## 六、文档自检

- [x] 可以用一句话说明模块存在的意义：tools 模块提供标准化的内置工具集（含网络工具），供 ToolScheduler 调度执行
- [x] 可以清楚回答"这个模块不该做什么"：不做权限检查、不做分类管理、不做并发控制、不直接对接厂商 SDK
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 工具来源清晰：内置 / 模块自带 / MCP
- [x] web_search 和 web_fetch 已纳入内置工具，背后由 `tools/search-providers/` 子模块封装具体厂商
