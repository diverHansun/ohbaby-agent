# `ohbaby-cli` 转型路线图

本文档定义 `packages/ohbaby-tui` → `packages/ohbaby-cli` 的完整转型路线，分阶段推进。原则：**先把架构钉牢，再做样式与布局**——高层决策（命令路由、状态契约、目录边界）的辐射半径远大于颜色、字距、动画，把高层决策做错一次会让叶子动作返工。

> 限轮数原则：本路线图 **明确限制架构阶段为 2 轮 PR**（Phase 0 + Phase 1）。架构稳定后立刻进入样式/布局阶段（Phase 2 起），不再回头做架构。例外只允许在样式阶段反向倒逼出来的、由实际 UX 证据驱动的小幅微调。

---

## 一、路线总览

| 阶段 | 主题 | 性质 | 大致工作量 | 状态 |
|------|------|------|----------|------|
| **Phase 0** | 包重命名 + 目录下沉 | 纯机械 | 半天 | 已完成 |
| **Phase 1** | command 模块架构化 | 架构 | 1–2 天 | 待开始 |
| **Phase 2** | TUI 主题系统 | 样式 | 1–2 天 | 待开始 |
| **Phase 3** | TUI 布局与对齐 | 样式 | 1–2 天 | 待开始 |
| **Phase 4** | 命令调色板与补全 UX 打磨 | 体验 | 视情况 | 待开始 |
| **Phase 5+** *(post-MVP)* | 后端多包拆分 | 架构 | 视情况 | 推迟 |

阶段之间的依赖：

```
Phase 0 ──► Phase 1 ──► Phase 2 ──┐
                              │    ├──► Phase 4
                              └──► Phase 3
                                          │
                                          ▼
                                    (MVP 收尾)
                                          │
                                          ▼
                                    Phase 5+ (post-MVP)
```

---

## 二、Phase 0 — 包重命名

详见 [rename-tui-to-cli.md](rename-tui-to-cli.md)。

**范围**：

- 包名 `ohbaby-tui` → `ohbaby-cli`
- 目录：`packages/ohbaby-tui/src/*` → `packages/ohbaby-cli/src/tui/*`，新增 `src/index.ts` 薄壳 re-export
- 所有外部耦合点（tsconfig / vitest / package.json / bin.ts / tests / docs）同步更新

**非目标**：

- 不动文件内部结构
- 不去重 SDK / TUI 之间的命令解析
- 不引入 intent 联合
- 不动 theme / 颜色 / 布局

**验收**：`pnpm typecheck && pnpm test && pnpm build` 全绿，`ohbaby` 命令可正常启动 TUI。

---

## 三、Phase 1 — command 模块架构化

**前置**：Phase 0 已合并。

**目标**：消除 TUI 与 SDK 命令解析的重复，引入 intent 联合做路由清晰化，busy 状态从 snapshot 读取。

### 3.1 文件结构（新）

```
packages/ohbaby-cli/src/tui/command/
├── index.ts          # barrel
├── types.ts          # OhbabySlashIntent（判别联合）+ SlashCommandBusyReason
├── resolve.ts        # resolveSlashIntent({ input, catalog, snapshot, skillCommandMap? })
│                     #   内部 import ohbaby-sdk 的 parseSlashInput / resolveCommand / filterCommandCatalog
│                     #   再用 busy / source 包成 intent
├── completions.ts    # getSlashCompletion / getSlashCompletionCandidates（保留，内部改调 SDK）
├── hints.ts          # formatCommandHint / formatCommandHints（不变）
└── skills.ts         # （可选，见 §3.5）
```

旧 `runtime.ts` 被拆掉：

- `parseSlashInput` / `resolveCommand` / `filterCommandCatalog` → 删除，全部走 SDK
- `applySlashCompletion` → 移到 `completions.ts`，内部改用 SDK 的对应函数

### 3.2 决策记录：Q1 — TUI 使用 SDK 的 parser

**结论**：TUI 不再持有 parser，统一用 `ohbaby-sdk` 导出的 `parseSlashInput` / `resolveCommand` / `filterCommandCatalog`。

**原因**：

- 现在 `packages/ohbaby-cli/src/tui/command/runtime.ts` 与 `ohbaby-sdk/src/command/parse.ts` 存在两份 tokenizer，引号处理、TokenSpan 结构都不同。任一处改动都需要双向同步，迟早错位。
- SDK 作为协议包，命令解析逻辑本就该归 SDK；TUI 是协议消费者，不应另起一套。
- 远端 / remote UI 未来若复用同一协议，必须复用 SDK 的 parser，否则一套语义两个实现。

**实现细节**：

