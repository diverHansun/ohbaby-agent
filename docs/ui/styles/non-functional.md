# styles/ 非功能性约束

本文档定义 styles/ 模块在功能之外必须满足的工程约束。这些约束不是"未来想法"，而是**实现时需要主动保证**的边界条件。

对应职责追溯：goals-duty.md G5（Surface-Owned Rendering）；styles/index.md Non-Duties N2/N3/N6。

---

## 一、终端色彩兼容性

### 约束

styles/ 只使用 hex 格式色值（`#RRGGBB`）。**不手动处理 256 色 / ANSI 降级**，完全委托给 Ink + chalk 的内置降级机制。

### 行为定义

| 终端能力 | 期望行为 |
|---|---|
| 真彩（16M 色） | 输出 hex 精确色值，效果最佳 |
| 256 色 | chalk 自动映射到最接近的 256 色索引，视觉差异可接受 |
| 16 色 ANSI | chalk 降级到最近 ANSI 色；视觉效果退化但不崩溃 |
| 1 色（无色） | MVP 不主动支持。`NO_COLOR` 处理推迟到 v2（见 §五） |

### 实现要求

- palette 中的所有色值**必须是标准 6 位 hex**（`#RRGGBB`）。
- 不得在 tokens.ts 或 theme-manager.ts 中出现 ANSI 转义码、chalk 颜色名（`'blue'`）或 CSS 颜色名。
- 新增色值时，在 colors.md 的选择理由中说明为何在 256 色终端下仍然可辨识。

---

## 二、禁止硬编码颜色

### 约束

组件代码中**禁止直接出现 hex 色值或 ANSI 颜色字符串**。所有颜色必须通过 `theme.*` 的语义路径引用。

### 行为定义

```typescript
// ✅ 合规
<Text color={theme.tool.running}>{toolName}</Text>
<Text color={theme.dialog.toneDanger}>{deleteWarning}</Text>

// ❌ 违规
<Text color="#FF0000">错误信息</Text>
<Text color="red">错误信息</Text>
<Text color={palette.red}>错误信息</Text>
```

### 范围说明

- 适用于 `packages/ohbaby-tui/src/` 下的所有 tsx / ts 文件。
- `palette` 导出仅供极少数特殊场景（例如：测试用例验证 token 映射、Storybook 预览），不供组件使用。
- 违反此约束会使未来的主题切换无法生效，也会让"颜色由哪个 token 控制"无从追溯。

---

## 三、getter 代理的性能边界

### 约束

theme getter 代理每次访问都会调用 `themeManager.getTokens()`。MVP 阶段 `getTokens()` 仅返回内存中的对象引用，是同步的常量时间读取；不做 I/O、计算或复制。

### 行为定义

| 场景 | 期望 |
|---|---|
| 组件渲染时访问 `theme.text.primary` | 同步返回，无 I/O，无计算 |
| 高频渲染（流式响应期间，每帧多次访问） | 只做内存引用读取；不需要额外缓存 |
| `themeManager.setTheme()` 之后 | 下次访问 theme.* 立即反映新主题，不需要组件重渲染（MVP 不调用 setTheme，此路径未激活） |

### 实现要求

- `getTokens()` 只返回 `this.currentTokens` 引用，不做任何计算或复制。
- 不在 getter 代理里缓存子对象（`text / tool / ...`）——MVP 没有性能压力，缓存引入复杂性没有回报。

---

## 四、SemanticTokens 类型完整性

### 约束

`darkTokens` 的每个字段**必须覆盖 `SemanticTokens` 接口的所有 key**，不允许留空或 `undefined`。

### 行为定义

- TypeScript 类型检查在编译时强制执行。若新增 token 字段（如扩展 `dialog` 分组）时只更新类型定义而忘记在 `darkTokens` 赋值，**编译将报错**，不会进入运行时。
- 这是"类型即约束"——不需要运行时断言，类型系统已经保证。

### 实现要求

- `darkTokens` 声明类型为 `SemanticTokens`（而非 `Partial<SemanticTokens>` 或 `as const`），确保类型检查覆盖所有字段。
- 新增 token 分组时，必须**同时**修改：类型定义（tokens.ts）、darkTokens 赋值（tokens.ts）、getter 代理（theme-manager.ts）、tokens.md 文档。

---

## 五、已识别但推迟的约束（v2）

以下约束已识别为真实需求，但 MVP 不实现，不应在 MVP 代码中预埋占位逻辑：

| 约束 | 推迟理由 |
|---|---|
| `NO_COLOR=1` 无色模式 | 用户群体以开发者为主，终端均支持颜色；无色需求边缘化，但值得在 v2 支持 |
| OSC 11 终端背景检测（自动明暗切换） | 依赖终端协议支持，实现复杂，MVP 阶段暗色主题已满足主要使用场景 |
| 用户自定义主题（配置文件加载） | 需要定义配置格式 + 校验 + 合并策略，独立的 v2 功能 |
| 亮色主题 `lightTokens` | 依赖终端背景检测或用户配置，与上两项联动 |

这些项目在 **styles/theme-manager.md §六** 有扩展路径说明，但在当前实现中**不预埋**任何 hooks 或 flags。

---

## 六、文档自检

- [x] 终端兼容性：行为定义清晰，委托 Ink/chalk 降级，不手动处理
- [x] 禁止硬编码：有正例/反例代码示例，适用范围说明
- [x] getter 性能：常量时间、无 I/O、无复制的边界已说明
- [x] 类型完整性：编译期强制，新增字段的操作链已列出
- [x] v2 推迟项：明确标注，不预埋实现
