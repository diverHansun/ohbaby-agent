# 4. 测试与验收标准

> 实施发布门。测试分类遵循 [`docs-test/classification.md`](../../../../../docs-test/classification.md)；局部 unit 继续 colocated。本批只复用历史已存在的 colocated `client.integration.test.ts`，不新建同类错位文件；新增跨模块 integration 应放根 `tests/integration/`。Web 约定见 [`../../../test.md`](../../../test.md)。本批不新建 e2e 框架。

## 4.1 测试策略

| 层 | 负责证明 | 不能替代 |
|----|----------|----------|
| command unit | 真实 catalog alias、canonical resolve、共享 eligibility projection、`/skills` output | 浏览器交互与视觉布局 |
| Web client integration | direct `/skill` 绕过 palette 后产生 canonical POST | modal/palette DOM 行为 |
| UI component unit | canonical label、hover/keyboard/click、metadata、scroll、modifier class | CSS 实际布局 |
| style unit | 必要 selector、grid column 与 ellipsis 合同 | 浏览器计算布局/像素 |
| 真实浏览器手工 | alias 反假阳性、no-args 与有 args 两类布局、完整落入路径 | 可重复的逻辑回归 |
| typecheck | 改动包的类型完整性 | 运行时行为 |

规划前基线：`catalog.unit.test.ts`、`service.unit.test.ts`、`slashCommands.unit.test.ts`、`App.unit.test.tsx`、`styles.unit.test.ts` 共 5 个文件、148 个测试均通过。实施后必须在此基线上新增门槛，而不是用改写旧断言掩盖回归。

## 4.2 自动化场景

| ID | 场景 | 落点 | 必须断言 | Phase |
|----|------|------|----------|-------|
| A1 | 真实 catalog direct resolve `/skill` | `catalog.unit.test.ts` | `ok`；`command.id === "skills"`；invocation `path === ["skills"]`；`usedAlias === ["skill"]` | A |
| A2 | palette draft `/skill` | `slashCommands.unit.test.ts` | 仅一项，`label === "/skills"`，没有 `/skill` 第二行；completion suffix 为 `"s"` | A |
| A3 | client direct `/skill` | 既有 `client.integration.test.ts` | 不经 palette；原始 raw 为 `/skill`，POST body 为 builtin `skills` 的 canonical id/path。该测试不负责证明 UI header | A |
| A4 | builtin occupied paths | `service.unit.test.ts` / policy unit | 从真实 builtin-only catalog 枚举全部 canonical paths+aliases，逐项验证同名/大小写 skill 被拒；显式抽查 `status`、`help`、`exit/quit/q`、`mcps/mcp`、`skills/skill` | A |
| A5 | legacy 与 extra policy | `service.unit.test.ts` / policy unit | `cancel/mode/model` roots、`permission/default` 与 `permission/full-access` exact paths 保留，大小写不敏感；`permission/custom` 可通过；path `status` 或 alias `help/mcp` 的 extra 被 builtin 占用并跳过；已接受 extra path/alias 优先于同名 skill | A |
| A6 | `/mcps` alias 回归 | `catalog.unit.test.ts` | `/mcp` 仍 canonical resolve 到 `/mcps`，不被新 policy 误伤 | A |
| A7 | projection/output 一致 | `service.unit.test.ts` | provider 返回 builtin/alias/legacy/extra 冲突、大小写重复与普通 `review`；listCommands 不因 skill 冲突抛错，catalog 与 `/skills` output 只保留同一批 accepted skills；extra 自冲突仍 fail-fast | A |
| A8 | canonical header | `slashCommands.unit.test.ts` 或 `App.unit.test.tsx` | 用 canonical notice path `['skills']` 断言 result model/header 为 `/skills`；不把 client request body 当 header 证据 | A |
| B1 | metadata | `App.unit.test.tsx` | 同一行显示 `scope · source`；缺 source 只显示 scope；不使用 `source ?? scope` 的丢字段结果 | B |
| B2 | hover 后 Tab | `App.unit.test.tsx` | 用 `userEvent.hover` 或 React 可接收的 `mouseover` 路径 hover 非首行；该行 true、首行 false；Tab 落入该行、关窗、聚焦 textarea，且未 execute | B |
| B3 | click | `App.unit.test.tsx` | 不先 hover，模拟 touch-like 单击任意行；直接落入 `/<name> `、关窗、聚焦，证明 click 不依赖旧 selectedIndex | B |
| B4 | 键盘导航 | `App.unit.test.tsx` | ↑/↓、PgUp/PgDn clamp；Tab/Enter 均落入当前项；Esc 关闭不改 draft | B |
| B5 | 精确行滚动 | `App.unit.test.tsx` | selected index 变化后只有对应 row 的 `scrollIntoView` 被调用，参数含 `{ block:"nearest" }`；无关重渲染不重复调用 | B |
| B6 | skill 三段 CSS | `styles.unit.test.ts` | 三条 grid track 均可收缩且有界，metadata 不用无界 `auto/max-content`；`strong`、description、metadata 各自具备 `min-width:0` / overflow / ellipsis；无伪状态点依赖 | B |
| C1 | no-args class | `App.unit.test.tsx` | fixture 在同一次渲染中提供真实非空长 `argsHint` 行和空行；空行带 `ohb-slash-row-no-args` 且保留空 args 节点，有 args 行不带 modifier | C |
| C2 | 两类 grid | `styles.unit.test.ts` | base 仍为四列；modifier 为三列；modifier 隐藏空 args，并把 description 明确放到第三列 | C |
| C3 | 顶层不 flood | `slashCommands.unit.test.ts` / `App.unit.test.tsx` | `/` 含 `/skills`，不含 `executionKind:"skill"` 的单个 skill | 护栏 |
| C4 | 权威规格 | 文档 diff / link check | 实施后 `skill-invocation.md` / slash README 把 improve-1 目标翻转为已实施，§6 历史计划保持不动；`/<skill-name>` 与 `/skill` alias 无歧义 | C |

