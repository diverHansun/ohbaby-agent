# 2. 阶段方案与跨层接线

> 已获实施授权的实施契约；以下是目标行为，不是已完成记录。规划沿用 improve-2.1 路径，本次实施分支为 `codex/improve-2.2`，不另复制一套方案。Web 模块细节以[模块 02](../../../ohbaby-web/improve-3/02-change-spec.md)为唯一结构规格。

## 2.1 方案总览与决定

先把 New session 的入口、权威空判断和连接生命周期接通并单独验收，再按已有职责移动 Web 代码，最后收窄接口、迁移 CSS 与测试。保持 SDK/backend → client/store → React 的事实流，用户操作通过既有 runtime/client 出站。

| 决策 | 理由与代价 | 放弃的做法 |
| --- | --- | --- |
| 功能模块组织，内部按必要性拆文件 | 降低同一功能跨目录追踪成本；增加少量显式接口 | 全局 hooks/utils 大桶；一函数一文件 |
| New session 先独立修复 | 能区分行为修正和机械移动；需要额外跨层回归 | 改完目录后靠单测总数推断修复 |
| 浏览器 runtime 与 backend client 按现有两个类拆开 | 暴露真实职责，保持生命周期；修改 import 但不重造连接框架 | 新状态库、全局 singleton context 大改 |
| 展示数据与操作能力分离 | conversation 可独立使用，准备自然复用；需要整理 props | 完整 ViewModel/client 传遍全部组件 |
| 保留共享会话观看与既有路由保留期 | 复用占用是候选筛选条件，不是会话独占锁 | 断开即取消运行/审批；保留期改零 |

## 2.2 New session 产品与入口合同

### 权威空判断与选候选

一个可复用候选必须是同 canonical project 的 active 主会话，非 child/归档，持久 message（含零 part 的消息）、run、任意状态 prompt 均不存在；活动或正在准入的 submit 也不存在。metadata 的 messageCount=0 只是预筛选。读取失败显式报错，不当作空或静默新建。

权威空判断由持有 message、run、prompt stores 的 `ui-inprocess.ts` 提供，通过窄异步谓词注入现有 session-controller；controller 负责候选顺序，`createSessionMetadata` 和 in-process `/new` 复用同一判断。热页 `messages.length` 与 metadata `messageCount` 只能预筛，不能独自判空；直接 in-process 提交也必须受 backend 权威空检查和提交准入保护，不能只靠 server。server 提供当前 client 的绑定、其他有效占用与在途保护，不由后端读取 React 或 server 全局 activeSessionId。顺序：本客户端当前空 root → 同项目其他未占用空 root → 创建。禁止复用则跳过两类候选。

### 入口矩阵（必须有差分测试）

| 入口 | 目标语义 | 返回 / 副作用 |
| --- | --- | --- |
| Web New 按钮 | 明确请求复用；上述顺序 | 复用原 ID；同一健康 scope 不重置 ready、审批或草稿 |
| Web/remote `/new` 默认 | 同一规则，以调用 client 的绑定为准 | 复用输出 `session.current`，新建输出 `session.created`；保留 session.selected action 的 source=new |
| `/new --no-reuse-empty-session` | 明确新建，不复用当前或闲置空会话 | 新 ID、session.created；不新增未有的 `--no-reuse` 别名 |
| in-process `/new` | 同一空规则和 flag；使用其本地 scope | 保留原终端清屏/选择事件，不引入 daemon 依赖 |
| 低层 SDK/JSONRPC `createSession()` 无复用选项 | 保持明确创建的默认能力 | 不将所有底层创建悄悄改成复用 |
| 低层创建带复用选项 | 参数显式传递并按绑定验证 | 忽略选项不是兼容实现；外部 exclude 不能取消 server 的其他 client 保护 |
| fresh 启动 | 保持当前空视图/按需创建合同 | 不为拆分主动写入空会话 |

Web 的私有 `POST /v1/sessions` 增加可选 `reuseEmpty` 意图，缺省为 false 保持底层创建行为；浏览器 New 明确传 true。daemon `/new` 将 flag 转换为同一 server 操作，不直接借全局 backend 选中态。JSONRPC createSession 必须透传 SDK 的可选参数，server 对目标候选与调用绑定校验，并合并自己的排除集合；不得信任客户端自报的“其他 client 已离线”。

追加验收补齐浏览器 SDK 适配：REST 同时支持显式 `options`（SDK 的 `reuseSessionId` / `reuseInactiveEmpty.excludeSessionIds`），与旧 `reuseEmpty` 不能同时指定。两者均缺省仍明确创建；旧 `reuseEmpty` 兼容保留。Web runtime 的 New 显式传复用 options，公开 `client.createSession()` 维持低层默认新建。非法 options 在产生会话前返回 400，selected-root 和其他客户端保护仍由 server 校验。

