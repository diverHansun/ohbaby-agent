# 实施与验收

状态：后端 Stage 1、2，Web Stage 3，TUI Stage 4 均已完成；2026-10-28 合并前审查与最终自动化验证通过。

日期：2026-10-26。实施分支：`codex/session-model`，基线：`18eb1f04`。

## 分工与范围

按本次会话更新：agent 完成 Stage 1、2 的后端、测试、子代理审查；用户检查后端并实施 Web/TUI。原阶段约定全部完成后再合并 main，不提前推送。2026-10-28 用户已授权：审核和测试通过后合并并推送 main，删除本地功能分支，不推送功能分支。

后端阶段的 Web 只同步了 SDK 要求的传输方法、开发 mock 和测试夹具。用户检查后端后，Web 的聊天菜单、Settings 和 reasoning 控件改由 agent 在同一分支实施，见“Web 前端实施与验收”。TUI 同样由 agent 实施，见文末“TUI 实施与验收”。

## 实施记录

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| 0 | 六份规划文档纳入分支，更新分工和可选 key 文案 | 已提交 `59f1dff1` |
| 1 | 每模型参数、旧文件迁移与备份、条目解析与配置加载 | 已提交 `e6d0ae6c` |
| 2 | 会话与提交快照、迁移 027、SDK/HTTP/RPC、RunModel 与适配器整合 | 已提交 `09e33438` |
| 3 | 跨层场景与竞态验收测试 | 已提交 `d94c9812` |
| 4 | 全量检查、审查修复、交接记录 | 已提交 `b4ef15aa` |
| 5 | 用户追加 SWE/KISS 复查与局部修复 | 已提交 `49c702cc`；追加审查后的全量检查通过 |

## 语义与兼容

- 提交记录有条目 id 时按该条目执行；留空时使用执行时的全局默认，不回读会话选择。
- 首条提交可以持久化预选模型；之后单条提交覆盖不改会话。首条判断同时检查历史消息和已接受的提交记录。
- 运行中切换仅影响后续轮次；标题、摘要和子代理沿用父轮捕获的客户端。
- 模型文件修改不重建运行时；env 等其他域的重建规则保留。
- 模型文件只写 `activeProfileId`、`models`。旧文件读取只在内存中迁移，首次覆盖前备份原始字节。
- key 可以为空；缺地址、协议或显式标记未完成才属于配置不完整。
- 不兼容的 reasoning 在执行前回退至条目默认并提示。

## 审查记录

| 发现 | 处理 |
| --- | --- |
| 已设 reasoning 的空会话首条提交可能漏存模型 | 首条判断与 reasoning 是否已有值分开，保留既有 reasoning 的单次覆盖语义 |
| 提交模型与 reasoning 分别读取会话，可能读到不同版本 | 一次提交复用同一个会话快照 |
| 第一条仍排队时，第二条覆盖可能被误认成首条并改写会话 | 增加提交记录存在性检查，新增失败后通过的回归测试 |
| 删除全部模型或条目变不完整后，刷新失败保留旧窗口 | 刷新失败也清理会话用量及缓存统计 |
| 旧轮完成后或排队旧轮启动时覆盖切换后的窗口及统计 | 显示跟随当前会话选择，按捕获的模型身份过滤旧轮用量；两类竞态回归通过 |
| 查看新模型窗口时，旧轮迟到的 calibration / compaction floor 污染新模型 | 上下文 scope 内按模型对象保存状态；检查模型与执行模型分离，迟到反馈写回所属模型 |
| 能力探测后保留与输出上限冲突的 reasoning 默认预算 | 按条目输出上限重新验证，不兼容默认清除，保留已探测能力 |
| 同请求 ID 并发重试时派生模型或 reasoning 不同，原子存储误报冲突 | 区分显式覆盖与派生快照；内存 / SQLite、单 / 双调度器八个回归通过，显式覆盖冲突仍保留 |

三名子代理完成配置、运行时、存储及接口的交叉审查；上述发现均已修复，最终只读复查无新增问题。

## 验证记录