### 防止 alias 假阳性

A1 和 A3 是发布门。以下测试**不能**单独证明 alias：

- `filterSlashCommandCatalog` / palette items 在 draft `/skill` 时能看到 canonical `/skills`；这是 prefix matching 在 alias 不存在时也能成立。
- palette 打开时按 Enter 成功打开 `/skills`；当前 UI 会提交 selected item 的 canonical label，同样可能绕过原始 `/skill`。

## 4.3 建议命令

```bash
pnpm vitest run packages/ohbaby-agent/src/commands/catalog.unit.test.ts
pnpm vitest run packages/ohbaby-agent/src/commands/service.unit.test.ts
pnpm vitest run apps/ohbaby-web/src/api/daemon/client.integration.test.ts
pnpm vitest run apps/ohbaby-web/src/ui/slashCommands.unit.test.ts
pnpm vitest run apps/ohbaby-web/src/ui/App.unit.test.tsx
pnpm vitest run apps/ohbaby-web/src/ui/styles.unit.test.ts
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
pnpm exec prettier --check docs/ohbaby-web/ui/slash-commands/improve-1/*.md docs/ohbaby-web/ui/slash-commands/skill-invocation.md docs/ohbaby-web/ui/slash-commands/README.md
```

若 policy 单独建立 colocated test 或 SDK resolve 补测试，应加入同一 targeted run。完成 targeted suite 后跑全仓 lint/test/build；不得只跑单个新增 case。根 `format:check` 不覆盖 `docs/`，所以保留上面的显式文档 Prettier 命令。

## 4.4 真实浏览器验收

### M1 · direct alias（必须绕过 palette）

1. 输入字面量 `/skill`。
2. 按 `Esc` 关闭 palette，确认 composer 仍是 `/skill`；随后点击 Send 或按 Enter direct 提交。也可在 runtime 层直接调用 `executeSlashCommand({ text:"/skill" })` 作为等价证据。
3. 预期：打开的结果 header 是 canonical `/skills`，网络 command invocation 也是 builtin `skills`；页面任何 slash label 都不出现 `/skill` 第二行。

### M2 · modal 指针/键盘

1. 在至少两行的 `/skills` modal 中把鼠标移到第二行。
2. 预期第二行立即出现 selected 样式且 `aria-selected=true`；按 Tab 落入第二行。
3. 重新打开 modal，单击另一行；预期直接落入并关闭。
4. 使用 PageDown 进入视口外的行；预期选中行滚入最近可见位置，不跳到列表顶部。

### M3 · card 与 metadata

使用包含长名称、长描述、scope+source 和仅 scope 的测试数据：

- 在固定桌面视口与一个窄视口分别检查：三段同一行，名称/描述/metadata 均 ellipsis，不把 modal 撑宽且无水平 overflow；记录 row/modal bounding box 作为几何证据；
- 两字段显示 `scope · source`，缺 source 时只显示 scope；
- 不出现 MCP 状态点样式或额外空圆点。

### M4 · palette 两种布局

