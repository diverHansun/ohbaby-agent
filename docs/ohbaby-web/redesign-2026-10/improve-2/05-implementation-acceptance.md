# improve-2 · 5. 实施验收

> **最新复审补充（2026-10-24）**：下文是 `376896e0` 实施方的验收记录；独立复审在该版本仍复现三个运行时问题，已在后续工作树局部修复，683 条 Web 测试通过。另有新草稿残留旧消息的 P2，以及 B16 真实审批/Stop 联动缺口。当前状态以 [07 最新提交复审](07-latest-review-03ef136f.md) 为准，不能把下文“B1–B17 通过”理解为完整独立验收结论。

> 范围：`feb940d8`（improve-1 收尾）之后的 9 个提交，`5c5f13c0` 至 `376896e0`（最后一个是审查后的修复）。验收依据是本目录的 [02](02-plan-and-change-scope.md)、[04](04-test-and-acceptance.md)，以及总设计 [02 §3.2](../02-frontend-architecture.md)、[06 §1–§3](../06-data-api-and-state.md)。

**当前结论：improve-2 的 B1–B17 在下面写明的范围内通过，可以进入 improve-3。** 初版实施后经独立子代理审查，发现 2 个 P1、5 个 P2 和若干 P3 问题，已在 `376896e0` 修复，见 §7；本表是修复后的结果。有三处做法和 02 不同，见 §2，02、06 的对应段落已同步改写；有两个已知的测试抖动不是本批引入，见 §5。

## 1. 提交与改动

按 8 步实施，每步单独提交，纯拆分和行为变化分开：

| 步 | 提交 | 内容 |
|---|---|---|
| 1 | `5c5f13c0` | `client.ts` 拆成 `client-sync.ts`（连接、SSE、绑定、历史）、`client-prompts.ts`（未知结果账本、发送、排队编辑）、`client-commands.ts`（命令、模型、导出、归档）。`BrowserDaemonClient` 对外接口不变，只做组装 |
| 2 | `227ce369` | `runtime.ts` 移到 `runtime/`：`index.ts`（façade）、`global-layer.ts`、`instance-layer.ts`。行为不变 |
| 3 | `b8f60f06` | HTTP 报错保留 `targetDirectory`，支持 PUT，传输可复用；新增 `global-sessions.ts`；`WorkspaceScopesResponse` 补 `defaultWorkspace` |
| 4 | `d7c2c468` | store 新切片：全局目录（项目、默认目录、已加载的会话范围）、草稿所选项目、侧栏分组纯选择器；置顶改为全局 key 并迁移旧 key |
| 5 | `872a817f` | 运行时改为以会话为中心：按会话请求目录连接、`SESSION_MOVED` 重发、跨目录归档与导出、刷新时机、导航记忆改为“上次打开的会话” |
| 6 | `5ff364b5` | 草稿 key 改为 `new` / 会话 ID 并迁移旧 key；`ProjectPicker`；没有实例时的 `DraftFallback`；晚到的首发回执不抢回选择 |
| 7 | `afe65cf7` | 全局侧栏：Pinned → Projects → No project、分页、折叠记忆、相对时间、运行与审批标记 |
| 8 | `37e9b132` | mock 场景：`fresh`、`typical`、`many`、`pending-move` |
| 修复 | `376896e0` | 审查发现的问题，见 §7 |

文件规模：`runtime/index.ts` 560 行、`instance-layer.ts` 335 行、`global-layer.ts` 187 行；`client-sync.ts` 700 行，其余 `client-*.ts` 都在 500 行以内。`client-sync.ts` 偏大，但内容都是“连接与同步”一件事，再拆会把共享的绑定状态切散，这次没有为凑行数硬拆。

## 2. 与 02 不同的做法

