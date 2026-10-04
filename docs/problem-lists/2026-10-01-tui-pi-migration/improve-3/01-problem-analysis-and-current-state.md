# improve-3：现状与问题

2026-10-03；ohbaby 分析基线 `5c2adab5`。本轮仅改文档。前两轮是规划基线，未发现本议题的 05 验收文档；不得把其目标写成当前产品能力。以下路径相对仓库根，行号是快照，定位以符号为准。

## 1. 主要问题

| ID     | 当前事实与证据                                                                                                                                                                                                                                     | 用户影响                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| I3-P01 | `packages/ohbaby-cli/src/tui/components/message/parts/tool-part.tsx:9` 的 `renderToolPart` 只显示结果错误；`message-row.tsx` 配对工具主要渲染 label                                                                                                | 成功 Bash 输出、Write 内容和 Edit diff 看不到                 |
| I3-P02 | `packages/ohbaby-sdk/src/snapshot.ts:150` 的 `UiToolResult` 只有 output/error/execution 等；实时 `adapters/ui-runtime/run-stream-adapter.ts:193` 与历史 `adapters/ui-state/persistent-store.ts:83` 没有通用展示事实投影（后两项位于 ohbaby-agent） | 数量、采集截断、真实 diff 等不能只靠改组件解决                |
| I3-P03 | `packages/ohbaby-agent/src/tools/utils/output.ts:50` 的 `renderUnifiedDiff` 把整个 before 标成删除、after 标成增加                                                                                                                                 | 改一行也像重写整份文件，无法突出改动                          |
| I3-P04 | `packages/ohbaby-agent/src/tools/write.ts` 仅 dry-run 分支计算 diff；正式写入只有字节数、created 等 metadata                                                                                                                                       | 覆盖后无法还原执行时的旧内容，TUI 事后读文件不可靠            |
| I3-P05 | `packages/ohbaby-cli/src/tui/render/markdown.ts` 为自制逐行解析；工具摘要以 UTF-16 长度 180 截断；`pattern` 未被摘要输入候选覆盖                                                                                                                   | Markdown、中文、emoji、长路径的显示规则分散                   |
| I3-P06 | `app.tsx:551` 将 Ctrl+R 交给 recovery.retry；`session-recovery.ts:285` 刷新 identity/control/sync/receipts；SDK `session-sync.ts` 的单轮有界恢复会进入 error                                                                                       | 删除按键后若不接续自动恢复，仍可能永久等待手动重试            |
| I3-P07 | 当前没有 Ctrl+O 工具展开；前轮输出策略尚有技术验证门                                                                                                                                                                                               | 不能假定 Static 输出能够通过 React props 更新已打印历史       |
| I3-P08 | lifecycle 的普通 error 状态未保存 result.output；persistent-store 对 error 返回空 output，实时则可能含部分输出                                                                                                                                     | 失败命令在现场和恢复后看到的内容可能不一致                    |
| I3-P09 | `packages/ohbaby-server/src/protocols/jsonrpc/client.ts:657` 缓存失败的 initializePromise；初始化在 SSE 重连循环外。CLI 的 identity/control/index/receipt 读取也没有统一有界期限                                                                   | 仅增加 CLI 自动定时重试仍可能无法前进，或被永不返回的查询卡住 |

## 2. 按职责检查

### 2.1 目标、用例与架构

ohbaby 负责工具业务事实、权限与会话状态；Ink 负责输入、布局和终端生命周期。pi-tui 的 `Component.render(width)` 返回显示行，不是 React 组件。可以复用 Markdown 和公开文本函数，但不能直接把 Pi coding-agent 的工具 renderer 当成 SDK 组件导入。

高频用例的缺口是“结果读不到”和“失败后需要懂恢复快捷键”，不是缺少工具管理系统。前两轮保留的输入、审批、Tasks 不需要为了这一轮重写。

### 2.2 数据模型与数据流

```text
工具执行结果（output / metadata）
    → lifecycle 持久化 ToolPart.state
    → 实时 / 快照 / 历史投影
    → UiToolResult → store → 工具行
```

执行数据已有 metadata 落点，不等于 SDK 已暴露所需字段。新增展示事实应按白名单投影，不透传任意 metadata；必须让实时与历史用同一个映射。Read 的读取范围、Grep 的扫描完整性/展示限制、Glob 的 token 裁剪和 Bash 后台状态含义不同，不能统一用 `truncated=true` 代替所有语义。

Write 的正式覆盖 diff 需要在文件锁内、写入之前取得有预算的旧内容；成功后记录执行事实。旧记录没有这份事实时只展示实际保存内容，不能追溯编造。普通 error 的部分输出需沿既有工具状态 JSON 的序列化链补齐可选字段及校验，不能只在 CLI 内缓存。

### 2.3 非功能性

主要风险是 MainScreen 原生回滚与重绘冲突、巨量输出挤占动态帧、ANSI/宽字素被二次换行，以及自动恢复造成请求风暴。pi Markdown 有主题、tab、链接和环境能力检测行为，不能称为完全无环境影响的纯字符串函数。必须用真实 Ink 与 Ghostty 验证。

### 2.4 测试现状

已有 `app.contract.test.tsx`、`message-row.unit.test.tsx`、`tool-part.unit.test.ts`、transcript flicker 契约测试、`session-recovery.unit.test.ts`、SDK `session-sync.unit.test.ts`，可直接扩充真实失败用例。尚不能用这些文件存在来证明 Ctrl+O、真实 diff、回执自动查询和 pi 兼容已经通过。

测试遵循 [docs-test](../../../../docs-test/README.md)：纯算法 unit、DTO contract、真实模块协作 integration、构建入口 smoke。终端回滚和复制需要真机，测试假终端不能替代。

## 3. 旧设计与目标差距

| 旧文档                               | 当前代码              | 本轮处理                                                |
| ------------------------------------ | --------------------- | ------------------------------------------------------- |
| plan 的“长内容进入详情”，入口未定    | 没有完整详情能力      | 已被用户否决；改为原位 Ctrl+O                           |
| improve-1 的稳定历史和整帧预算       | 输出策略仍需实施验收  | 本轮 Stage 0/1 使用其实际契约，不假设已支持任意历史改高 |
| improve-2 保留 Ctrl+R                | 手动 retry 和提示存在 | 本轮 Stage 4 替换为自动恢复，前轮文本标注接续关系       |
| improve-2 暂不接 pi，Markdown 留后续 | 当前无 pi Markdown    | 本轮只消费这一留项，不迁移编辑器                        |

## 4. SWE 判断与影响面

复用成熟文本能力可以减少自制解析，但叠加第二套终端宿主会增加维护成本。应保持一条显示链、一个工具事实来源和一个恢复调度责任方。少量专用函数优于工具插件平台；有界 diff 和可选 DTO 字段优于无限保存所有原始内容。

涉及 CLI 的显示/恢复、SDK 的可选结果字段、Agent 的工具事实及两条投影；自动恢复另需覆盖远端客户端初始化失败缓存和恢复读取的取消/超时。Web 作为共享 DTO 消费者做兼容回归，不改变其布局。没有理由为本轮另建独立模块文档树；本目录作为唯一改造契约。
