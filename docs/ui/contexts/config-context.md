# ConfigContext 配置状态

本文档定义 ConfigContext 的状态结构与使用规范。

ConfigContext 提供应用配置的只读访问。数据由 cli 模块初始化时注入，运行时通过 Bus 事件更新。UI 层不修改配置。

---

## 一、职责

提供以下配置信息的只读访问：

- 当前使用的模型名称
- 当前操作模式（Ask / Plan / Agent）
- Agent 编辑行为设置
- 当前工作目录

---

## 二、State 定义

```typescript
interface ConfigContextValue {
  modelName: string                                        // 当前模型（如 "claude-sonnet-4-6"）
  mode: 'ask' | 'plan' | 'agent'                          // 操作模式
  agentState: 'ask-before-edit' | 'edit-automatically'    // Agent 编辑行为
  workingDirectory: string                                 // 当前工作目录
}
```

**初始值**：由 cli 模块加载配置后传入 Provider。

---

## 三、数据来源

| 字段 | 初始来源 | 运行时更新 |
|------|---------|-----------|
| `modelName` | config 模块加载 | `/model` 命令 → Bus 事件 |
| `mode` | config 模块加载 | Shift+Tab 切换 → Bus 事件 |
| `agentState` | config 模块加载 | `/agent-mode` 命令 → Bus 事件 |
| `workingDirectory` | cli 参数或 `process.cwd()` | `/cd` 命令 → Bus 事件 |

### 更新机制

ConfigContext 的更新由外部事件驱动，UI 层不主动修改：

```
cli 初始化 → config 对象 → ConfigProvider props
                                    |
运行时变更：                          v
  /model 命令 → commands 模块 → Bus.publish(Config.Event.Updated)
                                    |
                                    v
                        ConfigProvider 内部订阅 Bus 事件
                        → setState 更新对应字段
```

---

## 四、消费者清单

| 消费者 | 读取字段 | 用途 |
|--------|---------|------|
| StatusBar | `modelName`, `mode`, `agentState`, `workingDirectory` | 底部状态栏信息展示 |
| SessionProvider | `modelName` | 根据模型确定 context limit，计算 token 使用率 |
| useInput | `mode` | 不同模式下输入处理行为可能不同 |
| HomeView | `modelName`, `mode` | 欢迎界面显示当前配置 |

---

## 五、更新频率

**极低**。只有用户手动执行 slash 命令或按快捷键切换时才会变化。正常对话过程中不会更新。

这是将 ConfigContext 放在 Provider 最外层的理由：变化时影响范围最大，但变化极少发生。

---

## 六、Provider 实现要点

```tsx
interface ConfigProviderProps {
  config: ConfigContextValue      // cli 模块传入的初始配置
  children: React.ReactNode
}

export function ConfigProvider({ config, children }: ConfigProviderProps) {
  const [state, setState] = useState<ConfigContextValue>(config)

  useEffect(() => {
    // 订阅 Bus 事件更新配置
    const unsub = Bus.subscribe(Config.Event.Updated, (payload) => {
      setState(prev => ({ ...prev, ...payload }))
    })
    return unsub
  }, [])

  return (
    <ConfigContext.Provider value={state}>
      {children}
    </ConfigContext.Provider>
  )
}
```

**关键**：ConfigProvider 自身订阅 Bus 事件进行更新。这是 Context 直接订阅 Bus 的唯一场景——因为配置更新来自 commands 模块而非 lifecycle 流程，不经过 useStream。

---

## 七、设计理由

### 为什么 ConfigContext 独立而不合并到 AppStateContext？

两者变化频率差异极大。ConfigContext 极少变化，AppStateContext 在对话过程中频繁变化（LoadingState）。合并后，Config 消费者会被 Loading 变化波及。

### 为什么 ConfigContext 是只读的？

配置的修改由 commands 模块（业务层）负责，UI 层只负责展示。这遵循 ui 模块 goals-duty.md 中"不负责业务逻辑"的原则。

---

## 八、文档自检

- [x] 所有字段有明确的类型定义
- [x] 数据来源和更新机制已说明
- [x] 消费者清单完整
- [x] 更新频率已分析
- [x] Provider 实现要点已说明
- [x] 只读设计理由已解释
