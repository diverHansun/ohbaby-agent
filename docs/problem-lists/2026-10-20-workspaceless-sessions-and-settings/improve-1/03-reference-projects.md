# 3. 参考项目借鉴

> 2026-10-20 至 2026-10-21 核对本地 `code-cli/` 下的项目与已安装 Codex 桌面资源。以下区分具体产品入口，不把 TUI、开发者工具和桌面端混为一谈。参考项目帮助判断取舍，ohbaby 最终规则以 [00](00-discussion.md) 为准。

## 3.1 参考范围与证据

| 来源 | 本轮用途与限制 |
|---|---|
| 用户提供的 Codex 截图 | 确认会话菜单有 Project 和“从当前项目移出”入口；截图本身不能证明工作目录如何变化 |
| 已安装 Codex 桌面资源 | 核对项目归属、待生效目录与请求发起流程；对应当前安装版本，不代表所有历史版本 |
| 本地 `codex`（`12cca49c81`） | 核对公开协议、项目归属测试、正文搜索；桌面标题搜索另看桌面资源 |
| 本地 `ZCode`（`aac4755666d0`） | 核对默认目录、设置、当前 Command Center 会话搜索 |
| 本地 `deepseek-harness`、`kimi-code`、`opencode` | 核对会话目录、移动与不同搜索入口 |
| 本地 `pi`（`7d75a0e3eb27`）、`frontend/pi-web`（`7c0778a8bc73`） | 分别核对 TUI 与 Web；二者搜索规则不同 |
| [pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop) | 用户指定的界面参考；本地 `frontend/pi-web` 并非同一仓库版本，不能直接用它证明原项目的具体实现 |

旧稿把多个项目概括为“没有真正移动会话”，证据不足，本次撤回。也不再用某个 CLI 的目录限制推断对应桌面产品不支持无项目会话。

## 3.2 项目归属与目录切换

| 项目或入口 | 核实到的做法 | ohbaby 的取舍 |
|---|---|---|
| Codex 桌面 | 项目归属与执行目录分别处理；移出可保留原目录。换项目记录下一轮目录，正在运行时仍可操作 | 采用立即变更归属、当前轮原目录、下一轮目标目录；移出保留目录 |
| Codex 公开协议 | 项目元数据与 cwd 分开；测试包含同一会话的项目重分配和清除 | 保留会话 ID、消息和运行历史，不通过复制代替移动 |
| OpenCode | 已有同会话移动流程；可在执行步骤边界切换实例继续 | 说明实际移动可行，但不照搬步骤中途切换，ohbaby 采用下一轮生效 |
| DeepSeek Harness | 初始工作区与有效 cwd 有区分，有工作目录变更能力；跨原始工作区的关联另有限制 | 不把“关联限制”误读成所有目录都永远固定 |
| ZCode | 使用真实默认工作区承接无项目任务；可调整分组，未据此确认同会话执行目录迁移 | 借鉴默认目录与分组，移动语义以本轮确认规则为准 |
| Pi / Pi Web | fork 会创建新会话；部分恢复入口允许 cwd 覆盖，但不能等同于桌面菜单的同会话移动 | 不用 fork 实现本轮的 Project 菜单 |

主要代码锚点（均相对于各仓库）：

- Codex：`codex-rs/app-server-protocol/src/protocol/v2/thread.rs` 中的项目元数据与续聊 cwd；项目测试包含重新分配、清空归属。已安装资源为 `/Applications/ChatGPT.app/Contents/Resources/app.asar`，目录状态区分已应用与待应用目标，发送准备阶段应用后者。
- OpenCode：会话移动 handler、`session/move`、执行 runner 与会话投影共同完成迁移，不能只看 UI 菜单下结论。
- DeepSeek Harness：`session/working-directory/src/index.ts`、`workspace/workspace/src/entity.ts`，分别处理有效目录与工作区关联约束。
- Pi：`session-manager.ts` 的 `forkFrom` 创建新 ID；这与本轮的原会话移动不同。

## 3.3 搜索规则对比

