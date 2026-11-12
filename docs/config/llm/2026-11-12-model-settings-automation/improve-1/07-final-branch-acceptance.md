# 分支最终验收

日期：2026-11-12。用户授权本分支全量检查、独立子代理与 Pi 审查，通过后合并 main、推送远程并删除本地功能分支。

审查基线是 `b8d5fc67a0bf61a62a398bcd511b2aef670c4621`；本轮起点为 `e501a48f`，最终代码及新增回归提交为 `f4a6eb66`。审查范围是两者间完整 diff，加上本页记录的两处边界修复。先前 05、06 的结果保留为历史记录，本页使用重新执行的结果。

## Standards

独立子代理发现 1 项可复现 P2：同路由重复刷新时，旧任务的写回已进入配置锁队列，新任务取消它却不改变配置 generation，因此旧结果仍可能落盘。修复给内部写回条件传递现有任务的 `AbortSignal`，在持锁后读取配置前及读取后拒绝取消任务。没有增加持久化、SDK 或 UI 字段，也没有增加全局代际机制。

新增 `model-entry-refresh-race.integration.test.ts` 分别覆盖 context 与 reasoning 写回，先红后绿。测试用 deferred 控制锁与请求顺序，断言文件原文、用户偏好、通知和新任务终态，未用 sleep 猜时序。相关 4 文件、23 项测试通过；另一位 Spec 审查员独立复核并重跑新增 2 项测试，通过。

字段职责与依赖检查：覆盖、检测证据、有效预算保持分工；投影不把存储溯源字段传给模型客户端；SDK 保持 DTO 边界，未新增跨包运行时依赖环。既有 writer/discovery/index 模块内部相互引用和较长的 discovery 函数是可维护性议题，没有仅为缩短函数增加抽象。

## Spec

独立子代理发现 1 项 P2：独立 draft probe 在配置了不存在的 API key 变量时仍会用占位凭证请求。现在直接返回 `missing-credential`，不发网络请求；保留用户 context 或默认兜底，未指定凭证变量的 keyless 端点仍可探测。两个缺凭证用例先红后绿，加上 keyless 正例；所在测试文件 32 项通过。

另有 1 项文档口径问题：生产默认值集中定义不要求 Web mock 引入后端运行时包。02 已明确 fixture 字面量例外，避免为了消除测试数据重复制造依赖倒置。04 增加 T36、T37，分别将缺凭证与排队写回场景落入验收契约。

Defaults、版本迁移、null 清空、保存后自动发现、无等待新 run、Responses max、Anthropic minimal 清理与通知，均保持本轮已批准契约。输出截断后的自动接续仍不在本分支范围。

## 前端与视觉

独立前端子代理检查完整 Web/TUI diff，运行 8 文件、106 项测试，全部通过。检查了数字范围和标签关联、草稿保留、null patch、自动探测终态、发送保护与 Stop、主题变量使用；测试中有 React act 警告，不影响退出结果。

主代理使用内置浏览器，连接构建后的真实 daemon/Web 产物和隔离模型库，使用本地模拟上游。没有读取或复制真实 API key，也没有修改用户实际运行中的模型库。

| 实际操作 | 观察结果 |
| --- | --- |
| 390px 宽度打开模型列表 | 模型名称、Check settings、Default 和菜单按钮完整可见 |
| 小 context 模型打开设置，输入输出上限 -1 | 保留输入原文，显示正整数错误，Save 禁用；底部操作可达 |
| 改为 4096 并保存 | 模型列表预算问题标记消失 |
| 桌面 1280×900 打开模型高级选项 | 空白 Auto 输入、检测值与操作按钮布局正常；没有把 300000 填入表单 |
| 点击 Detect again，使用延迟响应上游 | Context/Reasoning 两处动效可见，原有 effort 保留；响应后动效结束 |

四张新截图由前端审查员逐张查看，无阻止合并的视觉缺陷。截图保存在本地忽略目录 `.ohbaby/model-settings-implementation/`：`final-mobile-models.jpg`、`final-mobile-settings-error.jpg`、`final-desktop-settings.jpg`、`final-desktop-detecting.jpg`。本次没有做暗色主题或屏幕阅读器人工验收；先前 composer 的 Enter/草稿/修正后恢复流程见 06。

