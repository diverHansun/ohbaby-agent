# 4. 测试与验收

> 对应 [02](02-optimization-plan-and-change-scope.md) 的 Stage 1 至 4。测试文件沿用仓库现有约定：与源码同目录，`*.unit.test.ts`、`*.integration.test.ts`、`*.contract.test.ts`，按类型用 `pnpm test:unit`、`pnpm test:integration`、`pnpm test:contract` 运行。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| unit | `model.json` 迁移与投影、模型解析规则、客户端池失效、reasoning 兼容判断、Web 的勾选与能力选择逻辑 |
| integration | 两个会话并发用不同模型、排队消息的快照、被删条目的回退、子代理继承、压缩与标题用的模型、运行中切换、提交记录迁移 |
| contract | 新 HTTP 路由与 JSON-RPC 方法、设置接口字段变化 |
| 浏览器走查 | Stage 3 的 ModelMenu、Settings 列表与编辑器（mock 场景和真实 daemon 各走一遍） |
| 手工 | Stage 4 的 TUI `/models`、`/effort`、底栏 |

假的 LLM 客户端要能看出请求发给了哪个条目（例如记录 `baseUrl` 和 `model`），T8 至 T12 都靠它断言。

## 4.2 关键场景

### Stage 1：后端核心

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T1 | 读旧格式 `model.json`（有顶层快照和 `llmParams`） | unit | 内存里每个条目拿到 `maxOutputTokens`（条目已有值时保留条目值）；`temperature` 和 `reasoning` 只迁到原默认条目，`reasoning` 不兼容时丢弃；读取不写盘 |
| T2 | 旧格式文件第一次被写入 | integration | 写入后磁盘只剩 `activeProfileId` 和 `models`；备份文件存在且内容与原文件一致；第二次写入不再备份 |
| T2b | 只有顶层字段、没有 `models[]` 的最老格式 | unit | 仍能转成一个条目并设为默认；1f 列出的 smoke 读取方改完后能跑通 |
| T3 | 投影指定条目 | unit | `projectModelDocument(doc, id)` 的 `llmParams.maxTokens` 等于该条目的 `maxOutputTokens`，没有时为 8192；预算档案的输出上限与请求一致 |
| T4 | 模型解析 | unit | 提交时：提交选项 → 会话 → 留空。执行时：记录有 id 用它，留空用当时的默认，不读会话；默认也没有时报错；条目不存在时返回默认并带 `removedEntryId`；条目不完整时报 `MODEL_CONFIG_INCOMPLETE` |
| T4b | 没有默认模型 | integration | 运行时能正常启动；会话锁定在有效条目时照常执行；跟随默认的会话提交后报“没有可用模型” |
| T5 | 会话的条目被删后运行一轮 | integration | 这一轮用默认模型；会话的 `modelEntryId` 被清除；发出 `model:entry-removed:<sessionId>` 提示。若排队期间用户已把会话改成条目 Z：这一轮仍按记录回退到默认，会话字段保持 Z 不被清除，下一轮用 Z |
| T5b | 排队消息的条目在执行前被删 | integration | 执行时回退到默认并提示，不报错 |
| T6 | 改了条目的 key 或地址 | integration | 下一轮请求用新配置；正在运行的轮次继续用旧客户端完成；两个工作区目录下 `.env` 不同时各自取到自己的 key |
| T7 | 改模型库时实例里有运行中的会话 | integration | 不再出现“等待空闲后重建运行时”；运行中的轮次不中断；下一轮生效 |
| T8 | 同一实例两个会话用不同条目并发运行 | integration | 两边的请求分别发往各自条目的 `baseUrl` 和 `model`；助手消息的 `providerId`、`modelId` 各自正确 |
| T9 | 上下文预算按会话条目 | integration | 会话 A 用 1M 窗口条目、B 用 128K 条目，B 在超过 128K 阈值时触发自动压缩，A 不触发；两个条目服务商模型名相同、窗口不同时也各用各的预算 |
| T9b | 同一会话从大窗口切到小窗口 | integration | 切换后校准系数和压缩下限已重置；第一轮按新窗口判断；估算偏差导致溢出时由现有溢出压缩重试恢复 |
| T10 | 压缩摘要和标题 | integration | 自动压缩、手动 `/compact` 的摘要请求和新会话的标题请求都发往这一轮的条目；上下文用量接口返回会话条目的窗口 |
| T11 | 子代理 | integration | 父会话用条目 X 时，子代理请求发往 X；父会话中途切到 Y 后，下一轮新起的子代理用 Y；续跑已结束的子代理时按父会话解析 |
| T12 | 排队消息 | integration | 会话用 X 时提交两条，第一条运行中把会话切到 Y：第二条仍用 X；之后新提交的用 Y |
| T12b | 跟随默认时排队，之后切换 | integration | 会话跟随默认（默认为 D）时提交两条，第一条运行中把会话切到 Y：第二条用 D，不用 Y |
| T12c | goal 自动续跑与插话 | integration | 会话切到 Y 后，goal 自动续跑的下一轮用 Y；运行中插话并入当前轮，沿用当前轮的模型 |
| T13 | 会话切换与 reasoning | integration | 会话 reasoning 为 `xhigh`，切到只支持 `low/medium/high` 且能力已识别的条目时，同一次更新清掉 reasoning；切到能力未知的条目时保留 |
| T13b | 执行时 reasoning 不兼容 | integration | 跟随默认的会话选了 `xhigh`，全局默认换成不支持 `xhigh` 的条目后执行：请求不报错，改用条目默认档位并发提示；被删条目回退时同理 |
| T14 | 每模型默认 reasoning | integration | 条目 A 默认 `high`、B 无默认；会话未选档位时，A 的请求带 `high`，B 的请求用能力默认；切换全局默认模型不改动任何条目的 `reasoning` |
| T14b | 默认 reasoning 与输出上限冲突 | unit | Anthropic 预算模式下，默认档位的思考预算不小于条目输出上限时，保存被拒绝 |
| T18b | 只有一个模型即默认 | integration | 空的 `model.json` 里新建一个配置完整的条目后，它成为默认；新建一个缺地址或协议的条目、之后补全，补全时成为默认；缺 key 不影响配置完整性；已有默认时新建条目不改默认 |