- 修改前 `pnpm typecheck` 通过；提交钩子 lint 为 0 错误、122 条已有警告。
- 配置专项：22 文件、229 测试通过。
- 存储及接口专项：28 文件、507 测试通过；追加传输验证 7 文件、241 测试通过。
- 独立适配器验收：7 场景通过，覆盖标题/自动及手动摘要、reasoning、项目环境变量隔离、排队删除回退。
- 独立子代理继承测试直接使用生产 composition；旧单模型测试通过仅测试工具适配新接口。
- goal 自动续跑切换模型、当前轮 steer 保持原模型：2 个实际 goal 场景通过。
- 真实用户格式文件的临时副本迁移通过：读取不写盘、首次备份字节一致、二次写入不重复备份、用户原文件未变化。
- 全仓 `pnpm typecheck`、改动 TypeScript 文件 Prettier 检查通过。提交 hook 的 lint 0 错误、117 警告（基线为 122 警告）。
- `pnpm test:contract`：37 文件、571 测试通过（追加审查修复后重新运行）。
- `pnpm test:unit`：378 文件、4706 测试通过，2 条既有跳过（追加审查修复后重新运行）。
- `pnpm test:integration`：202 文件、1895 测试通过（追加审查修复后重新运行，436.97 秒）。
- 未运行真实 provider 请求；自动化的 HTTP/SDK/CLI 测试使用本地假服务。Web/TUI 界面验收仍待前端实施。

## 前端交接

- `updateSessionModel({ sessionId, modelEntryId: string | null })`：更新会话并发布 `session.updated`。
- `getCurrentModel({ sessionId? })`：返回解析后的条目 `id`、`source` 和能力；无参数返回默认。
- 首次提交可以携带 `modelEntryId`。普通会话切换应调用会话接口。
- Settings 条目带 `reasoningDefault`，创建/修改接受 `reasoning`，全局 `params` 删除。
- `selectDefaultModel(entryId)` 供 TUI 后续接线，返回 `{ ok: true, ...models }`。
- 前端发布门仍为 04 中 T19–T27；本次后端完成不等于这些界面场景已验收。

## 测试定位

| 验收范围 | 主要测试 |
| --- | --- |
| T1–T3、T14b、T18b 配置、迁移与自动默认 | `config/llm/__tests__/session-model-config.integration.test.ts` 与既有 model-document / settings 测试 |
| T4–T8、T12、T12b 解析、删除回退、配置更新与排队 | `adapters/session-model.integration.test.ts`、`model-switch.integration.test.ts` |
| T9–T10 窗口、校准与摘要 | `core/context/run-model.integration.test.ts`、`adapters/session-model-acceptance.integration.test.ts`、`session-model-usage.integration.test.ts`，以及既有压缩 / 溢出恢复测试 |
| T11 子代理继承 | `adapters/ui-runtime/session-model.integration.test.ts`，以及既有 subagent / permission / goal 生命周期测试 |
| T12c goal 与 steer | `adapters/session-model-goal.integration.test.ts` |
| T13–T14 reasoning 兼容与默认 | `adapters/session-model-acceptance.integration.test.ts` |
| T15–T18 持久化、HTTP、RPC、幂等 | `runtime/prompt-scheduler/model-persistence.integration.test.ts`、`model-replay-review.unit.test.ts`、server 的 create-app / daemon / settings-global 测试 |

表内 `config/`、`adapters/`、`core/`、`runtime/` 均以 `packages/ohbaby-agent/src/` 为根。D4（模型配置数据模型）已同步；D1–D3 的 Web 文档应随前端实现同步，不提前描述尚未完成的 UI。

## 改动面质量评估

`RunModel` 将模型客户端、预算和摘要能力明确绑到一次运行，减少了 Lifecycle 对全局配置的隐式依赖；客户端池独立在 `ui-inprocess/model-client-pool.ts`，读取与创建分开，查询当前模型不触发客户端工厂。生产接口要求显式传入运行模型，旧夹具的默认模型便利函数只留在 `core/testing/`。

本轮保留了既有适配器、调度器和 store 边界，没有额外引入通用配置框架。主要维护代价仍在较大的 `ui-inprocess.ts`：选择、回退和缓存通知跨多个入口，需要保留本轮的并发验收测试。未为形式上的分层另做大范围拆分；后续前端接线应使用 SDK 方法，不直接操作配置或运行时。

## 用户追加的 SWE / KISS 复核

按用户要求，分支改名为 `codex/session-model`，后续前端沿用此分支。以任务起点 `18eb1f04` 为基线，由两名没有参与实现的新子代理分别检查 Standards 与 Spec；不把延期的 Web/TUI 当作后端缺项。