创建/复用结果要来自实际操作，而非用“绑定是否改变”猜测：从 A 换到既有空 B 是 changed=true、created=false。定义只用于 `createSession` 操作返回的 `UiSessionCreationResult extends UiSessionIndexEntry`，增加可选 `created`；`UiSessionIndexEntry` 本身保持纯索引 DTO，该字段不得进入 index/数据库或持久态。本仓库参与复用的 adapters 和 test doubles 必须提供准确 `created`，旧 backend 没有 outcome 或不支持复用时，复用路径显式报告能力/合同错误，不伪造 created。无选项的明确创建仍可返回不含该字段的既有形状。REST/JSONRPC wrapper 对齐操作结果；`rpc-route.ts` 当前硬编码 `session.created`，须和已按结果区分 current/created 的 `commands/builtin.ts` 一并改为真实操作结果。

### 有界并发与提交屏障

- 同 client、同 binding generation、同复用策略的 New 操作共享正在执行的结果；REST、JSONRPC 和命令入口共用 server 级协调。命令仍各自保留 invocation 身份与响应。不同 flag/不同绑定不能混为一个请求。
- 现有 `for(;;)` 改为有限重试：同一被排除候选再次返回立即判定 backend 合同失败；并发抢占最多重选 3 次，耗尽明确报可重试冲突，不自动强制创建。无可用候选时只能由权威 backend 的明确创建分支创建一次。
- coordinator 候选排除同时查看现有 `pendingSessionCreates` 和按会话记录运行归属的 `activePromptsBySession`，并增加短期在途 create/select/submit pin。`activePromptsBySession` 记录单个 prompt item 的运行路由，不可直接充当同会话多个请求的准入计数。每个请求在首次 `await` 前建立自己的 pin，成功或失败均在 `finally` 释放；无 SSE 或 timer 到期也不能删除在途 pin。准入后由持久 prompt/run 事实继续保护，不把 pin 延长到模型运行结束。
- 后端返回候选后，绑定前同步复查 generation、其他有效占用及在途 submit/provisional。空判断到候选确认之间要有连续的准入保护，不能“再 await 一次查询”后留下新窗口；直接 in-process 路径也须覆盖。不得把数据库事务横跨网络等待。
- 请求断开或迟到不能选择到新 generation。已经写入但失去绑定资格的会话保留事实，不擅自删除；同 scope 后续请求可通过正常规则复用。

## 2.3 连接状态与占用资格

server 已拥有 SSE 集合和保留 timer；在现有 coordinator 内集中管理唯一的空候选占用资格来源与在途 pin，不新建全局 session lease 服务。注册和无 SSE 请求刷新的是同一宽限机制，SSE 在线取消宽限计时；最后一条 SSE 断开立即失去空候选占用资格，但路由清理 timer 仍按既有预算运行。

| 状态 | 空候选占用规则 | 路由 / 绑定 |
| --- | --- | --- |
| 已注册、尚未建立 SSE | 注册时启动有界初始宽限，沿用 5000ms 默认预算；期间保守占用；每次观测到 HTTP/JSONRPC 请求刷新该宽限 | 不在注册时创建会话；SSE 建连取消宽限 timer |
| 同 ID 至少一条 SSE 在线 | 占用；关闭其中一条不能释放 | 正常路由 |
| 最后一条 SSE 断开、无在途操作 | 立即撤销该 client 对空候选的排除资格；候选是否空仍经权威判断；后续无 SSE 请求可重新获得有界活性宽限 | 保留既有路由清理 timer，不改 binding/generation/owner，不立即取消运行或审批 |
| 无 SSE、仍有 create/select/submit 在途 | 保留对应候选保护到准入结算 | 不因 timer 删除在途保护；最终成功/失败有幂等释放 |
| 无 SSE 宽限到期 | 撤销空候选占用资格；在途 pin 仍有效 | 清理 `knownClientIds` 与 interaction 状态须遵循既有 owner/过期合同；清理 timer 先验证没有更新的请求或重连，不能删除在途 pin；后续请求按既有注册要求处理 |
| 同 ID 在保留期内重连 | 恢复在线占用，取消旧 timer；旧 timer 不能清理新连接 | 保留原绑定，不抢回或自动换到别的空会话 |

被释放的 B 若已被另一个 client 复用，旧 client 重连可以继续观看 B，等同现有多页共享会话；复用资格不是独占会话租约。审批继续按既有 root/epoch/generation 及一次回答规则路由，不扩大权限。同 root 多页能看到权限请求，不代表 command/interaction 的 owner 可互换。

## 2.4 同 scope 的健康与恢复行为

| 原状态 | 同 binding 的 New/receipt 响应 |
| --- | --- |
| ready | 维持已有 session/permission 订阅，不人为闪恢复提示 |
| syncing，已有有效恢复在途 | 加入/等待既有同步，不每次点击 restart |
| error / 无有效恢复的 idle | 显式触发现有会话恢复入口，保留草稿；审批按自己的状态独立恢复 |
| 旧 epoch / generation / 已切 workspace | 丢弃旧响应，不能恢复旧页或清掉新页草稿 |

实际无 session 的 idle 空视图不是失败，应保留 fresh 语义。800ms 首次加载提示与中断后恢复提示仍由 session 功能的 hook 管理，不用 UI banner 代替恢复动作。

## 2.5 实施阶段与完成定义