| # | 02 的写法 | 实际做法 | 理由 |
|---|---|---|---|
| D1 | 草稿不建实例，第一次发送时再建 | 草稿就连到草稿目录（所选项目或默认目录）的一个新 client，这个 client 不绑定任何会话 | 03 §4.2 的草稿线框里有权限、模型、思考强度控件，improve-2 里它们都依赖实例；斜杠命令和命令面板也要实例。服务端对新 Web client 本来就不选会话（`startupSessionMode: fresh`），所以“连着实例”和“没有会话”可以同时成立。这样 B1“点新对话不产生服务端会话”仍然满足，草稿的发送、命令、未知结果恢复都复用现有路径，不用另写一条首发链路 |
| D2 | 首发分两步：先建会话，再发 prompt | 一步：在没绑定会话的实例里发 prompt，由服务端在接纳时创建会话，之后 UI 选中回执里的会话 | 这是现有 Web 已有并测过的路径（`acceptDaemonPrompt` 在接纳内部生成会话 ID）。被明确拒绝时没有会话留下，超时走原来的未知结果恢复，所以 B15“重试不再创建会话”同样成立，还少了“会话建好、prompt 失败”这个中间状态 |
| D3 | improve-2 提前做 `GET /v1/settings/models` 的最小客户端 | 第 3 步加了，第 6 步删掉 | D1 之后草稿已有实例，模型是否配置沿用实例的 `GET /v1/model`；读失败时 `currentModelLoaded` 为假，不会误判成未配置（B1）。留一个没人用的客户端不符合 KISS，improve-4 做设置页时再加 |

另外两处按 02 的原则落地，但范围比文档写的窄，记在这里：

- **运行标记只覆盖当前打开的会话。** 06 §3.4 写的是“当前实例里的会话”。实际上实例的会话索引不带运行状态，会话视图也只包含已绑定的那一个，所以侧栏只能给当前打开的会话显示转圈或琥珀点，同目录的其他会话也显示时间。
- **`SESSION_MOVED` 只在发送路径上、且该会话没有进行中的一轮时自动重发。** 运行中或有待审批时不跟随，提示这一轮结束后生效，保住当前的流、审批和停止。 服务端只在 `POST /v1/prompts` 及编辑、插话、重发等 prompt 接口上返回带 `targetDirectory` 的 409；`/compact` 返回 400 且没有错误码，`/v1/commands` 可能是 500。本批不改服务端，这些情况按普通错误显示。正常打开会话时本来就按请求目录连接，只有“会话运行中被别处改了项目”才会碰到。

跨目录的归档和导出要先在那个目录注册一个 client（服务端要求 client 已注册），每个目录只注册一次并复用；它不开 SSE，所以当前对话的流和审批不受影响。

## 3. 验收结果

自动化：`pnpm --filter ohbaby-web typecheck`、`eslint apps/ohbaby-web/src`（0 error）、`pnpm --filter ohbaby-web build` 通过；`vitest run apps/ohbaby-web` 53 个文件、678 个用例通过（改造前基线 46 个文件、622 个用例）。

| ID | 结果 | 依据 |
|---|---|---|
| B1 | 通过 | `runtime/session-runtime.integration.test.ts`：草稿在默认目录、无会话，首发后会话 `projectDirectory` 为 null；选项目后首发归入该项目。真实 daemon：New chat 前后服务端会话数不变 |
| B2 | 通过 | `AppController.unit.test.tsx` 换项目不动文字；真实 daemon：草稿在 No project ↔ workspace 之间切换，文字保留，刷新后文字和 No project 仍在 |
| B3 | 通过 | 集成测试：移出项目的会话（`projectDirectory: null`、工作目录 `/a`）打开时连到 `/a`，不是默认目录；`sidebar-groups.unit.test.ts` 按 `projectDirectory` 分组 |
| B4 | 通过 | 集成测试：先展开到 150 条，刷新时从首页串行重取两页，外部归档的行被移除；`Sidebar.unit.test.tsx`：Show more 跨页凑够、空组和未加载的 Pinned 保留入口、计数只算已加载；mock `many` 中稀有项目从 5 条翻页到 26 条 |
| B5 | 通过 | 集成测试：会话移到 `/b` 后发送，换目录重发一次，`clientRequestId` 和正文不变，未知结果账本为空；一直被移动时共发 3 次后报 `SESSION_MOVED`；`global-sessions.unit.test.ts` 验证 HTTP 层保留 `targetDirectory` |
| B6 | 通过 | `session-pins.unit.test.ts`：同一服务器的旧 key 合并、取较早时间、旧 key 保留、只迁移一次 |
| B7 | 通过 | `session-restore.integration.test.ts` 全部迁移通过；新增用例：hash 里是旧目录、会话已移到 `/b` 时，在 `/b` 打开且不带旧的启动意图；真实 daemon 刷新后回到同一会话 |
| B8 | 通过 | 见 §1；`runtime/`、`client-*.ts` 不依赖 React；原有集成测试迁移到 `openDraft` / `openFolder` / `openSession` 写法，场景没有删 |
| B9 | 通过 | `session-runtime.focus.integration.test.ts`：窗口 `focus`、`visibilitychange` 触发刷新并读到新会话；集成测试：刷新失败保留旧行、状态为 error、不弹提示；切换实例不算重连，不触发整表重读。SSE 断线重连触发刷新只有代码检查，没有单独的测试 |
| B10 | 通过 | 组内 6 条、Pinned 8 条、每次多 20 条；折叠状态写入 localStorage，重新挂载后保持；`relative-time.unit.test.ts` |
| B11 | 通过 | `AppController.unit.test.tsx`：从选择条点 Open folder… 选好目录后，目录被注册、草稿切到该项目，文字保留；侧栏 New chat 从 No project 开始，项目分组 `[+]` 预选该项目 |
| B12 | 通过 | 草稿有实例（D1），直通命令按草稿目录执行；`/compact`、`/goal` 在没有会话时打开浮层说明原因（沿用现有实现），不会静默失败 |
| B13 | 通过 | 输入框本来不靠 key 重挂载；草稿与租约 key 同步改为不含目录，原有租约、排队编辑相关的 App 用例全部通过 |
| B14 | 通过 | 见上方自动化 |
| B15 | 通过 | D2；App 用例：首发请求期间在同一目录点 New chat（client 不变、只换选择代次），晚到的回执不打开新会话；去掉守卫时该用例失败。另一条是换 client 的情况，同一守卫覆盖 |
| B16 | 通过（真实 daemon 未走查） | 集成测试：打开 `/a` 的会话时导出、归档 `/b` 的会话，当前 client、SSE 不变，请求发往 `/b` 且使用另一个 client；会话运行中被移到 `/b` 后发送，当前 client 与 SSE 不变、报“这一轮结束后生效”；空闲时则换到 `/b` 重发。没有在真实 daemon 上用 TUI 触发换项目走查 |
| B17 | 通过 | `draft-storage.unit.test.ts`：可唯一定位的旧草稿和会话租约迁移；多个旧 `new` 草稿不合并；`new` 不接收旧租约；每个标签页只迁移一次，已发出的草稿不会复活；新状态在 `store/` 下按切片组织，不反向依赖 UI |

