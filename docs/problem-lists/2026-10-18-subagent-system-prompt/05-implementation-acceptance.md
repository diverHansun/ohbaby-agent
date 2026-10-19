# 子代理系统提示词：实施验收

> 本文保留首次本地验收的结果与当时限制。后续已完成真实浏览器、普通子会话跨进程恢复、三协议压缩和缓存用量抽测，见 [在线验收](./06-live-acceptance.md)。保存根 A／执行目录 B 的恢复专项仍未在线覆盖。

## 范围与结论

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-10-19 |
| 分支／基线 | `feat/subagent-system-prompt`／`e527285e` |
| 实现／测试提交 | `99ed2591`／`3366cdab` |
| 对照契约 | 本目录 00、02、04 的 2026-10-19 定稿 |
| 检查范围 | 用户实现的全部未提交变更，以及验收时补齐的修复、测试与现行文档 |
| 结论 | 本地实现与回归通过；S8 子会话重启专项及真实模型服从性未抽测，不能据此宣称所有场景或模型行为已验证 |

本批只交付子代理提示词调整及重复 memory 路线清理。system-reminder 尚未实施，不混入本批提交；未合并或推送。00–04 保留规划时的原始契约，不回填测试结果。

## 实际实现与规划对照

| 02 条目 | 实际实现 | 状态 |
| --- | --- | --- |
| 共用说明加载 | 主、子代理共用 custom loader；子代理保持 base → task → addon → custom | 完成 |
| 传递已有项目根 | runner → run context → lifecycle → provider；无快照 assemble／prepareTurn／compact 同样支持 projectRoot | 完成 |
| 说明范围和优先规则 | `{ scope, text }` 贯通；renderer 固定 Global → Project，项目约定优先 | 完成 |
| 删除独立 memory 注入 | 删除 composition 接线、Context 字段、serializer 追加、计量参数及无调用者的 core/memory | 完成 |
| 缓存与文档 | run system 快照保持稳定；同步现行模块文档、OHBABY 与中英文 README | 完成 |

数据结构、依赖方向和错误处理均按规划落实。没有新增 resolver、来源去重框架、依赖包或长期记忆接口。`projectRoot` 是可选字段，旧调用仍回退 `directory`；正常运行使用已存会话根。工具环境继续使用执行目录，权限配置未改。

环境与 MCP 菜单原本就通过 `buildRuntimeContext()` 附着 initiating user 的 model-context part。此次只修正文档里的旧描述，没有把它们重新塞回稳定 system，也没有提前实现提醒机制。

## 审查发现与处理

三个子代理分别检查提示词契约、项目根／memory 数据流及 SWE／测试边界；修复后交叉复核实现和新的请求测试。

| 发现 | 处理与证据 |
| --- | --- |
| 自定义 loader 逆序返回时，renderer 仍输出 Project → Global | 新增逆序断言先失败，再按 scope 固定输出；同内容逆序输入得到相同字节，原输入不变 |
| 无快照 Context 入口丢失 projectRoot | 三个入口先复现 `WORKDIR_RULE`，增加可选字段并透传后全部得到 `ROOT_RULE`；未新增根解析 |
| 只测 loader／provider，不能证明真实请求收到说明 | 新增三协议真实 composition → 主／子 run → SDK → HTTP body 捕获测试 |
| 三处测试夹具还返回 snapshot.memory | 清除旧字段；补全局路径、空文件回退及 UTF-16 上限测试 |
| 现行文档仍声称子代理不读说明、独立 MemoryLoader 在运行 | 同步模块文档；旧 memory 文档保留迁移入口，不继续描述已删除接口 |
| 复审发现 system/runtime 层混写及英文 README 漏同步 | 对齐稳定 system 与独立 runtime 文本，统一说明文件定位 |

两处实现问题都有修复前失败、修复后通过的证据。第一轮全仓测试恰好读到了 renderer 的红测阶段，因此该轮有 1 项失败；第二轮的 CLI 套件准备阶段与外部并行构建冲突，出现 SDK 声明产物暂时缺失（TS6305）。这两轮均不记为通过。停止额外并行构建后，使用冻结代码的独立重跑结果。

## 验收项证据

下表的路径均相对 `packages/ohbaby-agent/src`。分层证据共同覆盖契约，不把单元断言包装成真实模型行为。