**Standards：** 静态窗口查询未携带模型身份，旧 A 查询可能抢先写缓存，随后 B 查询把 A 当作较新的缓存；另一个边界是在 A 运行期间查看 B 后再查看 A，会清掉 A 的校准状态。前者复用已有 `RunModel` 和 `matchesSelectedModel`，查询返回时拒绝旧模型结果；后者仅限制 inspection 的重置条件，实际切换执行模型仍重置。两项均有失败后通过的回归，原审查者复核通过。

**Spec：** 旧 reasoning 迁移原来只验证档位，未验证思考预算与条目原有输出上限是否冲突。现复用 `resolveRequestReasoning` 完整校验，只丢弃不兼容的旧迁移值。新增 4096 上限冲突、8192 上限兼容两例，原审查者复核通过。

本轮没有新增框架或通用抽象，也没有为形式上的职责拆分扩大改造。先验证出的 564 条受影响路径测试通过；修复后的全量检查结果以本文件验证记录为准。

## Web 前端实施与验收

日期：2026-10-26，分支 `codex/session-model`，接在后端提交之后。

### 做了什么

- **模型按钮**（D17、D19）：输入框旁的按钮只列配置完整的模型，按服务商分组。默认模型旁有一个不显眼的 `default` 标记，勾选的是这个会话下一轮要用的模型。列表很长时只滚动列表本身，`Manage models…` 固定在底部，打开时勾选的条目自动滚到中间。手机宽度下沿用底部抽屉的整体滚动。
- **会话与草稿**：已有会话直接调 `updateSessionModel`；草稿先在本地记住选择，第一条消息带上 `modelEntryId`，由服务端写进新会话。离开草稿后这个选择就清掉，下一个新会话从默认开始。选中的条目在发送前被删掉时，第一条消息不带它，由服务端用默认。
- **reasoning 控件**：草稿读所选条目的能力；已有会话仍读 `GET /v1/model?sessionId`，换条目或者列表重新加载出新能力时再读一次。会话没设档位时，回退到条目的 `reasoningDefault`。
- **Settings**：列表顶部加说明；删除任何单个模型都先确认，文案说明会话会改用默认；编辑器新增 Thinking 行（检测状态、Detect again、默认档位），删掉了前端自己做的自动设默认（P16 已交给服务端）。

### 与规划的出入

| 规划 | 实际 | 原因 |
| --- | --- | --- |
| 04 T22 写“Reasoning 行” | 编辑器里叫 Thinking | 与输入框旁的控件用同一个词 |
| 02 要求 Max output 说明“Used for every request with this model.” | 提示写成 `tokens per request` | 提示放在标签后面，整句太长；意思相同 |
| 02 要求 `selectors.ts` 的 `modelLabel` 按会话显示 | 没改 selectors | 页面上能看到的模型名就是模型按钮，已经按会话显示；`/status` 优先用后端按会话返回的 model 行，`modelLabel` 只在后端没给时兜底 |

### 子代理审查

一名没有参与实现的子代理审查了 Web 改动，有效发现都已处理：

| 发现 | 处理 |
| --- | --- |
| 所有草稿共用同一个作用域，草稿的选择会带到下一个草稿 | 离开草稿时清掉选择 |
| 选中的条目被删除后，草稿仍发送旧 id | 只有所选条目还可用时才发送 |
| 菜单的“待确认选择”一直不清，换会话后还在 | 服务端回传后清掉；每个会话各用一份菜单 |
| 切换还没确认时，点回原模型被忽略 | 改为和当前显示的选择比较 |
| 方向键能把焦点移到看不见的行 | 移动焦点后把该行滚进可见区域 |
| Detect again 后 Thinking 下拉框可能停在已不支持的档位 | 已不支持的档位显示为 Model default，保存时清掉；能力未知时不动已存的值 |
| Detect again 不发 model 事件，已有会话的控件不刷新 | 列表重新加载出新能力时再读一次 |
| Thinking 行无障碍：错误没关联到控件、状态不播报 | 下拉框关联错误信息，状态改为 `role="status"` |
| 模型列表读了两次 | 由会话页面读取，菜单通过 props 接收 |

审查还建议已有会话也改读条目能力。这样改了以后，App 里 6 个测试、Settings 里 1 个测试失败：这些测试覆盖了工作区切换、元数据还没回来等竞态，都依赖后端按会话返回的能力。所以撤回了这条，保留后端为准。

### 验证记录

