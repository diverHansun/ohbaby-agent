# 5. 实施与验收

2026-11-20，Stage 1、2 在本地 `codex/subagent-model` 完成，Stage 3（Web）随后在同一分支完成，见下文 “Stage 3：Web”。Stage 4（TUI）还没开始。

## 后端行为

- 用户可以从配置完整的条目中任选一个作为子代理模型，也可以选择跟随聊天。可选的思考档位随模型选择保存，省略时使用该条目的默认值。
- 新建子代理，或给空闲子代理发消息时，读取当时的设置。模型、档位和运行配置取自同一份模型库快照。已取得配置的执行继续使用这个快照。删除条目后发起的新执行跟随父会话。
- 若模型条目缺少连接配置，或已有父会话运行时模型库暂时读不出来，子代理使用父会话这一轮的模型和档位并发出提示。已选模型实际请求的鉴权错误照常报告。显式档位失效时，本次执行使用所选模型的默认档位。

## 前端接口

| 入口 | 调用 |
| --- | --- |
| Web Settings | `runtime.settings.selectSubagentModel({ id, reasoning? })`。沿用 Settings 写入队列及缓存 |
| TUI | `client.selectSubagentModel({ entryId, reasoning? })` |
| `/models` 数据 | `subagent` 顶层设置包含模型名、档位及 `configurationComplete`。`models` 中每行的 `subagent` 标明是否为所选模型 |

`id` 或 `entryId` 传 `null` 恢复跟随聊天。选 `Model default` 时省略 `reasoning`。HTTP 和 TUI 命令读取同一个全局设置。前端的 Default 说明、模型与档位选择、删除提示和真实界面走查对应 T14 至 T20。

## 验证结果

| 范围 | 结果 |
| --- | --- |
| T1–T6 | 模型库读写、后台探测、单条和按提供商删除、HTTP 校验、JSON-RPC 转发及 `/models` 数据通过 |
| T7–T13、T11a、T12a | 通过。覆盖独立模型与档位、父会话继承、运行中保持原模型、空闲后跨协议续跑、设置读取失败、档位失效和并发删除 |
| 回归 | 单元测试 5,495 项通过，契约测试 591 项通过。最终版本的 250 个非 CLI 集成测试文件共 2,523 项通过，12 项按测试条件跳过。CLI 打包、安装和启动相关测试另行运行 |
| 真实请求 | 两次通过。父会话用阿里云 `qwen3.8-flash`，子代理用智谱 `glm-5.3-flash`，两端均返回完成。记录的实际模型请求符合配置。DeepSeek 直连超时后改用上述两个端点 |
| 静态检查 | `pnpm typecheck`、`pnpm lint` 及改动代码的格式检查通过。全库格式检查发现基线 `packages/ohbaby-server/src/terminal/pty.integration.test.ts` 的已有格式问题 |

本次真实请求通过临时模型库执行，使用本地 `.env` 中的凭证。测试目录已清理。

## 后端独立验收

2026-11-20 对提交 `ea7f4ec0` 做了独立检查：逐个读了改动的源码，对照 02 的 P1 至 P13 和 04 的 T1 至 T13。`pnpm typecheck` 通过；子代理模型、模型设置、Settings 接口和 session-model 四组集成测试共 53 项全部通过。

结论：Stage 1、2 达到完成定义，可以开始做界面。

### 与 02 的差异

| 位置 | 02 的写法 | 实际做法 | 评价 |
|---|---|---|---|
| P2 档位 | `mergeReasoningIntent(client.config.reasoning, setting.reasoning)` | 设置了档位时，用 `resolveSubagentReasoning` 把它当成一个整体，替换条目默认档位；没设档位时才用 `mergeReasoningIntent(client.config.reasoning)` | 合理。保存时校验的就是这个整体，运行时也按整体用，不会拼出一个没校验过的组合 |
| P5、P9 解析位置 | 解析放在 `subagent-model.ts`，复用 `compatibleReasoning` | 读设置和读条目配置放进 `modelClientPool.resolveSubagent`，在同一次 `coordinateModelConfig` 里取快照；档位校验改用新的 `config/llm/subagent-reasoning.ts`，写入和运行时共用 | 更好。避免了“读到 id 以后条目被删，又退回 Default”的竞态（T12a） |
| P9 能力未识别 | `compatibleReasoning` 在能力未识别时放行 | 能力未识别时不允许保存显式档位，运行时遇到也退回模型默认档位并提示 | 更严，但可以接受。界面只在能力已识别时提供档位选项 |
| P12 读视图 | `{ id; provider; model; reasoning? }` | 多了 `label` 和 `configurationComplete` | 需要。界面靠 `configurationComplete` 显示 “Needs setup” |
| 新增 | 无 | 模型库读不出来时继承父会话并提示（T11a）；宿主注入固定 `llmClient` 时不读子代理设置 | 合理。注入客户端时所有请求本来就发往同一个客户端 |

### 遗留与提醒

- 设置的条目缺 key、加载配置失败时，子代理这次执行直接失败，主代理收到工具失败。这和 00 D11 一致，不算缺陷。
- `CommandModelProvider` 新增了可选的 `listModelsWithSubagent`，和原有的 `listModels` 并存。目前只有一个实现，以后可以考虑合并成一个。
- Web 界面（T14 至 T17a）已完成，见下一节；TUI（T18 至 T20）还没做。

## Stage 3：Web

2026-11-20 完成，Web 代码提交为 `95db03d1`，验收记录在 `codex/subagent-model` 上单独提交。

### 做了什么