### Stage 2：接口

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T15 | `PATCH /v1/sessions/:id/model` | contract | 合法 id 返回更新后的 `UiSession` 并发 `session.updated`；`null` 清除；不存在的条目 `MODEL_NOT_FOUND`；不完整的条目 `MODEL_CONFIG_INCOMPLETE`；跨工作区与 reasoning 接口同样拒绝 |
| T16 | 新会话首条提交带 `modelEntryId` | integration | 会话创建后 `modelEntryId` 已写入；同一 `clientRequestId` 重试时，显式传的 `modelEntryId` 不同视为冲突；没显式传时，会话模型在两次之间变化不算冲突 |
| T17 | `GET /v1/model?sessionId=` | contract | 返回会话解析出的条目，`source` 正确；不带参数返回默认 |
| T18 | 设置接口 | contract | 响应没有 `params`；条目带 `reasoningDefault`；创建、修改可设和清除 `reasoning`，能力已识别时拒绝不兼容的值；JSON-RPC 的 `updateSessionModel` 与 HTTP 行为一致 |

### Stage 3：Web

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T19 | 已有会话里切换模型 | 浏览器 | 只有当前会话的标签和勾选变化；顶栏的模型名和上下文窗口立即刷新，不用等下一轮；Settings 里的 Default 不变；切到另一个会话看到它自己的模型 |
| T19b | 菜单的默认标记 | 浏览器 | 菜单只列模型，没有额外项；默认模型旁有不显眼的 `default` 标记；没选过模型的会话勾在默认模型上，在 Settings 改默认后勾和下一轮的模型跟着换；选过模型的会话不受影响；跟随默认的会话点一下勾着的默认条目后，再改默认，这个会话不再跟着换 |
| T19c | 模型很多时的菜单 | 浏览器 | 配 15 个以上模型：菜单不超出屏幕，列表区域内部滚动，过滤框和 Manage models… 不动；打开时能看到当前勾选的条目；手机宽度下沿用现有底部抽屉的整体滚动 |
| T20 | 新会话预选模型 | 浏览器 | 还没发消息时选模型，发出第一条后会话上记录了这个模型 |
| T21 | reasoning 控件跟随会话的模型 | 浏览器 | 切到另一种能力的模型后，档位选项随之变化，不支持的档位回到默认 |
| T22 | Settings 编辑器的 Reasoning 行 | 浏览器 | 显示检测状态；Detect again 调用 probe 并刷新；能力已识别时可设 Default effort 并保存 |
| T23 | 删除模型 | 浏览器 | 删除任何单个模型都弹确认，文案包含会话会改用默认模型；正在用它的会话下一轮出现提示并显示默认模型 |
| T24 | 列表说明与默认标记 | 浏览器 | 列表顶部有默认模型的说明；ModelMenu 里默认条目有标记 |

