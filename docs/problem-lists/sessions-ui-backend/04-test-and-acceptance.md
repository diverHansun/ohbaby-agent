# 04 — Sessions 测试与验收标准

> 创建日期: 2026-06-09
> 状态: 待实施后执行
> 原则: 遵循 SWE 原理，不为了通过测试而测试。每项测试对应真实的用户可感知行为。

---

## 1. 测试架构

```
                    ┌──────────────────────────┐
                    │   E2E  / Manual Visual    │
                    │   (卡片风格、翻页体验)      │
                    ├──────────────────────────┤
                    │   Integration Tests       │
                    │   (ESC 流程、命名流程)      │
                    ├──────────────────────────┤
                    │   Unit Tests              │
                    │   (TitleGenerator, 脱敏)   │
                    └──────────────────────────┘
```

- **Unit tests**: TitleGenerator、脱敏逻辑、title 截断逻辑
- **Integration tests**: ESC 取消流程、AI 命名端到端、当前 project active sessions 全量加载
- **E2E / manual**: 视觉卡片风格一致性、PgUp/PgDn 翻页流畅度

---

## 2. 单元测试

### 2.1 TitleGenerator

**测试文件**: `packages/ohbaby-agent/src/services/session/__tests__/title-generator.test.ts`

#### TEST-TG-01: 英文消息生成英文标题

```
Given: 用户首条消息 "Help me fix the login button on the mobile homepage"
When: 调用 generateTitle()
Then: 返回英文标题，3-7 词，sentence-case
```

**真实验证**: mock LLM 返回已知字符串，验证 cleanTitle 处理逻辑（去除引号、换行、多余空格）。

#### TEST-TG-02: 中文消息生成中文标题

```
Given: 用户首条消息 "帮我在移动端首页修复登录按钮的样式问题"
When: 调用 generateTitle()
Then: 返回中文标题，简洁概括主题
```

#### TEST-TG-03: LLM 调用失败时静默降级

```
Given: LLM 调用抛出异常
When: 调用 generateTitle()
Then: 返回空字符串 ""，不抛出异常
```

#### TEST-TG-04: 超时保护

```
Given: LLM 调用超过 5 秒
When: 调用 generateTitle()
Then: 返回空字符串或超时前已有结果
```

#### TEST-TG-05: Reasoning 模型 think 标签清理

```
Given: LLM 返回 "<think>分析一下...</think>\n修复登录按钮"
When: cleanTitle()
Then: 返回 "修复登录按钮"（去除 think 块）
```

#### TEST-TG-06: 标题过长截断

```
Given: LLM 返回超过 100 字符的标题
When: cleanTitle()
Then: 返回 97 字符 + "..."
```

### 2.2 安全脱敏

**测试文件**: `packages/ohbaby-agent/src/services/session/__tests__/prompt-sanitizer.test.ts`

#### TEST-DM-01: API Key 脱敏

```
Given: prompt 包含 "api-key=sk-abc123def456"
When: sanitizePrompt()
Then: 输出包含 "api-key=[redacted]"
```

#### TEST-DM-02: 私钥脱敏

```
Given: prompt 包含 "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
When: sanitizePrompt()
Then: 输出不包含原始私钥内容
```

#### TEST-DM-03: Bearer Token 脱敏

```
Given: prompt 包含 "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..."
When: sanitizePrompt()
Then: 输出包含 "Authorization: Bearer [redacted]"
```

### 2.3 临时标题截断

#### TEST-TT-01: 英文截断

```
Given: 英文首条消息 120 字符
When: truncateForTempTitle(text)
Then: 返回前 48 字符 + "…"
```

#### TEST-TT-02: 中文截断

```
Given: 中文首条消息 30 个汉字
When: truncateForTempTitle(text)
Then: 返回前 16 字符 + "…"
```

---

## 3. 集成测试

### 3.1 ESC 取消流程

**测试文件**: `packages/ohbaby-agent/src/commands/__tests__/sessions.test.ts`

#### TEST-ESC-01: ESC 不报错

```
Given: /sessions 命令弹出 session 列表
When: 用户按 ESC 键
Then:
  - 对话关闭，无错误输出
  - 不显示 "INTERACTION_CANCELLED" 错误
  - session 状态不变（active session 不受影响）
```

**验证方式**: mock interaction broker，发送 `{ kind: "cancelled" }` 响应，断言：
- `context.fail()` 未被调用
- 无 error 事件发布

#### TEST-ESC-02: ESC 后再次打开 /sessions 正常

```
Given: ESC 刚关闭了 /sessions
When: 用户再次输入 /sessions
Then: session 列表正常弹出（状态未被上一次 ESC 污染）
```

### 3.2 AI 命名端到端流程

#### TEST-AI-01: 首条消息触发命名

```
Given: 新建 session（title = "New session"）
When: 用户发送首条消息 "帮我想一个变量名"
Then:
  - 临时 title 变为 "帮我想一个变量名…"（截断）
  - TitleGenerator.generateTitle() 被异步调用
  - AI 完成后 session.title 更新为 AI 生成的标题
  - SessionEvent.Updated 事件发布
```

