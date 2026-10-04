# improve-3：测试与验收

2026-10-03。**这是实施验收计划，未执行产品测试。** 遵循 [项目测试规则](../../../../docs-test/README.md)。前端用户用例见 [frontend/08](frontend/08-test-and-acceptance.md)，统一 fixture 见 [frontend/06](frontend/06-data-api-and-state.md)。

## 1. 测试分层

unit 测 diff、预览、身份与恢复调度；contract 测 SDK DTO/RPC、终端输出和按键可观察行为；integration 测执行→持久化→SDK→真实 store/组件；smoke 测锁定 pi 包的 import/build 与 CLI 入口。FakeTTY 记录真实 Ink 控制序列，Ghostty 验证回滚、复制、resize 和输入法。不开新的浏览器 UI 测试项目，不使用真实 LLM 做日常回归。

## 2. 验收场景

| ID     | 场景与明确断言                                                                                                                                                                                                                             | 层级/入口                               | Stage |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ----- |
| I3-T01 | 记录前轮实际 commit/输出策略，阅读、整帧预算、输入模式基线已通过；缺口不伪称完成                                                                                                                                                           | 前轮 04/05＋Ghostty                     | 0/5   |
| I3-T02 | pi Markdown 列表/表格/代码/未闭合结构和文本函数在真实 Ink 无二次换行；有效列宽扣除前缀，emoji 不切半；改共享 wrap 时回归会话选择器列对齐、用户/系统消息及后备输出，来源过滤/reasoning 隐藏和编辑器 tab 契约不变                            | render unit＋Ink contract，F05          | 1     |
| I3-T03 | 已完成长工具滚出当前视口后，Ctrl+O 能在当前会话投影的原位置展开/恢复正常紧凑视图；主动切换至多一次必要整体重建，允许清屏替换原生回滚；不追加副本、不删会话消息，后续刷新稳定；两种模式的晚到修正/旧页前插仍正确，无变化通知不重印          | transcript contract＋Ghostty，F03/F04   | 1/3   |
| I3-T04 | CSI/OSC/ANSI 截断不泄漏颜色或控制序列；长 URL、tab、宽字符、无色和复制可用                                                                                                                                                                 | render contract＋真机                   | 1     |
| I3-T05 | Read/Glob/Grep 参数和可信数量正确；0、未知、部分扫描、展示受限、token 裁剪区分                                                                                                                                                             | tool-part unit/DTO contract，F01        | 2a    |
| I3-T06 | Bash 紧凑保留末尾，展开可达完整保存输出；失败原因未被裁掉，空输出不混成未知                                                                                                                                                                | message-row contract，F03               | 2a    |
| I3-T07 | 后台启动只显示已启动/已知状态，无凭空实时日志和虚假完成；未知工具安全后备                                                                                                                                                                  | 工具投影 contract，F03                  | 2a    |
| I3-T08 | 小改一行只出现相关 hunk；重复行、首尾插删、空文件、CRLF、无末尾换行、无变化正确                                                                                                                                                            | output/diff unit                        | 2b    |
| I3-T09 | Write 锁内有界采集、mtime/abort 保护不变；新建/覆盖/dry-run/失败语义正确；diff 失败不改变写入结果                                                                                                                                          | tools/write integration，F02            | 2b    |
| I3-T10 | 同一工具现场、快照恢复和历史补载展示事实一致，包括 failed 部分 output；序列化不会丢 details                                                                                                                                                | Agent→SDK integration/contract，F01–F03 | 2a/2b |
| I3-T11 | 旧快照/旧 error/无 details 可解码；旧无 diff 不伪造；源头已截断不出现虚假全文入口；Web 兼容                                                                                                                                                | DTO/RPC＋共享消费者回归                 | 2a/2b |
| I3-T12 | 一次 Ctrl+O 只切一次；无结果/投影无差异时安静切换模式且不强制清屏，后到结果遵循模式；已展开后 resize 令全部内容变短也能收起；审批/命令/队列编辑等独占上下文不触发；草稿/光标不变                                                           | app.contract＋Prompt 组合               | 3     |
| I3-T13 | 展开后新结果/补历史沿当前模式；切会话回紧凑，resize/恢复不重置；不发 loadHistory/submit                                                                                                                                                    | app/store integration，F04              | 3     |
| I3-T14 | Read/搜索默认摘要，显式展开可读保存正文；Write 开头、Bash 末尾、diff 变化处预览，紧凑省去 hunk 标头而展开保留真实范围；长单行及多行/超长命令按显示行限制，短或空输出不掩盖命令溢出；展开恢复完整必要参数，原数据不变；错误/行号/缩进不越界 | tool render unit＋Ink contract          | 3     |
| I3-T15 | 暂时故障超过 SDK 快速上限，假时钟推进后自动恢复；身份/初始化/control 同样能前进；远端首次 initialize 失败后同一 client 可恢复且无重复会话/授权变化；健康无额外恢复查询                                                                     | recovery unit/integration，F06          | 4     |
| I3-T16 | 提交已接收但确认丢失：自动查原 ID；null 回执不重发；新建会话绑定正确；明确拒收/旧 epoch 不误执行                                                                                                                                           | recovery contract＋延迟客户端           | 4     |
| I3-T17 | 单类请求不重叠，读取永不返回时能超时取消，服务随后健康可继续且迟到响应无效；持续失败按退避上限，重复 hello 不重置风暴；断线停查询，切换/dispose 取消，旧结果不串会话；无 Ctrl+R 入口/提示，恢复先落地后再集成 improve-2 也不重新加入       | 假时钟＋请求计数＋App                   | 4     |
| I3-T18 | 20 条混合工具与 300 行输出，Markdown 流式、审批、Tasks、长草稿、上滚、展开、resize 组合无回归                                                                                                                                              | FakeTTY＋Ghostty，F03–F06               | 3/5   |