### Stage 4：TUI

| ID | 场景 | 类型 | 验证点 |
|---|---|---|---|
| T25 | `/models` 切换 | 手工 + integration | 选择后只改当前会话；没有会话时暂存，首条提交后写入会话；超过 8 个条目时可滚动选到最后一个；配置不完整的条目不出现 |
| T25b | `/models` 设默认 | 手工 + integration | 按 `d` 后 Settings 的 Default 变成这个模型；跟随默认的会话（包括当前会话，如果它没选过模型）下一轮换成新默认；选过模型的会话不变；面板不关，`default` 标记移到新条目；没有会话时也能用 |
| T26 | 底栏与 `/effort` | 手工 | 显示当前会话的模型和该模型支持的档位 |
| T27 | `/connect` | 手工 | 保存条目并设为默认，与 improve-2 一致；当前会话若有自己的模型则不受影响 |

## 4.3 集成边界

- **agent 与 llm 包**：LLM 包只接收投影结果，T3 保证投影出的 `llmParams` 完整合法。
- **in-process 适配器与运行时**：`resolveRunModel` 是唯一入口，T8 至 T12 从适配器层发起，不直接构造运行时。
- **daemon 与 Web、TUI**：T15 至 T18 用真实路由。
- **磁盘**：T2 使用临时 `OHBABY_HOME`，不碰用户目录。

## 4.4 回归清单

- 现有会话 reasoning 的保存、提交快照、恢复测试全部通过（`agent/runtime/prompt-scheduler/reasoning-persistence.integration.test.ts` 等）。
- `/connect` 保存、旧 `POST /v1/model`、Settings 的新增、修改、删除、设为默认、删除服务商。
- 删除默认模型后按列表顺延；全部删除后 `active: null`。
- 自动压缩、手动压缩、上下文用量显示。
- 子代理运行、goal 子代理。
- prompt cache 统计（`onStepUsage`）不因换客户端而丢失。
- 跨工作区移动会话后，下一轮仍用会话自己的模型。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|---|---|---|
| 功能 | T1 至 T24（含带字母后缀的子项）通过；T25 至 T27 在 Stage 4 完成时通过 | 测试命令与浏览器走查记录 |
| 类型与测试 | `pnpm typecheck` 和 `pnpm test:unit`、`pnpm test:integration`、`pnpm test:contract` 全部通过 | 命令输出 |
| 运行时去耦 | `createUiRuntimeComposition` 的选项里没有 `llmClient`；`Lifecycle` 不再从依赖读客户端 | 代码检查 |
| 文件迁移 | 用当前用户真实格式的 `model.json` 副本跑一次迁移，备份与结果都正确 | 临时目录手工验证 |
| 文档 | 02 §2.9 的 D1 至 D4 已同步 | 检查文档 |

## 4.6 对抗性审查要点

| 攻击面 | 可能出错的地方 | 防御 | 残余风险 |
|---|---|---|---|
| 漏改的 `llmClient` 引用 | 某条路径（例如上下文用量、诊断日志）仍取默认模型，显示和实际不一致 | 去掉选项让编译器报错；T8、T10 断言请求去向 | 通过闭包间接持有的旧客户端，类型检查发现不了，需要人工看 composition |
| 客户端池失效 | 缓存键漏了 key 值或项目目录 | 按内容哈希，键含 key 值和项目目录（P5）；T6 | 外部进程环境变量变化不会被感知，与现在相同 |
| 排队消息的模型漂移 | 跟随默认时排队的消息被之后的切换带走 | 执行时不读会话（P2）；T12b | 无 |
| 重建附带的隐性重置丢失 | 顶栏、校准、prompt cache 统计沿用旧模型 | 1d 显式重置；T9b、T19 | 还有没发现的隐性重置，靠 T7 和回归清单兜底 |
| 回退时的竞争 | 回退清字段覆盖了用户刚做的切换 | 条件写入；T5 | 无 |
| 迁移丢数据 | 条目已有 `maxOutputTokens` 时被全局值覆盖；reasoning 或温度被迁到所有条目 | T1 明确断言规则 | 用户原本依赖“全局 `maxTokens` 覆盖条目值”的行为会改变，属预期 |
| reasoning 校验来源 | 某处仍按全局模型校验，导致会话档位被误清 | T13、T14、T21 | 能力未知的条目不校验，错误档位要到请求时才发现，与现在相同 |
| 提交幂等 | 重试时 `modelEntryId` 不同未被识别为冲突 | T16 | 无 |