| 项目 / 入口 | 实际规则 | 借鉴或不采用的部分 |
|---|---|---|
| Codex 正文搜索 | 对用户、助手文本做不区分大小写的字面查询，按消息提取片段；整个输入作为查询文本 | 借鉴正文范围和片段，不照搬整句匹配 |
| Codex 桌面标题搜索 | 与正文搜索不是同一种算法，包含按顺序的模糊匹配；标题命中优先，后续还比较分数与时间 | 借鉴标题优先；ohbaby 标题与正文统一，不引入模糊评分 |
| DeepSeek Harness 标题 / 正文 | 标题按子串；正文使用 SQLite FTS 短语查询，分词会影响中文和标点 | 不采用两套规则，也不把 FTS 短语当成空格关键词 AND |
| ZCode 当前会话搜索 | Command Center 调任务索引，标题和拼接正文使用 `LIKE` 查询；输入空格不自动变成 AND | 借鉴统一搜索入口；不沿用正文截断或固定候选数量，也不把 `%`、`_` 当用户通配符 |
| Kimi TUI 会话选择 | 主要搜标题或 ID，关键词内允许按顺序跳字匹配 | 不适合作为本轮正文搜索依据 |
| Kimi Inspect | 开发者检查工具，默认支持多词 AND，标题与单条消息分别索引；中英文有专门分词 | 借鉴同一标题/消息内全部命中的思路；不宣称这是 Kimi 主 Web 的规则，不照搬分词与截断 |
| Pi TUI | 可把标题、ID、消息、cwd 等合并查询；支持模糊词、短语和正则 | 功能多于本轮需要，且可能跨消息命中，不采用 |
| Pi Web | 标题和用户/助手正文做不区分大小写的整段子串查询，有片段和消息定位；扫描有文件数等上限 | 借鉴结果展示，不采用固定历史扫描上限 |

搜索代码锚点：

- Codex：`codex-rs/rollout/src/search.rs`，可见消息筛选与字面搜索；桌面 Command Menu 的标题匹配另在打包资源中。
- DeepSeek Harness：`ui-workspace/tree` 的标题匹配，以及搜索模块 `query`、`schema`、`docs` 中的 FTS 查询与消息索引。
- ZCode：`packages/ui/src/command-center/CommandCenterDialog.tsx` → `taskIndexRepo.ts` → `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts`。旧 `TaskSearchDialog` 已不是当前入口，不能拿它的条数限制描述现状。
- Kimi Inspect：`apps/kimi-inspect/src/components/SearchView.tsx` → `searchService.ts` → `minidb/text-index`。Kimi TUI 的选择列表是另一条链路。
- Pi Web：`lib/session-search.ts`；Pi TUI：`session-selector-search.ts`。

ohbaby 采用的组合是：空白分词、每词连续字面匹配、同一标题或同一消息内全部命中、英文忽略大小写、标题命中优先、组内更新时间倒序。这是结合使用需求后确定的规则，并非完整复刻某个项目。

## 3.4 设置与 Web 布局

界面参考用于确定几件事：新会话入口不要求先打开目录，输入框可以选项目，侧栏按项目组织会话，设置有独立入口。具体视觉与组件设计在相应批次的 Web 页面开工前补充。

ohbaby 已有自己的配置文件、MCP 管理器和模型保存入口。第一版将这些能力汇总展示，MCP 列表同时提供状态、失败原因、已加载工具数与工具名称；不为靠近参考产品而复制一套配置系统。

模型页按当前能力只维护一套活跃连接。保存多套 provider 配置是明确的后续需求，本轮不提前引入配置库。项目级配置只读，来源标签有真实数据才显示。

## 3.5 对方案的影响

- 保留固定默认工作区，但不再把“无项目”与“默认目录”画等号。
- 用同一会话的归属调整与下一轮目录切换，替代旧稿中的复制方案。
- 搜索统一标题和正文规则，不照搬参考项目各自的分词、模糊算法或历史条数上限。
- 只借鉴当前需要的页面结构和能力，保持现有工具权限，不增加单独的 Chat 模式。
