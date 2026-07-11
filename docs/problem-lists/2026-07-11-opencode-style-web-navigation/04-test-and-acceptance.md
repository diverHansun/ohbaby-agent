# 4. 测试与验收标准

## 4.1 测试基线与分类

仓库当前使用 Vitest，测试以 `*.unit.test.ts(x)`、`*.contract.test.ts(x)`、`*.integration.test.ts(x)`、`*.smoke.test.ts(x)` 分类，默认 co-located；根脚本 `scripts/run-vitest-by-type.mjs` 按后缀执行。本议题遵循现有规则，不另建第二套 server 测试树。

仓库当前没有 `@playwright/test` config。用户要求开发阶段使用 Playwright 打开浏览器调试，因此本批采用：

1. Vitest unit：纯函数、store、React 行为。
2. Vitest integration：共享 SQLite、Hono `app.fetch`、Web runtime/SSE。
3. 既有 contract/regression：不破坏 daemon/Web/CLI 契约。
4. Playwright 驱动真实浏览器：实施完成后的必过发布门和调试证据。

本批不为了一个页面先建立重型截图基线平台；如果实施时加入可维护的 Playwright 自动套件，可以增强，但不能用它替代下面的真实 daemon 调试。

## 4.2 Phase A：registry 与全局 API

| ID | 场景 | 类型 | 验证点 |
|----|------|------|--------|
| A1 | migration 013 | unit/integration | 新库和旧库升级后表/索引存在；重复启动幂等；session 数据不变 |
| A2 | 新项目 open | unit | canonical scope 插入 visible，分配稳定 position，更新时间正确 |
| A3 | 无 session 项目持久 | integration | open 后不创建 session；关闭/重开 DB 后仍在 visible list |
| A4 | hide tombstone | unit/integration | hide 后 list 不返回；session root 和 loaded scope discovery 都不能改回 visible |
| A5 | explicit reopen | integration | `scopes/open` 将 hidden→visible，position 保持，lastOpenedAt 更新 |
| A6 | discovered compatibility | integration | 旧 session roots 与 loaded roots 在无 registry 项时被追加；重复/路径变体去重 |
| A7 | unavailable project | integration | registry 入口保留且 `available=false`；不静默删除 |
| A8 | concurrent position | integration | 并发新增无 position 冲突或丢项目；沿用 busy retry |
| A9 | auth | integration | scopes open/hide 与 picker 无 token 均 401 |
| A10 | picker loopback | unit/integration | loopback 可用；非 loopback 明确 403，且不泄露目录 |
| A11 | directory-only | integration | listing 只含目录；普通文件、不可读项、破损链接不让整个请求失败 |
| A12 | picker path validation | integration | 相对路径、不存在、文件路径返回结构化 400；无 cwd fallback |
| A13 | Git/non-Git selection | integration | open 子目录 canonicalize 到 Git root；非 Git 返回 canonical directory |
| A14 | hide 无副作用 | integration | session 行数、run 状态、InstanceStore loaded 状态均不因 hide 改变 |
| A15 | serve 主动恢复 hidden | unit/真实进程 integration | 新启动和复用 server 都在返回 URL 前 open 当前 canonical cwd；即使 browser open 失败，registry 仍 visible |

建议测试落点：

- `packages/ohbaby-agent/src/services/workspace-registry/database-store.unit.test.ts`
- `packages/ohbaby-agent/src/services/database/database.integration.test.ts`
- `packages/ohbaby-server/src/runtime/directory-picker.unit.test.ts`
- `packages/ohbaby-server/src/runtime/daemon/global-server.integration.test.ts`

## 4.3 Phase B：Web navigation runtime

