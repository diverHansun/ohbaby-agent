# improve-3 · 实施与验收

2026-10-24。基于 `codex/redesign` 的 `c6d9be86` 实施；开工时工作区干净。本批完成会话菜单、项目隐藏和侧栏全局搜索，C1–C11 均有对应验证。

## 实施结果

- `SessionMenu` 复用已有 `Menu`，提供 Pin / Unpin、Move to project…、Export…、Archive。二级列表在原位置切换，支持右键、方向键、Enter、Escape 和焦点恢复；超过 8 个项目时提供过滤框。当前项目禁用并标记 `(current)`，未绑定项目时不显示 Remove from project。
- 移动时保留原行，显示行内 spinner，收到服务端成功响应后才更新归属。失败通过既有右上角通知显示原因。移动不替换当前客户端，不中断本轮回复或审批；下一轮沿用 improve-2 的目录切换规则。
- `ProjectMenu` 统一使用 `Menu`。Hide project 成功后一次移除项目与缓存会话行，再刷新列表；当前主区继续可用。全局列表的分页增加写入代次检查，防止旧请求把刚隐藏或归档的行补回来。
- `SidebarSearch` 使用 `useSessionSearch` 管理 250ms 防抖、AbortSignal、请求代次、分页和重试。搜索走全局接口，不限于侧栏已加载的会话；保留服务端的标题优先排序。正文片段用 React 文本节点与 `mark` 渲染，视觉上最多两行。
- Cmd/Ctrl+K 展开侧栏并聚焦搜索；重复按也会重新聚焦，保留关键词。输入法合成中的方向键、Enter、Escape 不触发搜索操作。搜索关闭后回到 Search 按钮，菜单逐层返回，不接管 composer 的 Escape。
- 归档保留既有乐观隐藏与失败回滚。同目录的其他会话也改用独立 HTTP 客户端归档，避免活动客户端归档后的历史同步影响当前对话。跨目录导出和归档继续与当前 SSE 隔离。

## 与方案的差异

搜索状态保留在 `useSessionSearch`，没有再建共享 store 切片。目前只有侧栏消费这份状态，抽到全局没有复用收益；查询并发也没有加入既有 `store.ts`。`AppController` 仅持有打开状态与聚焦请求。

开工时旧菜单已经位于 `ui/sidebar/SessionActionsMenu.tsx`，并已复用通用 `Menu`；本次直接扩展并改名，未按早期文档中的 `ui/session/` 路径重复迁移。无新增依赖，无新搜索索引、缓存层或菜单框架。

## 验收记录

| ID | 结果与证据 |
|---|---|
| C1 | runtime 集成测试覆盖空闲/运行中移动、不切换客户端和 SSE。真实 daemon 走查中，project-a 的流式回复开始后移到 project-b，原流继续收到结尾；下一轮真实 bash 工具在 project-b 生成测试文件。审批等待中再移回 project-a，原审批仍能 Allow once，当前工具继续在 project-b；下一轮工具在 project-a 生成文件。 |
| C2 | 集成测试断言移出后 `projectDirectory=null`、`workingDirectory` 保留。浏览器右键 Remove from project 后，行进入 No project，主区仍显示原 project-b 工作目录。 |
| C3 | 集成测试覆盖失败不改归属；侧栏测试覆盖等待与失败后原行保留；AppController 测试检查右上角错误原因。 |
| C4 | 600+ 会话的 search 场景中，在侧栏首批 100 条之外找到并打开 Chat 599。浏览器检查标题命中在首位，Show more results 将结果从 20 条增至 40 条。搜索测试覆盖防抖、取消、旧响应丢弃及分页。 |
| C5 | 手机尺寸下实际输入无结果关键词，出现规定文案。输入 `error` 后出现原因和 Retry，重试保留关键词；单测覆盖失败后重试成功。 |
| C6 | 菜单单测及浏览器检查方向键、Enter、Escape、焦点恢复、过滤框和二级返回。过滤框有内容时 Escape 先清空过滤，再返回一级菜单，再关闭。补充重复快捷键和 IME 的先红后绿回归。 |
| C7 | 原有 runtime 集成测试覆盖当前归档成功回草稿、失败回滚、跨目录归档/导出不切换 SSE；新增同目录其他会话隔离与分页竞态测试。真实浏览器归档当前测试会话后行消失、主区回到草稿，无成功通知。 |
| C8 | 真实浏览器检查右键菜单、隐藏、搜索快捷键、Export 二级列表；实际下载 HTML 和 JSONL，文件包含测试消息，JSONL 的 4 行均能解析。超过 8 个项目时可过滤到 sample-7，返回及 Remove from project 不被过滤。 |
| C9 | 单测与真实搜索片段检查 `<img src=x onerror=alert(1)>` 按文字显示；搜索结果区域没有 img 节点。 |
| C10 | Web 全套 56 文件 / 705 用例通过；`pnpm typecheck`、`pnpm lint`、`pnpm build` 通过，详见下表。 |
| C11 | 真实浏览器 Hide project 后 project-a 和其会话行一起消失，当前正文仍保留，通过正文关键词找到并重新打开隐藏会话。集成测试额外覆盖后续刷新失败和较早分页响应晚到的情况。 |

