# 1. 现状与问题分析

> 时间口径：2026-11-22，`main` 分支 `f3b2fff9`。下文路径都相对 `apps/ohbaby-web/src/ui/`。

## 1.1 问题陈述

1. **一件事分成两个入口。** "这轮用哪个模型、想多深"是一次决定，现在要点两个控件。思考强度还会随模型变化（换模型后原来的强度可能不支持），两个控件分开放，用户看不出它们之间的关系。
2. **样式不统一。** 模型按钮是文字按钮加自绘菜单，思考强度是原生 `<select>` 加脑袋图标，弹出的样子由浏览器决定，和其他菜单不一致。
3. **底部一行太挤。** 右侧依次是模型（最宽 220px）、思考强度、发送，语音输入要在这一行加麦克风和波形，没有余量。
4. **手机上要去两个地方。** 手机（小于 640px）把思考强度收进"更多"菜单，模型按钮还在外面，同一件事分在两处。

## 1.2 已确认的分界

见 [00 §2](00-discussion.md#2-已确认目标与范围)：一个按钮、一个菜单；菜单里模型列表加一行"Effort ›"；后端不改；只做 Web。

## 1.3 ohbaby-web 输入框控件现状

### 1.3.1 职责（goals-duty）

| 组件 | 职责 |
|---|---|
| `composer/ComposerControls.tsx` | 输入卡片底部一行：手机"更多"、权限、空白、模型、思考强度、发送或停止（D22）。它调用 `useReasoning`，把同一份思考强度状态同时交给桌面控件和手机"更多"菜单 |
| `composer/ModelMenu.tsx` | 模型按钮和菜单：按提供方分组列出配置完整的模型，打勾标出下一轮用的模型，默认模型带灰色 `default` 标记，底部固定"Manage models…"。列表达到 9 个时出现筛选框（`FILTER_FROM`） |
| `composer/ReasoningControl.tsx` | 桌面的思考强度控件：识别中显示转圈的脑袋图标，未知时显示 `unknown` 或"某档 · inactive"，识别成功后是原生 `<select>` |
| `composer/ComposerMoreMenu.tsx` | 手机"更多"菜单：思考强度二级列表和 Full access 开关（D29） |
| `composer/useReasoning.ts` | 思考强度的状态：读当前模型的思考能力，按会话保存用户的选择，模型变了就清掉不再支持的选择 |

### 1.3.2 结构（architecture）

`ModelMenu` 和思考强度状态不在同一个地方创建：

```
SessionScreen.tsx
  └─ <Composer modelControl={<ModelMenu .../>} modelEntry={...}>   ← 模型菜单在这里创建，作为现成的节点传下去
        └─ ComposerControls
              ├─ useReasoning(client, session, onReasoningChange, modelEntry)   ← 思考强度状态在这里创建
              ├─ ComposerMoreMenu reasoning={...}
              ├─ {modelControl}                                                 ← 原样放进去
              └─ ReasoningControl state={...}
```

`modelControl` 是一个已经渲染好的 React 节点（`session/SessionScreen.tsx` 里的 `modelControl={<ModelMenu .../>}`），`ModelMenu` 拿不到 `useReasoning` 的结果。合并时要让两者碰头，这是本议题唯一一处结构调整。

### 1.3.3 数据（data-model）

需要的数据都已经有了，不用加字段：

- `ohbaby-sdk` 的 `UiReasoningCapabilityView`（`packages/ohbaby-sdk/src/contract/connect-model.ts`）：`status`（detecting / identified / unknown）、`mode`（none / binary / effort）、`supportsDisabled`、`efforts`、`default`。
- `UiSettingsModel.reasoning`（`packages/ohbaby-sdk/src/contract/settings.ts`）：每个设置条目都带上面的能力。
- `useReasoning` 返回的 `ReasoningState` 已经把这些整理成四种界面状态：`hidden`、`detecting`、`unknown`、`choice`（含 `value`、`options`、`error`、`select`）。桌面控件和手机菜单都只读它。

### 1.3.4 数据流（dfd-interface）

- 选模型：`ModelMenu` 调 `onSelect(id)`，选择先挂起，等会话事件回传后才算生效；失败时恢复原来的文字并走 `onError`。
- 选强度：`ReasoningState.select(value)` → `client.updateSessionReasoning` 按会话保存；草稿（还没有会话）时只走 `onReasoningChange`。
- 换模型后：`useReasoning` 收到新的 `modelEntry` 或 `model.invalidated` 事件，重新读能力；原来的强度不支持就清空，回落到 `entry.reasoningDefault` 或能力里的 `default`。

这条链路本议题不动，只换展示方式。

### 1.3.5 用例（use-case）

| 用例 | 现在怎么做 |
|---|---|
| 只换模型 | 点模型按钮 → 选一项 → 菜单关闭 |
| 只换强度 | 点思考强度下拉 → 选一项 |
| 换模型再调强度 | 两个控件各点一次；换模型后强度可能被清空，但界面上没有提示两者有关 |
| 手机上换强度 | 点"更多" → Reasoning Effort → 选一项 |
| 模型不支持思考 | 思考强度控件消失（`hidden`），模型按钮位置不变 |

### 1.3.6 非功能（non-functional）

- **宽度**：输入卡片最宽 784px。底部一行全宽时右侧大约有 250px 空白，640–720px 时只剩约 100px（`composer/controls.css`）。模型按钮最宽 220px，420px 以下限制到 120px，思考强度 `<select>` 限制到 82px。
- **可访问性**：思考强度控件用 `aria-label="Reasoning effort"`，识别中是 `role="status"`，保存失败是 `role="alert"`。合并后这些语义不能丢。
- **键盘**：共用的 `shared/Menu.tsx` 已支持二级菜单（换 `level` 时焦点回到第一项，`onEscape` 退回上一级）和筛选框（`data-menu-filter="false"` 的项不参与筛选）。

### 1.3.7 测试（test）

| 测试文件 | 覆盖 | 合并后的影响 |
|---|---|---|
| `apps/ohbaby-web/src/ui/App.unit.test.tsx`（约 5980–6180 行） | 通过 `[aria-label="Reasoning effort"]` 找到 `<select>`，检查识别中、未知、切换、模型变化后清空等行为 | 这些测试要改成"打开模型菜单 → 进入 Effort → 选一项"，行为断言保留 |
| `composer/model-refresh.integration.test.tsx` | 模型菜单列表刷新、选择挂起与回传 | 菜单里多了 Effort 一行，断言要容纳它 |
| `composer/Composer.unit.test.tsx` | 输入框整体 | 基本不受影响 |

手机"更多"菜单里的思考强度二级列表目前没有单独的测试文件，靠 `App.unit.test.tsx` 间接覆盖。

## 1.4 文档与实现对照

| 文档说 | 代码做 | 差距 |
|---|---|---|
| `docs/ohbaby-web/redesign-2026-10/README.md` D22：右边是模型、思考强度、圆形发送 | 一致 | 合并后要改成"模型与思考强度（一个按钮）、圆形发送" |
| `03-ui-layout-and-style.md` 线框 `[gpt-5 v] [Med v] (^)` | 一致 | 线框要改成 `[gpt-5 Med v] (^)` |
| `05-components.md` 的 `ComposerControls`、`ModelMenu`、`ComposerMoreMenu` 三节 | 一致 | `ModelMenu` 要写进 Effort 二级；`ComposerMoreMenu` 只剩 Full access；`ReasoningControl` 删掉 |
| D29：手机"更多"里有 Thinking 二级列表和 Full access | 一致 | 改成只放 Full access |

## 1.5 改动影响面（现状视角）

- 会动：`composer/ModelMenu.tsx`、`composer/ComposerControls.tsx`、`composer/ComposerMoreMenu.tsx`、`composer/ReasoningControl.tsx`（删除）、`composer/Composer.tsx`、`session/SessionScreen.tsx`（传参方式）、`composer/controls.css`。
- 不动：`composer/useReasoning.ts` 的逻辑、`ohbaby-sdk`、后端。
- 测试：`App.unit.test.tsx` 里思考强度相关的几组用例、`model-refresh.integration.test.tsx`。

## 1.6 SWE 原则审视

- **内聚**：模型和思考强度是一个决定，却分在两个组件。合并后由 `ModelMenu` 负责"这轮用什么模型、多深"，内聚更好。
- **耦合**：`useReasoning` 已经是一份状态供两处读，合并后读的地方从两处变成一处（手机和桌面都走合并按钮），耦合下降。
- **KISS / YAGNI**：不加新组件、不加新接口、不引入滑块等新交互，复用现有的 `Menu` 二级能力和 `ReasoningState`。
- **可逆**：纯前端展示调整，随时能退回，不涉及数据和协议。

## 1.7 与既有文档关系

`docs/ohbaby-web/redesign-2026-10/` 是 Web 界面的权威设计文档，本议题改动的是其中 D22、D29 的描述。实施时在那边补一条新决定并更新 03、05 两篇（见 02 §2.5）。改动范围小，不另建模块级 `improve-N/` 文档。