- `/skills`：点 / 命令 / 描述紧凑三列；检查空 args 的计算样式和 description 所在 grid column，确认无空 args 大洞。
- `/goal` 与 `/connect`：保持点 / 命令 / args / 描述四列；长 args 不与描述重叠，不反向撑大 composer。桌面与窄视口都记录 bounding box / overflow 结果，不只凭肉眼判断。

### M5 · 落入后的既有执行链

从 modal 落入一个普通 skill，补一段参数并发送；确认仍 POST `skill.<name>`、raw args 保持，session 收到既有 skill prompt 注入。此项是回归，不授权修改注入协议。

## 4.5 集成边界

- **catalog alias ↔ SDK resolve**：alias 命中后 path 必须 canonical；Web 不特殊处理字符串 `"skill"`。
- **external policy ↔ catalog/output**：纯 policy 处理 normalized/occupied paths，`service.ts` 形成 builtin > accepted extra > skill projection，`builtin.ts` 通过 helper 消费同一批 `slashInvocableSkills`；Web modal 不再有自己的 reserved name filter。
- **palette ↔ direct submit**：palette 展示 canonical item；A3/M1 独立验证原始 direct 输入。
- **modal selected state ↔ prefill**：hover、keyboard 共享 selectedIndex；click 可以直接指定该行，但最后都走同一 insert/prefill 通道。
- **DOM class ↔ CSS**：React 明确产生 no-args modifier；CSS 不用内容猜测。四子节点保留，modifier 负责列切换与 description 定位。
- **共享 output ↔ TUI**：TUI `/skills` 会同步少掉 reserved 项；测试验证这是数据政策，不误删普通 skill。

## 4.6 回归清单

- `/status`、`/help`、`/mcps`、`/skills` 结果 modal 仍能打开。
- `/connect`、`/connect-search`、`/compact` 仍走 overlay，不因 alias 测试改走 POST。
- `/mcps` → `/mcp` alias 仍工作。
- 顶层 `/` 仍不含单个 skill。
- 现有 PgDn+Tab、click、重复 prefill nonce 行为保持。
- modal 空 skills 仍回退安全 JSON/text projection。
- `executeSkillCommand`、raw args 和 Web server gate 不变。
- 有 args 行 base 四列、无 args 行 modifier 三列都通过自动化和浏览器检查。

## 4.7 发布门

| 门槛 | 通过标准 |
|------|----------|
| alias | A1–A3、A8 全绿；M1 header/POST 均 canonical `/skills` |
| policy | A4–A7 全绿；builtin/legacy/extra/skill 优先级与 catalog/output projection 一致 |
| card | B1、B6 + M3；三段数据完整且有界 |
| 指针/键盘 | B2–B5 + M2；真实选中、落入、nearest scroll 一致 |
| palette | C1–C3 + M4；三列/四列互不破坏 |
| 注入回归 | M5 通过，未修改既有协议 |
| 文档 | C4、链接/锚点检查与 diff 自检通过 |
| 工程 | targeted tests、`typecheck`、`lint`、全仓 `test` / `build` 与显式文档 Prettier 全绿 |

全部门槛满足后才可写实施验收记录。本次文档审核通过本身不等于授权开发；仍需用户明确确认开始实施。

已知边界：`aria-selected` 在当前普通 button + window keydown 结构中只作为可观察 selected 状态，不足以证明完整的辅助技术语义。本批不以 B2 宣称 listbox/focus accessibility 完成；相关焦点模型与屏幕阅读器验证另立议题。

## 4.8 对抗性复审问题

1. 是否把“palette 能看到 `/skills`”误当成 `/skill` alias 已成功？
2. 是否只过滤少数静态名字，却遗漏真实 builtin canonical/aliases、permission exact paths 或 accepted extra command 占用？
3. policy/projection 是否真的单源，还是测试/handler 又复制了 builtin 或 reserved 名单？
4. hover 是否只改 CSS class，`aria-selected` 和 Tab 仍指向旧 index？
5. `scrollIntoView` 是否作用于当前精确 row，并使用 nearest，而非每次把容器重置？
6. 是否用全局 `max-content` 修 `/skills`，却让 `/connect` 的长 args 挤坏描述？
7. `skill-invocation.md` 是否把 `b5e00f4` 已完成计划重新写成待办？
8. scroll effect 是否错误依赖每次 render 重建的 skills 数组，导致无关重渲染重复滚动？
9. skill metadata track 是否偷用无界 `auto/max-content`，让子元素虽有 ellipsis 仍挤坏整行？