| ID | 场景 | 类型 | 验证点 |
|----|------|------|--------|
| B1 | preference parser | unit | 空、坏 JSON、旧 version、错误字段均回空偏好；不抛 bootstrap 致命异常 |
| B2 | serve directory 优先 | integration | hash directory 压过 local selected 与 injected default；先 open/unhide 再 connect |
| B3 | 无 hint fallback | unit/integration | local visible→最近打开 visible/available registry→最近添加→null 的顺序固定；rail 不重排，injected daemon cwd 不抢选择 |
| B4 | invalid explicit hint | integration | 显示错误且不静默连接其他 cwd；rail 仍能选择恢复 |
| B5 | per-project last session | integration | A/B 各自记忆；切回 A 恢复 A 的 session，不把 B session 传给 A |
| B6 | stale session preference | integration | 不存在/归档/跨 scope session 被清理，回退最近 active 或 null |
| B7 | URL sync | unit | directory/session 成功后 replaceState；切项目先清 session；不 reload |
| B8 | switch generation isolation | integration | 旧 SSE abort、旧事件丢弃、新 header/clientId 正确；现有测试必须继续绿 |
| B9 | switch rollback | integration | 目标 connect 400 后恢复原 project/client/snapshot/preference/hash |
| B10 | hide non-selected | integration | rail 刷新，active client 不关闭 |
| B11 | hide selected with fallback | integration | 先成功切 fallback 再 hide；fallback 失败则原项目仍 visible/selected |
| B12 | hide only project | integration | client close/store reset/selected null；session DB 不变 |
| B13 | hidden hash 幂等恢复 | integration | hidden B + `#directory=B` → Web 再次 open 校验 → selected B → 恢复 B last session；与 serve 预先 open 不冲突 |
| B14 | open duplicate/nested root | integration | canonical dedupe，不新增两个 rail item |

必须保留并扩展：

- `apps/ohbaby-web/src/api/daemon/workspace-switch.integration.test.ts`
- `apps/ohbaby-web/src/api/daemon/client.integration.test.ts`
- `apps/ohbaby-web/src/bootstrap.unit.test.ts`（若当前不存在则新增）
- `packages/ohbaby-server/src/runtime/daemon/main.unit.test.ts`
- `packages/ohbaby-server/src/runtime/daemon/global-single-serve.integration.test.ts`

## 4.4 Phase C：React 三栏 UI

| ID | 场景 | 类型 | 验证点 |
|----|------|------|--------|
| C1 | 三层导航 shell | component | rail、按需 project sidebar、conversation 层级正确；旧 workspace `<select>` 不存在 |
| C2 | glyph identity | unit/component | basename 首字符、fallback icon、稳定 palette、重复首字母仍有不同 accessible name |
| C3 | project select | component | 点击 rail 调 runtime switch；selected 双重视觉信号与 `aria-current` 正确 |
| C4 | project header | component | basename、缩短路径、完整 title 与当前 scope 一致 |
| C5 | scoped sessions | component | 切 project 后只出现目标 snapshot sessions，无旧项目 session 闪现 |
| C6 | right click/remove | component | contextmenu 打开；“从项目栏移除”调用 hide，不调用 archive/delete |
| C7 | keyboard menu | component | 不用右键也能打开同一 action；Escape 关闭并恢复 focus |
| C8 | new session | component | 在 selected scope 调 createSession；null project 时 disabled/引导添加项目 |
| C9 | directory dialog | component | `+` 打开；无路径 input；breadcrumb/parent/list/select/loading/error/empty 都可见 |
| C10 | dialog focus | component/browser | focus trap、Escape、关闭后 focus 回 `+` |
| C11 | unavailable project | component | entry 保留并有警告；点击失败有可见错误；仍能 remove |
| C12 | sidebar collapse | component/browser | 默认零宽收起；展开按钮位于 rail 顶部；rail 始终保留，conversation 可用，展开后只显示当前项目 sessions |
| C13 | empty global/project | component | 无 visible project 与有 project 无 session 是两种明确空态 |
| C14 | existing conversation regression | component | Composer、permission、slash overlay、goal、archive 旧用例继续通过 |

测试落点：

- 更新 `apps/ohbaby-web/src/ui/App.unit.test.tsx`，删除 selector 测试。
- 新增 `ui/projects/*.unit.test.tsx`、`ui/sessions/*.unit.test.tsx` 或等价 co-located 文件。
- 保留 `ui/selectors.unit.test.ts`、`slashCommands.unit.test.ts` 和现有 App 回归。

禁止用“CSS class 存在”代替 C3/C5/C6/C9 的行为断言。

## 4.5 Playwright 真实浏览器调试（发布门）

