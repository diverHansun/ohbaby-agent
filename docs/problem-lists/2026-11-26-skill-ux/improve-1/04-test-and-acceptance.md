# 4. 测试与验收

> 覆盖后端和 TUI。Web 的验收见 [frontend/08](frontend/08-test-and-acceptance.md)。对应的方案见 [02](02-optimization-plan-and-change-scope.md)。
>
> 项目没有单独的 test-blueprint。本文沿用仓库现有的测试分类：文件名后缀 `*.unit.test.ts`、`*.contract.test.ts`、`*.integration.test.ts`，按类型运行用 `npm run test:unit`、`npm run test:contract`、`npm run test:integration`。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| 单元测试 | 展开函数的各种输入（含多行原话）；`isSkillBodyPart` 和各消费方的过滤；预填 helper 的四种记录；skill-usage 的判断；TUI 上色的切分逻辑 |
| 契约测试 | `ui-inprocess` 的新消息、编辑重发、steer 重发、排队编辑的对外行为；公共 submit 不能伪造 skill 身份；编辑重发新错误码经服务端和 SDK 之后的状态码和文字；TUI 输入框的渲染结果 |
| 集成测试 | prompt-scheduler 的手动和自动 steer（含重试、并发编辑和两个实例共用一个数据库）；run-manager 拿到租约后登记信任，read 工具不再弹审批 |
| 实测 | 用真实模型和真实 skill 在 Web 和 TUI 各走一遍，确认模型确实拿到了正文 |

现有相关测试要一起更新：`skill/tool.unit.test.ts`、`skill/registry.unit.test.ts`、`adapters/ui-inprocess.contract.test.ts` 中带 `skillBodyExpanded` 的用例、`runtime/prompt-scheduler/current-run-inputs.integration.test.ts`、`automatic-steer.integration.test.ts`。

## 4.2 关键场景