I3-T03 的限制要如实记录：终端原生 scrollback 的旧物理副本不能任意原地修改。验收对象是应用当前会话的正确投影、历史可达性和后续阅读稳定；允许用户已确认的主动清屏重印，但不得删除会话事实或把展开副本贴到末尾算通过。一次切换后继续任务、编辑和普通刷新，验证稳定历史不被每帧重印。

## 3. 运行入口

实施时按改动选择相关测试，新增文件遵循 `.unit/.contract/.integration/.smoke.test.ts(x)` 分类，不为每个 helper 建镜像测试。当前已有入口可执行：

```sh
pnpm exec vitest run packages/ohbaby-cli/src/tui/session-recovery.unit.test.ts packages/ohbaby-sdk/src/session-sync.unit.test.ts
pnpm exec vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx packages/ohbaby-cli/src/tui/components/message/parts/tool-part.unit.test.ts packages/ohbaby-cli/src/tui/components/message/message-row.unit.test.tsx
pnpm exec vitest run packages/ohbaby-cli/src/tui/components/transcript/transcript-viewport.flicker.contract.test.tsx
pnpm exec vitest run packages/ohbaby-server/src/protocols/jsonrpc/client.unit.test.ts
pnpm run typecheck
pnpm run build
```

Agent diff、Write 和投影测试用 `rg --files packages/ohbaby-agent/src` 找到既有测试入口后运行，新增链路测试必须覆盖 I3-T09/10；上述现有命令不是全轮已完备的测试集合。按项目提交要求运行 lint/format 等检查，勿以 `--passWithNoTests` 掩盖漏跑。

## 4. 真机步骤与回归

Ghostty 记录版本、macOS、行列、主题、tmux/SSH 条件。80×24 下加载 F04，运行输出时上滚并停留 10 秒；结束后再停留 10 秒。主动 Ctrl+O 后回滚读取旧工具，再静置，检查后续普通通知不会不断拉回底部。以 60×20 和 120×40 重复关键路径。

在展开态输入中文/emoji 草稿，切审批再返回、补历史、断线重连、复制命令/代码，核对草稿/光标、字素、内容顺序和退出后的终端状态。切动画关闭、深浅背景、低色彩重复阅读检查。Windows 不作为本轮同等专项验收，但不主动破坏已有分支。

回归前轮来源过滤、reasoning 隐藏、working phrase 稳定、两行底栏、长输入、普通 PgUp/候选翻页、队列原身份、审批 Esc/Always、Tasks Ctrl+T。工具展开不能替代 Tasks 长列表的未决阅读方案。

I3-T03 的隔离候选要同时记录启动前 shell scrollback、当前会话已加载消息及未加载历史的前后可达范围，不能只检查 store 还在。用户已接受主动切换时必要的 scrollback 替换；通过条件仍包括已加载会话顺序正确、未加载历史可经原入口补载、草稿/光标不变、再次按键恢复正常紧凑视图，以及之后普通刷新稳定。

## 5. 发布判断与对抗性检查

| 攻击面             | 必须防住                                                                  | 残余限制                          |
| ------------------ | ------------------------------------------------------------------------- | --------------------------------- |
| 巨量结果与历史改高 | 动态帧有界，历史正确，Ctrl+O 不制造副本或删除会话事实；主动清屏重印后稳定 | 原生回滚坐标不可被应用精确控制    |
| 伪造/缺失 metadata | 白名单与身份校验，不猜 diff/成功/数量                                     | 旧记录未保存内容无法补回          |
| 回执丢失与跨 epoch | 只查原 ID，不重复执行                                                     | 服务端丢失确认事实时可能长期未知  |
| 自动恢复持续失败   | 单在途、退避、断线暂停、dispose 清理                                      | 自动尝试不能修复永久配置/权限错误 |
| ANSI 与宽度        | 不执行工具输出中的终端控制动作，样式闭合，复制可读                        | 字体/终端差异必须真机记录         |

任何承重技术验证门未通过，本轮都不能标完成。计划审查通过、单测通过和真实终端验收是三种不同证据。实施结束后再创建 05 和前端 09，记录已测、未测及实际风险。