| ID | 结果／边界 | 证据 |
| --- | --- | --- |
| S1 | 通过，共用入口 | loader 候选文件测试、provider 主／子回调测试、assembler 角色组装；真实 wire 使用项目 AGENTS 和全局 CLAUDE |
| S2 | 通过 | `custom-instruction-loader-service.unit.test.ts`：首个可用、配置子目录、显式路径、OHBABY_HOME 和旧目录回退 |
| S3 | 通过 | loader：缺失、空文件、读取失败、安全扫描；无可用说明时 renderer 返回空字符串 |
| S4 | 通过，共用 loader 边界 | loader 用中文／emoji 验证每文件 50 × 1024 个 UTF-16 编码单元；主、子不另设绕过入口 |
| S5 | 通过 | `custom.test.ts`：仅全局、范围标题、正文伪造标题、逆序输入、固定优先规则与字节稳定 |
| S6 | 通过 | `assembler.test.ts`、prompt 资产测试及真实子请求：base/task/addon/custom、无主身份和角色目录；未改工具权限 |
| S7 | 通过，分层验证 | provider 与三协议 wire 证明项目根和 nested workdir 分离；runner、run-manager、host-local-environment 既有测试覆盖执行目录及 sandbox lease。未实测远端 sandbox 或真实 Git worktree |
| S8 | 部分直接验证，其余源码核对 | 非 Git 临时项目及已有主会话再次启动采用不同入参目录的 wire 检查；AgentService／subagent-host 均使用保存的 session.projectRoot。尚未增加“进程重启恢复子会话、保存根 A 与 workdir B 不同”的专门 wire 场景 |
| S9 | 通过，分层验证 | 三协议真实文件从 V1 改为 V2：父同 run system 逐字不变，子新 run／父下一 run 读取 V2；retry 和 summary 的快照／同源契约由既有 Context、SDK 集成测试覆盖，不声称新 wire 测试触发了重试或压缩 |
| S10 | 通过 | Context 三个无快照入口回归、composition 手动 compact／usage 根目录接线核对、serializer／计量测试；真实 wire 中每份说明 marker 恰好一次 |
| S11 | 通过，请求内容证据 | `adapters/ui-runtime/custom-instructions.integration.test.ts`：OpenAI Compatible、Responses、Anthropic 各 4 次最终 HTTP 请求，真实子代理运行；网络回复使用本地 fixture |
| S12 | 通过 | `context/manager.unit.test.ts`：用户和工具原文中的 `<memory>` 留存，system 不再自动追加 |
| S13 | 通过 | 类型检查、旧字段／mock／helper 引用清理、provider 仍返回字符串；Goals 的 memory 工具类别与共享旧路径保留 |
| S14 | 通过，确定性边界 | renderer 固定规则明确用户要求、宿主权限、委派范围；已有权限回归不变。真实模型遇到冲突后是否遵守，未在线验证 |

尚未做真实模型的小任务服从性抽测，也未验证新行为的实际缓存命中率；缓存证据只覆盖请求内容稳定。重启恢复子会话的 A/B 目录场景仍是专门测试缺口，源码未发现对应错误。

## 执行记录

以下均为本地运行，不调用真实模型 API。

| 检查 | 实际结果 |
| --- | --- |
| `pnpm run typecheck` | 通过 |
| `pnpm --filter ohbaby-agent run prompt:check` | 通过 |
| `pnpm exec vitest run --reporter=dot --maxWorkers=4 --minWorkers=1` | 566 个文件通过、6 个文件跳过；6711 项通过、17 项跳过（219.53s，退出码 0），含 CLI 包构建与终端测试 |
| 三协议 custom-instructions 集成测试 | 3/3 通过；最终 HTTP body 含说明，回复由 fixture 提供 |
| project-instructions Context 集成测试 | 2/2 通过；真实文件、快照／无快照一致性及子代理说明边界 |
| `pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-agent/src/adapters/ui-runtime/subagent.e2e.test.ts --reporter=dot` | 8/8 通过；本地 scripted provider |
| `pnpm run build` | 修复后完整构建通过；测试自带的包构建另由最终全仓回归验证 |
| 本批变更 TypeScript 的 ESLint | 0 error；composition.ts 原有 7 条返回类型 warning，未新增 |
| 提交钩子的全仓 `pnpm run lint` | 0 error、122 warnings；其余告警位于本批未修改的代码，未顺带清理 |
| 本批变更 TypeScript 的 Prettier／`git diff --check` | 通过 |

新增回归最小运行命令：

```sh
pnpm exec vitest run \
  packages/ohbaby-agent/src/core/system-prompt \
  packages/ohbaby-agent/src/core/context/manager.unit.test.ts \
  packages/ohbaby-agent/src/core/context/project-instructions.integration.test.ts \
  packages/ohbaby-agent/src/adapters/ui-runtime/custom-instructions.integration.test.ts
```

## SWE 评估与维护事项

改动沿现有装配链传一个已经存在的项目根，删除重复读取路线，保留一个说明加载入口。`scope` 只用于区分全局／项目，renderer 用两种固定范围排序，没有增加通用注册器、去重状态或生命周期框架，符合这批 KISS 目标。

后续维护应保持三点：说明来源取 session projectRoot，环境取执行目录；新 run 才更新稳定 system；保留共享路径迁移和 Goals 的 memory 类别，不能按名称一并删除。权限、安全扫描及历史消息结构沿用现有实现。

主要改动入口：

- [system-prompt/assembler.ts](../../../packages/ohbaby-agent/src/core/system-prompt/assembler.ts)、[custom.ts](../../../packages/ohbaby-agent/src/core/system-prompt/layers/custom.ts)：共用加载、固定顺序与范围规则。
- [runner.ts](../../../packages/ohbaby-agent/src/core/agents/runner.ts)、[context-manager.ts](../../../packages/ohbaby-agent/src/core/context/context-manager.ts)：项目根透传与删除独立 memory 读取。
- [serializer.ts](../../../packages/ohbaby-agent/src/core/context/serializer.ts)：取消宿主自动 `<memory>` 追加。
- [custom-instructions.integration.test.ts](../../../packages/ohbaby-agent/src/adapters/ui-runtime/custom-instructions.integration.test.ts)：真实组合层和三协议请求验收。
- [system-prompt 文档](../../core/system-prompt/architecture.md)、[Context 文档](../../core/context/architecture.md)、[Memory 迁移入口](../../core/memory/architecture.md)：当前契约。
