# 03 — 优秀项目借鉴：opencode / claude-code / kimi-code

## 1. 对比总览

| 维度 | opencode | claude-code | kimi-code | ohbaby-agent (目标) |
|------|----------|-------------|-----------|---------------------|
| **Provider 管理命令** | `/connect` | `/provider` (`/api`) | `/login` | `/connect` ✨ |
| **模型切换命令** | `/model` | `/model` | `/model` | `/models` (增强) |
| **配置格式** | JSON/JSONC | JSON | TOML | JSON |
| **API Key 存储** | `auth.json` (0o600) | 环境变量 / Keychain | `config.toml` (0o600) | `.env` 文件 |
| **OAuth 支持** | ✅ (多 provider) | ✅ (Anthropic) | ✅ (Kimi Code) | ❌ (本期不做) |
| **多 Provider** | ✅ 20+ SDK | ✅ 7 种 (anthropic/openai/gemini/grok/bedrock/vertex/foundry) | ✅ 6 种 | ✅ 2 种 (openai-compatible / anthropic) |
| **自动模型发现** | ✅ models.dev | ✅ 内置 | ✅ API `/models` | ❌ (本期不做) |
| **交互方式** | TUI 对话框 + CLI | TUI 选择器 + CLI | TUI 选择器 | ConnectPanel 表单 + 非敏感 CLI 参数 |

---

## 2. opencode 深度分析

### 2.1 Provider 连接流程 (`/connect`)

opencode 的 `/connect` 是全功能的 provider 连接入口，流程设计非常成熟：

```
Footer: "Get started /connect"
           │
           ▼
    DialogProvider (dialog-provider.tsx)
    ┌─────────────────────────────────────┐
    │  Sorted provider list:              │
    │  ✓ OpenCode (connected)             │
    │    OpenAI                           │
    │    Anthropic                        │
    │    GitHub Copilot                   │
    │    Google                           │
    │    ... (20+)                        │
    └─────────────────────────────────────┘
           │ 选择 provider
           ▼
    Auth Method Selection
    ┌─────────────────────────────────────┐
    │  OAuth: 浏览器打开 → 自动回调        │
    │  OAuth+Code: 显示URL → 粘贴code      │
    │  API Key: 直接输入                   │
    └─────────────────────────────────────┘
           │ 认证完成
           ▼
    DialogModel (自动打开)
    ┌─────────────────────────────────────┐
    │  Favorites / Recents / All models   │
    │  模糊搜索 + 收藏 + 模型详情           │
    └─────────────────────────────────────┘
```

**可借鉴的设计：**
1. **Provider 列表 + 连接状态**：展示所有可用的 provider，已连接的显示 ✓
2. **Auth 后自动切模型选择**：连接成功 → 立即弹出模型选择器
3. **收藏/最近使用**：`~/.opencode/state/model.json` 持久化模型选择历史

### 2.2 Provider 配置结构

```jsonc
// opencode.json
{
  "provider": {
    "my-custom": {
      "api": "https://api.example.com/v1",
      "name": "My Provider",
      "env": ["MY_API_KEY"],           // 环境变量名
      "options": {
        "baseURL": "https://...",      // 自定义 base URL
        "timeout": 300000
      }
    }
  },
  "model": "my-custom/gpt-4"           // 当前激活模型
}
```

**可借鉴的设计：**
1. **`env` 数组声明**：provider 定义所需环境变量，系统自动检测是否已配置
2. **`model` ID 格式**：`provider/model` 双段式，清晰表达归属
3. **`whitelist/blacklist`**：控制可用模型范围

### 2.3 API Key 安全

- 存储位置：`~/.opencode/data/auth.json`
- 写入权限：`0o600`（仅 owner 可读写）
- 分离存储：config 文件不存 key，auth 文件独立
- 环境变量兜底：先查 env var，再查 auth.json

```typescript
// opencode/packages/opencode/src/auth/index.ts:79
yield* fsys.writeJson(file, { ...data, [norm]: info }, 0o600)
```

