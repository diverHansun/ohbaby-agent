# 包重命名：`ohbaby-tui` → `ohbaby-cli`

本文档记录将 `packages/ohbaby-tui` 重命名为 `packages/ohbaby-cli` 的现状调查、目的与后续路径。本次只做命名与目录层级调整，不动后端拆分，也不改变 SDK / 后端结构。

---

## 一、现状

### 1.1 三个工作区包及其依赖关系

```
packages/
├── ohbaby-sdk     纯协议层：DTO + UiBackendClient 接口 + slash 解析 / catalog 解析
├── ohbaby-agent   后端：runtime / lifecycle / commands / agents / adapters …，并提供 bin.ts（CLI 入口）
└── ohbaby-tui     基于 Ink 的终端 UI 应用层：app.tsx / components / dialogs / store / command
```

依赖方向（由 `package.json` 与 `tsconfig.base.json#paths` 共同保证）：

```
ohbaby-sdk    ←    ohbaby-tui
   ↑                  ↑
   └──── ohbaby-agent ┘
```

- `ohbaby-tui` 依赖 `ohbaby-sdk`
- `ohbaby-agent` 同时依赖 `ohbaby-sdk` 与 `ohbaby-tui`（在 `bin.ts` 中 dynamic import）

### 1.2 `ohbaby-tui` 的实际内容

`packages/ohbaby-tui/src` 当前为平铺结构：

```
src/
├── index.tsx            导出 OhbabyTerminalApp + renderTerminalUi
├── app.tsx              顶层 React 组件，负责输入循环 / 键盘事件 / store 订阅
├── components/          footer / header / logo / message / prompt / status-bar
├── dialogs/             manager / confirm / select-one / model / permission / session
├── store/               基于 UiEvent 投影的快照 store + selectors
└── command/             slash 命令补全 / 提示 / TUI 侧 runtime
```

包的 `package.json` 描述自称 "Terminal UI package"，但实际职责是 **一个用 Ink 渲染的 CLI 前端应用**——TUI 只是其内部的渲染层。这是当前命名的核心矛盾。

### 1.3 外部对 `ohbaby-tui` 的耦合点（迁移时全部要改）

调查 `ohbaby-tui` 字面引用，命中 49 个文件，关键耦合分四类：

| 类别 | 文件 / 位置 | 说明 |
|------|------|------|
| 包元数据 | `packages/ohbaby-tui/package.json` | `name`、`description` 字段 |
| TS 解析配置 | `tsconfig.base.json#paths`、`tsconfig.json#references` | `ohbaby-tui` 路径别名 + 项目引用 |
| 子包 tsconfig | `packages/ohbaby-tui/tsconfig.json`（路径无影响，但目录名变化）、`packages/ohbaby-tui/tsconfig.tsbuildinfo` | `composite` 项目 |
| 构建配置 | `packages/ohbaby-tui/tsup.config.ts`、`packages/ohbaby-agent/tsup.config.ts` | 入口路径 + `external` 列表 |
| 后端 package | `packages/ohbaby-agent/package.json` | 在 `dependencies` 中以 `workspace:*` 引用 |
| 后端入口 | `packages/ohbaby-agent/src/bin.ts` | 动态 import：`await import("ohbaby-tui")` |
| 测试别名 | `vitest.config.ts` | `react` / `ohbaby-tui` 等 alias 都用了 `packages/ohbaby-tui/...` 物理路径 |
| 测试用例 | `tests/integration/tui/main-chain.integration.test.tsx`、`tests/integration/tui/persistent-display.integration.test.tsx`、`tests/smoke/tui-real-provider.smoke.test.tsx` | `from "ohbaby-tui"` |
| 文档与 README | `README.md`、`packages/*/README.md`、`docs/cli/architecture.md`、`docs/ohbaby-sdk/architecture.md`、`docs/ui/**`、`docs/implementation/tui-productization/**`、`docs/superpowers/plans/2026-05-20-tui-productization-and-npm.md` 等 | 大量 markdown 中存在字面提及 |
| 工作区锁文件 | `pnpm-lock.yaml` | `pnpm install` 重生即可 |

