# 优化方案与改动面

> 2026-10-19 精简稿。路径相对 `packages/ohbaby-agent/src`。这是后续实施契约，当前未改业务代码。

## 1. 共用说明加载，保留角色差异

取消 `createSystemPromptProvider.build` 的子代理提前返回，让两类代理共用 `customInstructionLoader`。子代理按 base、task、addon、custom instructions 组装；主代理保留原有身份和角色目录位置。

修改 `prompts/subagents/base.md`：宿主可能提供项目／全局说明，子代理在委派范围内遵守；仍不创建更多子代理。修改源文件后重新生成 `templates.generated.ts`，通过 `prompt:check`。

## 2. 直接传递会话项目根

`agents/subagent-host.ts:1001` 用父会话 `projectRoot` 创建子会话，`:1564` 又传给 agent instance。`core/agents/runner.ts:210-215` 当前只把执行目录传入 run，丢掉了这两种目录的区别。

从 runner 经 run context、lifecycle、Context 到 provider 透传 `projectRoot`；已有 `directory` 继续表示执行目录。说明加载使用 `projectRoot`，环境检测使用 `directory`。恢复运行从已有 session 取得项目根；手动压缩、用量预览等入口同样使用该 session 的根，不从子代理 workdir 猜测。

不增加 resolver 或新的 Git 发现接线。已有会话如何确定根目录仍由会话模块负责，包括显式目录、非 Git 项目和 worktree 边界；本改动只使用其结果。子代理在其他工作目录执行不会自动换一套项目说明。

## 3. 保留现有文件规则，明确说明范围

| 范围 | 候选顺序 |
| --- | --- |
| 项目 | 会话项目根中的 OHBABY → AGENTS → CLAUDE；再回退项目 `.ohbaby/`、`.ohbaby-agent/` 同名候选 |
| 全局 | `resolveOhbabyHome()` 同名候选，默认 `~/.ohbaby/` 且支持 `OHBABY_HOME`；再回退旧 `~/.ohbaby-agent/`，最后既有 XDG／APPDATA 旧 OHBABY 路径 |

每个范围只选首个可用文件；没有、为空或普通读取失败则继续回退，无可用文件则跳过，不新增警告或启动阻断。保留显式路径选项、安全扫描和每文件 50K 字符限制，不扩展祖先合并或子目录覆盖。

说明项使用 `CustomInstruction { scope: "project" | "global"; text: string }`，贯通 loader、注入回调、assemble 与 renderer。范围来自读取分支，不能从数组位置或正文猜测。最终 `build` 仍返回字符串。

renderer 按 scope 固定先渲染 Global、后渲染 Project，不依赖 loader 返回的数组顺序；显示对应标题，文件正文外的固定规则写明：全局作为默认，项目具体约定优先；用户当前明确要求、宿主权限和委派边界仍优先。无说明时不生成空包装。仅有全局说明也不能标成项目说明。

## 4. 删除独立 memory 注入

说明入口已经覆盖生产 MemoryLoader 的项目／全局文件范围。保留两条加载路线再去重没有必要。

- 取消 composition 的 `createMemoryLoader()` 接线；Context 的 run 快照和无快照 assemble 都不再读 memory。
- 移除 `MemoryReader`、Context options／assembled context／prompt snapshot 的 memory 字段、serializer 的自动 `<memory>` 追加，以及用量重建、压缩重建中的对应参数。
- 清理失去调用者的 helper 转导出、Memory 专属告警名称分支和测试 mock。若旧 `core/memory` 实现已无调用方，删除其专属实现与测试；共享路径、安全扫描、旧文件迁移和 Goals 的 `ToolCategory: "memory"` 保留。
- 不新增 `{ text, sources }`、`instructionSources`、`excludePaths`。不删除用户或工具历史里字面上的 `<memory>` 文本，不移动用户文件。

## 5. 缓存与改动面

同一 run 继续使用固定 systemPrompt；重试与自动摘要沿用已有 prepared 请求。正常运行、无快照 assemble、手动压缩、用量预览只使用同一说明入口。移除重复 memory 会改变新请求的 system 前缀，这是此次行为修正的一次变化，不为维持旧缓存保留重复内容。

主要改动集中在五处：

1. assembler／custom loader／custom renderer：共用加载、明确范围与优先规则。
2. runner → run context → lifecycle → Context／provider：传递已有项目根，覆盖恢复和无快照入口。
3. 子代理 base 文案与生成资产。
4. composition、Context、serializer、用量计算：移除 memory 路线及无用接口。
5. 相关测试与现行模块文档：同步说明定位，保留既有压缩与权限行为。

先按 [04](./04-test-and-acceptance.md) 独立验收，再实施提醒。说明文件不注册 reminder provider；本批不做长期记忆、角色专属裁剪、权限或压缩算法改造。
