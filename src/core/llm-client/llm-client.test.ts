/**
 * Integration tests for the LLM Client module.
 *
 * Tests the createLLMClient and streamChatCompletion functions
 * with mocked config module and OpenAI API responses.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLLMClient, streamChatCompletion } from './index';
import type { LLMClientInstance } from './types';

// Mock the config module
vi.mock('../../config/index.js', () => ({
  getLLMConfig: vi.fn(),
}));

import { getLLMConfig } from '../../config/index.js';

describe('LLM Client Integration Tests', () => {
  const mockConfig = {
    provider: 'openai',
    model: 'gpt-4',
    apiKey: 'sk-test-123',
    baseUrl: 'https://api.openai.com/v1',
    temperature: 0.7,
    maxTokens: 4096,
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('createLLMClient', () => {
    it('should create client with config from config module', async () => {
      vi.mocked(getLLMConfig).mockResolvedValue(mockConfig);

      const client = await createLLMClient();

      expect(client).toBeDefined();
      expect(client.client).toBeDefined();
      expect(client.config).toBeDefined();
      expect(client.config.provider).toBe('openai');
      expect(client.config.model).toBe('gpt-4');
      expect(client.config.baseUrl).toBe('https://api.openai.com/v1');
      expect(client.config.temperature).toBe(0.7);
      expect(client.config.maxTokens).toBe(4096);
    });

    it('should not expose apiKey in returned config', async () => {
      vi.mocked(getLLMConfig).mockResolvedValue(mockConfig);

      const client = await createLLMClient();

      // apiKey should not be in the config object
      expect((client.config as any).apiKey).toBeUndefined();
    });

    it('should use different provider config', async () => {
      const zhipuConfig = {
        provider: 'zhipu',
        model: 'glm-4-plus',
        apiKey: 'zhipu-key-123',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        temperature: 0.2,
        maxTokens: 2048,
      };
      vi.mocked(getLLMConfig).mockResolvedValue(zhipuConfig);

      const client = await createLLMClient();

      expect(client.config.provider).toBe('zhipu');
      expect(client.config.model).toBe('glm-4-plus');
      expect(client.config.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
      expect(client.config.temperature).toBe(0.2);
      expect(client.config.maxTokens).toBe(2048);
    });

    it('should propagate ConfigError from config module', async () => {
      const configError = new Error('Configuration file not found');
      (configError as any).code = 'FILE_NOT_FOUND';
      vi.mocked(getLLMConfig).mockRejectedValue(configError);

      await expect(createLLMClient()).rejects.toThrow('Configuration file not found');
    });

    it('should have OpenAI SDK chat completions method', async () => {
      vi.mocked(getLLMConfig).mockResolvedValue(mockConfig);

      const client = await createLLMClient();

      expect(client.client.chat).toBeDefined();
      expect(client.client.chat.completions).toBeDefined();
      expect(typeof client.client.chat.completions.create).toBe('function');
    });
  });

  describe('streamChatCompletion', () => {
    let mockClient: LLMClientInstance;

    beforeEach(() => {
      mockClient = {
        client: {
          chat: {
            completions: {
              create: vi.fn(),
            },
          },
        } as any,
        config: {
          provider: 'openai',
          model: 'gpt-4',
          baseUrl: 'https://api.openai.com/v1',
          temperature: 0.7,
          maxTokens: 4096,
        },
      };
    });

    it('should accumulate text content from streaming chunks', async () => {
      const chunks = [
        {
          choices: [
            {
              delta: { content: 'Hello' },
              finish_reason: null,
              index: 0,
            },
          ],
        },
        {
          choices: [
            {
              delta: { content: ' world' },
              finish_reason: 'stop',
              index: 0,
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        },
      ];

      mockClient.client.chat.completions.create = vi.fn().mockResolvedValue(
        (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })()
      );

      const messages = [{ role: 'user' as const, content: 'Say hello' }];
      const responses: any[] = [];

      for await (const response of streamChatCompletion(mockClient, messages)) {
        responses.push(response);
      }

      expect(responses.length).toBe(2);

      // First chunk should have accumulated content
      expect(responses[0].completeMessage.content).toBe('Hello');
      expect(responses[0].isComplete).toBe(false);

      // Last chunk should have complete content
      expect(responses[1].completeMessage.content).toBe('Hello world');
      expect(responses[1].isComplete).toBe(true);
      expect(responses[1].finishReason).toBe('stop');
      expect(responses[1].tokenUsage?.total_tokens).toBe(15);
    });

    it('should accumulate and parse tool calls', async () => {
      const chunks = [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_123',
                    function: {
                      name: 'get_weather',
                      arguments: '{"location":"',
                    },
                  },
                ],
              },
              finish_reason: null,
              index: 0,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: 'NYC"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
              index: 0,
            },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 10,
            total_tokens: 30,
          },
        },
      ];

      mockClient.client.chat.completions.create = vi.fn().mockResolvedValue(
        (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })()
      );

      const messages = [{ role: 'user' as const, content: 'Get weather for NYC' }];
      const responses: any[] = [];

      for await (const response of streamChatCompletion(mockClient, messages)) {
        responses.push(response);
      }

      const lastResponse = responses[responses.length - 1];

      // Verify raw tool call accumulation
      const toolCall = lastResponse.completeMessage.tool_calls?.[0];
      expect(toolCall?.id).toBe('call_123');
      expect(toolCall?.function.name).toBe('get_weather');
      expect(toolCall?.function.arguments).toBe('{"location":"NYC"}');

      // Verify parsed tool call
      const parsedCall = lastResponse.parsedToolCalls?.[0];
      expect(parsedCall?.name).toBe('get_weather');
      expect(parsedCall?.arguments).toEqual({ location: 'NYC' });
    });

    it('should handle empty responses with default content', async () => {
      const chunks = [
        {
          choices: [
            {
              delta: {},
              finish_reason: 'stop',
              index: 0,
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 0,
            total_tokens: 10,
          },
        },
      ];

      mockClient.client.chat.completions.create = vi.fn().mockResolvedValue(
        (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })()
      );

      const messages = [{ role: 'user' as const, content: 'test' }];
      const responses: any[] = [];

      for await (const response of streamChatCompletion(mockClient, messages)) {
        responses.push(response);
      }

      const lastResponse = responses[responses.length - 1];
      expect(lastResponse.completeMessage.content).toBe('(Empty response)');
    });

    it('should use configuration from client instance', async () => {
      mockClient.config.model = 'gpt-4-turbo';
      mockClient.config.temperature = 1.0;
      mockClient.config.maxTokens = 128000;

      mockClient.client.chat.completions.create = vi.fn().mockResolvedValue(
        (async function* () {
          yield {
            choices: [
              {
                delta: { content: 'test' },
                finish_reason: 'stop',
                index: 0,
              },
            ],
          };
        })()
      );

      const messages = [{ role: 'user' as const, content: 'test' }];

      const iterator = streamChatCompletion(mockClient, messages);
      await iterator.next();

      const createCall = mockClient.client.chat.completions.create as any;
      const callArgs = createCall.mock.calls[0][0];

      expect(callArgs.model).toBe('gpt-4-turbo');
      expect(callArgs.temperature).toBe(1.0);
      expect(callArgs.max_tokens).toBe(128000);
    });

    it('should pass tools parameter to API', async () => {
      mockClient.client.chat.completions.create = vi.fn().mockResolvedValue(
        (async function* () {
          yield {
            choices: [
              {
                delta: { content: 'test' },
                finish_reason: 'stop',
                index: 0,
              },
            ],
          };
        })()
      );

      const messages = [{ role: 'user' as const, content: 'use tool' }];
      const tools = [
        {
          type: 'function' as const,
          function: {
            name: 'test_tool',
            description: 'Test tool',
            parameters: {
              type: 'object' as const,
              properties: {},
            },
          },
        },
      ];

      const iterator = streamChatCompletion(mockClient, messages, { tools });
      await iterator.next();

      const createCall = mockClient.client.chat.completions.create as any;
      const callArgs = createCall.mock.calls[0][0];

      expect(callArgs.tools).toEqual(tools);
    });

    it('should include stream_options in request', async () => {
      mockClient.client.chat.completions.create = vi.fn().mockResolvedValue(
        (async function* () {
          yield {
            choices: [
              {
                delta: { content: 'test' },
                finish_reason: 'stop',
                index: 0,
              },
            ],
          };
        })()
      );

      const messages = [{ role: 'user' as const, content: 'test' }];
      const iterator = streamChatCompletion(mockClient, messages);
      await iterator.next();

      const createCall = mockClient.client.chat.completions.create as any;
      const callArgs = createCall.mock.calls[0][0];

      expect(callArgs.stream).toBe(true);
      expect(callArgs.stream_options).toEqual({ include_usage: true });
    });
  });

  describe('Module exports', () => {
    it('should export createLLMClient and streamChatCompletion', () => {
      expect(typeof createLLMClient).toBe('function');
      expect(typeof streamChatCompletion).toBe('function');
    });

    it('should work with ES module imports', async () => {
      vi.mocked(getLLMConfig).mockResolvedValue(mockConfig);

      const client = await createLLMClient();

      expect(client).toBeDefined();
      const gen = streamChatCompletion(client, []);
      expect(typeof gen[Symbol.asyncIterator]).toBe('function');
    });
  });
});