### 消息结构和新消息（Stage 1）

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| A1 | 发 `/code-review 帮我看看` | 契约 | 历史里是一条 user 消息、两个 part；第一个 `synthetic: true`、`kind: "skill-body:v1"`，文字以 `<skill name="code-review">` 开头、以 `\n\n` 结尾，带 `skillUsage`；第二个文字是 `帮我看看`，带 `displayText: "/code-review 帮我看看"` 和 `skillMarker` |
| A1b | 同 A1，但让第二个 part 写入失败 | 契约 | 历史里不留下只有隐藏正文的用户消息；同一个操作重试后，历史和 A1 一样 |
| A2 | 发 `/code-review`，不带原话 | 契约 | 可见 part 文字为空，`displayText` 是 `/code-review`；界面投影里这条消息仍然可见 |
| A3 | 发 `/Code-Review 原话` | 契约 | `displayText` 和 `skillMarker.name` 都是标准名 `code-review` |
| A4 | 模型请求体 | 单元 | 序列化后的 user 文字是 `<skill …>正文</skill>\n\n帮我看看`，没有 `User request:` |
| A5 | `prompt_submission.text` | 契约 | 存的是 `/code-review 帮我看看`，排队列表和 `promptRecordToUi` 返回的也是它 |
| A6 | 发送瞬间的乐观消息 | 契约 | 乐观消息只有可见 part，文字、`displayText` 和 `skillMarker` 与正式消息的可见 part 一致；没有隐藏的正文 part |
| A7 | 用户敲 `/Code-Review x` | 单元 | 标签属性里写的是标准名 `code-review`；registry 只刷新一次（只调一次 `load`） |
| A8 | 排队期间 skill 被删 | 契约 | 这条 prompt 照常开跑，不报错；历史里只有一个普通 text part，文字是 `/技能名 原话`，没有 `skillMarker`、`skillUsage` 和隐藏 part |
| A9 | 排队期间 skill 被改成不允许用户调用 | 单元 | 展开函数返回"不可用"，结果同 A8 |
| A9b | registry 查到条目之后、读正文之前删掉 SKILL.md（`load` 抛 `SkillLoadError`） | 单元 | 展开函数返回"不可用"，不抛错，结果同 A8 |
| A10 | 公共 submit 发 `/code-review x` 并伪造 `skillBodyExpanded: true` | 契约 | 不展开，按普通文字处理（保留现有契约测试） |
| A11 | 升级前已在排队的旧记录（`text` 是全文，标记为真） | 契约 | 按旧格式写一个 part，不重复展开；预填 helper 返回 `/name` 加 `request` |
| A12 | 会话标题回退、导出、子代理监控 | 单元 | 都不出现 SKILL.md 正文；token 统计把隐藏 part 计入 skills |
| A13 | 压缩后的 skill 提醒 | 单元 | 新消息（包括不带原话的）和旧版消息都被认作"加载过"；压缩掉之后正确提示重读 |
| A14 | 搜索 | 契约 | 搜 SKILL.md 里的词搜不到这条消息；搜原话能搜到 |
| A15 | 发 `/code-review` 后直接换行，第二行起写原话 | 契约 | 原话完整保留，`prompt_submission.text` 和 `displayText` 都是 `/code-review\n原话` |
| A16 | 第一行写参数，下面再贴一段带缩进和空行、以空格和换行结尾的代码，从真实的 TUI 输入框提交 | 契约 | 模型收到的可见文字包含第二行以后的全部内容，中间的缩进和空行逐字不变（现在只取 `rawArgs`，会丢掉）。TUI 发送和排队编辑本来就会对整段输入 `.trim()`，末尾的空格和空行不在断言范围内 |
| A17 | 只发 `/code-review`，会话还没有标题 | 单元 | 标题回退拿到 `/code-review`，不是空，也不是 SKILL.md 正文 |
| A18 | 运行中 steer 了一条 slash 消息，run 结束前没被消费 | 契约 | 未处理 steer 的预览（`projectUnconsumedSteers`）显示 `/技能名 原话`，没有 SKILL.md 正文 |
| A19 | 历史里没有任何 skill 调用（slash 和工具调用都没有） | 单元 | 展开函数和信任扫描都不调用 registry 刷新 |

