# 测试与验收标准

本文件是实施后的验收要求，**不是已执行结果**。基线调查只执行了 01 中的元数据 GET 和问题复现。Q1–Q4 已由用户确认；能力未知允许正常请求，实际服务错误按既有规则处理。

## 1. 分层与证据

沿用仓库 Vitest、Ink testing、现有集成/真实模型 harness；没有发现统一 `docs/test-blueprint.md`，本轮不重建全仓测试规范。测试按风险组织，不追求覆盖率数字。

| 层                        | 验证内容                                           | 不能据此声称               |
| ------------------------- | -------------------------------------------------- | -------------------------- |
| 单元/契约                 | 枚举、能力/default、profile 身份、按键/输入值      | 已连接真实服务             |
| 集成（外部 HTTP fixture） | 实际 SDK/parser、存储、队列、切换、竞态和异常      | 真实模型接受参数           |
| 真实模型链路              | 所选协议、有效 reasoning 参数、工具往返、恢复      | 已验证浏览器/物理终端交互  |
| 真实 UI E2E               | 浏览器/PTY 输入操作→真实 backend→真实模型→可见结果 | 任意未操作协议或异常也通过 |

受控异常是必要证据，不伪装成真实服务错误。HTTP 成功、推理正文存在或 tokens 非零，都不能单独证明某档位真正生效；要核对实际请求参数、服务的已知合同和响应结果。纯工具回复合法地不带 native 状态时允许，只有实际产生的必要原生信息才要求保留。

## 2. 可判定用例