> 备注：`docs/cli/architecture.md` 当前描述的是 `packages/ohbaby-agent/src/bin.ts` 即「CLI composition root」语义，这与本次将前端包改名 `ohbaby-cli` 后会产生 **"cli" 一词两用** 的轻微冲突，需要在文档层面补一节澄清职责边界。详见 §4 后续动作。

### 1.4 当前唯一公开导出

`ohbaby-tui` 仅对外暴露：

```ts
// packages/ohbaby-tui/src/index.tsx
export { OhbabyTerminalApp } from "./app.js";
export type { TerminalUiOptions } from "./app.js";
export function renderTerminalUi(options: TerminalUiOptions): Instance;
```

任何 future 非交互模式都需要从 `ohbaby-agent/src/bin.ts` 之外的地方组装——目前没有自然安放点。

---

## 二、命名目的

### 2.1 修正概念错位

**"TUI" 是渲染层，"CLI" 是应用层。** 现在的包是一个 CLI 应用，它内部使用 TUI 渲染——把它叫 `ohbaby-tui` 是把内部实现细节当成包名。

对照参考项目：

- **kimi-code**：`apps/kimi-code/` 是 CLI 应用，内部分 `src/cli/`（参数解析 / 子命令 / 启动错误）和 `src/tui/`（Ink 渲染）。TUI 是 CLI 内部的渲染层。
- **opencode**：`tui` 是独立 Go 二进制，**纯渲染**通过 RPC 跟 server 通信——这种情况叫 `tui` 才合理（与 server 同级）。
- **pi**：`packages/tui` 是**终端原语库**（editor / keybindings / autocomplete / terminal IO），`coding-agent` 才是 CLI 应用——也是分开的两个概念。

我们当前的形态最像 kimi-code：一个 CLI 应用包含 TUI 渲染层。因此包名应是 `ohbaby-cli`，TUI 作为内部子目录。

### 2.2 为未来的非交互形态留出空间

`bin.ts` 已经存在「非交互模式」分支（`--prompt` / 非 TTY stdin），目前由 `packages/ohbaby-agent/src/cli/stdout-renderer.ts` 承担。但 stdout 渲染、参数解析、退出码、stdin 读取等等 CLI-only 关注点散落在 `ohbaby-agent/src/cli/` 与 `bin.ts` 之间。重命名后，新的 `ohbaby-cli` 包可作为：

- 现有：交互式 Ink TUI 渲染（迁移自 `ohbaby-tui`）
- 未来：非交互 stdout 渲染（可从 `ohbaby-agent/src/cli/` 抽出）
- 未来：CLI-only 子命令（如 `ohbaby config / ohbaby login`），与 lifecycle/runtime 解耦

本次重命名 **不动** 第二、三项；只是名义上为它们打开门。

### 2.3 保留对外 export 形态，迁移侵入面最小

`renderTerminalUi` / `OhbabyTerminalApp` 这两个 export 名字不改；只改包名、目录路径和内部目录层级。这样 bin.ts 的 dynamic import 只换一个字符串（`"ohbaby-tui"` → `"ohbaby-cli"`），React 组件代码不变。

---

## 三、目录结构与后续多包拆分

### 3.1 本轮目标结构

```
packages/ohbaby-cli/
├── package.json                # name: "ohbaby-cli"
├── tsconfig.json
├── tsup.config.ts              # entry: src/index.ts
├── README.md
└── src/
    ├── index.ts                # 仅再导出 ./tui，保持 renderTerminalUi 入口稳定
    └── tui/                    # ← 原 ohbaby-tui/src 全部内容下沉一层
        ├── index.tsx
        ├── app.tsx
        ├── components/
        ├── dialogs/
        ├── store/
        └── command/
```

