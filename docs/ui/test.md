# ui 模块 test.md

本文档定义 `ui` 模块的测试策略与关键测试场景，用于验证模块在真实协作环境中的正确性。

---

## 一、Test Scope（测试范围）

### 1.1 覆盖范围

本模块测试覆盖以下职责：

| 职责 | 测试类型 | 说明 |
|------|----------|------|
| 视图管理 | 单元测试 | 视图切换逻辑 |
| 消息渲染 | 快照测试 | 不同消息类型的渲染输出（类型路由） |
| 状态栏显示 | 快照测试 | 状态栏内容格式 |
| 输入处理 | 单元测试 | 命令分流逻辑 |
| Tab 自动补全 | 单元测试 | 补全建议显示和应用 |
| 弹窗队列管理 | 单元测试 | 队列入队/出队/优先级 |
| 虚拟化列表 | 单元测试 | 可见范围计算、滚动处理 |
| 加载状态 | 单元测试 | 状态转换、显示内容 |
| 键盘快捷键 | 单元测试 | 快捷键识别和处理 |
| 事件订阅 | 集成测试 | Bus 事件响应 |

### 1.2 不在测试范围

以下内容由其他模块测试覆盖：

- Slash 命令的具体执行逻辑（由 cli/commands 模块测试）
- 对话执行逻辑（由 lifecycle 模块测试）
- 权限判断逻辑（由 permission 模块测试）
- 消息存储逻辑（由 message 模块测试）

---

## 二、Critical Scenarios（关键场景）

### 2.1 视图管理场景

#### 场景 1: 初始视图为 HomeView

**前置条件**：应用启动，无初始 sessionId

**预期行为**：
- ViewState.current = 'home'
- 渲染 HomeView 组件

**验证方式**：单元测试 AppContext 初始状态

#### 场景 2: 视图切换

**前置条件**：当前视图为 'home'

**操作**：调用 navigateTo('chat')

**预期行为**：
- ViewState.current = 'chat'
- ViewState.previous = 'home'
- 渲染 ChatView 组件

**验证方式**：单元测试 navigateTo 函数

#### 场景 3: 视图返回

**前置条件**：ViewState = { current: 'help', previous: 'chat' }

**操作**：调用 goBack()

**预期行为**：
- ViewState.current = 'chat'
- ViewState.previous = undefined

**验证方式**：单元测试 goBack 函数

---

### 2.2 消息渲染场景

#### 场景 4: 渲染用户消息

**输入**：
```typescript
{
  message: { role: 'user', ... },
  parts: [{ type: 'text', text: '帮我写代码' }]
}
```

**预期行为**：
- 显示用户消息前缀（绿色 `> `）
- 显示消息文本

**验证方式**：快照测试

#### 场景 5: 渲染 AI 消息（含 TextPart）

**输入**：
```typescript
{
  message: { role: 'assistant', ... },
  parts: [{ type: 'text', text: '好的，我来帮你...' }]
}
```

**预期行为**：
- 显示 AI 消息前缀（蓝色）
- 渲染 Markdown 内容

**验证方式**：快照测试

#### 场景 6: 渲染 AI 消息（含 ReasoningPart）

**输入**：
```typescript
{
  message: { role: 'assistant', ... },
  parts: [
    { type: 'reasoning', text: '让我思考一下...' },
    { type: 'text', text: '我的答案是...' }
  ]
}
```

**预期行为**：
- ReasoningPart 默认折叠
- 显示"推理过程（点击展开）"
- 点击后展开显示内容

**验证方式**：快照测试 + 交互测试

#### 场景 7: 渲染 ToolPart 不同状态

**输入**：不同 status 的 ToolPart

**预期行为**：

| status | 颜色 | 显示内容 |
|--------|------|----------|
| pending | 黄色 | `Edit src/app.js 等待中...` |
| running | 蓝色 | `Edit src/app.js 执行中...` |
| completed | 绿色 | `Edit src/app.js 完成` |
| error | 红色 | `Edit src/app.js 失败: {error}` |
| aborted | 灰色 | `Edit src/app.js 已中断` |

