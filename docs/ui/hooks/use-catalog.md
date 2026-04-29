# useCatalog — 命令目录管理 Hook

本文档定义 useCatalog 的职责和 catalog 生命周期管理。

useCatalog 负责从 backend 拉取命令目录并写入 TuiStore，以及在 useStream 标记 catalog 失效后刷新。

---

## 一、职责

- 启动时调用 `client.listCommands({ surface: 'tui' })` 获取初始 catalog。
- 将 catalog 写入 TuiStore `catalog` 切片。
- 监听 TuiStore 的 `catalogInvalidation` 信号，版本号变化时重新拉取。
- 管理 catalog loading 状态（loading / loaded / error）。

**不做的事**：
- 不解析或执行命令（由 useInput 负责）。
- 不维护 catalog 真相（由 backend CommandService 负责）。
- 不订阅 SDK event stream。`command.catalog.updated` 只能由 useStream 接收并写入 `catalogInvalidation`。

---

## 二、签名

```typescript
function useCatalog(client: UiBackendClient): void
```

无返回值。catalog 数据通过 TuiStore selector `useCommandCatalog()` 读取。

---

## 三、调用位置

**App.tsx**（全局唯一，与 useStream 同级）

---

## 四、生命周期

```
App 挂载
    │
    ├─ client.listCommands({ surface: 'tui' })
    │     │
    │     ▼
    │  TuiStore.catalog = { version, commands }
    │
    ├─ useStream 收到 command.catalog.updated
    │     │
    │     ▼
    │  TuiStore.catalogInvalidation = { version, reason, receivedAt }
    │     │
    │     ▼
    │  useCatalog 观察到 catalogInvalidation.version 变化
    │     │
    │     ▼
    │  client.listCommands({ surface: 'tui' })
    │     │
    │     ▼
    │  TuiStore.catalog = { version, commands }
    │
App 卸载
    │
    └─ 取消订阅
```

---

## 五、实现要点

```typescript
function useCatalog(client: UiBackendClient): void {
  const invalidation = useCatalogInvalidation()

  useEffect(() => {
    let cancelled = false

    async function load() {
      const catalog = await client.listCommands({ surface: 'tui' })
      if (!cancelled) {
        tuiStore.setCatalog(catalog)
      }
    }

    const current = tuiStore.getState().catalog
    if (!current || (invalidation && current.version !== invalidation.version)) {
      load()
    }

    return () => {
      cancelled = true
    }
  }, [client, invalidation?.version])
}
```

- 初始加载和刷新共用同一个 `load()` 函数。
- 版本号比较避免不必要的重复拉取。
- `cancelled` flag 防止卸载后写入 store。

### 关于事件订阅边界

useCatalog 不直接调用 `client.subscribeEvents()`。SDK event stream 只由 useStream 聚合订阅；useStream 收到 `command.catalog.updated` 后只写入 `TuiStore.catalogInvalidation`，不调用 `listCommands()`。

这样可以同时满足两个约束：
- SDK 事件只有一个入口，避免多订阅生命周期问题。
- catalog 刷新仍由 useCatalog 负责，避免 useStream 的 reducer 路径掺入异步 RPC。

---

## 六、Catalog 未加载时的行为

| 场景 | 行为 |
|---|---|
| 用户输入 `/model` 但 catalog 尚未加载 | useInput 显示本地错误"命令目录尚未加载" |
| Tab 补全 | 不返回建议 |
| HelpView | 显示 spinner |

---

## 七、依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `UiBackendClient` | 参数 | `listCommands()` |
| TuiStore | 写入 | `setCatalog()` |
| TuiStore | 读取 | `catalogInvalidation` |

---

## 八、文档自检

- [x] catalog 初始化和刷新流程完整。
- [x] 版本号比较避免重复拉取。
- [x] 与 useStream 的分工清晰（useStream 标记 stale，useCatalog 拉取 catalog）。
- [x] catalog 未加载时的降级行为已说明。