真实走查使用隔离的临时 profile、数据库、project-a/project-b 和本地可控模型服务，运行的是实际构建后的 daemon、HTTP 与 SSE。模型输出里的目录标签不作为证据：测试服务初版只提取了历史中首个目录；目录切换以实际 bash 生成文件的位置、请求路由和界面状态核对。未调用外部付费模型，未使用个人会话数据。

| 命令 | 结果 |
|---|---|
| 开工基线：`pnpm exec vitest run apps/ohbaby-web --maxWorkers=2 --minWorkers=1 --reporter=dot` | 54 文件 / 683 用例通过 |
| 同一命令，最终实现 | 56 文件 / 705 用例通过，新增 22 个用例 |
| 最后一次 AppController 测试 | 11 用例通过；清理了测试异步更新造成的 act 警告 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 errors，122 warnings，与开工已有警告数一致 |
| `pnpm build` | 全工作区构建成功，CLI 已复制最新 Web 产物；保留既有大于 500kB 的 chunk 提醒 |
| `git diff --check` | 通过 |

## 视觉、复核与范围

参考 pi-web 的菜单与侧栏搜索交互，沿用 improve-1/2 的黑白灰、字标、间距和轻玻璃。电脑操作检查覆盖 1280px 桌面与 390×844 手机：无横向溢出，搜索片段最多两行；手机菜单贴底、宽 390px，操作行高 48px。截图随本次交付提供，不新增仓库 evidence 目录。

代码复核发现并修复了三项问题：隐藏/归档后的旧分页回填、重复搜索快捷键不重新聚焦、IME 选字键误触发结果导航。相关回归通过，窄范围复核无未解决项。

本批复用了 improve-2 已有的会话中心运行时，并补上了运行中移动与审批的真实走查。设置页、模型菜单与手机 composer 的“更多”控制项仍属于 improve-4；本记录不替代其他批次的整体验收。

## 提交收尾

2026-10-24 按运行时、界面、文档分批提交：

| 批次 | 提交 | 内容 |
|---|---|---|
| 运行时 | `0822073a` · `feat(web): add global session moves and search` | 全局接口、缓存与分页竞态修复、独立归档客户端、集成测试及 mock 适配 |
| 界面 | `896c4fab` · `feat(web): add project menus and sidebar search` | 菜单、搜索、键盘与手机交互、UI 回归测试和预览场景 |
| 文档 | 本验收记录所在提交 | 批次状态、架构与组件文档同步、验收与提交记录 |

提交前重新运行 Web 全套测试，56 个文件、705 个用例通过。两个代码提交均通过仓库预提交钩子的 lint 和 typecheck；lint 为 0 errors、122 条既有 warnings。临时 daemon、模型服务、预览服务和验收用数据已清理。
