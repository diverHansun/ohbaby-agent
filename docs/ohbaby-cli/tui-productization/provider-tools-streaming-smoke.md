# Provider, Tool, And Streaming Smoke Notes

## Scope

This note records the 2026-05-20 closeout check for:

- Zhipu/BigModel OpenAI-compatible provider configuration.
- Real TUI smoke with the Tavily-backed `web_search` tool.
- Current TUI streaming/rendering boundary.

It does not add attachable server behavior, MCP, plugins, skills, or multi-client control.

## Provider Boundary

`apiConfig.baseUrl` is the SDK base URL prefix, not the final REST endpoint.

For Zhipu/BigModel OpenAI-compatible chat, use:

```json
{
  "provider": "zhipu",
  "defaultModel": "glm-5.1",
  "apiConfig": {
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKeyEnv": "ZAI_API_KEY"
  },
  "llmParams": {
    "temperature": 0.7,
    "maxTokens": 128000
  }
}
```

Do not include `/chat/completions` in `baseUrl`; the OpenAI-compatible SDK appends that path. The validation layer now rejects final endpoint paths such as `/chat/completions`, `/messages`, and `/responses`.

Provider routing is intentionally simple for MVP:

- `anthropic` and `claude` use the Anthropic Messages provider.
- All other provider ids use the OpenAI-compatible Chat Completions provider.

That keeps future providers such as Qwen/DashScope on the OpenAI-compatible path while preserving a dedicated Anthropic path.

## Tavily TUI Smoke

A temporary real smoke test rendered `OhbabyTerminalApp` with a persistent in-process backend, a real Zhipu OpenAI-compatible model, and a real Tavily API key supplied through environment variables.

Covered behavior:

- `/mode ask` updates the visible policy state.
- `/tools` shows `web_search` and `web_fetch` in ask mode, while edit tools such as `write` and `bash` are hidden.
- A real prompt caused the model to call `web_search`.
- The TUI displayed `tool web_search (completed)`.
- The run returned to idle.

The temporary smoke test file was removed after the run so no API key or provider secret is persisted in the repo.

## Streaming Boundary

The backend path is true streaming:

1. Provider SDK stream yields chunks.
2. `streamChatCompletion()` normalizes provider events.
3. Lifecycle accumulates full assistant content and computes `delta`.
4. Run manager publishes `message.part.delta`.
5. UI runtime attaches a stable `messageId`.
6. TUI store applies the delta by replacing the text part with the latest full content.

The current TUI rendering is basic but correct for MVP:

- Assistant text updates incrementally.
- Existing tests assert the visible text is not duplicated.
- The footer shows running/idle/error status.

The current TUI is not yet a polished typewriter/Markdown renderer:

- No paced rendering layer like opencode's `PacedMarkdown`.
- No Markdown/code-block/table renderer.
- No dedicated CJK or long-token hard-wrap helper.
- No assistant message metadata line for model, duration, interrupted state, or token activity.

## Reference Design Notes

- opencode: useful model for paced Markdown display and assistant metadata around streaming messages.
- Claude Code: useful model for keeping transcript rows, permissions, prompts, and theme primitives separate.
- DeepSeek-TUI: useful model for long text, CJK, and no-whitespace wrapping fixes.

Recommended P1 follow-up:

1. Add a small `StreamingText`/`PacedText` component behind the assistant text renderer.
2. Add Markdown-aware rendering for code blocks and lists.
3. Add hard-wrap helpers for CJK and long tokens.
4. Add a compact assistant meta line while a run is active.
5. Add screenshot/smoke coverage for streaming frames at narrow terminal widths.
