# ohbaby-web · UI 状态可视化

> 各状态如何在界面上呈现。连接态/运行态是 preview 的「正确性可见」核心；空态是首屏。对齐 [`../data-model.md`](../data-model.md)（ConnectionState 五态机、ViewState）与 [`../use-case.md`](../use-case.md)。参考实现：[`design/session-screen.dc.html`](./design/session-screen.dc.html)、[`design/empty-state.dc.html`](./design/empty-state.dc.html)。

---

## 1. ConnectionState 五态 → 状态文字

主会话状态文字（header 右侧）呈现根会话连接态（无诊断行）。不显示圆点或内层胶囊。颜色组：slate=蓝、green、gold、red。

| ConnectionState      | 文案           | 色组  | 动效  | 含义                                     |
| -------------------- | -------------- | ----- | ----- | ---------------------------------------- |
| `live` + run idle    | `idle`         | green | 无    | 实时、空闲                               |
| `live` + run running | `running`      | slate | pulse | 实时、agent 运行中                       |
| `connecting`         | `connecting`   | gold  | pulse | 建连中                                   |
| `reconnecting`       | `reconnecting` | gold  | pulse | SSE 断、带 Last-Event-ID 重连            |
| `resyncing`          | `resyncing`    | slate | 无    | 命中 resync-required，重拉 snapshot 重建 |
| `disconnected`       | `disconnected` | red   | 无    | 不可恢复（如 401），等用户介入           |

> `running` 是 `live` 下的子状态（连接 live 且有 run 进行）。`reconnecting` 必须显眼（gold + pulse）；`resyncing` 用 slate 静态文字表示正在重同步，不把它误画成仍在运行。

---

## 2. 运行态（run）

- **running**：状态文字 `running`(slate,pulse) + 流内三色波点思考指示器（`Thinking · {elapsed}s`）。composer 空草稿显示圆形方块 Stop，有草稿显示圆形纸飞机；发送后 follow-up 进入队列、草稿清空，恢复 Stop。
- **等待子代理**：在既有根 StatusBar 的正常布局区域显示等待及完成/活动数量，不使用固定底部坐标覆盖输入区或末尾消息。
- **waiting-for-permission**：当前根存在主/子待批时提示等待审批，即使没有 primary active run；这不修改无关 primary 的执行状态。
- **idle**：状态文字 `idle`(green) + 流内定稿行 + composer 显示圆形纸飞机。
- **中断**：double-esc 或 Stop → 转 idle（与 CLI 一致）。
- **重连 / 重同步**：顶栏显示 `reconnecting` / `resyncing`，保留最后已知 run 状态。空草稿且最后已知 running 时显示不可点的圆形 Stop；不能据此断言 run 当前仍在执行。同步后依最新快照更新主按钮。
- **命令 UI**：slash 命令执行中显示 running notice；错误回流后就地更新；只读成功结果可打开结构化 modal。command UI 是易失投影，不改变 run 状态，除非 command 本身通过 backend 产生 session/run 事件。

---

## 3. 空态 / 就绪屏（首屏未发 prompt）

参考 [`design/empty-state.dc.html`](./design/empty-state.dc.html)：

- **居中抬升的输入框**（非底部 dock），上方 `oh ba by` 字标 + `ohbaby-agent · ~/dev/ohbaby-agent · glm-5.1` 一行上下文。
- **发送首条 prompt 后**：输入框下沉到底部 dock，进入主会话屏布局。
- 仍受连接态约束：未建连/建连中时状态文字如实显示（connecting/disconnected），输入受限。

---

## 4. 错误 / 不静默（呼应 non-functional）

UI 不得静默失败。当前已定义的呈现：

- **401 token 失效** → `disconnected`(红) 文字 + 提示"重启 ohbaby serve / 重新打开"。
- **审批同步**有独立 idle/syncing/ready/error/unavailable 状态；全局 live 不自动启用按钮。临时失败耗尽后显示 Retry approvals，严重 PERMISSION_UNAVAILABLE 保持停用、不自动重试。PERMISSION_NOT_PENDING 重新同步，旧范围错误不更新新范围。见 [`components.md`](./components.md)。
- **网络错 / 通用失败** → 通知条（待补具体样式；归 ConversationStream 顶部或 header 下方的瞬时条）。

> 注：通用错误通知条的视觉样式当前设计未给出具体稿，实现时按"瞬时、可见、可关"补齐；状态机层面已由 ConnectionState 覆盖主链路失败。

---

## 5. 开发者可观测性（不在 UI）

`seqNum / clientId / lastEventId / 端口` 等不进 UI（决策 1，简洁优先）。正确性（基线对齐、续传、resync）在内部强制执行，开发者从 devtools/console/日志查看。v0.1.6 不做指标/trace 上报（见 [`../non-functional.md`](../non-functional.md)）。

## 6. 子会话阅读状态

| 状态 | 呈现与交互 |
| --- | --- |
| 未打开 | 根消息中的紧凑委派行显示任务和 execution 状态，无额外顶部栏 |
| 定位中 | 显示 `Locating delegation…`；目标明确后定位该次父消息，自动滚底不能覆盖定位 |
| 已接受、未开跑 | 蓝色父消息显示 `From parent` 和 `Queued`；开跑后由同一消息身份接管 |
| 阅读浮层 | 子消息、思考与工具增量更新；根输入区保持形状和草稿，显示 `Read-only subagent`，写操作禁用 |
| 放大阅读 | 原消息 DOM 和阅读状态不变；显示父子路径，根阅读区和输入区隐藏；底部标明 `Read-only` |
| 阅读旧窗口 | 保持当前阅读位置，显示后续历史间隔；用户滚动或主动加载推进窗口，也可跳转最新，不靠程序滚动循环加载 |
| 无精确锚点 | 说明原始委派消息不可定位，展示可用历史；正文为空且有可靠存档结果时显示 `Stored result` |
| 重连或读取失败 | 分别显示 `Reconnecting…` 或错误与 Retry；不把连接异常伪装为子任务成功 |
| 根有待审批 | 子会话仅提示 `Approval required`；回根后实际审批卡取代输入区（含 Todo/队列），保留草稿和停止入口，最后一项处理完恢复输入区 |
| 关闭 | 恢复根输入和焦点；根持有的子会话阅读缓存保留，重开工具展开可恢复，明确点击委派仍优先定位该次父消息 |

运行结果与阅读模式相互独立：关闭、放大、收起或切换子会话都不取消 execution，也不改变其终态。