- `npx vitest run apps/ohbaby-web`：68 个文件、797 个测试通过。Web typecheck、eslint、改动文件的 Prettier 检查通过。
- 新增或改写的测试：草稿选择随第一条消息发出（T20）、所选条目被删后不再发送、切换未确认时切回原模型、会话的模型不随默认变化、默认标记、失败时恢复原标签、Thinking 行的检测与保存、删除一律确认。
- mock 浏览器走查（`models-many` 场景、20 个模型）：列表内部滚动，勾选的条目在中间，`Manage models…` 不动，手机宽度下底部抽屉占满宽度。
- 真实 daemon 浏览器走查（`pnpm build` 后 `ohbaby serve`）：用一个临时条目 `walkthrough-test`（指向本机未使用的端口）验证，走查结束后已删除，测试会话也已归档。
  - T19：在会话里切换模型后，只有这个会话的标签变了，`PATCH /v1/sessions/:id/model` 返回 200；另一个会话仍显示自己的模型；顶栏上下文窗口跟着模型刷新（1M）。
  - T20：草稿选模型后发第一条消息，刷新页面后会话仍显示这个模型。新开的草稿回到默认模型。
  - T21：从未知能力的条目换到 deepseek 后，thinking 控件从 unknown 变成可选档位（medium）。
  - T22：Thinking 行显示 Model default (medium)；Detect again 调用 probe，检测期间按钮禁用，完成后列出 minimal 到 max 各档。没有在真实条目上保存档位。
  - T23：删除确认文案为“Chats using this model will switch to the default model.”；删除后正在用它的会话显示默认模型。下一轮的提示需要真正发一条消息，没有在浏览器里验证，由后端测试覆盖。
- 走查第一次保存模型时，旧格式的 `~/.ohbaby/model.json` 按 D16 改写成新格式，原文件备份在 `~/.ohbaby/backups/model-json-…`；条目、上下文窗口和输出上限都保留了。

### 改动面评估

新增的只有 `model-choice.ts` 里的一个读取 hook 和一个解析函数，菜单、会话页面和 reasoning 控件共用。草稿的选择就是会话页面里的一个 state，没有为它另做 store。主要的复杂度在 `useReasoning`：它要同时处理草稿、已有会话和切换中的竞态，后续改动要保留现有的竞态测试。

## 命名约定

用户确认：界面上写 **Thinking**，代码和接口字段保持 `reasoning`（`reasoning`、`reasoningDefault`、`updateSessionReasoning`），不跟着改名。Web 已经这样做（输入框控件、编辑器的 Thinking 行）；TUI 的 `/effort` 面板目前仍显示 Reasoning Effort，没在这次改。

## TUI 实施与验收

日期：2026-10-26，分支 `codex/session-model`，接在 Web 提交之后。

### 做了什么

- **`/models` 可以选了**（T25、T25b）：面板列出所有配置完整的条目，不完整的不显示。↑↓ 移动光标，Enter 给当前会话换模型（`updateSessionModel`），成功后关闭面板；`d` 把光标所在条目设为默认（`selectDefaultModel`），面板不关，`default` 标记跟着移动。勾选的是这个会话下一轮要用的模型。底部提示：`↑↓ move · enter use in this chat · d set default · esc close`。
- **草稿**：还没有会话时，Enter 只在本地记住选择（和 `pendingReasoning` 一样），第一条消息带上 `modelEntryId`。会话建好后这个选择就清掉，下一个新会话从默认开始。
- **底栏和 `/effort`**（T26）：都按会话读模型；草稿读所选条目。会话有更新（`session.updated`）时底栏重新读取模型，所以换模型后会跟着变。草稿换了条目时，之前给别的模型选的 `/effort` 档位一并清掉。
- **后端**：`listModels` 返回全部完整条目，带 `id`，并标出默认和当前会话的条目；删掉没有任何实现的可选接口 `switchModel`，以及输出里的 `switching` 字段。`/models` 的目录说明改成“Choose this chat's model or the default”。
- **`/connect`**（T27）：代码没动。

### 与规划的出入