**可借鉴的设计：**
1. **auth.json 独立存储**：config 和 credential 物理分离
2. **0o600 权限**：文件级安全
3. **auth type 三元组**：`api / oauth / wellknown`，扩展性好

---

## 3. claude-code 深度分析

### 3.1 `/provider` 命令

claude-code 的 `/provider` 是最简洁的 provider 切换方案：

```bash
# 命令格式
/provider [anthropic|openai|gemini|grok|bedrock|vertex|foundry|unset]

# 示例
/provider openai    # 切换到 OpenAI
/provider anthropic # 切回 Anthropic (默认)
/provider unset     # 清除配置
```

**实现机制：**
```typescript
// claude-code/src/commands/provider.ts
// 1. 写入 userSettings.modelType
// 2. 检查对应 API Key 是否已设置
// 3. 提示用户设置缺失的环境变量
```

**可借鉴的设计：**
1. **极简参数**：只需 provider 名，不需要额外参数
2. **自动检测**：切换时检查 API Key 是否就绪，缺失时给出明确提示
3. **`unset` 子命令**：快速恢复默认

### 3.2 `/model` 命令 + ModelPicker

```typescript
/model              # 打开交互式 ModelPicker
/model sonnet       # 直接切换到 sonnet
/model --info       # 显示当前模型详情
```

**ModelPicker 功能：**
- 按用户 tier 分组显示（Max / Pro / PAYG / Enterprise）
- 左右箭头切换 effort level（low/medium/high/max）
- 空格键切换 1M context
- 选择后立即生效，写入 `userSettings`

**可借鉴的设计：**
1. **alias 系统**：`sonnet` → 自动解析到当前默认 sonnet 版本
2. **多参数组合**：model + effort + context 一次交互完成
3. **直接传参模式**：`/model sonnet` 跳过交互，立即生效

### 3.3 Settings 层级系统

```
policySettings  (MDM/remote, 最高优先级)
      ↓
flagSettings    (--settings CLI flag)
      ↓
localSettings   (.claude/settings.local.json, gitignored)
      ↓
projectSettings (.claude/settings.json, 项目级)
      ↓
userSettings    (~/.claude/settings.json, 全局)
```

**可借鉴的设计：**
1. **分层 settings**：项目级 vs 用户级 vs 本地级，优先级清晰
2. **settings.local.json**：gitignored 的本地覆盖文件，适合存 API key

---

## 4. kimi-code 深度分析

### 4.1 `/login` 命令

kimi-code 用 `/login` 统一处理认证和配置：

```
/login
  ├── "Kimi Code" → OAuth (device code flow)
  │     └── 成功后自动拉取模型列表 → 写入 config.toml
  │
  ├── "Moonshot AI (moonshot.ai)" → API Key
  │     └── 输入 key → 调用 /models API → 显示模型选择器
  │
  └── "Moonshot AI (moonshot.cn)" → API Key
        └── 同上
```

**可借鉴的设计：**
1. **认证 + 配置一体化**：login 完成后自动发现模型列表
2. **Platform 选择器**：不同平台不同认证方式
3. **API 模型发现**：`GET /v1/models` 自动拉取可用模型

### 4.2 配置格式 (TOML)

```toml
# ~/.kimi-code/config.toml

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
oauth = { storage = "file", key = "oauth/kimi-code" }

[providers.my-openai]
type = "openai"
api_key = "sk-xxx"
base_url = "https://api.openai.com/v1"

[models.my-gpt4]
provider = "my-openai"
model = "gpt-4"
max_context_size = 128000
capabilities = ["image_in", "tool_use"]

default_model = "my-gpt4"
```

**可借鉴的设计：**
1. **Provider + Model 分离**：provider 定义连接，model alias 定义使用方式
2. **capabilities 声明**：模型能力前置声明（thinking, image_in, tool_use）
3. **max_context_size**：为 token 预算提供基础数据

### 4.3 安全实现