## 全量自动化与真实请求

最终修复后的 `pnpm preflight` 退出码 0，顺序执行 format:check、lint、typecheck、test、build，日志 `/tmp/model-settings-merge-preflight.log`：

- 698 个测试文件通过、6 个跳过；8132 项测试通过、17 项跳过，测试耗时 216.51 秒。
- 格式、类型检查、所有包和 Web/CLI 构建通过。
- Lint 为 0 errors、125 warnings；构建保留大于 500kB chunk 提示。没有把“检查通过”写成“零警告”，也没有为了本议题扩大成全仓警告清理。

按 `tests/models-4-tests.md` 重新运行 18 条真实路由探测，实际完成 18 条：17 条识别 reasoning；Zenmux DeepSeek Responses 对非法档位也返回成功，按契约保留 unknown/ignored-reasoning。共 132 个 POST，每路由最多 8 个，确认 D12 移除备用 wire 后的上限。Context 从 metadata 识别出 10/18；其余没有可用容量字段或 metadata 接口不可用，使用后端兜底并保持表单检测值未知，不将兜底冒充实测容量。

另外通过产品客户端执行三种协议的真实流式 noop 工具调用，三项均通过：

| 路由 | 正式请求参数 | 结果 |
| --- | --- | --- |
| 智谱 Chat | max_tokens=32768，reasoning_effort=high | 收到 noop，正常 tool_calls 终态 |
| Zenmux Luna Responses | max_output_tokens=32768，reasoning.effort=max | 收到 noop，正常 tool_calls 终态 |
| Zenmux Sonnet Anthropic | max_tokens=32768，adaptive，effort=high | 收到 noop，正常 tool_calls 终态 |

脱敏结果在本地忽略目录 `final-real-probe-results.json`、`final-real-stream-results.json`；日志 `/tmp/model-settings-final-real-probe.log`、`/tmp/model-settings-final-real-stream.log`。本轮真实请求验证不等同于对所有供应商真实容量或参数语义作保证，也不宣称重新执行了全部主子代理长会话场景。

## Pi 复核

使用 `calling-pi-agent`，模型 `anthropic/claude-opus-5-5`、thinking `xhigh`，项目根目录启动，会话 `codex-model-settings-final-review-20261112`。本轮实际返回完整审核正文，已原样展示给用户；与 06 的历史 429 请求分开记录。

首轮 Pi 检查了工艺、SWE、模块依赖、字段、协议和前端代码，未发现可复现合并阻塞。它未自行运行全量测试或浏览器；其前端委派中途停止后，父 Pi 自行完成代码审查。

同一会话第二轮已核实两处新修复与四张新截图，返回“两处修复都正确，没有发现阻塞合并的问题”。Pi 对桌面截图只确认了布局，指出图片文字细节不够清晰；没有验证暗色主题、手机更多菜单或重新运行真实端点。其结论作为独立审查意见，测试与浏览器事实仍以主代理执行记录为准。日志 `/tmp/model-settings-final-pi-followup.log`，请求退出码 0。临时 `.pi` 委派产物从 Git 工作区移到本地忽略目录保留，不纳入提交。

首轮非阻塞建议包括：context usage 查询复用运行预算校验、unknown 能力真实保存会再次付费探测、内部 reason 命名、进程内 notice 清理、冗余 input type 参数、TUI 原因码文案、Goal 独立入口的前端预算提示。这些没有足够证据成为本次配置功能的合并阻塞；继续保留后端校验，不在收尾阶段扩大为运行生命周期或全局调度重构。D12 最终验证缺失已由本页补齐。

## 集成记录

合并前已重新 fetch，`main` 与 `origin/main` 均为审查基线，且是功能分支祖先。代码与新增回归已一同提交 `f4a6eb66`，提交钩子 lint/typecheck 通过；文档按职责单独提交。临时验收服务器已停止，本轮 Pi 临时文件已移出待提交范围，无关 `.pi` 历史文件与 worktree 保留。

本页记录合并前验收通过的代码。集成按 fast-forward 合并，再对 main 执行全仓测试后普通推送；不 force push。实际合并后测试、远程 SHA 核对与本地分支删除结果以本次交付回执为准。