### 各个入口（Stage 2）

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| B1 | 运行中手动 steer `/code-review 原话` | 集成 | 写入的 steer 消息是两个 part，和 A1 结构一致 |
| B2 | goal run 中的自动 steer | 集成 | 同 B1；展开发生在进锁之前，不走内容核对和重试 |
| B3 | steer 时 skill 被删 | 集成 | 照常 steer 进去，结果是 steered；写入的是一个普通 text part `/技能名 原话`，没有标记 |
| B4 | 编辑重发，改成 `/code-review 新原话` | 契约 | 截断后的新消息是两个 part，正文从磁盘重新读取（测试里先改 SKILL.md 再重发，能看到新内容） |
| B5 | 编辑重发，skill 已被删 | 契约 | 返回新错误码；历史没有被截断，正在跑的 run 没被停，goal 没被暂停，排队项没被取消；经服务端是 400，SDK 拿到的错误文字带技能名，没有 `Something went wrong:` 前缀 |
| B6 | 编辑重发，把开头改成 `/compact x` 或 `/api/v1` | 契约 | 按普通文字发送，不报错 |
| B7 | 编辑重发，开头是和保留名重名的 skill | 契约 | 和新消息的结果一致（都不作为 skill） |
| B8 | 编辑重发，校验通过但截断后提交失败 | 契约 | 走 `sendError`，返回原样输入 |
| B9 | 编辑排队中的 slash 消息，只改原话 | 契约 | `namingSource` 重新算出，出队后展开正常 |
| B10 | 编辑排队中的 slash 消息，删掉开头的 `/技能名` | 契约 | 变成普通消息，不展开 |
| B11 | 未处理的 steer 重发 | 契约 | 重发前的预览是 `/技能名 原话`；重发的是 `original.text`，结果和新消息一致，不会把 SKILL.md 当普通文字发出去 |
| B12 | 保留项重发（`resubmitRetainedPrompt`），编辑了原话 | 契约 | 同 B9；提交的是这次编辑后的 `input.text`，不是原记录的文字 |
| B13 | `rewindSession` 返回的 `restoredText` | 契约 | 新消息是 `/name 原话`；旧消息按预填 helper 的规则 |
| B14 | 编辑重发写成 `/Code-Review 新原话` | 契约 | 存进去的 `text` 是 `/code-review 新原话`，展开正常，不被当成旧记录 |
| B15 | 排队编辑写成 `/CODE-REVIEW 原话` | 契约 | 同 B14 |
| B16 | 手动 steer 第一次成功但回包丢了，同一个操作重试 | 集成 | 记录已不是 `queued`，直接返回第一次的回执，不调展开端口，消息只写入一次；即使重试前 skill 被删了也一样 |
| B17 | 保留项重发回包丢了重试 | 契约 | 相同操作 ID、相同文字：返回原回执，只提交一次；相同操作 ID、不同文字：报冲突 |
| B18 | 手动 steer 在锁外展开时，另一个后端实例编辑了这条排队项 | 集成 | 用真实的 `commitCoordinator`，两个 scheduler 共用一个数据库。A 展开期间让 B 编辑并提交；A 进事务后发现 `text` 变了，按新记录重新展开。最终写进历史的 part 和提交记录的最新文字一致，不是旧内容；返回给调用方的 steer 结果仍是现有枚举里的值 |
| B18c | A 展开期间，B 只续期了编辑租约、没改文字 | 集成 | 不触发重试，按第一次展开的结果写入 |
| B18b | 同上，但记录连续被改 3 次 | 集成 | 重试 2 次后仍对不上，按普通文字 steer 进去，不报错 |
| B19 | 旁聊里排队了 `/code-review x`（按字面发送），编辑排队项改一个字；或者保留项重发 | 契约 | 不解析 slash，不展开；模型只收到原话 `/code-review x…`，没有 `skillMarker` |
| B20 | 不传 `submitPromptAccepted` 时执行 skill 命令 | 单元 | `executeSkillCommand` 显式报错，不再输出 markdown 全文 |
| B21 | 主会话排队编辑或保留项重发时 skill 已被删 | 契约 | 不报错，按普通文字处理；对比 B5，只有编辑重发报错 |

### 信任登记（Stage 3）

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| C1 | 非 full-access，slash 调用后 read 读 `references/x.md` | 集成 | 不弹审批 |
| C2 | 进程重启后继续同一会话再 read | 集成 | 不弹审批 |
| C3 | fork 出来的会话 | 集成 | 不弹审批 |
| C4 | steer 带进来的 skill | 集成 | 同一个 run 里接着 read，不弹审批 |
| C4b | steer 已写进消息表、但模型还没读到它时 run 就结束了；重启后继续这个会话 | 集成 | 这条 steer 没进过模型请求，不算加载过；读这个 skill 在工作区外的目录仍要审批 |
| C5a | write 改工作区外的 skill 文件 | 集成 | 仍然弹外部写审批 |
| C5b | write 改工作区内项目级 skill（`.ohbaby/skills/`）的文件 | 集成 | 和改其他工作区文件的审批一样，不因为登记了信任而放宽（已知边界，00 B3） |
| C6 | write 写 `.ohbaby/skill-output/<name>/` | 集成 | 不弹审批 |
| C7 | 历史里的 skill 已被删 | 集成 | 跳过，不报错，run 正常开始 |
| C8 | 模型调 `skill` 工具 | 单元 | 行为和改动前一致（共用登记核心后不回归） |
| C9a | 工具调用 metadata 里的 `dir` 已过时（skill 被移动） | 集成 | 登记的是 registry 当前的 `baseDir`，旧路径不放行 |
| C9b | 同名 skill 换了来源（项目级新装了一个，覆盖用户级） | 集成 | 登记的是新来源的目录（已知边界，和工具路径一致） |
| C10 | 子代理或另一个 `contextScopeId` 里读同一个 skill 的 `references/` | 集成 | 主上下文的 slash 调用不让这里放行；这个上下文自己的历史里没有加载过，就照常审批 |
| C11 | 历史里同一个 skill 被调用了很多次 | 单元 | registry 只刷新一次，同一个目录只登记一次 |
| C12 | 同一个 run 里同一条 steer 消息被处理两次 | 单元 | 只登记一次 |