## 4. 走查

**mock（1280×820）**：`typical` 侧栏顺序为 Pinned → ohbaby-agent / pi-web / notes → No project，行尾为相对时间，悬停时换成归档和菜单；`Show more · 23` 展开后变为 `Show more · 3` 和 `Show less`；项目选择菜单列出 No project、三个项目、Open folder…。`fresh` 只有 Projects 标题和 `[+]`。`pending-move` 中该会话已在 pi-web 分组下，顶栏仍显示 ohbaby-agent。`approval` 行尾为琥珀点，`running` 为转圈。控制台无报错。

浏览器面板在视口仿真下用坐标点击会落到别的元素（指针事件的目标是主区而不是按钮），所以菜单一类交互改用页面脚本点击确认；这是工具的坐标映射问题，`elementFromPoint` 和组件测试都表明按钮本身正常。

**真实 daemon**：用 `scripts/run-compiled-web-e2e.mjs`，临时 profile、数据库、workspace 和本地脚本化模型，没有动用户配置，没有请求外部模型。

- 从 CLI 带 `#directory=<workspace>` 打开：草稿预选 workspace 项目，没有绑定会话，服务端会话数为 0。
- 首发：会话建在 workspace 项目下，侧栏出现该行并更新标题，工具结果显示。
- 续问、刷新：回到同一会话，工具结果和续问各显示一次。
- New chat：连到默认目录、无会话，服务端会话数不变；草稿在项目间切换和刷新后文字都在。
- harness 判定 UI、backend（3 次 agent 请求、cache key 稳定、工具结果被消费）、diagnostics、cleanup 全部通过；daemon 已停止，端口释放。

前两轮 harness 失败，原因是我输入的续问文字不含 harness 要求的 `OHBABY_COMPILED_WEB_FOLLOWUP`，脚本化模型因此拒绝，页面显示 “LLM provider request failed after 5 retries”。用只多打一行日志的临时副本查到原因，改正输入后通过；产品代码和断言都没改。improve-1 05 记录的同一报错首轮失败，很可能是同样的原因，这次没有再核实。

## 5. 已知问题与限制