| 规划 | 实际 | 原因 |
| --- | --- | --- |
| 02 要求按 EffortPanel 的方式做成交互面板 | 仍是展示类面板，数据走原来的命令输出；`ModelsPanel` 自己处理按键，Esc 仍归面板管理器 | 复用现有数据通道，不新开一套交互协议 |
| 02 的 `getCurrentModel` 只有 `sessionId` | 增加可选的 `modelEntryId`（SDK、进程内适配器、JSON-RPC 校验） | 草稿的底栏、`/effort` 和首条消息的档位校验都要按所选条目读能力。传了 `sessionId` 就按会话解析（会话没选就用默认），`modelEntryId` 不起作用；只有没传 `sessionId` 时才按 `modelEntryId` 解析 |
| 02 把 `dialogs/model-dialog.tsx` 列为可删 | 保留 | 它渲染 SDK 交互协议里 `subject: "model"` 的通用 `select-one`，有合约测试。生产代码目前不发这种交互，属于休眠代码，留给以后和协议一起清理 |
| 02 设计了单独的“当前模型”区块 | 改成一行摘要（This chat / Next chat + 模型 · 服务商 · 协议 · 上下文用量） | 让列表在终端里放得下 |
| 04 T25 写“超过 8 个条目时滚动” | 列表一页最多 6 行（Skills 面板的页高减 4），超出就滚动 | 终端够高时，面板总高度和 Skills 面板一致，摘要、标题、提示占掉 4 行；终端很矮时最少显示 3 行 |
| — | 跟随默认的会话在 ✓ 那行按 Enter，也会把会话固定到这个条目 | 和 Web 一致（P14）。TUI 区分不出“跟随默认”和“已固定”，多发一次 `session.updated`，结果无害 |

### 子代理审查

一名没有参与实现的子代理（opus）对照 02/04 的 Stage 4 审查了 TUI 改动，没有发现高危问题。处理如下：

| 发现 | 处理 |
| --- | --- |
| 忙碌标记在下一次渲染才生效，两次按键赶在渲染前到达，会发出两个请求 | 改成同步的 ref；新增测试，去掉保护后这个测试确实会失败（调用 2 次） |
| Enter 的请求还没返回时按 Esc 关掉面板，返回后 `onClose()` 可能关掉用户新开的面板 | 面板卸载后不再调用 `onClose` 和 setState |
| 注入客户端（磁盘上没有条目）时列表那一项没有 `default` 标记 | 标为默认 |
| 草稿换条目后，之前的 `/effort` 档位在提交时被静默丢掉 | 换到别的模型时立刻清掉 |
| 缺失败路径和 RPC 校验的测试 | 补了保存失败时面板不关并显示原因的测试；补了 `getCurrentModel` 的 `modelEntryId` 透传和空值拒绝 |
| 底栏在会话每次更新时都重新读模型 | 暂不改。读的是本机文件，开销小；只在模型字段变化时刷新需要另存上一次的值，留到确有性能问题时再做 |
| 文档没有 `activeProfileId`、只有一个条目时，面板不显示默认 | 不改。后端对这种文档本来就报错，不是这次引入的 |
| `pendingModelEntryId` 和 `draftModelEntryId` 两个名字 | 不改。TUI 里沿用已有的 `pendingReasoning` 叫法，组件内部的 `draft…` 指同一件事 |

### 验证记录

- 全量：`pnpm typecheck` 通过；lint 0 个错误（警告都是改动前已有的）；unit 378 个文件 / 4706 个测试、contract 37 / 575、integration 202 / 1902 全部通过；Web 68 / 798 通过。
- 新增或改写的测试：`/models` 可选面板、会话里 Enter 换模型和 `d` 移默认（T25/T25b）、草稿选择随第一条消息发出、12 个条目时滚动到最后一个、保存失败与重复按键、后端列出完整条目并标出会话模型和默认、RPC 透传与校验。
- 真实 TUI 走查（tmux，独立的 `OHBABY_HOME`，复制了用户的一个真实条目，加 10 个指向 127.0.0.1:9 的假条目和 1 个不完整条目，用户自己的 `~/.ohbaby/model.json` 没碰）：
  - 不完整的条目不显示；能滚到第 11 个条目。
  - 草稿选的模型显示在底栏；`d` 移动默认后，磁盘上的 `activeProfileId` 变了，面板没关。
  - 用所选的真实模型发第一条消息，provider 返回 403（用户那个 key 的权限问题，与本改动无关），说明消息确实带着草稿选的模型发出去了。
  - 会话里按 `d` 不改变已固定的 ✓；Enter 换模型后底栏随之更新；`/effort` 显示 deepseek 的档位；`/new` 的会话跟随新的默认。
  - `/connect`（T27）代码没动，没有手动走查。

### 改动面评估