### TUI（Stage 4）

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| D1 | 消息行、排队列表、排队编辑、RewindPanel | 契约 | 显示 `/技能名 原话`，没有 SKILL.md 正文 |
| D2 | 输入框敲 `/code-review 帮我` | 契约 | `/code-review` 是 accent 色，后面文字颜色不变 |
| D3 | 输入框敲 `/compact` | 契约 | 不上色 |
| D4 | 光标停在技能名中间 | 契约 | 光标格按光标样式，其余技能名仍是 accent |
| D5 | 第一行很长被换行，或输入框滚动到下面 | 契约 | 只有第一条逻辑行开头的技能名上色，换行出来的第二段、滚动后的视口第一行都不误上色 |
| D6 | 第二行开头敲 `/code-review` | 契约 | 不上色 |
| D7 | 浅色主题 | 契约 | 用的是浅色主题的 `accent` |

## 4.3 集成边界

- **commands 和 adapter**：`executeSkillCommand` 只校验、不读正文；展开发生在 adapter 写消息之前。测试要覆盖"校验通过、开跑时 skill 已不在"的情况（A8）。
- **adapter 和 prompt-scheduler**：steer 的展开端口在 `ui-inprocess.ts` 创建 scheduler 时注入。测试用假端口验证"端口返回不可用时按普通文字 steer"和"记录已不是 `queued` 时不调用端口"，再用真实端口跑一次 B1。B18 必须用真实的 `commitCoordinator` 和共用的数据库，单个实例里的会话锁测不出跨实例的问题。
- **run-manager 和 sandbox**：信任登记用真实的 sandbox lease 和 read 工具权限判断，不 mock 权限结果，否则测不出 C1 到 C4。
- **后端、服务端和 SDK**：编辑重发的新错误码要经过 `ohbaby-server` 的状态码映射和 SDK 的错误包装，B5 在这条链路上断言 400 和原样文字，不能只测 adapter。
- **后端和界面**：界面只认 2.5 节的字段。契约测试断言字段本身，Web 的显示交给 frontend/08。

## 4.4 回归清单

- 普通消息（不带 slash）的发送、排队、steer、编辑重发、搜索、标题完全不变。
- 模型通过 `skill` 工具加载 skill 的行为和权限不变。
- 旧会话里的 slash 消息照常显示全文，编辑预填按测试 B13 的规则（`restoredText`）。
- 前缀缓存：同一会话连续发两条消息，第二次请求的前缀和第一次一致。可以用 `npm run test:cache:real` 里对应的场景，或在实测中看缓存命中数。
- 公共 submit 的安全约束（A10）。
- full-access 模式下的行为不变。

## 4.5 验收标准