要点：

- `src/index.ts` 是 **薄壳**，只做 `export * from "./tui/index.js"`。保留它的意义是：以后增加 `src/print/`（非交互 stdout 渲染）或 `src/cli-args/`（参数解析迁入）时，根入口可以聚合多个子模块，而不必动外部消费者。
- `src/tui/` 内部维持现有平铺（components / dialogs / store / command），文件内容**不动**。后续 `command/` 模块的内部重构（去重 parser、引入 intent 联合、busy 走 snapshot）作为独立 PR 推进，详见 [ohbaby-cli-roadmap.md Phase 1](ohbaby-cli-roadmap.md)。TUI 样式与布局优化在 Phase 2/3 进行。

### 3.2 关于后端拆分的明确推迟

后端 `packages/ohbaby-agent/src/` 当前为大目录（`adapters / agents / bus / commands / config / core / mcp / permission / policy / project / runtime / sandbox / services / shell / skill / snapshot / tools / utils`）。最终目标是五包结构（参照 kimi-code 的 `kosong + kaos + agent-core`、pi 的 `ai + agent + coding-agent`）：

| 包 | 内容（具体目录） | 触发条件 |
|------|------|------|
| **`ohbaby-llm`** | `core/llm-client/` + `services/providers/` + `services/llm-model/` + `config/llm/` | 出现非 CLI entry 需要复用 LLM 抽象；或 provider 数量上升到 4+ 个 |
| **`ohbaby-host`** | `shell/` + `sandbox/`（含 `sandbox/adapters/`）+ host-相关 utils（`parseCommand` / `containsOrEqual` / `lazy` 等） | 出现远端执行需求（SSH / 容器）；或被独立 host 进程消费 |
| **`ohbaby-agent`** (留下) | 其它所有：`agents / bus / commands / config（除 llm 外）/ core（除 llm-client 外）/ mcp / permission / policy / project / runtime / adapters（UI 后端 adapter）/ services（除 providers / llm-model 外）/ skill / snapshot / tools / utils（除 host 外）/ cli / bin.ts` | 默认保留 |

**本轮明确不做。** MVP 阶段保持后端单包，原因：

- 当前没有第二个 entry，"分发与复用" 收益是想象的。
- runtime / lifecycle / commands 的接口形状还在迭代，过早跨包会上锁。
- 真正易出问题的边界（CLI ↔ 后端）已经被 `ohbaby-sdk` 物理隔开。

后端拆分留待 MVP 之后；最终包结构、依赖规则、各模块归属、边界耦合点（如 `config/llm` 与 `utils/` 共享）的详细论证见 **[package-design.md](package-design.md)**。

#### 3.2.1 关于 `adapter` 一词的三种含义（澄清）

由于"adapter"在不同上下文指代不同对象，新人极易混淆。本仓库共三种 adapter：

| 位置 | 适配什么 | 归属 |
|---|---|---|
| `packages/ohbaby-agent/src/adapters/` | **UI 后端**：实现 SDK 的 `UiBackendClient` 协议（in-process / persistent / 未来 remote） | 留 `ohbaby-agent` |
| `packages/ohbaby-agent/src/sandbox/adapters/` | **沙箱执行环境**：实现 `SandboxAdapter`（host-local / 未来 container / SSH） | 未来进 `ohbaby-host` |
| `packages/ohbaby-agent/src/services/providers/` | **LLM vendor SDK**：实现 `ProviderInstance`（Anthropic / OpenAI-compat / 未来 Gemini） | 未来进 `ohbaby-llm` |

**反模式**：不要因为它们同名就以为可以合并或互换归属。详细论证见 [package-design.md §6](package-design.md)。

### 3.3 关于 TUI 不独立成包的决定

TUI 渲染层 **不** 单独成 `ohbaby-tui-renderer` 之类的包，而是固定为 `ohbaby-cli/src/tui/`。理由：

