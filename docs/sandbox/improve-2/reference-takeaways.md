# improve-2 业界参考：多根与脚本执行

improve-1 的 [reference-takeaways](../improve-1/reference-takeaways.md) 已分析过四个项目的整体
sandbox 取向。本文只聚焦 improve-2 的两个新主题：**多可信根**与**脚本/skill 执行**，记录抉择。

## 一、Claude Code / Agent skills（主要参考：skill 目录即可信根）

Claude Code 的 skills 安装在 `~/.claude/skills/<name>/`，每个 skill 可带 `scripts/`。
agent 执行 skill 脚本时，脚本位于用户主目录下、workspace 之外。

可借鉴的取向：
- **已加载 skill 的 exact baseDir 是"已声明可信"的执行位置**，不应每次执行都当成
  "访问 workspace 外目录"来反复确认。信任粒度是 skill bundle 目录本身，不是父级 skills 目录。
  这正是我们 session `TrustedRootRegistry` 的动机。
- skill 脚本仍受全局安全约束（不能读凭据、不能任意联网）——对应我们"可信根不豁免 denylist"的不变式。

我们的采纳：
| 设计点 | 采纳形式 |
|---|---|
| skill 目录作为可信执行位置 | `TrustedRootRegistry` 中加入已加载 skill 的 exact `baseDir`，保留到 session 结束 |
| 可信 ≠ 无限制 | denylist / sensitive 优先于可信根判定 |
| 脚本就地运行 | `resolveCommandContext` 预留 cwd/env 注入，让脚本能定位自身资源 |

不采纳 / 改造：
| 设计点 | 选择 | 原因 |
|---|---|---|
| 由 sandbox 自己扫描 `~/.claude/skills` | 不采纳 | sandbox 不发现 skill；根由调用方（skill 模块）传入，保持单一职责 |
| skill 专用的执行沙箱 | 不采纳（本轮） | 先用统一 bash/scheduler 链路 + 多根，避免又长出一套二次实现 |

## 二、opencode（多目录权限：external_directory 已是目录粒度）

opencode 的 [bash.ts:258-279](../../../opencode/packages/opencode/src/tool/bash.ts#L258-L279)
对 workspace 外目录发 `external_directory` ask，pattern 是 `<dir>/*`，并支持 always-allow。
它本质上是"运行期逐目录建立可信"，而不是预声明一组根。

对照我们：
- improve-1 已采纳 opencode 的 external_directory + always-allow（用户批准一个外部目录后记住）。
- improve-2 的 trusted roots 分两类，与 opencode 的运行期累积可信互补：
  - 结构可信：skill 工具成功加载后的 exact `baseDir`，不该让用户每次点。
  - 运行期可信：用户临时访问某外部目录，仍走 external_directory；只有 `always allow` 才升级为 shared root。
- 两者叠加：active skill / external-approved roots → 不问；其余外部 → opencode 式 ask + always 记忆。

我们的采纳：保留 external_directory always-allow 作为"运行期可信"，active skill exact baseDir 作为
"结构可信"，两层都写入 session `TrustedRootRegistry`，并由 bash/file tools 共同消费。

## 三、kimi-code（脚本执行：靠 permission 模式，不解析脚本路径）

kimi-code [bash.ts](../../../kimi-code/packages/agent-core/src/tools/builtin/shell/bash.ts) 不解析命令，
`python x.py` / `./run.sh` 全是字符串，靠 manual/yolo/auto 权限模式整体放行或整体询问。

对照我们：
- 我们**不走** kimi-code 的"整体模式"路线——improve-2 的 `executedScript` 让我们能对"执行哪个脚本"
  给出路径级事实，比"整条命令一起问"更精确（能区分 workspace 内脚本 vs 外部脚本）。
- 但借鉴其进程硬化（improve-1 已采纳 non-interactive env / stdin / kill chain）。

不采纳：kimi-code 的"脚本路径不可见"正是我们 improve-2 要消除的盲区（G1）。

## 四、pi（解释器/脚本作为扩展执行，配置化路径策略）

pi 的 sandbox extension 用 `@anthropic-ai/sandbox-runtime` + 配置化 `filesystem.allowWrite`/`denyRead`，
本质是把"哪些路径可访问"做成配置。

对照我们：
| 设计点 | 选择 | 原因 |
|---|---|---|
| 配置化 allowWrite/denyRead | **不在本轮**（与 improve-1 一致） | trusted roots 是 session 事实而非配置文件；配置化留后续 |
| 多路径可信清单 | **采纳思路** | `TrustedRootRegistry` 是一个动态可信路径清单，来源是 skill load / external always / workspace 初始化 |
| OS sandbox-runtime 执行 | 不采纳（本轮） | 仍是应用层；OS adapter 接口保留 |

pi 的配置 schema（`allowWrite`/`denyRead`/`denyWrite`）是未来若要把 trusted roots 配置化时的
好参考——届时可对齐其字段命名。

## 五、整体决策摘要

| 主题 | opencode | kimi-code | pi | Claude skills | improve-2 决策 |
|---|---|---|---|---|---|
| 外部目录可信 | 运行期 ask+always | 整体模式 | 配置文件 | 已加载 skill 根 | session TrustedRootRegistry：active skill exact root + external always（并存） |
| 脚本路径可见 | 部分（白名单命令） | ❌ | 委托引擎 | n/a | ✅ executedScript（解释器 + 直接执行） |
| 可信是否豁免凭据 | n/a | n/a | denyRead 优先 | 不豁免 | denylist 优先于可信根 |
| 执行环境注入 | plugin shell.env | 固定 env | 引擎管 | skill env | resolveCommandContext 通道（本轮留口） |
| 配置化 | ❌ | ❌ | ✅ | ❌ | ❌（trusted roots 走 session 事实，配置化留后续） |

## 六、刻意不借鉴的

| 想法 | 不做的原因 |
|---|---|
| sandbox 自动发现/扫描 skill 目录 | 破坏单一职责；skill 发现是 skill 模块的事 |
| 给每个 skill 一个独立 OS 沙箱进程 | 过度工程；improve-2 仍应用层，多根足够 |
| 把脚本内容做静态分析判危险 | shell/sandbox 不读脚本内容；脚本内行为靠运行期链路 + 未来 OS adapter |
| 用配置文件定义可信根（本轮） | 运行时入参更简单且足够；配置化等真有用户场景再说 |