- `ModelsSection.tsx`：标题下加了 Default 说明 “Default is used by new chats and chats that haven't picked a model.”；模型分组上方加了 “Subagent model” 一行；删 provider 的确认框在 provider 含子代理模型时追加提示。
- `SubagentModelRow.tsx`（新）：这一行本身。左边是标题和一句说明，右边是两个原生下拉框：
  - 模型：“Follow chat” 加所有配置完整的条目。引用的条目不完整时，多一个禁用的 “模型名 (needs setup)” 选项并选中它，旁边出现 “Needs setup” 文字按钮，点击打开这个条目的编辑器。
  - 档位：只在选了模型、且这个模型有可选档位时出现。第一项是 “Model default (默认档位)”，下面是支持的档位。已保存的档位不在可选列表里时，显示一个禁用的 “档位 (unavailable)” 选项。
  - 每次改动立刻保存，和 “Set as default” 一样。保存中显示小转圈并禁用下拉框；`MODEL_CONFIG_INCOMPLETE` 打开编辑器，`MODEL_NOT_FOUND` 重新加载列表，其他错误在行下显示一句失败提示。
- `model-form.ts`：删单个模型的确认文案在条目是子代理模型时追加 “Subagents will follow the chat's model.”。原本在 `ModelEditor.tsx` 里的 `reasoningValue`、`thinkingOptions`、`reasoningFrom` 挪到这里导出，编辑器和子代理行共用同一套档位规则。
- `settings.css`：这一行的下拉框间距和最大宽度；手机宽度下控件换到下一行并占满宽度，文字放不下时两个下拉框各占一行，不截断。

### 与 02 的差异

| 位置 | 02 的写法 | 实际做法 | 评价 |
|---|---|---|---|
| 控件形式 | 点击这一行打开菜单，菜单里先选模型、再选档位，当前项打勾；行上显示 “模型 · 档位” | 两个原生下拉框，模型和档位各一个 | 更简单。设置页的模型编辑器和 Web search 已经用原生下拉框，样式和键盘操作现成，也不用写两级菜单的状态。下拉框本身就显示当前值，所以 T15 的 “模型 · 档位” 由两个框并排表达 |
| 档位何时可选 | 能力已识别时 | 只要条目有已知档位就显示，后台重新探测（`detecting`）期间也保留 | 必要。保存子代理模型后后端会重新探测，按 “已识别” 判断会让档位框在保存后闪没 |

### 验证结果

| 范围 | 结果 |
|---|---|
| T14 | 真实 daemon 和 integration 都通过：标题下有 Default 说明 |
| T15 | integration 用 mock 走完 “选模型 → Model default (medium) → low → Follow chat”，断言三次保存的参数。真实 daemon 上选 `glm-5.3-flash`、档位 high，`model.json` 写入 `subagentModel: { entryId: "glm", reasoning: { enabled: true, effort: "high" } }`，Default 没变；重启服务后仍显示 glm / high |
| T16 | 真实 daemon 上选 Follow chat 后档位框消失，`model.json` 里没有 `subagentModel` 字段 |
| T17 | 删单个模型和删 provider 两个确认框都有提示；删别的模型（qwen）时没有。真实删除 glm 后这一行回到 Follow chat |
| T17a | 组件测试 `SubagentModelRow.unit.test.tsx`：不完整的条目显示 “model-b (needs setup)” 并选中，“Needs setup” 按钮打开对应编辑器 |
| 真实对话 | 隔离的 `OHBABY_HOME` 里，父会话用 DeepSeek `deepseek-flash`。子代理模型设为 glm 时，数据库里子会话的请求走 `zhipu / glm-5.3-flash`；改回 Follow chat 后，子会话走 `deepseek / deepseek-flash`。阿里云端点这次从本机连不上（ECONNRESET），换成了 DeepSeek |
| 手机宽度 | 375px 下控件换行、没有横向滚动，档位文字完整显示 |
| 自动化 | 在仓库根目录运行 `vitest run apps/ohbaby-web`：88 个文件、1,045 项通过。`pnpm typecheck`、改动文件的 eslint 和 prettier 通过 |

### 注意事项

- Default 说明在 2026-11-12 的 b583f020（“trim explanatory copy”）里删过一次。这次按 00 D2 用更短的 P14 文案加回来。
- Web 不显示后端的 `model:subagent-unavailable` 和 `model:subagent-reasoning-fallback` 提示，和 04 的约定一致。

### Codex 内置浏览器复验

2026-11-20，在内置浏览器分别操作开发版 mock 和连接隔离 daemon 的编译版 Web。真实 daemon 路径使用本地 OpenAI-compatible 测试端点和临时数据库。

- T14 至 T17a 通过。默认说明、完整条目过滤、无档位模型、档位保存与刷新、跟随聊天、单条删除和按提供商删除均已实际操作。无关条目的删除确认没有子代理提示。不完整的已选条目显示 `Needs setup`，点击进入对应条目的编辑器。
- 从浏览器发送两次任务。独立配置时，父会话请求 `parent-base / medium`，子代理请求 `effort-child / high`。恢复 `Follow chat` 后，父会话和子代理都请求 `parent-base / medium`。两次对话均完成，模型库的 Default 保持为 `parent-base`。
- 复验修正了两处问题。`Model default` 现在显示模型条目保存的档位，已设 `low` 的条目显示 `Model default (low)`。640 px 下，模型与档位控件会按可用宽度换行。640 px 和 375 px 都确认设置行没有横向溢出。
- Web 自动化共 88 个文件、1,046 项通过。编译、类型检查及改动文件的 ESLint 和 Prettier 检查通过。