```typescript
// kimi-code/packages/agent-core/src/config/toml.ts
mkdir(dirname(filePath), { recursive: true, mode: 0o700 });  // 目录 0o700
open(filePath, 'wx', 0o600);                                  // 文件 0o600
```

**可借鉴的设计：**
1. **目录 0o700 + 文件 0o600**：双重文件权限保护
2. **OAuth token 分离存储**：API key 和 OAuth token 使用不同存储路径

---

## 5. 关键设计决策总结

| 设计决策 | opencode | claude-code | kimi-code | **ohbaby-agent 采用** |
|----------|----------|-------------|-----------|----------------------|
| 命令命名 | `/connect` | `/provider` | `/login` | **`/connect`** |
| 交互模式 | 对话框向导 | 参数直传 | 对话框向导 | **ConnectPanel 表单 + 非敏感参数模式** |
| API Key 输入 | TUI 输入框 | 环境变量 | TUI 输入框 | **TUI mask 输入 + 安全结构化提交** |
| Key 存储 | auth.json (0o600) | 环境变量 | config.toml (0o600) | **`.env` 文件 (现有方案保持)** |
| 模型发现 | models.dev 数据库 | 内置硬编码 | API 动态拉取 | **用户手动输入 (本期)** |
| 模型历史 | recents + favorites | 无 | 无 | **暂不做** |
| Provider 类型 | 20+ SDK | 7 种后端 | 6 种后端 | **2 种 (扩展性预留)** |
| 写入安全 | 0o600 + Effect transaction | 0o600 + lockfile | 0o600 + 0o700 dir | **temp-file rename (已有)** |

## 6. 核心借鉴要点

1. **opencode 的 `/connect` 交互入口**：provider 连接作为独立 TUI 对话框，而不是把敏感字段塞进普通命令输出
2. **claude-code 的 `/provider` 简洁设计**：一个参数搞定切换，自动检测 API Key 状态
3. **kimi-code 的 config 结构**：provider 与 model alias 分离，清晰易维护
4. **三者共同的安全实践**：API Key 与 config 物理分离，文件权限 0o600

---

## 7. 上下文窗口管理的参考做法

ohbaby-agent 面临的核心挑战：切换模型时如何同步 `contextWindowTokens`（详见 `05-context-window-sync.md`）。以下是三个参考项目的做法：

| 项目 | 上下文窗口来源 | provider 匹配逻辑 | 可借鉴点 |
|------|--------------|------------------|---------|
| **opencode** | models.dev 数据库（`cache/models.json`），每个模型有 `limit.context` | Provider ID 是 branded type，与 model ID 解耦；模型窗口独立于 provider 查询 | 第三方模型数据库是终极方案，但本期不引入 |
| **claude-code** | `configs.ts` 硬编码（12 个 `ModelConfig`），key 为 provider，value 为模型名及其窗口 | Provider 类型（`firstParty`/`openai`/`gemini`）与模型字符串分别在两个维度 | **直接借鉴**：provider 类型用于 API 路由，模型名前缀用于窗口查表——两者可独立 |
| **kimi-code** | `ModelAliasSchema.maxContextSize`（config.toml 中每模型字段）+ `GET /v1/models` API 动态发现 | Provider 类型是 `schema.ts` 中的 union type，与窗口解耦；用户可在 config 中覆盖 | **直接借鉴**：per-model 的 `maxContextSize` 作为显式配置项 |

**对 ohbaby-agent 的启发：**

- claude-code 和 kimi-code 都做到了 **provider 身份（API 路由）与模型窗口查表（按模型名前缀匹配）的解耦**。这正是 ohbaby-agent 当前 `modelProfiles.ts` 的问题所在——内置规则把 provider 和 modelPrefix 绑在了一起
- kimi-code 的 `ModelAliasSchema.maxContextSize` 是最简洁的方案：每个模型 alias 都有一个显式的 `maxContextSize`，用户可覆盖。ohbaby-agent 的 `model.json` → `models[]` 已经有相同结构，只需在 ConnectPanel 保存时自动填充或按用户输入覆盖
- opencode 的 models.dev 是终极方案但重——本期不引入