新增的只有 `models-panel.tsx` 一个组件，按键、滚动窗口都在里面，复用 Skills 面板的翻页方式。草稿的选择是 `app.tsx` 里和 `pendingReasoning` 并列的一个 state，没有新建 store。后端只是把 `listModels` 从“当前一个”扩到“全部完整条目”，并给 `getCurrentModel` 加了一个可选参数。

## 同分支的 Web 小改动

用户在 TUI 实施期间提的两处，和会话模型无关，单独提交：

- **Settings › Archived 删除和恢复时有移除动效**：行先原地淡出，再收起高度，约 320 ms 后从列表移除，期间这一行不能再点。开启“减少动态效果”或环境不支持动画时直接移除；页面在后台、动画暂停时，有个兜底定时器照样把行移走。真实浏览器里逐帧采样确认了高度从 60px 收到 0；新增单元测试确认动画结束前行还在且不可交互。
- **模型编辑器 Label 一栏加提示**：`optional, shown after the model name`。Label 是可选的显示名，同一个模型配了两个条目时用来区分。


## 2026-10-28 合并前复核

审查范围为 `a9c7e8e5..94abaa64` 的七个追加提交，并纳入用户确认提交的 `commands/builtin.ts` 与 `commands/service.unit.test.ts`。两名独立子代理分别对照 SWE/KISS 和功能契约审查；主代理核对调用链并运行回归测试。

### 发现与修复

| 发现 | 修复与验证 |
| --- | --- |
| Web 在模型保存完成前发送，下一轮可能仍用旧模型 | 提交等待同客户端、同会话的保存；失败保留输入；等待期间切会话则取消发送。三个 App 场景先失败、修复后通过 |
| TUI 同一批输入里的 ↓ 和 Enter / d 读到旧光标 | 移动光标时同步更新现有 ref；覆盖同一输入批次的选择与设默认 |
| TUI `/effort` 用能力默认覆盖条目默认或会话的部分覆盖值 | `getCurrentModel.reasoning.default` 返回该条目的实际默认；面板逐字段叠加会话偏好。覆盖 high、关闭、重新启用和能力未知 |
| Web 将仍存在但配置不完整的已选条目显示为默认 | 只有条目被删除才回退；不完整条目保留所选 id，让后端报告配置错误。菜单仍只列完整条目 |
| 草稿 A → B → A 后，已清除的 Thinking 档位重新出现在界面 | 不兼容时同时清理本地显示与提交偏好；未知能力仍保留偏好 |
| 全局默认为空时，Web 阻止已选完整模型的会话或草稿发送 | 缺模型判断接受有效的显式选择；已有会话和草稿两个 App 场景先失败、修复后通过 |

前五项及用户的 `/status` 修正提交为 `d65e6a50`；第六项提交为 `3d2c1c26`。`/status` 现在按当前会话查询模型列表，与会话摘要保持一致。

这些修复复用了已有状态、ref 和 SDK 字段，没有新增 store、协议字段或通用框架。`getCurrentModel` 描述下一轮的实际配置，因此它的 `reasoning.default` 包含条目偏好；Settings 仍分别保留能力默认和 `reasoningDefault`，能力未知时不伪造已识别结果。

### 最终验证

- Web：68 个文件、806 项测试通过。
- 非集成测试：`pnpm exec vitest run --exclude '**/*.integration.test.ts' --exclude '**/*.integration.test.tsx'`，427 个文件通过、6 个文件跳过；5423 项通过、17 项跳过。
- `pnpm build` 通过；提交钩子的全仓 lint 为 0 错误、117 条已有警告，`pnpm typecheck` 通过。
- `pnpm test:integration`：202 个文件、1906 项测试通过，耗时 873.71 秒，包含等待另一个测试进程释放共享打包锁的时间。
- 两部分合计 629 个文件通过、6 个文件跳过；7329 项测试通过、17 项跳过。最新修复的 TypeScript 文件 Prettier 检查及 `git diff --check` 通过。

本轮没有重跑真实 provider 请求或人工浏览器 / TUI 走查；这些人工证据保留在前面的实施记录。最终默认自动化测试集拆成非集成与串行集成两部分运行，避免 CLI 打包测试同时重建共享 dist。新增回归曾在修复前失败；中途运行结果不作为最终通过证据。

后续子代理生命周期的六份规划文档按用户要求保留到 main，仍为待实施事项，不纳入本轮功能验收。

交付按用户授权执行：将 `codex/session-model` 快进合并到 main，只推送 main，随后删除本地功能分支。功能分支不推送。
