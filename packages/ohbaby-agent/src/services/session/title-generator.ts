import type {
  ChatCompletionMessage,
  LLMClientInstance,
} from "../../core/llm-client/index.js";
import { streamChatCompletion } from "../../core/llm-client/index.js";
import {
  isDefaultSessionTitle,
  sanitizePromptForSessionTitle,
} from "./prompt-sanitizer.js";

const DEFAULT_TITLE_GENERATION_TIMEOUT_MS = 5_000;
const GENERATED_TITLE_MAX_LENGTH = 80;
// Titles are at most ~80 characters; a small per-request cap keeps a
// misbehaving model from burning tokens until the timeout. Passed as a
// request option so the shared client config is never copied or mutated
// (a config-level override is how main-run output once got capped at 512).
export const TITLE_GENERATION_MAX_TOKENS = 128;

const TITLE_GENERATION_SYSTEM_PROMPT = [
  "Generate a concise title for a coding-agent chat session.",
  "Use the same language as the user's first message when practical.",
  "Reply with only the title: no JSON, no markdown, no quotes, no explanation.",
  "Keep it short: at most 8 English words or 24 CJK characters.",
  "Do not include credentials, tokens, keys, URLs with secrets, or private values.",
].join(" ");

export interface GenerateSessionTitleInput {
  readonly firstUserMessage: string;
  readonly llmClient: LLMClientInstance;
  readonly timeoutMs?: number;
}

export async function generateSessionTitle({
  firstUserMessage,
  llmClient,
  timeoutMs = DEFAULT_TITLE_GENERATION_TIMEOUT_MS,
}: GenerateSessionTitleInput): Promise<string | null> {
  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const messages: ChatCompletionMessage[] = [
    {
      content: TITLE_GENERATION_SYSTEM_PROMPT,
      role: "system",
    },
    {
      content: `First user message:\n${sanitizePromptForSessionTitle(
        firstUserMessage,
      )}`,
      role: "user",
    },
  ];

  const generation = collectGeneratedTitle(
    llmClient,
    messages,
    abortController.signal,
  ).catch((caught: unknown) => {
    logTitleGenerationFailure(caught);
    return null;
  });
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(
      () => {
        abortController.abort();
        resolve(null);
      },
      Math.max(0, timeoutMs),
    );
  });

  try {
    return await Promise.race([generation, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export function cleanGeneratedSessionTitle(rawTitle: string): string {
  let title = rawTitle
    .replace(/<think>[\s\S]*?<\/think>/giu, "")
    .replace(/```(?:json|text|markdown)?\s*([\s\S]*?)```/giu, "$1")
    .trim();

  const parsedTitle = parseJsonTitle(title);
  if (parsedTitle !== undefined) {
    title = parsedTitle;
  }

  title = stripWrappingQuotes(title)
    .replace(/^\s*(?:[-*]\s+|#+\s*)/u, "")
    .replace(/\s+/gu, " ")
    .trim();

  return truncateGeneratedTitle(stripWrappingQuotes(title));
}

/**
 * Title failures degrade gracefully (the temporary title stays), so they are
 * not surfaced to the UI. Gate diagnostics behind OHBABY_DEBUG: unconditional
 * stderr writes would corrupt the TUI frame.
 */
function logTitleGenerationFailure(caught: unknown): void {
  const debug = process.env.OHBABY_DEBUG;
  if (debug === undefined || debug === "") {
    return;
  }
  const message = caught instanceof Error ? caught.message : String(caught);
  process.stderr.write(
    `[ohbaby] session title generation failed: ${message}\n`,
  );
}

async function collectGeneratedTitle(
  llmClient: LLMClientInstance,
  messages: readonly ChatCompletionMessage[],
  signal: AbortSignal,
): Promise<string | null> {
  let rawTitle = "";
  for await (const response of streamChatCompletion(llmClient, [...messages], {
    maxTokens: TITLE_GENERATION_MAX_TOKENS,
    signal,
  })) {
    const content = response.completeMessage.content;
    if (typeof content === "string") {
      rawTitle = content;
    }
  }

  const cleaned = cleanGeneratedSessionTitle(rawTitle);
  return isDefaultSessionTitle(cleaned) ? null : cleaned;
}

function parseJsonTitle(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const title = (parsed as { readonly title?: unknown }).title;
      return typeof title === "string" ? title : undefined;
    }
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stripWrappingQuotes(value: string): string {
  let output = value.trim();
  for (;;) {
    const next = output.replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "").trim();
    if (next === output) {
      return output;
    }
    output = next;
  }
}

function truncateGeneratedTitle(value: string): string {
  if (value.length <= GENERATED_TITLE_MAX_LENGTH) {
    return value;
  }
  return `${value.slice(0, GENERATED_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}