- 当前 TUI 强依赖 `ohbaby-cli` 内部 store / command runtime，自然耦合。
- TUI 的稳定接口已经由 `ohbaby-sdk`（`UiBackendClient` + DTO）承担，**包边界不需要再画一道**。
- TUI 的复用面是 0（不会有第二个消费者）。
- 拆出去要付出 package.json + tsconfig + 发布版本管理成本，零收益。

---

## 四、迁移动作清单

> 实施时按此清单一次性完成。每一步都对应 §1.3 的某个耦合点。

### 4.1 包与目录

- [x] `git mv packages/ohbaby-tui packages/ohbaby-cli`
- [x] 在新包内 `mkdir src/tui` 并将原 `src/*` 全部移入（保留文件名）
- [x] 新建 `packages/ohbaby-cli/src/index.ts`：`export * from "./tui/index.js";`

### 4.2 包元数据

- [x] `packages/ohbaby-cli/package.json`：
  - `name`: `"ohbaby-cli"`
  - `description`: 改为 "CLI front-end for ohbaby-agent (Ink-based TUI + future non-interactive surfaces)" 或同义中文
  - `main` / `types` / `exports` 保持指向 `dist/index.*`
- [x] `packages/ohbaby-cli/tsup.config.ts`：`entry: ["src/index.ts"]`（不再是 `src/index.tsx`，因为 index 变成纯 re-export）

### 4.3 TS 工程引用

- [x] `tsconfig.base.json#paths`：`ohbaby-tui` 键名改为 `ohbaby-cli`，值改为 `packages/ohbaby-cli/src/index.ts`
- [x] 根 `tsconfig.json#references`：`./packages/ohbaby-tui` → `./packages/ohbaby-cli`
- [x] `packages/ohbaby-cli/tsconfig.json`：`rootDir`/`outDir` 不变，`references` 不变
- [x] 删除 `packages/ohbaby-cli/tsconfig.tsbuildinfo`（迁移后让 `tsc -b` 重建）

### 4.4 后端引用

- [x] `packages/ohbaby-agent/package.json#dependencies`：`"ohbaby-tui": "workspace:*"` → `"ohbaby-cli": "workspace:*"`
- [x] `packages/ohbaby-agent/src/bin.ts`：`await import("ohbaby-tui")` → `await import("ohbaby-cli")`
- [x] `packages/ohbaby-agent/tsup.config.ts`：若 `external` 中包含 `ohbaby-tui` 字面量，改为 `ohbaby-cli`

### 4.5 测试

- [x] `vitest.config.ts`：
  - React 三个 alias 的 `replacement` 路径：`packages/ohbaby-tui/...` → `packages/ohbaby-cli/...`
  - `ohbaby-tui` alias 项：`find` 与 `replacement` 一并更新；目标文件路径改为 `packages/ohbaby-cli/src/index.ts`
- [x] 三个测试文件中的 `from "ohbaby-tui"` 改为 `from "ohbaby-cli"`：
  - `tests/integration/tui/main-chain.integration.test.tsx`
  - `tests/integration/tui/persistent-display.integration.test.tsx`
  - `tests/smoke/tui-real-provider.smoke.test.tsx`

### 4.6 文档

- [x] `README.md`、`packages/ohbaby-cli/README.md`、`packages/ohbaby-agent/README.md`、`packages/ohbaby-sdk/README.md` 中的 `ohbaby-tui` 全部替换
- [x] `docs/cli/architecture.md`：补一节说明「cli 一词在本仓库的两种语义」——
  - 文档章节 `docs/cli/`：描述 `packages/ohbaby-agent/src/bin.ts` 即 composition root（启动顺序、stdin/stdout 渲染）
  - 包 `packages/ohbaby-cli/`：CLI **前端**应用（Ink TUI 渲染 + 未来的非交互渲染）
