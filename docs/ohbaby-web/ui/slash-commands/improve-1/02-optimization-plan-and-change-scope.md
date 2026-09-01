# 2. 优化方案与改动范围

> 后续实施会话的执行契约。规划会话不修改业务代码。基线 `origin/main@7cec6ba`（v0.1.12）；定位以符号为准。

## 2.1 方案总览

保持既有发现与执行模型，只修命令政策、弹窗交互和 palette 布局三条边界：

1. **alias + 单一 projection**：builtin `/skills` 增加 input-only alias `/skill`；提取 external-command policy，由 service 形成 builtin > extra > skill eligibility projection，让动态 catalog 与 `/skills` 输出消费同一批 slash-invocable skills。
2. **skill 弹窗**：名称 / 描述 / `scope · source` 三段有界显示；hover 建立真实选中，单击落入；键盘选中 + Tab/Enter 落入，选中行自动保持可见。
3. **no-args palette 行**：有参数命令继续四列；无参数命令加显式 modifier，改为点 / 命令 / 描述三列，不保留空 args 大洞。

```text
/skill 或 /skills
  → SDK resolve canonical [skills]
  → UI 始终显示 /skills
  → /skills output 仅包含 external policy 允许 slash 调用的 skill
  → modal hover/keyboard 选中，click/Tab/Enter 落入
  → /<skill-name>  + Enter → 既有 skill 注入链
```

## 2.2 设计决策

| 决策项 | 选择 | 理由 | 明确不选 |
|--------|------|------|----------|
| 发现入口 | `/skills` modal | 避免顶层 `/` flood；沿用已落地 Layer 2 | 展开全部 skill 到 palette |
| `/skill` | catalog alias `[ ["skill"] ]` | SDK 已支持 alias 与 canonical path | Web 字符串特判、第二条 `/skill` 行 |
| 显示名称 | 始终 canonical `/skills` | alias 只是输入兼容 | chip/header 展示 usedAlias |
| eligibility policy | 纯 `external-command-policy.ts` + service projection | legacy policy 单源，builtin 占用从真实 catalog 派生，catalog/output 共用结果 | 两处复制黑名单、UI 过滤 |
| 占用优先级 | builtin canonical/aliases > 已接受 extra commands > registry skills | builtin 稳定；显式集成优先；skill 冲突不拖垮 catalog | 依赖合并顺序碰运气 |
| 列表过滤 | 只输出 projection 接受的 `slashInvocableSkills` | 展示承诺与 slash 可调用性一致 | 只排除新增 `skill` / `skills` |
| metadata | `scope · source`，缺 source 时 scope | 与 TUI 口径一致且不丢信息 | `source ?? scope` |
| 鼠标 | hover = selected；click = insert | 选中语义可观察，点击保持快捷路径 | hover 仅视觉、不改 index |
| 滚动 | 精确选中行 `scrollIntoView({ block:"nearest" })` | 长列表中保持高亮可见 | 滚整个 modal 到顶部 |
| no-args 布局 | class modifier + 三列 | DOM 状态显式，有参数 base 不受影响 | 全局 `max-content` args 列、仅靠 `:empty` |

## 2.3 Phase A · alias 与共享 external-command policy

### 目标

- direct `/skill` resolve 为 builtin `skills`，invocation path 仍是 `['skills']`。
- 全部 builtin canonical/aliases、已接受 extra command path/aliases 与 legacy reserved policy 都不会被动态 skill 抢占。
- `/skills` 输出只承诺真正可通过 slash path 落入和执行的 skill。

### 实施

1. 新增 `packages/ohbaby-agent/src/commands/external-command-policy.ts`。它提供大小写不敏感的 path key、command path+aliases 收集、reserved/occupied 检查等纯函数。
2. policy 单源保留两类 legacy 规则：root 规则 `cancel` / `mode` / `model`；exact path 规则 `permission/default` / `permission/full-access`。不要把 builtin 名单手抄进 policy；`permission/custom` 必须仍可通过。
3. `catalog.ts` 把 builtin `skills.aliases` 改为 `[["skill"]]`，canonical path 不变。`service.ts` 先调用 `buildCommandCatalog()` 得到 builtin-only catalog，并机械收集全部 canonical paths 与 aliases，因此 `status`、`exit/quit/q`、`help/?`、`mcps/mcp`、`skills/skill` 等自动进入 occupied set。
4. `service.ts` 形成统一 eligibility projection，优先级固定为 builtin > 显式 `options.extraCommands` > registry skills：
   - 先按 legacy policy 与 builtin occupied set 过滤显式 extra commands；被 builtin 占用的 extra command 跳过；已接受 extra commands 彼此 canonical/alias 冲突继续 fail-fast，暴露配置错误；
   - 再按相同 policy 和 builtin+accepted-extra occupied set 过滤 sanitized skills；动态 skill 冲突时按 registry 稳定顺序 first-wins，其余跳过，不能让安装一个冲突 skill 使整个 catalog 抛错；
   - projection 返回 `{ catalog, slashInvocableSkills }`，两者来自同一批 accepted skills。