| ID  | 场景与预期                                                                                                                                                                                                                                                                               | 层 / 阶段                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| T01 | 三枚举经过 SDK、REST connect/probe、Web/TUI 原样传递；非法显式值拒绝，缺字段按原 URL 推断。                                                                                                                                                                                              | 单元+契约 / A                    |
| T02 | 新建/重新打开/只改 key 或窗口/旧配置加载，显式 Responses 不回退 Chat；失败不自动切协议。                                                                                                                                                                                                 | 集成 / A                         |
| T03 | 同 provider/model 的 Chat、Responses、不同 endpoint 共存；更新一个不删另一个。通用旧 profile 保留，精确匹配优先。                                                                                                                                                                        | writer+resolver 集成 / A         |
| T04 | medium 优先；否则有效厂商默认；否则最低已知支持档；原名和排序正确，无额外醒目回退提示。                                                                                                                                                                                                  | 单元+UI / C                      |
| T05 | none 隐藏；binary 无假档位；always-on 无关闭项；后端拒绝绕过前端提交的无效选项。                                                                                                                                                                                                         | 单元+契约 / C                    |
| T06 | 元数据 reasoning:true 没档位时，保存后以真实请求探测；无效档位对照必须被拒绝，才记录实际接受的档位/关闭能力。忽略参数的服务保持 unknown；明确 none 与 unknown 区分；来源/override 生效。 | 单元+集成+真实 API / C |
| T07 | 元数据 401/429/无效 JSON/缺字段/模型未命中/分页/超时：保存与能力状态独立；保存后立即提交不等 detecting、不因 unknown 失败，三协议均实际发生成请求；请求中不猜造推理参数。                                                                                                                | fixture 集成 / C                 |
| T08 | 切模型/协议/地址使旧能力失效；兼容用户选择保留，不兼容的会话默认重算；已发送显式 effort 不被暗改；排队 high 切至已确认 binary，该次明确失败且无 HTTP、不占住队列，后续兼容消息可继续。                                                                                                   | 集成 / C                         |
| T09 | 响应头到达后正文挂起仍会超时；重查取消旧请求，迟到结果不能覆盖新连接。                                                                                                                                                                                                                   | 可控流/时钟 / C                  |
| T10 | 不同会话分别保存 medium/high，切换和恢复互不覆盖；同会话发送 A=medium 后切 high 发送 B；运行、排队、SQLite 重开后各自保持选择；旧 submission 无字段可读。                                                                                                                                | scheduler/store/backend 集成 / C |
| T11 | 同 clientRequestId 重放不生成第二任务，不同 reasoning 不覆盖原记录；队列文本编辑保持选择；主子/自动及手工摘要按约定继承。                                                                                                                                                                | 集成 / C                         |
| T12 | 先 Run 后保存、先探测后 Run 两种顺序：旧 Run 两次工具循环仍请求旧端点，保存不取消它；新任务按 Q3/Q4 切换。                                                                                                                                                                               | 确定性并发集成 / B               |
| T13 | 仅后台子 Run/工具/shell 活跃时不误判空闲；completed/interrupted 记录不永久阻塞；只剩等待新配置的 submission 时可立即切换，不能自等死锁；等待可取消，旧权限/取消操作不误路由；无 active Run 的手工摘要遇到旧后台工作时按相同准入等待。                                                    | 集成 / B                         |
| T14 | 等待期间保存 B→C，最终新 Run 用 C；保存失败不切换；model 文件写后 secret 写失败应恢复，恢复失败报告部分保存并阻止采用；持久化后 reload/启动失败明确区分已保存与不可运行，不偷偷回退；强制退出仍完成清理。                                                                                | 集成 / B                         |
| T15 | 两 workspace 共用配置：各自旧 Run 不变，新准入可见新配置；旧 overflow/计量不驱动新模型；探测/发布期间无丢写。                                                                                                                                                                            | daemon/backend/context 集成 / B  |
| T16 | Web 慢初始化不盖 dirty 草稿；A 探测晚于 B 返回仍显示 B；关闭/换 workspace 后不回写旧视图。                                                                                                                                                                                               | UI+client 集成 / C               |
| T17 | 保存中可继续操作，重复相同提交去重，不同草稿按序/最新规则保存；失败显示真实结果，页首/能力视图同步。                                                                                                                                                                                     | Web/TUI+backend / C              |
| T18 | 两配置表单 Enter 编辑、输入/退格、Enter 提交、Esc 放弃；空值可辨，退出编辑不等于保存成功。                                                                                                                                                                                               | Ink+PTY / D                      |
| T19 | PgUp/PgDn 浏览切字段，编辑中不串入文本、不提交；协议三选一无非法自由文本。                                                                                                                                                                                                               | Ink+PTY / D                      |
| T20 | 光标/提示不进入 payload，key 全程遮罩；NO_COLOR 下可辨；主 Prompt/queued edit/窄终端无退步。                                                                                                                                                                                             | 单元+Ink+PTY / D                 |
| T21 | 三协议首次生成、真实工具调用/结果配对、后续回答和重启恢复；不以必须 native 的错误断言拒绝合法纯工具回复。                                                                                                                                                                                | 真实 API / A–D 对应切片          |
| T22 | 旧配置/旧 SDK 可读取兼容；新增存储字段迁移、刷新重启、构建/打包安装回归；失败保留诊断。                                                                                                                                                                                                  | 集成+全仓 / D                    |
| T23 | 未知服务默认：保存旧 high/关闭偏好但请求不发送无法映射的控制，UI 不假称已应用；Responses 无 effort 仍有必要 include，真实 reasoning/native 保存、工具往返和 SQLite 续接正确；检测完成不改变本 Run，下一 Run 才应用已识别能力。实际生成 400/429/断流沿用原分类/重试，已知非法配置仍拒绝。 | fixture 集成+真实 API / C–D      |
| T24 | TUI `/effort` 只显示当前模型经后端确认的档位；已有会话调用共用的会话更新 API，新会话首条消息携带选择并持久化。不支持或未知时不编造档位；箭头、PgUp/PgDn、Enter、Esc 可操作，明确显示焦点。至少一组真实 TUI→Responses 请求核对档位、工具往返和保存。 | Ink 契约+真实 TUI API / 收尾 |

