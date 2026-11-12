# LLM 配置模块数据流与接口

## 上下文与范围

本模块读取模型库及环境凭证，接收 Settings/connect 的配置变更，提供脱敏读取视图和完整运行配置。Web/TUI 只表达用户覆盖与选择；供应商发现和预算解析由后端负责。

## 数据流描述

### 流程1：初始化配置加载

```text
读取 model.json
  → 缺版本：展开旧格式并迁移数字；版本 2：归一化；其他版本拒绝
  → 清理已知不可发送的 Anthropic 模型默认偏好（只改内存）
  → 过滤异 routeKey 自动证据
  → 解析有效 context/output，保留单模型 tokenBudgetIssue
  → 解析项目环境凭证 → LLMConfig
```

读取不写文件、不发起探测。`loadModelEntryConfig(options, entryId?)` 读取目标条目；`getLLMConfig()` 为默认模型旧调用方保留缓存。不存在的显式条目可回退默认，存在但连接不完整的条目拒绝运行。

### 流程2：保存、发现与热重载

```text
Create / Patch / connect → 校验用户输入 → 配置锁内原子发布
  ├─ 写入失败：回滚保护，不启动有效探测
  └─ 保存成功：返回 → 锁外自动发现
      context metadata → context 终态通知
      reasoning metadata / 必要主动探测 → reasoning 终态通知
      写回时核对 generation + routeKey → 只写检测字段
```

新建、连接变化、unknown 时有修改的 Save、Detect again、设为默认是触发点。普通保存复用可信能力，Detect again 强制刷新自动能力；无关字段修改不打断在途发现。同路由重探失败保留旧值和 identified，附内存 reason；没有旧值才为 unknown。所有结束路径通知，启动、读取、热重载、准备新 run 均不探测。

`reloadLLMConfig()` 清缓存后重新加载；新 run 使用新快照，在途 run 保留旧快照。未知 reasoning 不阻塞新 run，按 service-default 发送；已知能力才应用、校验显式偏好。

### 流程3：错误处理

结构与字段值错误拒绝写入。数值组合不兼容仍可保存和读取，视图返回 `tokenBudgetIssue`，新 run 以 `MODEL_TOKEN_LIMITS_INCOMPATIBLE` 拒绝。探测失败不回滚 Save，也不清除同路由可信证据。错误和状态只携带固定原因，不返回凭证明文或指纹。

## 接口定义

### 接口1：读取

| 接口 | 返回与用途 |
| --- | --- |
| `readModelSettings(options?)` / `GET /v1/settings/models` | 完整有序模型库、默认条目及每项发现/预算状态 |
| `getCurrentModel({ sessionId?, modelEntryId? }?)` | 指定会话或草稿模型的下一轮配置；未指定则默认 |
| `loadModelEntryConfig(options, entryId?)` | 目标条目的完整运行 LLMConfig |
| `getLLMConfig(options?)` / `reloadLLMConfig(options?)` | 默认模型旧接口的缓存读取与重新加载 |

Settings/current-model 的共同数值契约：

```typescript
interface ModelSettingsNumericView {
  contextWindowTokens?: number;       // 用户覆盖
  maxOutputTokens?: number;           // 用户覆盖
  detectedContextWindowTokens?: number;
  effectiveContextWindowTokens: number;
  effectiveMaxOutputTokens: number;
  contextDiscovery: {
    status: "detecting" | "identified" | "unknown";
    reason?: string;
  };
  tokenBudgetIssue?: {
    code: "MODEL_TOKEN_LIMITS_INCOMPATIBLE";
    contextWindowTokens: number;
    maxOutputTokens: number;
  };
  reasoningNotice?: "unsupported-anthropic-effort-cleared";
}
```

有效 context 为覆盖→同路由检测→300000；有效输出为覆盖→32768。reasoning 能力视图另行返回；identified 可附失败 reason，不含 stale。Responses 的 max 受能力校验；Anthropic adaptive 不发布不可发送的 minimal。清理通知只在明确 reasoning 选择成功保存后清除，probe 不清除。

### 接口2：写入和探测

| 输入 | Create | Patch / connect |
| --- | --- | --- |
| 省略数值 | 无覆盖 | 保持匹配条目原覆盖；新 connect 为无覆盖 |
| 正整数 | 设置覆盖 | 设置覆盖 |
| null | 拒绝 | 删除覆盖 |
| 0、负数、小数、空字符串 | 拒绝 | 拒绝 |

`createModelEntry`、`updateModelEntry`、`selectModelEntry`、删除接口和 `applyActiveModelConfig` 共用发布协调。旧 `setActiveLLMConfig.maxTokens` 仍可用，但正式字段 `maxOutputTokens`（包括 null）优先。`probeModelEntry` 对 unknown 仍返回成功结果；独立只读 context probe 保留其既有数值接口，不接受 null 清空语义。

输入框只显示覆盖值。检测容量在字段旁以“自动”只读提示展示，未知时不显示 300000 数字。表单只提交脏字段，主动输入与检测值相同也属于覆盖；后台通知只刷新只读状态，不替换草稿或打开基线。清空已有覆盖提交 null。配置标签统一为 Reasoning Effort。

## 数据归属与责任

| 数据 | 所有者 | 责任 |
| --- | --- | --- |
| schema 2 模型库 | config/llm | 保存用户意图与带 routeKey 的证据；首次迁移写入前备份 |
| 凭证 | 用户环境/全局 env | 配置层解析；设置视图、事件与 model.json 不含凭证原文或派生值 |
| discovery 状态、reason、reasoningNotice | 当前进程 | 通知重新读取，不持久化，不建立重启恢复队列 |
| LLMConfig / RunModel | 运行层 | 有效数值、准入和主子代理一致快照；专用标题/摘要/probe 上限独立 |
| 表单草稿 | Web/TUI | 仅编辑覆盖和偏好，不把自动值提升为用户输入 |
