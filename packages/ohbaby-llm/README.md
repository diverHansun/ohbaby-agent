# ohbaby-llm

Provider-neutral LLM streaming clients for OpenAI-compatible Chat Completions, OpenAI Responses, and Anthropic Messages. Requires Node.js >= 24 and ES modules.

Import the public API from `ohbaby-llm`. The package exports only its root entry; internal `src` and `dist` paths are not public subpaths. It has no runtime dependencies on other ohbaby workspace packages.

## Usage

Supply an already resolved and validated `LLMConfig`. The factory is synchronous and does not load or validate configuration files. Your application owns secret loading and configuration validation.

```typescript
import {
  createLLMClientFromConfig,
  streamResponse,
  type LLMConfig,
} from "ohbaby-llm";

// Values below come from your application's validated configuration.
const config: LLMConfig = {
  provider: "openai",
  interfaceProvider: "openai-compatible",
  model: "your-model-id",
  apiKey: "your-resolved-api-key",
  baseUrl: "https://api.openai.com/v1",
  promptCache: "auto",
  maxTokens: 1024,
};
const client = createLLMClientFromConfig(config);

for await (const frame of streamResponse(client, [
  { role: "user", content: "Hello" },
])) {
  // Accumulated text for display, rather than a text delta.
  console.log(frame.messageSnapshot.content ?? "");
}
```

The returned client config omits the plaintext API key. Protocol selection uses `interfaceProvider`; `provider` is a route identifier. Omitting the protocol in `createInterfaceProvider` selects Chat Completions, and unknown protocol kinds fail.

## API and boundaries

- `createLLMClientFromConfig` creates a provider-backed client. An optional `tokenUsageReporter` callback receives normalization diagnostics.
- `streamResponse` consumes owned `ModelMessage` and `ModelToolDefinition` types and yields response snapshots, reasoning, usage, and retry/request observations. It supports cancellation and request-level settings, idle timeout, and retry policy overrides.
- The package also exports provider factories/contracts, native-state validation, reasoning helpers, prompt cache helpers, and pure configuration types, validation, and model-profile functions.

A provider finish event is provisional until the stream exhausts and validation succeeds. Consumers must finish iterating and apply their own result acceptance and tool permission checks. Local cancellation returns real partial output with `user_aborted`; empty EOF without a provider terminal event is a failure. Parsed calls do not authorize tool execution.

All three built-in adapters set SDK `maxRetries: 0`, disabling SDK retries. The application retry layer defaults to five additional attempts for eligible failures before any text, reasoning, tool fragment, or finish signal; it does not replay partial output. Context overflow and summary transport recovery are left to the caller. Token usage reports provider measurements, not local estimates; missing details remain unknown.

This package does not load configuration from files or environment variables, install a global proxy, execute tools, or persist sessions. The adapters temporarily remove SDK custom-header environment variables during synchronous client construction and restore them in `finally`; this isolates SDK defaults while preserving configured credentials and protocol headers. In `ohbaby-agent`, the existing asynchronous `createLLMClient` wrapper handles configuration IO and diagnostics before calling this factory. Model probing, token estimates, and UI reasoning capability views remain in agent.
