# 一条 bash 命令连续弹出多次审批

本议题于 2026-11-23 记录，在 Web 审批卡片改版（[03 §4.6](../../ohbaby-web/redesign-2026-10/03-ui-layout-and-style.md)，D38）做真实页面验证时发现。这里只记问题和初步看法，正式分析和方案留到后续会话，按 plan-code-improvement 写 00–04。

## 现象（已证实）

在默认权限下，让模型执行：

```
rm -rf ./build && echo 'cleaned' > /tmp/clean.log
```

用户先看到一张审批卡片：

- 标题：`External path access requires confirmation: /private/tmp/clean.log`
- 内容：`external_directory_shell(/private/tmp/**)`

点了 Allow once 之后，同一条命令又弹出第二张：

- 标题：`Run this command?`
- 原因：`This command may be dangerous, so it needs your approval.`

用户的感受是"同一件事被问了两次"，而且第一张卡片看不到命令本身，只有一条内部规则。

## 原因（初步，已对照代码）

- 工具调度在执行 bash 前先跑预检（`core/tool-scheduler/scheduler.ts` 的 `confirmExternalPreflightPermissions`，约 1282 行起）。命令里每个工作区外的路径各弹一次审批（`toolName: "external_directory_shell"`），之后还有敏感路径的审批。
- 预检全部通过后，再按命令本身的风险走一次 bash 审批。
- 所以一条命令最多会弹出"外部路径数 + 敏感路径数 + 1"次审批，每次只问其中一部分。
- 前端只在 `info.type === "bash"` 时拿到原始命令（`adapters/app-events/permission-projection.ts`）。外部路径那次审批的类型不是 bash，所以卡片上只有规则原文。

## 补充核实（2026-11-23）

- **外部路径记住后还会不会弹 bash 卡（已证实：会）。** 权限只有 `default` 和 `full-access` 两档。`default` 下所有 bash 命令都要审批，只读命令也一样（`permission/evaluator.ts` 的兜底分支）。两张卡的 Always 记住的东西也不同：外部路径卡记 `external_directory_shell(<目录>/**)`，并把目录登记成可信根；bash 卡记命令前缀，例如 `bash(rm -rf ...)`。两条规则互不覆盖。所以在 `default` 下，碰到工作区外路径的命令必定至少弹两张卡。
- **外部路径审批不对应真实沙箱（已证实）。** 项目里的 sandbox 只做路径预检，没有系统层面的隔离（没有 seatbelt、bwrap 一类）。外部路径审批只是一道权限关卡，把它并进 bash 审批不会少掉实际防护。
- **参考项目（已对照代码）：**
  - Claude Code：路径检查是 bash 权限判断的一部分，一条命令永远只弹一张卡。卡上显示命令，Always 的选项写明"以后允许访问某目录"。
  - opencode：分开问，最多两次。所有外部目录先合成一次问，再问命令。重定向目标（如 `> /tmp/x`）不算外部目录。
  - Codex：不解析路径，由系统沙箱兜底，一般只问命令一次。
- **仍待核实：** 子代理触发时是否一样；TUI 表现是否相同（同一套后端，大概率一样）。

## 讨论结论

### 1. 方向：合成一次审批（已确认）

一条 bash 命令最多只弹一张审批卡，不再先做"只改展示"的过渡方案，因为改动集中在 `preflightCall` 和传给前端的字段，分两步做等于同一块代码改两遍。

做法：

1. **先判断，后提问。** 外部路径、敏感路径、命令风险三类检查先全部判断一遍，不弹卡。任何一项被拒绝，直接拒绝；全部放行，直接执行；剩下需要问的合成一张卡。
2. **Allow once** 一次放行这张卡上的全部内容。
3. **保留现有防护：** 黑名单路径照样直接拒绝；`full-access` 下照旧不弹卡；涉及敏感路径或命令分析不完整时，这张卡不能记住，只能 Allow once。

Always allow 记住什么、卡片怎么展示，见下面两项。

### 2. Always allow 记住什么（已确认）

卡上问到什么就记什么。卡上既问了命令又问了外部目录时，同时记住 `bash(命令前缀)` 和 `external_directory_shell(目录/**)`，并把目录登记成可信根。卡上只问了其中一项（另一项已被规则放行）时，只记那一项。

这样记下的规则和今天在两张卡上各点一次 Always 完全相同，不扩大放行范围。只用一个 Always 按钮，不做分别勾选命令和目录的复选框。涉及敏感路径或命令分析不完整时，不出现 Always 按钮（见第 1 项）。按钮文字放到第 3 项一起定。

### 3. 卡片展示（待讨论）

## 涉及位置

- `packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts`：预检和逐条确认
- `packages/ohbaby-agent/src/permission/`：策略判定和原因文案
- `packages/ohbaby-agent/src/adapters/app-events/permission-projection.ts`：传给前端的字段
- `apps/ohbaby-web/src/ui/permissions/ApprovalPanel.tsx`：卡片展示