**验证方式**：快照测试（每种状态一个快照）

#### 场景 8: 渲染系统消息

**输入**：
```typescript
{
  message: { role: 'system', kind: 'abort', ... },
  parts: []
}
```

**预期行为**：
- 显示系统消息样式（黄色）
- 显示中断提示文本

**验证方式**：快照测试

---

### 2.3 输入处理场景

#### 场景 9: Slash 命令分流

**输入**：`/model list`

**预期行为**：
- useInput.handleSubmit 调用 cli/commands.executeSlashCommand
- 不调用 lifecycle.execute

**验证方式**：单元测试 + Mock

#### 场景 10: 普通对话分流

**输入**：`帮我写一个排序算法`

**预期行为**：
- useInput.handleSubmit 调用 lifecycle.execute
- 不调用 cli/commands.executeSlashCommand

**验证方式**：单元测试 + Mock

#### 场景 11: 空输入处理

**输入**：`""`（空字符串）或 `"   "`（纯空白）

**预期行为**：
- 不调用任何处理函数
- 不清空输入框

**验证方式**：单元测试

---

### 2.4 Tab 自动补全场景

#### 场景 12: 显示补全建议

**前置条件**：输入框为空

**操作**：输入 `/mod`

**预期行为**：
- useCompletion 调用 cli/commands.getCompletions('/mod')
- CompletionState.suggestions 包含补全建议
- 显示 inline 补全（光标后灰色文本 `el`）

**验证方式**：单元测试 + Mock

#### 场景 13: 应用补全

**前置条件**：输入 `/mod`，显示补全建议 `el`

**操作**：按 Tab 键

**预期行为**：
- 输入框内容变为 `/model`
- CompletionState.suggestions 清空
- 不显示补全建议

**验证方式**：单元测试

#### 场景 14: 无补全时 Tab 无效

**前置条件**：输入 `帮我写代码`（非 slash 命令）

**操作**：按 Tab 键

**预期行为**：
- 输入框内容不变
- 无其他副作用

**验证方式**：单元测试

#### 场景 15: 补全建议更新

**前置条件**：输入 `/mod`，显示补全建议

**操作**：继续输入 `el`，变为 `/model`

**预期行为**：
- 补全建议更新（可能显示子命令如 `list`）
- 或补全建议清空（完全匹配）

**验证方式**：单元测试

---

### 2.5 弹窗队列管理场景

#### 场景 16: 入队并立即显示

**前置条件**：弹窗队列为空（current = null）

**操作**：enqueue(PermissionDialog)

**预期行为**：
- DialogState.current = PermissionDialog
- DialogState.queue = []
- 立即渲染 PermissionDialog

**验证方式**：单元测试

#### 场景 17: 入队并排队等待

**前置条件**：ModelDialog 正在显示

**操作**：enqueue(SessionDialog, priority: 'normal')

**预期行为**：
- DialogState.current 保持 ModelDialog
- DialogState.queue = [SessionDialog]
- 不渲染新弹窗

**验证方式**：单元测试

#### 场景 18: 高优先级插队

**前置条件**：ModelDialog 正在显示，queue = [SessionDialog]

**操作**：enqueue(PermissionDialog, priority: 'high')

**预期行为**：
- DialogState.current 保持 ModelDialog（不打断）
- DialogState.queue = [PermissionDialog, SessionDialog]
- PermissionDialog 排在队列最前面

**验证方式**：单元测试

#### 场景 19: 弹窗响应并出队

**前置条件**：PermissionDialog 正在显示，queue = [ModelDialog]

**操作**：用户选择 "允许"

**预期行为**：
- 调用 resolve(response)
- DialogState.current = ModelDialog（从队列取出）
- DialogState.queue = []
- 渲染 ModelDialog