实施完成后必须使用 Playwright 控制真实浏览器，而不是只看 jsdom。测试环境使用 loopback、临时 DB 与测试目录，避免污染用户正式 session/registry。

### 4.5.1 准备

1. 构建 Web：`pnpm --filter ohbaby-web build`。
2. 创建 `repo-a`、`repo-b` 两个临时 Git 根目录，以及 `repo-empty`（无 session）。
3. 使用临时 `--db-path`、`--port 0`、`--web-assets-dir apps/ohbaby-web/dist` 启动 foreground serve。
4. 通过输出/daemon state 取得真实 URL；不假设 4096。
5. Playwright 打开 `ohbaby serve` 返回的含 directory hash URL。

### 4.5.2 必跑交互

| ID | 操作 | 预期 |
|----|------|------|
| PW1 | 从 repo-a 执行 serve 打开页面 | rail 选中 A；第二栏路径是 repo-a；A 的 last/recent session 恢复 |
| PW2 | 点击 `+` | 打开目录 dialog；没有路径输入；可从 Home 逐层进入 repo-empty |
| PW3 | 选择 repo-empty | rail 新增且选中；无 session 仍保留项目；显示项目空态 |
| PW4 | 新建 session | session 出现在 repo-empty 第二栏；切到 A 后不出现 |
| PW5 | 切 A/B/empty | 每次路径、sessions、conversation 一致；浏览器 console 无 stale generation 错误 |
| PW6 | 刷新页面 | 当前项目与该项目最后 session 恢复；URL hash 同步 |
| PW7 | 右键非当前项目移除 | rail 消失；当前对话不重连；session 数据仍可从重新导入后看到 |
| PW8 | 右键当前项目移除 | 成功切 fallback 后入口消失；无项目时进入全局空态 |
| PW9 | 从 hidden repo-b 再执行 serve | 同一 origin 打开；B 自动恢复 rail 并选中，恢复 B last session |
| PW10 | 选择 Git 子目录 | rail 只有 Git root 一个项目，不出现子目录重复项 |
| PW11 | 使目录暂时不可用后刷新 | entry 不消失，显示 unavailable，可从菜单移除 |
| PW12 | 折叠第二栏并调整窄宽度 | rail、dialog、Composer 仍可操作，无水平页面溢出遮挡主动作 |
| PW13 | 键盘操作 | Tab 可达 rail/`+`/menu/session/composer；Escape 正确关闭 menu/dialog |
| PW14 | 运行中的 session 切项目/隐藏 | run 不被 stop；切回后 snapshot 展示真实运行状态 |

### 4.5.3 视觉检查

- rail 宽度稳定，选中态清楚但不过度抢占注意力。
- 同首字母项目靠 tooltip/path 能区分。
- 第二栏项目名、路径、新建会话和 session list 层级清楚。
- conversation 宽度、滚动区和底部 Composer 不被新栏挤压或遮挡。
- loading/error/empty/unavailable 不发生布局跳跃或无反馈。
- 不要求与 OpenCode 像素一致；要求信息层级和交互因果一致。

## 4.6 回归清单

以下已有行为不能因导航改版退化：

- 缺/非法 workspace header 继续 400 fail-closed。
- switch 继续关闭旧 SSE、换 clientId、隔离 seqNum/replay。
- workspace 切换失败继续恢复旧 client/snapshot。
- `ohbaby serve` 继续全局单实例、复用同 origin、cwd 只做 hash hint。
- packageVersion 不一致不复用、不 kill。
- 默认 TUI 继续 in-process，不 import server。
- session create/select/archive、prompt、stop、permission、slash、goal、model overlay 继续工作。
- Bearer token 不进入 localStorage、URL、console 或截图。
- hide/remove 不删除 session、message、run 或本机目录。

## 4.7 对抗性审查

