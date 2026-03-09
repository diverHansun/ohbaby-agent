# Colors 调色板

## 一、职责

colors.ts 定义样式系统的原始色值（palette）。这是样式系统的最底层，只包含颜色值本身，不含语义含义。

所有原始色值在此集中定义，tokens.ts 引用 palette 建立语义映射。组件不直接引用 palette。

---

## 二、Palette 定义

```typescript
export const palette = {
  // 灰阶
  white:       '#FFFFFF',
  gray300:     '#A0A0A0',
  gray500:     '#666666',
  gray700:     '#444444',
  gray900:     '#1A1A1A',

  // 主色
  blue:        '#00BFFF',
  green:       '#00FF00',
  yellow:      '#FFFF00',
  red:         '#FF0000',
  cyan:        '#00CED1',

  // 变体
  greenSoft:   '#90EE90',
  redSoft:     '#FF6B6B',
  blueDim:     '#5F87AF',
} as const
```

---

## 三、色值选择依据

### 灰阶

| 名称 | 色值 | 选择理由 |
|------|------|---------|
| white | #FFFFFF | 终端亮白色，主要文本 |
| gray300 | #A0A0A0 | 中灰，辅助文本（对应 Ink 的 dimColor 效果） |
| gray500 | #666666 | 深灰，弱化元素（已中止工具、边框等） |
| gray700 | #444444 | 暗灰，边框和分隔线 |
| gray900 | #1A1A1A | 接近黑色，选中项背景高亮 |

### 主色

| 名称 | 色值 | 选择理由 |
|------|------|---------|
| blue | #00BFFF | 深天蓝，对标 Claude Code 的强调色。高饱和度在暗色终端醒目 |
| green | #00FF00 | 终端经典亮绿，成功/完成/用户消息 |
| yellow | #FFFF00 | 终端经典亮黄，警告/等待 |
| red | #FF0000 | 终端经典亮红，错误 |
| cyan | #00CED1 | 暗青色，链接文本。与 blue 区分但同色系 |

### 变体

| 名称 | 色值 | 选择理由 |
|------|------|---------|
| greenSoft | #90EE90 | 柔和绿，diff 添加行。降低饱和度减少视觉干扰 |
| redSoft | #FF6B6B | 柔和红，diff 删除行。与错误红区分 |
| blueDim | #5F87AF | 暗蓝，hunk 头等弱化蓝色元素 |

---

## 四、终端兼容性

### 色值格式

所有色值使用 hex 格式（`#RRGGBB`）。Ink 通过 chalk 支持 hex 色值，在 256 色终端会自动降级到最接近的 ANSI 色。

### 降级策略

MVP 不实现主动降级。如果终端不支持 256 色（极少数情况），Ink/chalk 的内置降级已足够。未来可通过 ThemeManager 提供 ANSI-only 主题。

---

## 五、使用约束

1. **组件不直接引用 palette**：组件通过 `theme` 对象（ThemeManager 导出）访问颜色，而非直接导入 palette
2. **tokens.ts 是唯一消费者**：palette 只被 tokens.ts 引用，建立语义映射
3. **色值不可运行时修改**：palette 使用 `as const`，色值在编译期确定
4. **新增色值需评估**：添加新颜色前，先确认现有色值是否已覆盖需求

---

## 六、文档自检

- [x] 所有色值有 hex 值和选择理由
- [x] 灰阶/主色/变体三类分组清晰
- [x] 终端兼容性已说明
- [x] 使用约束已明确（组件不直接引用）
- [x] 总计 13 个色值，覆盖组件文档中出现的全部颜色需求