- **测试抖动（不是本批引入）**：`goal-resume.integration.test.tsx` 在全量并发运行时偶尔超过 3 秒超时；在 improve-2 开工前的提交上跑 5 次失败 2 次。`permission-recovery` 中一个 poll 原本要等约 0.9 秒的重试退避、默认超时只有 1 秒，已把这一处的超时放宽到 3 秒。
- **侧栏运行状态**只覆盖当前打开的会话（§2）。
- **执行目录不可用时**：启动时会忘掉上次的会话，退回默认目录的草稿；默认目录也不可用时没有实例，草稿区写明原因。打开某个会话时不可用，则回到原连接并在右上角报错。`Move to project…` 引导随 improve-3 的项目菜单启用（02 已写明）。
- **顶栏在加载中先显示侧栏标题**（04 §2.2）这次没有做，顶栏等会话视图返回后再显示标题。
- **窄屏和手机**侧栏这次只做了 CSS 调整（行尾按钮常显、44px 触控），没有逐尺寸走查。
- **旧链接**：hash 里的会话不在已加载的第一页、且已移到别的目录时，仍按 hash 里的目录打开，找不到就退回草稿。全局接口没有按 ID 查单个会话，这次不加。
- **Show more · N**：只要有已加载但折叠的行就显示数字，后面还有未加载页时也显示；06 §3.1 对这种情况写得不够明确，这里按“数字只算已加载”理解。
- **默认模型读取失败不误判成未配置**（B1 的一部分）只有代码检查（`currentModelLoaded`），没有专门的测试。
- `runtime.createSession()` 保留为“在当前实例创建或复用空会话”的底层接口，UI 已不调用，只有覆盖服务端复用规则的 `new-session-regression` 测试在用。improve-3 或之后可以评估是否连同这组测试一起收掉。

## 6. 给 improve-3 的交接

- 改归属的调用已在 `GlobalSessionsClient.moveSession`，成功后用返回的会话替换列表行（`catalog.upsertSession`），用 `beginWrite` 包住这次改动，再刷新。
- 搜索的调用 `searchSessions` 已写好并有单测，界面还没有。
- 会话菜单目前是 Pin、Export…、Archive，`SessionActionsMenu` 按 03 §4.4 加 `Move to project…` 即可。

## 7. 审查与修复（2026-10-24）

初版完成后由独立子代理按 Spec 与正确性两轴审查 `feb940d8..37e9b132`。确认的问题和处理如下，都在 `376896e0` 修复并补了测试：

| 级别 | 问题 | 处理 |
|---|---|---|
| P1 | 记住的会话或 hash 指向的目录已删除、不可读时，启动失败，整页显示 bootstrap 错误，而且每次刷新都一样 | 启动阶段的连接错误不再让 `ready` 失败：忘掉上次会话，退回草稿；不可用的项目直接跳过 |
| P1 | 运行中的会话被外部换项目后再发送，runtime 跟随 `SESSION_MOVED` 换了连接，切断了本轮的流、审批和停止（B16） | 有进行中的一轮或待审批时不跟随，提示这一轮结束后生效 |
| P2 | 换项目连接失败回滚后，选择条仍显示新项目，首发会落到旧目录 | 失败时把草稿项目改回实际连接的目录 |
| P2 | 启动恢复的会话已不存在时，连接停在那个目录、选择条却是 No project | 会话不存在就按草稿目录重开草稿 |
| P2 | `SESSION_MOVED` 跟随会覆盖用户在请求期间的新选择 | 跟随不算用户选择；用户选过别的就放弃跟随 |
| P2 | 首发守卫只比 client，同目录 New chat 不换 client，会被晚到回执拉走 | 增加选择代次比较 |
| P2 | 连接进行中时选同目录会话，绕过队列抢在注册前 | 只有连接完成的 client 才走就地选择 |
| P3 | 每次切换实例都被当成 SSE 重连，整表重读 | 换实例时重置重连判断 |
| P3 | 归档或改标题前开始的刷新，返回后把行改回旧值 | 本地改动计数，有未确认改动时保留本地行，改动确认后再刷新 |
| P3 | 跨目录操作每次注册新 client；Show more 可能一直翻到底 | 每个目录只注册一次；每次点击最多翻 10 页 |
| P3 | 侧栏 Open folder 会离开正在看的会话；迁移来的旧草稿丢了原项目；归档后服务端换绑别的会话时不回草稿 | 侧栏只登记项目；迁移后在原项目重开草稿；归档当前会话总是回草稿 |

审查同时指出 05 初稿把 B16 写成通过、B9 和 B15 的覆盖说得过满，以及 02、06 仍写着旧方案。本节之前的内容已按修复后的结果改写。未处理、记为限制的见 §5。