| 项 | 标准 | 如何验证 |
|---|---|---|
| 消息结构 | A1 到 A19（含 A1b、A9b）全部通过 | `npm run test:unit`、`npm run test:contract` |
| 入口一致 | B1 到 B21（含 B18b、B18c）全部通过 | `npm run test:contract`、`npm run test:integration` |
| 信任登记 | C1 到 C12（含 C4b）全部通过 | `npm run test:integration` |
| TUI | D1 到 D7 全部通过 | `npm run test:contract`（ohbaby-cli） |
| 实测：模型拿到正文 | 用一个 SKILL.md 里写了明确指令的真实 skill（比如"回答开头先写 OK-SKILL"）发 slash 消息，回答遵守了指令；气泡里只有标记和原话 | 启动 daemon，在 Web 和 TUI 各发一次，记录截图和回答 |
| 实测：读 references 不弹审批 | 非 full-access 下让模型读这个 skill 的 `references/` | 同上 |
| 实测：编辑重发 | 编辑上一条 slash 消息并改原话，重发后模型仍然遵守 skill 指令 | 同上 |
| 实测：排队期间删 skill | 运行中排一条 slash 消息，排队期间删掉这个 skill，轮到它时模型收到 `/技能名 原话`，气泡没有魔杖 | 同上 |
| 全量检查 | 类型检查、lint 和全部测试通过 | `npm run typecheck`、`npm run lint`、`npm test` |
| 文档同步 | 02 的 D1、D2 两份文档已更新 | 人工检查 |

## 4.6 对抗性审查要点

| 攻击面 | 可能出的错 | 防御 | 残余风险 |
|---|---|---|---|
| 伪造 skill 身份 | 外部调用方在公共 submit 里塞 `skillBodyExpanded`，让任意文字被当成 skill 展开，或冒充 slash 身份绕过提醒逻辑 | `publicNamingSource` 剥掉内部字段；展开只看后端标记；A10 | 无新增 |
| 漏掉的写入口 | 某个入口没走展开函数，模型收到字面 `/name 原话` 而不是正文，表现为"skill 不生效"，很难察觉 | 展开函数唯一；B1 到 B21 覆盖已知入口；实测用"回答开头写 OK-SKILL"的 skill 一眼可见 | 以后新增入口时可能再漏，靠 `skillBodyExpanded` 注释提醒 |
| 大小写没规范化 | 某个入口存了 `/Code-Review`，被当成升级前的旧记录，不展开 | 四个入口共用规范化；A3、B14、B15 | 无 |
| 回包丢了重试 | 重试时重新展开，消息写两遍，或者 skill 刚被删导致结果不一致 | steer 进锁前看状态，已提交就返回原回执；保留项重发沿用文字比较的冲突检查；B16、B17 | 保留项重发：大小写不同加重试前 skill 被删，会报冲突（已知边界，02 第 2.8 节） |
| 跨实例并发 | 两个后端共用 SQLite，A 锁外展开期间 B 改了记录，A 用旧内容写进历史 | 事务里核对 `text` 和 `namingSource`，变了重新展开，最多 2 次；B18、B18b、B18c | 无 |
| 旁聊被当成 slash | 旁聊里按字面发送的 `/name x`，排队编辑或保留项重发后变成调用 skill | 旁聊记录不解析 slash；B19 | 无 |
| 初始消息写一半 | 第二个 part 写失败，留下只有隐藏正文的用户消息 | 两个 part 一起落库或失败清理；A1b | 无 |
| 双重展开 | 旧排队记录被当成新记录再展开一次，正文出现两遍 | 用 `text` 是否以 `/` 开头区分（旧全文以 `## Skill:` 开头）；A11 | 无 |
| 标签注入 | SKILL.md 正文或原话里含 `</skill>`，让模型误判边界 | 技能名受 schema 限制，不会破坏属性；正文是用户自己装的 skill，原话是用户自己写的，都在用户信任范围内 | 模型可能被正文里的 `</skill>` 迷惑，影响很小 |
| 信任范围扩大 | 扫描历史时把不该登记的目录登记成可信 | 路径只取 registry 当前的 `baseDir`，不取 metadata 里的路径；只扫当前上下文、只登记模型真正看到过的 skill；C4b、C7、C9a、C10 | rewind 掉的 skill 目录残留到进程结束（已知边界） |
| TUI 上色错位 | 输入框滚动或换行后，颜色画到别的文字上 | 只按逻辑行和偏移判断；D5、D6 | 无 |