| Stage | 内容 | DoD / 中央验收 ID |
| --- | --- | --- |
| S0 基线收纳 | 对账未提交修改与 HEAD，保留用户工作；固化源码/行为测试和编译 UI 基线；建立能失败的刷新回归 | T01、T02 |
| S1 会话修复 | 入口矩阵、权威空规则、有限协调、占用/路由分离、error 恢复；独立提交 | T02–T08、T16 |
| S2 机械提取 | 先拆现有 runtime/client 两类；逐个提取 conversation、commands、permissions、workspace/composer、session，收窄 App | T09–T13、T17；原 App 行为断言保持 |
| S3 状态与接口整理 | session 掌管提交投影；composer 掌管本地编辑；commands/permissions 通过显式边界接线 | T09–T13、T17；不变成万能 useAppController |
| S4 样式与测试迁移 | 样式按原顺序入口组织；测试在源码提取稳定后另批迁移；更新权威文档 | T14、T15、T17 |
| S5 组合验收 | 编译服务、真实浏览器、SQLite、必要 TUI 回归、完整测试与独立审查 | T01–T17，产出本轮 05 |

各 Stage 在本轮内推进，不另开新轮。机械移动、行为修复、接口重构、CSS/测试迁移分别形成可审查提交；不能要求行为修复也“只搬不改”。

## 2.6 改动面、兼容与回滚

Web 的具体迁移清单只定义在[模块 02 §关键改动](../../../ohbaby-web/improve-3/02-change-spec.md#26-关键改动清单)，这里不重复维护。

| 包 / 目录 | 本轮作用 |
| --- | --- |
| ohbaby-web | 功能拆分、有限 props、runtime/client 分文件、New 请求意图、同 scope 恢复 |
| ohbaby-server | coordinator/create-app/REST/RPC/命令共用 New 协调；SSE 占用生命周期与有限重试 |
| ohbaby-agent | `ui-inprocess` 持有权威空谓词并注入 session-controller；直接 in-process 提交保护；持久 adapter 透传操作结果；prompt store 全状态存在性检查 |
| ohbaby-sdk | 创建选项与 `UiSessionCreationResult` 操作返回合同；`UiSessionIndexEntry` 不扩宽 |
| docs/ohbaby-web | 结构、状态和测试文档随实施同步；不提前把目标写成现状 |

不做数据库 schema 迁移，不清理用户历史、不改变模型请求/调度。API 的窄范围增量以 §2.2 为准，不能称为“零协议变化”；新增字段不能泄露内部 client 排除名单。旧无复用创建兼容，支持复用的客户端/backend 必须成套验证。旧 source import 仅在确有消费者时临时 re-export，最终清理，避免永久双入口。

回滚优先逐提交撤回结构迁移，保留已通过的会话修复；若撤回会话修复，要明确原回归重现，不能用它宣称恢复正确。运行数据无需转换；回滚不删除新旧会话。

## 2.7 关键跨层锚点

> 用户要求关键文件清单。行号是 2026-09-27 快照，以符号为准；不是实施进度表。

| 路径（仓库根相对） | 符号 / 行号 | 要改什么 |
| --- | --- | --- |
| packages/ohbaby-server/src/app/create-app.ts | POST /v1/sessions L1686；createSseResponse L2496；scheduleClientRoutingCleanup L2600 | New 意图与共用协调；首次注册/多 SSE/最后断开/重连 timer 接线 |
| packages/ohbaby-server/src/coordination/client-view.ts | initializeClient L336；sessionIdsBoundByOtherClients L420；preparePromptSubmit L448；activePromptsBySession | 唯一占用资格、逐请求准入 pin 与现有单 item 运行路由/owner 区分 |
| packages/ohbaby-server/src/coordination/session-access.ts | createOrReuseClientSession（从 permission-access.ts 迁入） | 有界操作、显式策略、created 与 changed 区分；New 协调固定放此处，避免混入 permission-access 职责 |
| packages/ohbaby-server/src/protocols/jsonrpc/{client,rpc-route}.ts | createSession L215；executeCommand/new L425 | 参数、flag、outcome、并发合并对齐 |
| packages/ohbaby-agent/src/adapters/ui-inprocess.ts 及 ui-inprocess/session-controller.ts | isAuthoritativelyEmptySession；createSessionFromCommand | 持有 stores 的 adapter 注入窄异步权威谓词；controller 只决定候选顺序；保留 in-process 行为及直接提交保护 |
| packages/ohbaby-agent/src/runtime/prompt-scheduler/*store*.ts | hasForSession | 所有状态均使会话非空；未知/失败不能当空 |
| packages/ohbaby-sdk/src/client.ts | createSession L158 | 创建意图与兼容 outcome；连带更新 adapters/fakes |

## 2.8 不在本轮

中央 improve-3/4 的子代理能力、全树停止与冷恢复；TUI 目录整理；大消息 O(N²) 投影优化；视觉改版；通用 modal/表单框架；多 store 重构；新增状态库；跨进程会话独占/接管。保留旧问题的记录，不以这次拆分宣称解决。