- [x] `docs/ohbaby-sdk/architecture.md`、`docs/ui/**`、`docs/implementation/tui-productization/**` 中的 `ohbaby-tui` 全部替换
- [x] `docs/superpowers/plans/2026-05-20-tui-productization-and-npm.md`：历史文档，可加注释 "ohbaby-tui 已于 YYYY-MM-DD 重命名为 ohbaby-cli"，不强制改正文

### 4.7 锁文件与构建

- [x] `pnpm install`（自动重写 `pnpm-lock.yaml`，引用 `ohbaby-cli`）
- [x] `pnpm run typecheck`
- [x] `pnpm run test`
- [x] `pnpm run build`

### 4.8 PR 标题建议

`refactor(packages): rename ohbaby-tui to ohbaby-cli; nest renderer under src/tui/`

---

## 五、非目标（本轮不做）

- ❌ `command/` 模块内部重构（消除 SDK/TUI 重复 parser、引入 `OhbabySlashIntent` 联合、busy 派生从 snapshot 读取）：作为 Phase 1 独立 PR 推进，见 [ohbaby-cli-roadmap.md](ohbaby-cli-roadmap.md)
- ❌ TUI 样式 / 布局 / 颜色优化：Phase 2/3 独立任务，全部在 `packages/ohbaby-cli/src/tui/` 内进行
- ❌ 后端拆包（`ohbaby-ai` / `ohbaby-runtime-host` 等）：MVP 之后再议（§3.2）
- ❌ 把 `packages/ohbaby-agent/src/cli/` 迁入 `ohbaby-cli`：留到非交互模式需要扩展时再做（迁移会牵动 `bin.ts` 启动顺序，与本轮重命名解耦更清晰）
- ❌ 修改 `UiBackendClient` 接口 / SDK 任何契约
- ❌ 改变 `bin` 字段：仍是 `ohbaby-agent` 包提供 `ohbaby` 命令，本次只换前端包名

---

## 六、风险与回滚

**风险点**：

1. **vitest react alias 物理路径**：当前 alias 物理指向 `packages/ohbaby-tui/node_modules/react/...`。迁移后必须确认 pnpm 把 React 装到了 `packages/ohbaby-cli/node_modules/react/`。如果出现 hoist 行为变化，alias 需要相应调整为 workspace root 的 react。
2. **dynamic import 的字符串**：`bin.ts` 的 `await import("ohbaby-tui")` 是字符串字面量，TS 编译期不会报未找到——必须在 §4.7 `pnpm run test` 中由 integration 测试覆盖。
3. **tsbuildinfo 缓存**：composite 项目的 `tsconfig.tsbuildinfo` 持有旧路径，删除以避免增量编译失败。

**回滚**：若 §4.7 任一步骤失败，`git revert` 整个 PR；不需要数据迁移、不影响用户数据。

---

## 七、参考

- [package-design.md](package-design.md) — 工作区五包架构总规范（包含 ohbaby-llm / ohbaby-host 详细设计、adapter 三种含义、模块映射表、对照 kimi/pi 的取舍）
- [ohbaby-cli-roadmap.md](ohbaby-cli-roadmap.md) — 本文档之后的完整阶段路线（Phase 1 command 重构、Phase 2/3 主题与布局、Phase 5+ 后端拆分）
- [tui-design.md](tui-design.md) — TUI 职责、样式/布局原则、验收标准与测试标准
- [docs/cli/architecture.md](../../cli/architecture.md) — 当前 CLI composition root 描述
- [docs/ohbaby-sdk/architecture.md](../../ohbaby-sdk/architecture.md) — SDK 协议层定位
- 参考项目 layout：`D:/Projects/Code-cli/kimi-code/apps/kimi-code/`（cli + tui 同级子目录）、`D:/Projects/Code-cli/ohbaby-agent/pi/packages/coding-agent/`（独立 CLI 应用包）
