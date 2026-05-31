# 04 · interface providers 边界说明

> services/llm-model improve-1  
> 日期: 2026-05-31  
> 范围: 命名和职责边界说明

## 1. 问题

旧源码目录 `services/providers` 容易被理解成“LLM provider 管理模块”。本分支将它重命名为 `services/interface-providers`，因为代码职责实际是底层接口协议适配层：

- `openai-compatible.ts` 使用 OpenAI SDK 调 Chat Completions 兼容接口。
- `anthropic.ts` 使用 Anthropic SDK 调 Messages 接口。
- `index.ts` 根据 `interfaceProvider` 显式选择接口 adapter，缺省为 `openai-compatible`。

这与用户看到的 LLM provider 不同。

## 2. 推荐术语

| 术语 | 推荐含义 |
| --- | --- |
| LLM provider | 用户理解的模型提供商或配置归属，例如 `openai`, `deepseek`, `zhipu` |
| interface provider | 底层 API 协议，例如 `openai-compatible`, `anthropic` |
| provider adapter | 某个 interface provider 的实现，例如 OpenAI SDK adapter |

## 3. 当前方向

用户确认：当前所有模型切换先走 OpenAI-compatible 接口。也就是说：

```text
deepseek / zhipu / openrouter / custom
  -> interfaceProvider: openai-compatible
  -> services/interface-providers/openai-compatible.ts
```

因此第一分支的默认行为应是：

```typescript
apiConfig.interfaceProvider ?? "openai-compatible"
```

不再把 LLM provider 名称直接等同于接口协议。

## 4. 对现有 services/interface-providers 的影响

第一分支建议最小改动：

- 本分支完成目录重命名为 `services/interface-providers`。
- 保留 `createOpenAICompatibleProvider()`。
- 保留 `createAnthropicProvider()`。
- `CreateInterfaceProviderOptions` 增加可选 `interfaceProvider`。
- `createInterfaceProvider()` 优先使用 `interfaceProvider`；缺省为 `openai-compatible`。

伪代码：

```typescript
export function createInterfaceProvider(options: CreateInterfaceProviderOptions): InterfaceProviderInstance {
  const kind = options.interfaceProvider ?? "openai-compatible";
  return kind === "anthropic"
    ? createAnthropicProvider(options)
    : createOpenAICompatibleProvider(options);
}
```

## 5. 为什么本分支执行重命名

目录重命名会影响：

- imports。
- docs。
- tests。
- 可能的构建输出和 package exports。

但它直接服务于本分支的核心边界：`provider` 表示模型提供商或配置归属，`interfaceProvider` 表示底层 API 协议。若继续保留 `services/providers`，后续多厂商 LLM provider 管理模块会和接口协议适配层产生命名冲突。

## 6. 当前命名结果

本分支结果：

```text
packages/ohbaby-agent/src/services/providers/
  -> packages/ohbaby-agent/src/services/interface-providers/

ProviderKind
  -> InterfaceProviderKind

ProviderInstance
  -> InterfaceProviderInstance

CreateInterfaceProviderOptions
  -> CreateInterfaceProviderOptions
```

重命名时需要同步：

- `docs/services/interface-providers/*`
- `core/llm-client`
- provider tests
- tsconfig/build 引用
