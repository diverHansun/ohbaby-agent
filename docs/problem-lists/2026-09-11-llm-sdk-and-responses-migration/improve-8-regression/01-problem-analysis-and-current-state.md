# 现状、问题与证据

分析基线：2026-09-17，`openai-responses-migration@135a6cda`。本轮尚未修改生产代码。下列路径均相对仓库根目录。

## 1. 用户路径与模块职责

用户从 Web/TUI 配置连接，经 SDK、REST 或 in-process backend 保存到模型配置。Runtime composition 创建 LLM client、Context、Lifecycle 和 RunManager；主代理、子代理及摘要通过这些对象请求模型。

协议、推理参数及能力校验属于后端。前端负责收集选择、显示真实状态和防止旧响应覆盖新输入。当前缺口跨越这一整条路径，只加前端按钮不足以闭环。

## 2. 问题清单

| ID  | 当前事实与证据等级                                                                                                                                   | 代码锚点                                                                                                                             | 方案 / 验收        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| P01 | 核心支持三协议，但 SDK 输入/Web wire 仍为两项；REST connect/probe 忽略显式字段后重新推断。此前真实 REST parser + fake backend 已复现。               | `packages/ohbaby-sdk/src/connect-model.ts`；`packages/ohbaby-server/src/app/create-app.ts`；`apps/ohbaby-web/src/api/daemon/wire.ts` | 02 §2；T01–T03     |
| P02 | 窗口探测与保存成功不保证推理能力已知；resolver 在生成 HTTP 前可抛错，关闭推理也不能绕过能力解析。此前本地 6 组失败与 1 组正向对照已验证。            | `packages/ohbaby-agent/src/services/interface-providers/reasoning.ts`；`config/llm/apply-active-model-config.ts`                     | 02 §3；T04–T09     |
| P03 | profile key 仅 provider+model；保存同名 Responses 时可删除原本并列的两条 profile，并留下 Chat 限定，后续解析 unknown。新增确定性复现成立。           | `packages/ohbaby-agent/src/config/llm/writer.ts`                                                                                     | 02 §2；T03         |
| P04 | connect 保存队列只串行保存；metadata await 期间新 prompt 可进入 running，随后仍写入新配置。新增确定性复现成立。                                      | `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`                                                                                 | 02 §4；T12–T15     |
| P05 | resetRuntime 会 dispose；composition dispose 会取消工具、子代理和 runs。源码已核对，不能删掉 running guard 后照旧 reset。                            | `adapters/ui-inprocess/runtime-controller.ts`；`adapters/ui-runtime/composition.ts`                                                  | 02 §4；T12–T15     |
| P06 | Run reasoning 已复制固定，AgentService 接受请求覆盖；SDK submit、REST parser、持久化 prompt submission 尚未承载该设置，Session 也没有相应 override。 | `agents/service.ts`；`runtime/run-manager/manager.ts`；`runtime/prompt-scheduler/types.ts`；`packages/ohbaby-sdk/src/client.ts`      | 02 §5；T10–T11     |
| P07 | Web 当前表单读取可覆盖本地编辑，探测/保存缺代次隔离；TUI 已有 dirty 保护与串行 latest-save，应保留。源码风险，尚未全部运行复现。                     | `apps/ohbaby-web/src/ui/App.tsx`；`packages/ohbaby-cli/src/tui/components/dialog/connect-panel.tsx`                                  | 03 §4、§5；T16–T17 |
| P08 | `/connect` 与 `/connect-search` 编辑前后同样式，无编辑光标；仅处理上下键。主 Prompt 和 queued edit 已有反色光标/编辑提示。                           | `packages/ohbaby-cli/src/tui/components/dialog/connect-panel.tsx`、`connect-search-panel.tsx`；`components/prompt/index.tsx`         | 03 §3、§4；T18–T20 |
| P09 | 窗口探测收到响应头即清除超时，随后 response.json 不在这段超时保护内；模型匹配采用的宽松策略不能直接拿来决定推理能力。                                | `packages/ohbaby-agent/src/config/llm/context-window-probe.ts`                                                                       | 02 §3；T07、T09    |
| P10 | writer 合并旧 reasoning；换成 binary/none 模型后，旧显式 effort 可能继续导致拒绝。源码风险。                                                         | `packages/ohbaby-agent/src/config/llm/writer.ts`；`services/interface-providers/reasoning.ts`                                        | 02 §3、§5；T08     |

