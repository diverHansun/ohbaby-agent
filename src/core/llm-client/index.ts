/**
 * Public API for the LLM Client module.
 *
 * This module exports the core functions and types needed to interact
 * with the OpenAI API for chat completions.
 *
 * Design Principle: Interface Segregation
 * Consumers import only what they need. The module provides three categories:
 * 1. Functions: createLLMClient, streamChatCompletion
 * 2. Types: LLMClientInstance, StreamingResponse, etc.
 * 3. Error Classes: APIUserAbortError (for convenience)
 */

// Export core functions
export { createLLMClient } from './client.js';
export { streamChatCompletion } from './streaming.js';

// Export type definitions for consumers
export type {
  // Main interfaces
  LLMClientInstance,
  StreamingResponse,
  // Message and token types
  ChatCompletionMessage,
  TokenUsage,
  // Tool-related types
  ParsedToolCall,
  // Metadata types
  ChatFinishReason,
} from './types.js';

// Re-export error class for convenience
// Allows consumers to: import { APIUserAbortError } from '@/core/llm-client'
export { APIUserAbortError } from 'openai';