5. `createCommandService` 给 `BuiltinHandlerHelpers` 提供 projection/helper；`handleSkills` 只把 `slashInvocableSkills` 投影成 output，不重新读 registry、重算名单或在 Web renderer 隐藏。

### 依赖约束

policy 模块不得导入 `catalog.ts`、`service.ts` 或 `builtin.ts`，只接收 command/path 数据；`service.ts` 负责把 builtin-only catalog、extra commands 与 sanitized skills 喂给 policy 并组装 projection；`builtin.ts` 只通过 helper 消费 `slashInvocableSkills`。不要把 registry provider 或 UI 类型放入 policy。

### DoD

- 真实 catalog 上 `resolveSlashCommand(..., "/skill")` 返回 `command.id === "skills"`、`path === ["skills"]`、`usedAlias === ["skill"]`。
- `/skill` palette 匹配只有一行，`item.label === "/skills"`，补全 suffix 为 `"s"`；不出现第二条 `/skill`。
- 从真实 builtin-only catalog 枚举出的每个 canonical path/alias 均拒绝同名/大小写变体的动态 skill；至少显式抽查 `status`、`help`、`exit/quit/q`、`mcps/mcp`、`skills/skill`。
- legacy `cancel` / `mode` / `model` roots 与 `permission/default` / `permission/full-access` exact paths 保持；`permission/custom` 对照可通过。
- path 与 builtin canonical 冲突或 alias 命中 builtin alias 的显式 extra command 被跳过且不使 catalog 抛错；已接受 extras 彼此冲突仍 fail-fast。
- 与 accepted extra command path 或 alias 冲突的 skill 被跳过；普通 skill 同时存在于 catalog 和 `/skills` output；两者集合一致。
- 显式 extra commands 彼此冲突仍 fail-fast；动态 skill 冲突不会使 catalog 构建抛错。
- catalog 构建与 `/skills` handler 的测试都通过，且生产代码与测试都没有手抄 builtin 占用名单。

## 2.4 Phase B · skill 卡片与指针/键盘一致性

### 目标

卡片三段内容稳定；鼠标与键盘共享一个真实选中态；落入行为保持现有协议；长列表选中行始终可见。

### 实施

1. `SkillsCommandResult` 为每行保留并在卸载时清理 ref，按稳定 row identity / index 精确访问已提交 DOM。
2. 每行 `onMouseEnter` 设置该行 `selectedIndex`；既有 `aria-selected` 继续由同一 index 派生。
3. 单击直接调用既有 insert path；Tab/Enter 使用当前 index，行为仍是“落入 + 关闭”，不直接执行。
4. clamp 后的 index 或稳定的 `notice.id` / row identity 变化后，在 DOM refs 已提交的 `useLayoutEffect` 中对当前精确行调用 `scrollIntoView({ block:"nearest" })`；不得依赖每次 render 都重建的 `skills` 数组引用，避免无关重渲染重复滚动。空列表与卸载路径必须安全。
5. metadata 由有效 `scope` 和 `source` 组合：两者均有值时 `scope · source`，仅 scope 时只显示 scope；不要回退成丢字段的 `source ?? scope`。
6. `.ohb-list-skill` 使用适配 `strong + span + small` 的三列 grid。三条 track 都必须可收缩且有明确上界（使用 `minmax(0, …)` 等有界合同）；metadata 列禁止无界 `auto` / `max-content`。名称、描述、metadata 均需 `min-width:0`、单行、overflow hidden、text-overflow ellipsis；清理重复 selector，但保留共享 `.ohb-list-row` 基础壳。

### DoD

- hover 第二行后第二行 `aria-selected="true"`，随后 Tab 落入第二行而不是首行。
- click 任意行继续落入 `/<name> `、关 modal、聚焦 textarea，且不触发执行。
- 方向键/Page 键改变 index 后，只有精确选中行收到 `scrollIntoView({ block:"nearest" })`；无关重渲染不重复滚动。
- DOM 同时展示 `scope · source`；缺 source 的行只显示 scope。
- 长名称、描述、metadata 都受独立有界 track 与截断约束；metadata 不能反向挤出名称/描述；不新增假状态点节点。
- 空列表继续走 `FallbackCommandResult`。

## 2.5 Phase C · no-args palette 行与权威规格

### no-args 行