**验证方式**：单元测试

#### 场景 20: 取消弹窗

**前置条件**：ConfirmDialog 正在显示

**操作**：用户按 Esc

**预期行为**：
- 调用 reject() 或 resolve(null)
- 弹窗关闭
- 显示下一个队列中的弹窗（如有）

**验证方式**：单元测试

---

### 2.6 虚拟化列表场景

#### 场景 21: 初始渲染可见范围

**前置条件**：消息列表有 100 条消息，容器高度 500px

**预期行为**：
- 只渲染可见范围内的消息（约 10-15 条）
- 不可见消息使用占位符
- totalHeight 正确计算

**验证方式**：单元测试

#### 场景 22: 滚动更新可见范围

**前置条件**：当前显示消息 0-15

**操作**：滚动到 scrollTop = 1000

**预期行为**：
- visibleRange 更新为新的范围
- 渲染新范围内的消息
- 之前可见的消息变为占位符

**验证方式**：单元测试

#### 场景 23: 新消息自动滚动

**前置条件**：用户在列表底部（autoScroll = true）

**操作**：收到新消息

**预期行为**：
- 自动滚动到底部
- 新消息可见

**验证方式**：单元测试

#### 场景 24: 用户滚动中不自动滚动

**前置条件**：用户已向上滚动（不在底部）

**操作**：收到新消息

**预期行为**：
- 保持当前滚动位置
- 不自动滚动到底部

**验证方式**：单元测试

#### 场景 25: 动态高度估算

**前置条件**：消息包含不同类型的 Parts

**预期行为**：
- TextPart 按行数估算高度
- ToolPart 按固定高度估算
- ReasoningPart 折叠时较小，展开时较大

**验证方式**：单元测试

---

### 2.7 加载状态场景

#### 场景 26: 思考状态显示

**触发**：Bus 事件 `Lifecycle.Event.Started`

**预期行为**：
- LoadingState.phase = 'thinking'
- 显示 `✦ Thinking...`

**验证方式**：集成测试

#### 场景 27: 工具执行状态显示

**触发**：Bus 事件 `Lifecycle.Event.ToolExecuting { toolName: 'read_file' }`

**预期行为**：
- LoadingState.phase = 'executing'
- LoadingState.toolName = 'read_file'
- 显示 `⠋ Executing tool: read_file`（带旋转动画）

**验证方式**：集成测试

#### 场景 28: 流式响应状态

**触发**：Bus 事件 `Lifecycle.Event.Streaming`

**预期行为**：
- LoadingState.phase = 'streaming'
- 不显示加载指示器
- 直接显示流式内容

**验证方式**：集成测试

#### 场景 29: 完成状态

**触发**：Bus 事件 `Lifecycle.Event.Completed`

**预期行为**：
- LoadingState.phase = 'idle'
- 加载指示器消失

**验证方式**：集成测试

---

### 2.8 键盘快捷键场景

#### 场景 30: Ctrl+C 双击中断

**操作**：500ms 内按两次 Ctrl+C

**预期行为**：
- 调用中断命令
- 显示中断提示

**验证方式**：单元测试（模拟键盘事件）

#### 场景 31: Shift+Tab 切换模式

**操作**：按 Shift+Tab

**预期行为**：
- 调用 commands.execute('agents.mode.cycle')
- 状态栏显示新模式

**验证方式**：单元测试 + Mock

#### 场景 32: 历史导航

**前置条件**：输入历史有 3 条记录

**操作**：按 ↑ 键

**预期行为**：
- 输入框显示上一条历史记录
- 继续按 ↑ 显示更早的记录
- 到顶后不再变化

**验证方式**：单元测试

#### 场景 33: Tab 键补全

**前置条件**：输入 `/mod`，有补全建议

**操作**：按 Tab 键

**预期行为**：
- 应用补全建议
- 输入框显示完整命令

**验证方式**：单元测试

---

