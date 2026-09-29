# 测试与验收标准

> 2026-09-29，规划草案，与 [02](02-optimization-plan-and-change-scope.md) 一起审查。以下是未来实施的验收要求，当前未执行这些新验收。已运行的 54 项基线单测与纯函数探针仅见 [证据说明](evidence/2026-09-29/research-notes.md)。

## 1. 分层策略

确定性单元测试覆盖投影、提示分类、命名素材、命令返回结果和清理规则；集成测试覆盖真实 SQLite、owner/初始化交错、SDK/HTTP/JSON-RPC、输出与完成回执的乱序；编译版 Web/TUI 检查用户全过程；真实模型仅用于标题质量和必要执行请求验证。

异步竞争使用可控闸门，保留失败现场，不用 sleep 恰好等到页面正常作为成功依据。不为 Bash 图标这种展示改动增加大量复制实现的测试；关键断言放进现有组件用例即可。

## 2. 验收矩阵

### Stage 1：会话进入与同步

| ID  | 场景                                      | 层次与硬断言                                                                                                |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| T01 | 健康会话 A→B→A、重复选择当前会话          | backend+SDK 集成：显式执行检查仍发生；进入动作本身不换健康 generation、不触发 mismatch 或多余 baseline 重读 |
| T02 | 首次读取撞上进行中的恢复/初始化           | 闸门集成：读取等待明确结果；不抛临时未初始化错误后循环 rebuild；同 session 并发入口不重复初始化             |
| T03 | 另一个客户端进入同一健康会话              | 真实 server+两个 SDK client：已有客户端不因对方选择而失效；身份与 revision 衔接正确                         |
| T04 | 真正补保存/失主恢复                       | SQLite 集成：interrupted、retained 和 control 真正进入视图；不自动发送 retained；不因取消 rebuild 漏事实    |
| T05 | 恢复失败、错误会话与另一健康会话          | 失败与隔离集成：保留原失败、草稿和正确准入；普通 GET 不反复写恢复；健康会话仍可进入                         |
| T06 | 100ms / 超过800ms首次加载、同会话短暂重连 | React 可控时钟：快速加载无恢复横幅；慢加载为正常 Loading；真实错误可见；内容不串会话                        |
| T07 | 快速连续选择、恢复回调与读取交错          | SDK/owner+Web：旧回复不覆盖最新选择；无初始化循环等待；发送/Stop/Steer 不使用旧会话身份                     |

T01/T03 的“无多余重读”限定于没有真实失效的控制场景，不把真实换代后必要重同步判成缺陷。记录所有状态转换和 baseline 次数，不仅截最终正常页面。

### Stage 2：工具详情与子会话阅读界面精简

| ID  | 场景                                           | 层次与硬断言                                                                                                |
| --- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| T08 | Bash error/cancelled/timed-out，实时与历史读取 | 现有工具组件用例+浏览器：不显示额外警告符号；错误文本、耗时、展开和 aria-label 仍准确；其他工具语义未被清空 |

新增场景沿用尾部编号，不重排已有 T01–T34：

| ID  | 场景                          | 层次与硬断言                                                                                                                         |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| T35 | 子会话小面板/展开视图移除箭头 | 组件+浏览器：无 Jump to latest 按钮及空浮层；滚动、分页、贴底/不抢滚动、定位/阅读缓存保留；Tab/Escape/关闭/展开正常                  |
| T36 | 多种旧工具没有 execution      | 组件+历史页面：展开只显示已有输入/输出/错误，无缺失阶段占位文案、不虚构计时；覆盖 web_fetch、subagent_status、Bash 等，主/子会话一致 |
| T37 | 新工具保存后重开和分页        | 真实 SQLite+投影+Web：合法 execution 与起止事实经保存→刷新/重开→历史/子会话保持；无效数据仍按既有校验处理，真实读取/工具错误不隐藏   |
| T38 | 只有工具结果的分页窗口        | 带合法 execution 的 result 单独渲染仍显示阶段详情；缺字段不提示；后续 call 加载/配对不重复显示或丢失事实                             |

### Stage 3：主/子会话命名