`SlashPalette` 根据 `item.argsHint` 是否为空，为 row 增加 `ohb-slash-row-no-args` modifier。保留现有四个 DOM 子节点，避免组件结构分叉：

- base `.ohb-slash-row`：继续点 / 命令 / args / 描述四列，服务 `/goal`、`/connect` 等有参数命令；
- modifier：切换为点 / 命令 / 描述三列，空 `.ohb-slash-args` 隐藏，description 显式放到第三列；
- 不使用会让最长 args 决定全局宽度的 `minmax(0,max-content)`；不只写 `display:none` 而遗漏 description 的 grid column。

### 文档同步

规划期已经完成状态分层：`skill-invocation.md` §1–§5 同时标明已落地基线与 improve-1 待实施目标；旧 §6 已标为 `b5e00f4` 历史记录；§7/§8 指向新增门槛与已确认决策；slash UI README 的三列/metadata 条目也带“improve-1 目标（待实施）”。

实施完成且 04 发布门通过后必须收口状态：

- 把 `skill-invocation.md` 中 improve-1 “目标/待实施”翻转为已实施当前合同；保留 §6 历史记录原样，不重写旧计划。
- 把 slash UI README 的两处“improve-1 目标（待实施）”翻转为当前行为。
- 保留 `/<skill-name>` 与字面量 alias `/skill` 的区分，并让 §7 指向完成后的真实测试证据。

### DoD

- `/skills` 行无空参数大洞；有 args 的 `/goal` / `/connect` 仍保持四列且描述不叠字。
- 空 args 节点仍存在于 DOM，但 modifier 下不占视觉列；测试同时覆盖 class 与 CSS column 指派。
- 实施完成后，权威文档把 improve-1 目标翻转为已实施、保留 §6 历史记录；`/<skill-name>` 与字面量 alias `/skill` 继续分写。

## 2.6 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 明确不动 |
|---------|------|------|----------|
| `packages/ohbaby-agent/src/commands/` | `external-command-policy.ts`（及必要测试） | `catalog.ts`、`service.ts` eligibility projection、`builtin.ts` helper/output、相关 unit tests | `executeSkillCommand` 语义 |
| `apps/ohbaby-web/src/ui/` | — | `App.tsx`、`styles.css`、`App.unit.test.tsx`、`styles.unit.test.ts` | `slashCommandLabel` canonical 规则；skill flood 过滤 |
| `apps/ohbaby-web/src/api/daemon/` | — | 仅补 direct alias integration assertion | POST 协议与 overlay 分流 |
| `packages/ohbaby-sdk/src/slash-command/` | — | 通常无需生产改动；仅在覆盖不足时补 resolve test | alias 实现语义 |
| `docs/ohbaby-web/ui/slash-commands/` | improve-1 文档集 | `skill-invocation.md`、`README.md` 一句布局契约 | `docs/skill/` 注入规格 |

## 2.7 API、兼容与数据变化

- `POST /v1/commands` shape 和 daemon handler 不变。direct `/skill` resolve 后发送 canonical `commandId:"skills"`、`path:["skills"]`。
- Web catalog 的 builtin `skills` 多一个 alias；旧消费者若只使用 path 不受影响。
- alias 同时对 TUI/headless/stdout 生效，这是共享 catalog 的预期一致性；显示仍应来自 canonical path。
- `/skills` output 将只保留 projection 接受的 registry skills：排除 legacy reserved、全部 builtin canonical/aliases、accepted extra command path/aliases 与重复 skill。TUI overlay 也会看到同一数据变化；这属于可调用性纠正，不是 TUI 视觉改版。
- 同名 registry skill 仍可由模型 SkillTool 使用，但不再通过 slash 发现/调用。该政策对用户可见，必须写入规格和回归测试。
- 所有改动技术上可回滚，无数据迁移、持久化 schema 或不可逆操作。

## 2.8 风险与缓解

| 风险 | 缓解 | 回滚方向 |
|------|------|----------|
| alias 被 palette 前缀假测试掩盖 | direct SDK resolve + client integration 绕过 palette | 删除 alias |
| policy/projection 造成循环依赖 | policy 不导入 catalog/service/builtin；service 组装，builtin 只消费 helper | 内联回原逻辑，但不得保留双名单 |
| builtin/extra/skill 优先级含糊 | projection 固定 builtin > accepted extra > skill；extra 自冲突 fail-fast、skill 冲突 skip | 回滚 projection |
| 迁移漏掉 permission exact paths | policy unit 锁两个 exact path 与 `permission/custom` 对照 | 恢复原 reserved path 集合 |
| `/skills` 数据减少影响 TUI | 测试普通 skill 保留，文档说明共享输出变化 | 回滚统一 policy 决策 |
| hover 与键盘争夺 index | 明确 hover 是最后输入来源；测试 hover→Tab | 移除 hover 更新（会违背已确认交互） |
| scroll effect 指向旧行 | refs 与有效 rows/index 同步，clamp 后调用 | 去掉 effect |
| no-args modifier 改坏有参数行 | base 四列不变；同时测试 `/skills` 与 `/connect` | 移除 modifier |
| CSS 静态测试产生布局假阳性 | 真实浏览器验收两类行 | 恢复样式后重新设计 |