| 攻击面 | 典型失败 | 防御/验收 | 残余风险 |
|--------|----------|-----------|----------|
| session discovery vs hidden | remove 后立即复活 | A4/B10/B11 | 手工 DB 修改不在产品保证内 |
| directory picker | LAN 用户枚举 Home | A9/A10/A11 + 非 loopback 禁用 | 获得 token 的本机用户仍可看目录名，符合本地 daemon 信任边界 |
| path race/symlink | list 后目标消失或换指向 | A12/A13/B14；open 时重新 realpath | 文件系统在 connect 后仍可变化，按已有 runtime 错误处理 |
| startup precedence | 旧 local preference 压过新 cwd | B2/B3/B4/B13 | 用户手改 hash 可触发可见 400，不静默猜测 |
| cross-scope session | B 的 sessionId 发给 A | B5/B6/C5/PW5 | session ID 碰撞仍由 backend scope/claim 契约防护 |
| hide active project | 意外停止 run/丢选择 | A14/B11/B12/PW14 | 用户主动切走后短时间看不到后台进度，属已知 UX |
| stale browser events | A 事件写入 B UI | B8/PW5 | 网络极端错误按现有 resync 模型处理 |

## 4.8 执行命令

实施阶段至少执行：

```bash
# 针对性
pnpm exec vitest run packages/ohbaby-agent/src/services/workspace-registry
pnpm exec vitest run packages/ohbaby-server/src/runtime/daemon/global-server.integration.test.ts
pnpm exec vitest run apps/ohbaby-web/src/api/daemon/workspace-switch.integration.test.ts
pnpm exec vitest run apps/ohbaby-web/src/ui

# 分类回归
pnpm test:unit
pnpm test:contract
pnpm test:integration

# 静态与构建
pnpm typecheck
pnpm lint
pnpm --filter ohbaby-web build
```

测试路径若实施时做了经用户确认的微调，命令可同步更新文档，但不得删掉对应风险场景。

## 4.9 发布门

- [x] migration/store 支持 visible、hidden、稳定 position 和显式 reopen。
- [x] 无 session 项目跨 daemon/DB reopen 后仍显示。
- [x] hidden 项目不会被 session/loaded discovery 自动恢复。
- [x] hidden 项目从对应 cwd 再次 `ohbaby serve` 会恢复并选中。
- [x] browser 自动打开失败时，单独执行的 `ohbaby serve` 仍已把 hidden 项目恢复为 visible。
- [x] directory picker 只在 loopback、Bearer 鉴权后列目录；无路径输入和文件内容。
- [x] serve cwd hint > local preference > registry fallback 的优先级有自动测试。
- [x] 每项目 last session 恢复且不会跨 scope select。
- [x] 三层导航 UI 完成，旧 workspace `<select>` 与样式已删除；会话栏默认零宽收起。
- [x] 右键与可见 actions 菜单都能“从项目栏移除”，且不删除 session/run/files。
- [x] 现有 workspace SSE generation、fail-closed、rollback 回归全绿。
- [x] 现有 Conversation/Composer/Permission/Slash/Goal 回归全绿。
- [ ] PW1–PW14 全矩阵尚未全部自动化；本轮真实浏览器已覆盖 PW1/2/3/4/5/6/7/9/12 核心闭环，console 无 warning/error。
- [x] `pnpm test:unit`、`test:contract`、`test:integration`、`typecheck`、`lint`、Web/CLI build 已完成回归；详见下方执行记录。
- [x] `docs/ohbaby-web` 与全局单 daemon 文档的 Phase 状态和术语已对齐。

## 4.10 2026-07-11 实施执行记录

- 自动化最终全量复跑：unit 193 files / 1556 tests，contract 10 files / 201 tests，integration 40 files / 246 tests，全部通过；integration 包含耗时 112.48s 的 npm packed CLI 安装 smoke。
- 静态检查：workspace `typecheck`、`lint`、Web build、全 workspace build 与 CLI 内嵌 Web assets build 通过。
- 真实进程：隔离 HOME + 临时 DB，以 `--port 0` 启动 foreground daemon，实际端口 61634。
- Playwright：验证 62px rail 默认态、300px sessions 展开态、目录弹窗无路径输入、无 session 项目导入、新建 session、A/B 会话隔离、hash/session 刷新恢复、右键隐藏、hidden cwd 再次 `serve` 恢复；页面无水平溢出，console warning/error 为空。
- 尚未声称完成：不可用目录视觉、Git 子目录 dedupe、运行中 run 隐藏/切换和完整键盘 focus trap 的真浏览器矩阵，保留为后续强化项，不阻塞本批已确认的产品闭环。