另有 P11（源码已核对，未做运行故障注入）：`config/llm/writer.ts` 先原子写 model.json，再写密钥文件；后者失败时，接口可能报失败而模型文件已经改变。方案见 02 §4.3，验收见 T14。仅不发布内存版本不足以阻止其他 backend 从磁盘读到部分保存结果。

表中省略包前缀的路径均在 `packages/ohbaby-agent/src/` 下。

## 3. 实际元数据调查

本轮用 `.env` 中已有凭据进行了 **2 次 GET、0 次生成请求**：

- `https://zenmux.ai/api/v1/models`
- `https://zenmux.ai/api/anthropic/v1/models`

两者均 HTTP 200。三模型均返回 `capabilities.reasoning=true`，未给出支持档位、默认档位和能否关闭：

| 模型 ID                      | 返回的 context_length |
| ---------------------------- | --------------------: |
| deepseek/deepseek-v4.1-flash |               1000000 |
| openai/gpt-5.6-luna          |               1050000 |
| anthropic/claude-sonnet-5    |               1000000 |

这是当前网关元数据证据，不能推导所有协议参数均可用，也不是 E2E。脱敏快照见 [evidence/model-metadata-20260917.json](./evidence/model-metadata-20260917.json)。

官方资料：

- [OpenAI 模型查询](https://developers.openai.com/api/reference/resources/models/methods/retrieve) 返回模型基本资料，没有通用 effort 清单。
- [Anthropic Models](https://platform.claude.com/docs/en/api/models) 已包含 thinking/effort 能力结构；仍应检查字段是否存在，不能假设所有兼容网关提供完整结构。
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) 列出真实 low/high/max 及 medium→high 等兼容映射。这说明 medium 不是通用原生档位；不能把直连能力无条件套给网关。

向模型提问“你支持什么档位”的正文不是配置证据。试发某个参数成功，只能说明该请求被接受，网关仍可能忽略参数；未知能力和确定不支持必须区分。

## 4. TUI 盘点与文档差距

| 入口                                  | 是否改动                                                       |
| ------------------------------------- | -------------------------------------------------------------- |
| `/connect`、`/connect-search`         | 补编辑态、空值光标/文字提示、PgUp/PgDn；保留密钥遮罩和保存逻辑 |
| 主 Prompt、queued prompt edit         | 校准青绿视觉，保留现有 reducer、输入语义和队列编辑租约         |
| Session/Model/权限/确认/Skills 选择器 | 不是文本编辑器，保留现有交互，仅做不回归检查                   |

没有发现独立 TUI session rename 输入框，不虚构改动入口。

| 前序文档 / 设计意图                                   | 实现现状                                 | 本轮关系                                     |
| ----------------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| improve-5.5：后端 reasoning 默认开启/medium，前端另议 | resolver/Run intent 已有，产品入口没有   | 增加产品发现和选择，保留现有协议适配         |
| improve-7：运行与请求结束分离，保留工具/失败历史语义  | 已实施并合入                             | 本轮切换必须保持这些语义                     |
| 运行中禁止切模型保护                                  | 只覆盖先 running 后 save，未覆盖反向竞态 | 新交互允许提交保存，需要重新定义后端准入协调 |

## 5. 证据与未关闭的历史门禁

本地证据（位于忽略目录，不保证其他 checkout 自动携带）：

- `.ohbaby/test-evidence/improve-8/preplan/confirmed-regressions.log`：2 个定向复现成立；其余 112 项为筛选跳过，不能计入本轮通过数。
- 同目录 `profile-route.audit.test.ts`、`connect-race.audit.test.ts`：分别复现 P03、P04。实施时将最小回归用例移入正式测试位置，不能把大段复制的调查文件当最终测试组织。
- `.ohbaby/test-evidence/improve-7/post-merge-20260916/summary.json`：合入后 26 文件/811 项通过。
- `.ohbaby/test-evidence/migration-main-review-20260916/summary.json`：此前全量 3594 passed / 1 failed / 16 skipped；唯一失败为 packaging npm install 180 秒超时，单独复跑同样失败；单独 build 成功。根因尚未锁定，不能直接归咎网络。

真实百万窗口自然达到 95%、真实上游 overflow 仍是 improve-6 的未测边界。force compaction 和本轮模型切换测试都不能关闭它们。

## 6. SWE 判断

主要风险是一个全局配置变化影响多个长期对象，而不是缺少抽象层。优先复用现有字段、prompt queue、Run intent 和主题 token；把能力判断放在后端一个入口，前端只消费结果。不要为三协议建立三套产品管理接口，不引入通用动态表单框架，不为热切换贸然复制整套 Runtime。具体取舍与待定边界见 02。