T12–T15 的竞态应使用 deferred/barrier 控制顺序，避免 sleep 猜测时机。按 Q4 验证后台排队后切换，不把立即并行当作本轮目标。

## 3. 测试位置和命令

优先扩展以下现有位置，具体新增文件名由实现确定：

- agent `config/llm/__tests__/`、`services/interface-providers/reasoning.unit.test.ts`。
- `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`、`adapters/ui-inprocess/runtime-controller.unit.test.ts`、`adapters/ui-runtime/`。
- agent `runtime/prompt-scheduler/`、`runtime/run-manager/`、`agents/` 及相关数据库集成测试。
- `packages/ohbaby-server/src/app/create-app.unit.test.ts`、daemon 测试。
- `apps/ohbaby-web/src/api/daemon/`、`ui/` 现有组件/集成测试。
- `packages/ohbaby-cli/src/tui/app.contract.test.tsx`、`components/dialog/connect-search-panel.unit.test.tsx`、prompt editor 测试。
- `tests/smoke/tui-real-provider.smoke.test.tsx`、`agent-loop.real.e2e.test.ts` 和对应 harness。现有 TUI live 固定某提供商，不直接把它当三协议覆盖。

基础命令（实施新增测试应纳入对应筛选，不使用 passWithNoTests 掩盖漏跑）：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/config/llm packages/ohbaby-agent/src/services/interface-providers/reasoning.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts packages/ohbaby-server/src/app/create-app.unit.test.ts
pnpm exec vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx packages/ohbaby-cli/src/tui/components/dialog/connect-search-panel.unit.test.tsx apps/ohbaby-web/src
pnpm run preflight
```

真实测试沿用显式 opt-in、有限请求预算与隔离配置根；每阶段在验收记录写出**实际运行命令**，不能把尚未创建的 runner 命令描述成可执行现状。

## 4. 真实 UI E2E

### 环境与模型

使用 `tests/models-4-tests.md` 中明确支持对应协议的模型；优先 Chat/Responses 的 `openai/gpt-5.6-luna` 与 Anthropic 的 `anthropic/claude-sonnet-5`，实际 ID、URL 和能力以执行时核查为准。DeepSeek 可补同模型跨协议验证。不能为了刷通过悄悄换模型，失败及诊断重跑分别记录。

凭据从仓库 `.env` 安全读入子进程，不输出值；隔离 `OHBABY_HOME`、临时 workspace、SQLite、端口，配置只保存环境变量名。UI 可填写环境变量名来完成连接。阶段 A/B 允许前序已验证 profile 作过渡基线，只验协议/切换；阶段 C/D 的 E1/E2 最终验收必须从空配置开始，不能预写带能力的特殊配置绕过待验产品流程。每组先设有限 HTTP 上限（建议 20，包含 SDK 重试），超限停止并记录；不为测试重试上限制造付费失败风暴。

### E1：Web 开发版三协议路径（UC01/UC02）

1. 在 agent 进程中启动本轮源码对应的本地 backend 和 Web 开发服务，使用 loopback 端口与隔离配置。
2. 当前 `ohbaby-web/package.json` 没有 `dev` 脚本；可用 Vite 开发入口，但 `window.__OHBABY__` bootstrap、backend 鉴权、SSE/API 同源代理必须接通。不能只启动 Vite 空壳当 Web E2E。实施阶段补一个最小开发测试启动器/临时配置，复用 server 的 bootstrap 生成，不改生产鉴权。
3. 用浏览器实际打开开发页面，进入 `/connect`，填写模型/地址/key 环境名并选择协议，保存；观察能力检测与最终控件。
4. 查看默认档位原名；选择另一个已确认支持的档位，发送短任务，至少一次真实读取测试文件的工具往返；核对界面回复、实际 HTTP 协议与 reasoning 参数、工具调用/结果 ID。
5. 刷新页面、重开表单/会话，核对协议与有效选择；另建会话设置不同强度，切回后各自保持。分别完成三种协议，不把一个协议的页面操作外推到另两个。
6. 键盘开关菜单、焦点恢复、窄窗口布局各检查一次；截图避开敏感信息。输出页面操作记录+脱敏请求摘要+结果。

至少补一组服务默认路径的真实生成与工具续接（T23）：若用受控 metadata 缺失来触发，明确记录“元数据 fixture、生成实网”，不能称元数据异常真实发生。后端实际仍走生产 resolver/adapter，不手写请求绕过能力未知分支。

现有 `pnpm test:e2e:compiled-web` 使用编译产物和 fake provider，可补打包回归，但不能替代本项开发版浏览器真实模型操作。

### E2：TUI 三协议真实链路（UC01/UC02/UC04）

在自己的进程中渲染真实 TerminalApp，连接真实 persistent backend；经 stdin 进入 `/connect`、选择协议、填写/保存、发消息。复用 Ink live 测试结构，但不替换 backend/模型响应。三协议各验证一次短回复，至少一组覆盖工具往返。收尾时再经 `/effort` 选择已确认档位，核对实际请求参数和会话保存。区分 Ink 真实链路与下项物理终端视觉。

### E3：保存切换与消息快照（UC02/UC03）

由实际 UI 发起旧任务，在其可控本地工具等待阶段保存新模型/协议，再提交新任务。释放工具后核对旧任务续答仍用旧模型，新任务按 Q3/Q4 在正确时机用新模型；再验证排队消息的 reasoning 不被后续控件修改。可控制本地工具等待，模型响应须真实。SQLite 重开后继续一次短请求验证恢复。低概率元数据逆序、限流、正文挂起由 T07/T09/T16 的 fixture 覆盖，不冒充实网发生。

### E4：真实 PTY 编辑反馈（UC04/UC05）

通过带 TTY 的子进程启动本轮 CLI，发送实际 PgUp/PgDn、Enter、Esc、文本和退格；检查 `/connect`、`/connect-search`、主 Prompt、queued edit。至少检查正常彩色与无色环境，以及窄终端。记录编辑前/中/后的屏幕或终端输出，确认密钥遮罩、青绿方向与非颜色提示。

若工具只能可靠验证输入与文本、无法判断真实颜色/光标，明确记“行为通过，终端视觉待用户补测”，提供精简步骤再请用户操作。用户愿意手测是兜底，不是略过 agent 进程测试的理由。

## 5. 分批验收与证据要求

每阶段记录 commit/工作树状态、命令、时间、协议/模型、HTTP 次数、用例结果和失败原因。请求审计只留必要参数、ID/哈希、用量和状态，不保存 key、完整推理密文或日常会话。完成单元/集成/该阶段 E2E 后，再进行子代理审查和分批 commit。

发布判断以行为为准：

- 所选协议和可应用的 reasoning 从 UI 到真实请求一致；未知采用服务默认时保留偏好、如实显示实际未应用，不阻止发送。
- 保存不取消旧 Run、不串配置；新任务不会永久使用旧 cached client。
- 队列/恢复/幂等和工具配对不退化。
- 编辑状态在无色环境也可辨，显示标记不进入数据。
- Web 实际操作、TUI 链路与 PTY 证据分别存在；有缺项就单列，不能写“全绿”。

自检只修改规划内的不一致，不生成虚假的 05 验收报告。实际执行后再创建 05，把失败、跳过、人工待补与通过分别记录。

## 6. 历史门禁和合入 main

本轮完成不自动授权合入 main。上轮 packaging 安装超时需保留 npm stderr/debug 日志与临时现场后重新诊断，不能简单加大超时或归因网络使其“通过”；修复限于真实根因和必要测试诊断，生产打包行为变化另行审阅。

improve-6 的真实百万窗口自然达到 95% 和真实上游 overflow 继续单列。若本轮未执行，仍写未执行；不能用 force 摘要、窗口 fixture 或 UI 回归代替。最终给用户的是已覆盖和未覆盖的清单，由用户审核是否达到合 main 条件，本轮不预先承诺。