| ID  | 场景                                                   | 层次与硬断言                                                                                                                          |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| T09 | 普通首条、默认空会话、后续消息、已有人工标题           | backend contract：命名任务只在既有首轮条件触发；后续/人工标题不新增；失败不阻塞 Run                                                   |
| T10 | 首次 `/skill args` 且展开超过2000字符                  | 命令→提交→标题请求集成：临时标题和正式请求都含真正 args；不把路径/技能正文当题目；执行输入仍为原展开文本                              |
| T11 | 仅 `/skill`、多语言、长 args                           | 素材/生成器单元：有可读回退，无虚构任务；任务语言与主体可识别；既有脱敏仍生效                                                         |
| T12 | 入队、幂等重放、重启 retained 手动发送                 | 真实存储集成：命名来源随事实恢复；不靠进程 Map；不自动发 retained；同请求重放不篡改命名素材                                           |
| T13 | queued 编辑与 retained 重发改正文                      | 集成：旧命名素材失效或明确重新产生，不能新任务沿用旧名称；同操作回执语义保持                                                          |
| T14 | 两条辅助消息、请求参数、cache与用量                    | 捕获 provider 请求：purpose=session-title、无tools/执行历史、无主执行显式cache key；共享client maxTokens等配置未改；标题用量不算主Run |
| T15 | 人工改名、归档/消失、晚到标题结果                      | 受控 read/check/write 交错：人工名称不被覆盖；旧结果不改另一会话；若现实现失败，先红后修；不伪造不存在的删除能力                      |
| T16 | 两个子代理，同一代理多次委派与重开                     | backend read model+Web：按root/subagent身份取稳定实例名；任务行分别显示本次摘要；不拿共享child Session.title混名；无新增命名请求      |
| T17 | 名称字段缺失、长/多行；模型返回空/JSON/think/超时/错误 | 单元/contract：回退稳定可读、清洗可靠；主任务继续；不将默认占位保存为正式标题                                                         |

人工标题规则以主会话现有能力为准，子会话本轮不新增手动改名功能。T14 与真实模型样本一起检查标题专用预算，不把“固定 prompt 字符串相等”当作质量测试。

### Stage 4：Slash 反馈、完成回执与清理

| ID  | 场景                                                     | 层次与硬断言                                                                                               |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| T18 | skill started→queued/run→正常完成                        | command/Web集成：全程无重复通用running/success卡；排队与任务状态、真正对话正文保留                         |
| T19 | `/help /status /skills /mcps` 成功、加载、失败与重复调用 | 组件+真实Web：有用结果可读可用；关闭后无聊天残留；新invocation显示新结果，不重新弹旧结果                   |
| T20 | skill加载/提交失败、运行失败、取消或中断                 | command/Run集成：失败仍有正确出口；进入Run后的错误不因移除外卡消失；正确绑定原session                      |
| T21 | 实际 `/goal` handler context.fail 但HTTP200              | 后端→HTTP→Web集成：completion明确failed，原面板显示错误，禁止success文案；错误事件/回执不重复显示          |
| T22 | handler完成、throw、fail后仍output、早退/交互取消        | command service单元：fully await后完成；首个failure不能被后续结果覆盖；completed不自动等同所有业务动作成功 |
| T23 | output→action、多次output与回执先后顺序                  | reducer/runtime集成：纯action不覆盖正文；HTTP先到/SSE先到均正确；完成回执不复制第二份查询正文              |
| T24 | A发慢命令→切B→A迟到成功/失败→回A                         | 两session真实server+Web：B没有A的卡/弹窗/错误；回A不复活已消费状态；未知归属不作为全局卡显示               |
| T25 | 关闭后重复/重放、同scope重同步、不同runtime同ID          | store+事件流：已关闭结果不复活、不误关联；仍在处理命令必要关联保留且有释放/有界策略                        |
| T26 | 断线期间完成、响应丢失、旧daemon缺completion             | HTTP/SDK集成：结果未确认不报成功、不自动重放副作用；不永久running；已知真实错误仍可见                      |
| T27 | REST、普通JSON-RPC及new/resume特殊分支                   | SDK/server集成：同一完成合同，不漏绕过CommandService的路径；TUI/stdout既有有效输出和错误不被重复或吞掉     |

若现有协议或事件 replay 生命周期无法可靠完成 T24–T26，必须给出最小必要的关联/版本改动并复验，不能降级为永久 Map、无归属弹窗或超时即成功。

### Stage 5：组合与质量

| ID  | 场景                             | 层次与硬断言                                                                                                                        |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| T28 | 编译版Web组合操作                | 新会话→skill→标题→子代理继续→切换→命令结果关闭→重连→Bash失败；过程视频/截图或DOM状态轨迹证明无闪卡/残留，控制台与后台结果对账       |
| T29 | 真实模型标题样本                 | 普通中英文、skill有/无args、长skill、带代码/引用的请求；记录输入来源、输出、耗时、请求用途及失败；人工评估语义，无伪造精确词句标准  |
| T30 | 执行prompt/cache保护             | 同样执行输入下比较主/子system文本、层次与tools；沿用已有prompt-cache与辅助用量回归；本轮新标题材料不能进入主执行system              |
| T31 | 默认in-process TUI与Web同库回归  | TUI skill/查询/失败有效；queued/retained、Stop/Steer及权限入口保持；同库不误改另一owner                                             |
| T32 | 迁移与旧数据（仅确有schema改动） | 备份、nullable新字段、旧记录回退、重开、幂等重发；不批量重名、不增加模型请求、不自动执行旧队列；无schema改动则记录不适用            |
| T33 | 定向性能采样与状态有界性         | 同环境记录正常进入baseline次数、历史规模/查询数量、命令重复打开关闭后的关联数；不设任意机器相关毫秒门，不把未测点查询成本认定为回归 |
| T34 | 静态检查、整仓与独立审查         | 本轮相关测试后运行typecheck/lint/必要整仓回归；独立审查对照02/04，记录结果和残余限制；产出本轮05                                    |