### 2.9 事件订阅场景

#### 场景 34: 消息更新事件

**触发**：Bus 发布 `Message.Event.PartUpdated { part, delta }`

**预期行为**：
- SessionContext 更新消息缓存
- Message 组件重新渲染
- 显示增量内容

**验证方式**：集成测试

#### 场景 35: 模式变更事件

**触发**：Bus 发布 `Policy.Event.ModeChanged { mode: 'plan' }`

**预期行为**：
- ConfigContext 更新 mode 状态
- StatusBar 显示新模式

**验证方式**：集成测试

#### 场景 36: 上下文压缩通知

**触发**：Bus 发布 `Context.Event.Compressed`

**预期行为**：
- 显示短暂通知（如 toast）
- 状态栏 token 显示更新

**验证方式**：集成测试

---

## 三、Integration Points（集成点测试）

### 3.1 与 Bus 模块的集成

**测试内容**：事件订阅和响应

**验证点**：
- 正确订阅所有需要的事件
- 事件处理函数被正确调用
- 组件状态更新正确

**测试方式**：
- 使用真实 Bus 模块
- 发布测试事件
- 验证 UI 状态变化

### 3.2 与 cli/commands 模块的集成

**测试内容**：Slash 命令执行

**验证点**：
- 正确调用 executeSlashCommand
- 正确处理返回结果
- 错误情况正确处理

**测试方式**：
- Mock cli/commands 模块
- 验证调用参数
- 模拟不同返回结果

### 3.3 与 lifecycle 模块的集成

**测试内容**：普通对话执行

**验证点**：
- 正确调用 lifecycle.execute
- 正确传递 sessionId 和 prompt
- 流式响应正确渲染

**测试方式**：
- Mock lifecycle 模块
- 验证调用参数
- 模拟流式事件

### 3.4 与 permission 模块的集成

**测试内容**：权限确认流程

**验证点**：
- 正确响应权限请求事件
- 正确调用 Permission.respond()
- 对话框状态正确管理

**测试方式**：
- Mock permission 模块
- 发布测试事件
- 验证响应调用

---

## 四、Verification Strategy（验证策略）

### 4.1 测试类型分布

| 测试类型 | 占比 | 工具 | 说明 |
|----------|------|------|------|
| 单元测试 | 50% | Vitest | 测试独立函数和 hooks |
| 快照测试 | 30% | Vitest + ink-testing-library | 测试组件渲染输出 |
| 集成测试 | 20% | Vitest | 测试模块间交互 |

### 4.2 Mock 策略

#### 需要 Mock 的外部依赖

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| cli/commands | 函数 Mock | 验证调用参数 |
| lifecycle | 函数 Mock | 验证调用参数 |
| permission | 函数 Mock | 验证响应调用 |
| Bus | 部分 Mock | 可使用真实 Bus 或 Mock |
| Ink | 使用 ink-testing-library | 测试渲染输出 |

#### Mock 示例

```typescript
// Mock cli/commands
vi.mock('@/cli/commands', () => ({
  executeSlashCommand: vi.fn().mockResolvedValue({
    handled: true,
    output: 'Command executed'
  }),
  getCompletions: vi.fn().mockReturnValue([
    { text: 'el', displayText: 'model', description: '切换模型' }
  ])
}))

// Mock lifecycle
vi.mock('@/core/lifecycle', () => ({
  lifecycle: {
    execute: vi.fn().mockResolvedValue(undefined)
  }
}))

// Mock Bus 事件
const mockBus = {
  subscribe: vi.fn(),
  publish: vi.fn()
}

// 模拟 Lifecycle 事件
mockBus.publish('Lifecycle.Event.Started', {})
mockBus.publish('Lifecycle.Event.ToolExecuting', { toolName: 'read_file' })
mockBus.publish('Lifecycle.Event.Completed', {})
```

### 4.3 快照测试策略

**适用场景**：
- 组件渲染输出稳定
- 需要检测意外的 UI 变化