## 2.9 明确不在本批

- 顶层 `/` 展示全部 skill。
- 在 modal 中直接执行 skill。
- 修改 `executeSkillCommand` / `submitPromptAndWait` 或把注入文本收成 Skill 工具卡。
- skill 搜索、参数表单、收藏、分组筛选。
- TUI SkillsPanel 视觉或交互改版。
- modal 的完整 listbox/option 语义、roving focus / `aria-activedescendant`、关闭后焦点恢复与屏幕阅读器专项改造。
- 像素级视觉回归框架。

## 2.10 关键改动清单

> 行号为 `origin/main@7cec6ba` 快照；实施以符号为准。本表不是进度表，实施中不勾选、不回写行号。

| ID | 类型 | 路径 | 符号/小节 | 行号快照 | 改动契约 |
|----|------|------|-----------|----------|----------|
| C1 | 代码 | `packages/ohbaby-agent/src/commands/catalog.ts` | builtin `id:"skills"` | L174–182 | `aliases:[["skill"]]`，path 保持 canonical `skills` |
| C2 | 新代码 | `packages/ohbaby-agent/src/commands/external-command-policy.ts` | 新模块 | — | normalized path、legacy roots/exact paths、occupied command/path 纯政策；不手抄 builtin |
| C3 | 代码 | `packages/ohbaby-agent/src/commands/service.ts` | reserved policy / `buildCatalog` | L20–82 | 组装 builtin > extra > skill eligibility projection，返回 catalog + slashInvocableSkills |
| C4 | 代码 | `packages/ohbaby-agent/src/commands/builtin.ts` | `BuiltinHandlerHelpers` / `handleSkills` | L29–33、L319–335 | 通过 helper 消费 projection 的 accepted skills，不重算 registry/名单 |
| C5 | 代码 | `apps/ohbaby-web/src/ui/App.tsx` | `SkillsCommandResult` | L1738–1827 | metadata 组合、hover 选中、row refs 与 nearest scroll |
| C6 | 代码 | `apps/ohbaby-web/src/ui/styles.css` | `.ohb-list-row` / `.ohb-list-skill*` | L1863–1949 | 三段有界 grid、名称/描述/metadata ellipsis、清重复规则 |
| C7 | 代码 | `apps/ohbaby-web/src/ui/App.tsx`、`styles.css` | `SlashPalette` / `.ohb-slash-row*` | App L3918–3951；CSS L2361–2433 | 显式 no-args class；三列 modifier；有 args 四列不变 |
| D1 | 文档 | `docs/ohbaby-web/ui/slash-commands/skill-invocation.md` | §1–§8 | 全文 | 当前契约与已完成历史计划分层；加入 improve-1 决策 |
| D2 | 文档 | `docs/ohbaby-web/ui/slash-commands/README.md` | Palette 视觉 | §3 | 说明有 args 四列、无 args 三列 |

### 连带测试面

- `packages/ohbaby-agent/src/commands/catalog.unit.test.ts`：真实 catalog alias / canonical resolve。
- `packages/ohbaby-agent/src/commands/service.unit.test.ts`：枚举真实 builtin canonical/aliases；legacy root/exact path、extra path/alias、重复 skill 的大小写冲突；catalog/output 集合一致，普通 skill 保留。
- `apps/ohbaby-web/src/api/daemon/client.integration.test.ts`：direct `/skill` 产生 canonical POST；不通过 palette 候选代替。header 另在 UI/model test 断言。
- `apps/ohbaby-web/src/ui/slashCommands.unit.test.ts`：仅一条 `/skills`、label 和 suffix。
- `apps/ohbaby-web/src/ui/App.unit.test.tsx`：metadata、hover→Tab、click、精确 row scroll、no-args class。
- `apps/ohbaby-web/src/ui/styles.unit.test.ts`：skill 三段截断、no-args 三列与 base 四列。

### 锁定不改的承重护栏

- `apps/ohbaby-web/src/ui/slashCommands.ts` 的 `slashCommandLabel` 继续从 `path` 生成 label；`isWebPaletteCommand` 继续排除单个 skill。
- `packages/ohbaby-agent/src/commands/service.ts` 的 `executeSkillCommand`、Web server command gate 与事件流。
- `docs/skill/` 及会话 prompt 注入协议。