**验证方式**:
1. Mock LLM 返回固定标题
2. 确认 `generateTitle` 被调用且参数为首条消息
3. 确认 `sessionManager.update` 被调用且新 title 为 mock 返回值

#### TEST-AI-02: AI 命名失败不阻塞

```
Given: 新建 session
When: 首条消息发出，但 AI 命名线程报错
Then:
  - session 保留临时标题不变
  - 无异常传播到用户界面
  - 后续消息正常处理
```

#### TEST-AI-03: 非首条消息不触发命名

```
Given: session 已有 3 条消息（非首条）
When: 用户发送第 4 条消息
Then: TitleGenerator.generateTitle() 不被调用
```

**验证方式**: spy 检查 `generateTitle` 调用次数为 0。

#### TEST-AI-04: 手动命名后不被 AI 覆盖

```
Given: session 已被手动命名为 "My Custom Title"
When: 首条消息发出
Then: TitleGenerator.generateTitle() 不被调用（title !== "New session"）
```

### 3.3 当前 project sessions 全量加载

#### TEST-FL-01: 超过 50 条当前 project active sessions 全量加载

```
Given: 当前 project 有 150 条 active primary sessions
When: /sessions 请求 session interaction options
Then: 返回所有 150 条 active primary sessions
```

**验证方式**:
1. 注入超过 50 条当前 project active primary sessions
2. 同时注入 archived session、subagent session、其他 project session
3. 执行 `/sessions`
4. 断言 interaction options 只包含当前 project、`status === "active"`、非 subagent 的 sessions，且数量完整

#### TEST-FL-02: 按 updatedAt 由近到远排序

```
Given: 当前 project 有多条 active primary sessions，updatedAt/createdAt 不同
When: /sessions 请求 session interaction options
Then: options 按 updatedAt DESC, createdAt DESC 排序
```

**验证方式**: 构造乱序 sessions，断言第 1 项是最近 updatedAt；updatedAt 相同时 createdAt 较新的排前。

#### TEST-FL-03: Snapshot limit 不影响 /sessions

```
Given: PersistentUiStateStore.DEFAULT_SESSION_LIMIT 保持 50
When: 当前 project 有 150 条 active primary sessions
Then: /sessions 仍显示全部 150 条 metadata
```

**验证方式**: 断言 `/sessions` 数据源走 `listByProject`，不依赖 UI snapshot `readSessions` 或 `getRecent()` 默认 limit。

---

## 4. 视觉验收标准（Manual）

### 4.1 卡片风格一致性

| 检查项 | 标准 | 对比参照 |
|--------|------|----------|
| 边框样式 | `borderStyle="round"` | 同 skills/mcps/connect |
| 标题栏 | 左 bold accent，右 "esc" muted | 同 overlay-card.tsx |
| 宽度 | 24-88 列自适应 | 同 overlay-card.tsx |
| 内边距 | `paddingX={2} paddingY={1}` | 同 overlay-card.tsx |
| 选中项高亮 | `> title` accent 色 + bold | 同 SkillsPanel |

### 4.2 PgUp/PgDn 翻页

| 操作 | 预期行为 |
|------|----------|
| PgUp | 向上跳 10 条（到页首为止） |
| PgDn | 向下跳 10 条（到页尾为止） |
| ↑ | 上移 1 条 |
| ↓ | 下移 1 条 |
| ↑ 在顶部 | 无变化（clamp） |
| ↓ 在底部 | 无变化（clamp） |
| 翻页底栏 | 始终显示当前位置（如 `Showing 1-10 of 42 sessions · pgup/pgdn · ↑↓`） |

### 4.3 ESC 行为

| 场景 | 预期 |
|------|------|
| 打开 /sessions → ESC | 对话关闭，无任何错误输出 |
| 打开 /sessions → 上下移动 → ESC | 对话关闭 |
| ESC 后继续正常输入 | 命令输入正常，active session 不变 |

---

## 5. 回归检查表

以下功能不应受此次改动影响：

| 功能 | 验证方式 |
|------|----------|
| `/sessions` 选择 session 后成功切换 | 手动：选择其他 session → 确认已切换 |
| `/new` 创建新 session 正常 | 手动：/new → 检查 session 列表 |
| `/compact` 压缩功能正常 | 手动：有对话 → /compact |
| `/resume` 指定 ID 恢复 | 手动：/resume <session-id> |
| Session 创建后自动持久化到 SQLite | 集成测试 |
| Subagent session 不在列表中 | 集成测试 |
| 权限弹窗优先级高于 session 对话 | 手动：触发权限 → 确认弹窗先出现 |

---

## 6. 测试执行命令

```bash
# 运行所有 session 相关测试
pnpm --filter ohbaby-agent test -- --testPathPattern="session|title-generator|prompt-sanitizer"

# 运行集成测试
pnpm --filter ohbaby-agent test -- --testPathPattern="commands/__tests__/sessions"

# 类型检查
pnpm --filter ohbaby-agent typecheck
pnpm --filter ohbaby-cli typecheck
```