## 3. 测试入口与运行纪律

现有测试应优先扩展，按最终改动选择匹配文件：

- agent `adapters/ui-inprocess.contract.test.ts`、session-view/scheduler 的既有测试。
- agent `services/session/title-generator.unit.test.ts`、`prompt-sanitizer.unit.test.ts`、commands 及子会话读取测试。
- SDK session-sync、command client/类型合同与 server HTTP/JSON-RPC 路由测试。
- Web `api/daemon/eventReducer.unit.test.ts`、`ui/conversation/tool-card.unit.test.tsx`、`ui/App.unit.test.tsx` 及命令/子会话组件用例。
- 现有 prompt-cache、辅助 token usage isolation、真实同库和 TUI store 回归。

基础命令：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/services/session/title-generator.unit.test.ts packages/ohbaby-agent/src/services/session/prompt-sanitizer.unit.test.ts apps/ohbaby-web/src/api/daemon/eventReducer.unit.test.ts apps/ohbaby-web/src/ui/conversation/tool-card.unit.test.tsx
pnpm run typecheck
pnpm run lint
pnpm test
pnpm build
```

第一条只是本轮定向子集，不能代替新加的协议/竞态测试。构建与typecheck按仓库已有资源约束顺序运行，不重复跑已通过的大套件，除非新改动或失败需要。

浏览器 E2E 使用本进程拥有的服务与独立测试数据目录，沿用本仓库 compiled Web 方式；记录 PID/端口，结束后确认释放，不关闭用户已有服务。模型配置按 `tests/models-4-tests.md` 与现有环境使用，密钥不写文档、日志或截图。真实模型测试与模拟provider结果分别报告。

## 4. 验收发布门与证据

- 每个适用 T 项有明确的实现/测试锚点与结果；未执行、平台不支持、只静态检查分别注明。
- 必须消除本轮确认的健康切换误报、首次读取竞态、Bash图标、子会话向下箭头、工具详情的缺失阶段冗余文案及独立结果 execution 丢失、skill命名素材丢失和空成功卡残留。
- 清理反馈不能牺牲真实错误可见性、有效查询结果、权限交互、会话归属或Stop/retained保证。
- 新增命名素材/命令完成结果的跨层接线通过真实边界测试，不能只测单个reducer。
- 原执行system-prompt/cache规则未改，子代理没有新增标题请求；命名质量按真实样本与失败记录评估。
- 原始失败场景、复现方式、修复后证据和外部审查意见保留；不把模型审查结论替代测试，不把历史全量通过替代本轮验收。
- 本轮05如实记录差异、迁移、残余风险及实际平台。本地完成不自动merge/push。

## 5. 对抗性审查重点

1. **初始化等待环**：恢复回调需要owner队列，读取又占着队列等待恢复；用闸门证明不存在循环依赖。
2. **命名素材过期**：队列编辑/retained重发后仍拿旧args；要求素材与当前正文对应，否则失效回退。
3. **空成功掩盖真失败**：fail事件被清除而HTTP仍200；完成回执与失败入口必须贯通，响应未知不报成功。
4. **跨会话复活**：关窗或切换清掉UI后，迟到/replay结果绕过归属；关联应保留必要信息且有界，不无条件建卡。
5. **辅助请求污染主执行**：标题预算、system、cache或字段扩散到主Run；捕获请求和共享配置验证边界，不能只看文件diff。

标题请求预算补充：T09/T10/T29 同时检查请求级 maxTokens=200，只有专用命名 system/user 输入，无工具 schema/description/执行上下文，不影响共享 client config 或 agent-step 请求。

## 6. 实施前独立审查补充

- T01/T03：健康进入 baseline 恰好一次、session.unavailable 与 generation mismatch 均为零；健康提交也不产生无变化的 executionRecovery 提交。
- T05：blocked 会话在历史可读时仍能看到历史与原因，发送受限；历史读取失败与执行恢复失败分别验证。
- T20/T21/T28：skill 接受后命令请求结束；用户正常 Stop 不报命令错误、不回填 slash 草稿；运行中刷新不把已接受提交报成 unknown。
- T23/T25/T26：回执先到后到均正确；输出计数去重；缺输出/缺回执也有明确释放，不形成永久关联或假成功。
- T31：TUI 健康进入/提交不闪 Checking execution records，skill 接受、后续运行及停止反馈准确。
- T32：如新增 nullable 列，验证既有连接与迁移/新旧记录写入；明确是否实际支持旧 TUI 共存，不默认加离线备份门，也不绕过既有安全检查。
- T22：真实 server 的 fail→output 仍送达正确客户端，不能第一条 failed 就丢 owner。
- T23/T27：completion→output→action、纯 action、真实 /resume 的 output→session.selected 副作用仍正确；释放输出关联不能吞 action，也不能复活旧 UI。
- T33：统计 Web 与 server 两侧关联数量，成功、失败、关闭、切换与 client detach 后均有界。