**命名规范**：
- `Message-UserMessage.snap`
- `Message-AssistantMessage-TextPart.snap`
- `Message-AssistantMessage-ToolPart-completed.snap`
- `StatusBar-default.snap`

**更新策略**：
- UI 变更时需要审查快照差异
- 确认变更符合预期后更新快照

### 4.4 测试环境

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./src/ui/__tests__/setup.ts'],
  }
})
```

```typescript
// setup.ts
import { cleanup } from 'ink-testing-library'

afterEach(() => {
  cleanup()
})
```

---

## 五、测试文件组织

```
src/ui/
├── __tests__/
│   ├── setup.ts                    # 测试环境设置
│   │
│   ├── views/
│   │   ├── HomeView.test.tsx
│   │   ├── ChatView.test.tsx
│   │   └── HelpView.test.tsx
│   │
│   ├── components/
│   │   ├── message/
│   │   │   ├── MessageList.test.tsx
│   │   │   ├── UserMessage.test.tsx
│   │   │   ├── AssistantMessage.test.tsx
│   │   │   └── SystemMessage.test.tsx
│   │   ├── shared/
│   │   │   ├── VirtualizedList.test.tsx
│   │   │   ├── LoadingIndicator.test.tsx
│   │   │   └── InlineCompletion.test.tsx
│   │   ├── Prompt.test.tsx
│   │   ├── StatusBar.test.tsx
│   │   ├── DialogManager.test.tsx
│   │   └── dialogs/
│   │       ├── PermissionDialog.test.tsx
│   │       ├── ModelDialog.test.tsx
│   │       └── SessionDialog.test.tsx
│   │
│   ├── hooks/
│   │   ├── useInput.test.ts
│   │   ├── useStream.test.ts
│   │   ├── useKeyboard.test.ts
│   │   ├── useHistory.test.ts
│   │   ├── useCompletion.test.ts      # Tab 自动补全
│   │   ├── useDialogQueue.test.ts     # 弹窗队列
│   │   ├── useVirtualizedList.test.ts # 虚拟化列表
│   │   └── useLoading.test.ts         # 加载状态
│   │
│   ├── context/
│   │   ├── AppContext.test.tsx
│   │   ├── SessionContext.test.tsx
│   │   └── ConfigContext.test.tsx
│   │
│   └── __snapshots__/
│       ├── MessageList.test.tsx.snap
│       ├── UserMessage.test.tsx.snap
│       ├── AssistantMessage.test.tsx.snap
│       ├── SystemMessage.test.tsx.snap
│       ├── LoadingIndicator.test.tsx.snap
│       └── StatusBar.test.tsx.snap
```

---

## 六、覆盖率目标

| 模块 | 行覆盖率目标 | 分支覆盖率目标 |
|------|-------------|---------------|
| hooks/ | 90% | 85% |
| context/ | 85% | 80% |
| components/ | 80% | 75% |
| views/ | 70% | 65% |

**说明**：
- hooks 和 context 包含核心逻辑，需要高覆盖率
- components 主要是渲染逻辑，通过快照测试覆盖
- views 是组合组件，集成测试覆盖主要路径

---

## 七、文档自检

- [x] 所有关键职责都有对应的验证场景
- [x] 明确了模块与外部交互时的失败处理预期
- [x] 避免了与具体实现细节的绑定
- [x] 测试策略服务于 goals-duty.md 中定义的职责
- [x] 覆盖了 dfd-interface.md 中描述的关键数据流
- [x] 新增：Tab 自动补全测试场景（场景 12-15）
- [x] 新增：弹窗队列管理测试场景（场景 16-20）
- [x] 新增：虚拟化列表测试场景（场景 21-25）
- [x] 新增：加载状态测试场景（场景 26-29）
- [x] 新增：测试文件组织包含新增 hooks 和组件
- [x] 场景编号连续，共 36 个测试场景