- 若 SDK 的 `tokenSpans` 缺少 `start/end`（语法高亮可能需要），在 SDK 一侧补齐字段，向后兼容（追加字段不破坏既有消费者）。
- TUI 不新增本地 `parse.ts`。`resolve.ts` 直接 import SDK 的 parser / resolver / filter，本地只负责把结果包装成 `OhbabySlashIntent`。

### 3.3 决策记录：Q2 — busy 状态从 snapshot 读取

**结论**：TUI 不维护本地 busy 字段，`resolveSlashIntent` 接收 `snapshot: UiSnapshot`，从其中派生 `isStreaming` / `isCompacting`。

**原因**：

- snapshot 已经是 single source of truth（`UiSnapshot.status.kind` + `UiSnapshot.runs[*].status`），多维护一份本地状态意味着两路同步、可能发散。
- snapshot 已经通过 `UiSnapshotReplacedEvent` / `UiRunUpdatedEvent` 实时推送给 TUI store，busy 派生天然实时。
- 未来 remote UI 拿到同一 snapshot，应该能得到同样的 busy 判定——把派生逻辑放 TUI 内会再次本地化，反而退化。

**实现细节**：

- 在 `resolve.ts` 内新增小工具：

  ```ts
  function deriveBusyReason(snapshot: UiSnapshot): SlashCommandBusyReason | undefined {
    const activeRun = snapshot.runs.find(/* status === "streaming" or similar */);
    if (activeRun?.status === "streaming") return "streaming";
    if (snapshot.status.kind === "compacting") return "compacting";
    return undefined;
  }
  ```

- 准确的 status 字段名以 `packages/ohbaby-sdk/src/snapshot.ts` 中 `UiRunStatus` / `UiSnapshot.status` 实际定义为准；P1 实施时再对齐。

### 3.4 OhbabySlashIntent 设计

借鉴 kimi-code 的判别联合，但**剔除 `skill` 分支**（理由见 §3.5）：

```ts
// packages/ohbaby-cli/src/tui/command/types.ts
import type { UiCommandInvocation, UiCommandSpec } from "ohbaby-sdk";

export type SlashCommandBusyReason = "streaming" | "compacting";

export type OhbabySlashIntent =
  | { readonly kind: "not-command" }
  | {
      readonly kind: "command";
      readonly command: UiCommandSpec;
      readonly invocation: UiCommandInvocation;
    }
  | {
      readonly kind: "message";
      readonly text: string;
    }
  | {
      readonly kind: "blocked";
      readonly commandName: string;
      readonly reason: SlashCommandBusyReason;
    }
  | {
      readonly kind: "invalid";
      readonly commandName: string;
      readonly reason: "unknown";
    };
```

注意 ohbaby 不分 `builtin` vs `skill` —— SDK 的 `UiCommandSpec.source: "builtin" | "user" | "mcp" | "skill" | "plugin"` 已经携带来源，无需在 intent 层再分。

`app.tsx` 消费形态：

```ts
const intent = resolveSlashIntent({
  input,
  catalog,
  snapshot,
});

switch (intent.kind) {
  case "not-command":
  case "message":
    await client.submitPrompt(intent.kind === "message" ? intent.text : input);
    break;
  case "command":
    await client.executeCommand(intent.invocation);
    break;
  case "blocked":
    showToast(slashBusyMessage(intent.commandName, intent.reason));
    break;
  case "invalid":
    showError(`Unknown command /${intent.commandName}`);
    break;
}
```

### 3.5 决策记录：Q3 — 不在 TUI 包装 skill

**结论**：不引入 `skills.ts`。skill 命令通过后端 catalog 暴露（`source: "skill"`），TUI 与处理其它命令一视同仁。

**原因**：

- ohbaby `UiCommandSpec.source` 字段已经预留 `"skill"`，后端 `CommandService` 应该负责把 skill 注册为 catalog 条目。
- 在 TUI 包装会重复后端能力，并且远端 UI 拿不到本地 skill 列表。
- 若后端目前还**未**把 skill 暴露到 catalog，应在 Phase 1 之前作为后端独立改动补齐（不影响 CLI 节奏）。

**实施前的验证步骤**：

1. 检查 `packages/ohbaby-agent/src/commands/catalog.ts` 是否已包含 skill 条目。
2. 若没有，开 backend issue 让 `CommandService` 把 `SkillRegistry` 的内容投影到 catalog；这件事是 backend 范畴，不进 Phase 1 PR。

### 3.6 Phase 1 PR 范围

**包含**：

- [ ] 删除 `packages/ohbaby-cli/src/tui/command/runtime.ts`
- [ ] 新建 `parse.ts` / `resolve.ts` / `types.ts`
- [ ] 重写 `completions.ts` 内部调 SDK
- [ ] `app.tsx` 切换到 intent 路由
- [ ] 新增 `resolve.unit.test.ts` 覆盖 not-command / command / blocked / invalid / message 五分支
- [ ] 若 SDK tokenSpan 字段缺失，在 SDK 补齐并加测试

**不包含**：

- 颜色 / 主题
- 组件结构调整
- store / selectors 改造（除非 busy 派生确实需要新 selector）

---

## 四、Phase 2 — TUI 主题系统

**前置**：Phase 1 已合并，命令路由稳定。

**范围**（待 Phase 1 落地后细化，本节为预占位）：

- 抽取颜色 token：从散落在 `components/*` 中的 chalk / ink color prop 收敛到一份 theme 文件
- 支持 light / dark / 终端自适应（参考 kimi-code 的 `tui/theme/detect.ts` 思路）
- 通过 prop drilling 或 React context 注入主题
- 不做：动画、字体、自定义图标——留到 Phase 3 或单独评估

**非目标**：不改命令路由、不改 store、不动 dialog 流程。

---

## 五、Phase 3 — TUI 布局与对齐

**前置**：Phase 2 已合并。

**范围**（占位，待 Phase 2 落地后细化）：

- prompt 区域的换行策略
- message list 的 indent / gutter
- footer / header / status-bar 的纵向分配
- terminal 宽度过窄时的降级渲染

---

## 六、Phase 4 — 命令调色板与补全 UX 打磨

**前置**：Phase 1–3 已合并。

**范围**：

- 自动补全的视觉呈现（参考 kimi-code 的 pi-tui 风格）
- 命令 hint 排序权重（按 `priority` + 使用频率）
- 模糊匹配（当前 SDK `resolveCommand` 只做前缀匹配，必要时引入 fuzzy）
- 历史命令快捷键

---

## 七、Phase 5+ — 后端多包拆分（post-MVP）

最终目标五包结构：

- `ohbaby-sdk` — 协议（已有）
- `ohbaby-cli` — 前端应用（Phase 0 完成）
- `ohbaby-agent` — 会话编排、命令服务、runtime / lifecycle、UI adapter
- **`ohbaby-llm`** — LLM 抽象：`core/llm-client/` + `services/providers/` + `services/llm-model/` + `config/llm/`
- **`ohbaby-host`** — 宿主访问：`shell/` + `sandbox/` + 相关 utils

完整设计（包括依赖规则、`adapter` 三义、边界耦合处理、对照 kimi/pi 的取舍）见 **[package-design.md](package-design.md)**。

**触发条件**（任一满足才考虑启动 ohbaby-llm / ohbaby-host 拆分）：

- 出现第二个 entry 需要复用后端某子集
- 某子目录改动频率显著低于其它部分（说明已稳定）
- 跨子目录类型穿透层数过深、IDE 跳转明显变慢
- LLM provider 数量增加到 4+，或出现远端/SSH 沙箱需求

---

## 八、为什么是这个顺序

1. **Phase 0 → Phase 1**：包名稳定后才能在干净的边界上做命令架构改造。先做命令改造再改包名，会有大量 import 路径双向移动，diff 难审。
2. **Phase 1 → Phase 2**：intent 路由直接影响哪些组件存在、props 是什么形状。theme 必须站在稳定的组件契约上做，否则 token 跟着组件重命名一起跑。
3. **Phase 2 → Phase 3**：颜色定下来后，布局阶段的视觉对齐有锚点；反之颜色未定时布局靠"灰度对比"猜测。
4. **Phase 4 在所有之后**：调色板 / 补全是叶子体验，依赖整套架构 + 视觉风格已经定型。

**最关键的设计约束**：架构 PR（Phase 0 + Phase 1）合并后**立刻冻结架构**，进入 Phase 2 不再做架构动作。如果 Phase 2/3 反推出某个架构调整必须做，**优先用最小局部改动解决**，不要回到"再开一轮架构"的思路——避免无限重构循环。

---

## 九、参考

- [rename-tui-to-cli.md](rename-tui-to-cli.md) — Phase 0 详细计划与迁移清单
- [tui-design.md](tui-design.md) — Phase 2/3 TUI 样式、布局、键盘交互与测试标准
- [docs/cli/architecture.md](../../cli/architecture.md) — CLI composition root（`bin.ts`）现状
- [docs/ohbaby-sdk/architecture.md](../../ohbaby-sdk/architecture.md) — SDK 协议层定位
- 参考实现：`D:/Projects/Code-cli/kimi-code/apps/kimi-code/src/tui/commands/` — kimi-code 的 slash 命令布局
