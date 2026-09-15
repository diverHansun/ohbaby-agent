import { describe, expect, it } from "vitest";
import {
  extractCacheUsageEvidence,
  extractCacheErrorCode,
} from "./responses-cache-evidence.js";

describe("passive native cache evidence", () => {
  it("keeps only safe error codes from JSON and streamed failures", () => {
    expect(
      extractCacheErrorCode(
        '{"error":{"code":"InvalidParameter","message":"private"}}',
      ),
    ).toBe("InvalidParameter");
    expect(
      extractCacheErrorCode(
        'data: {"type":"response.failed","response":{"error":{"code":"unsupported_parameter","message":"private"}}}\n\n',
      ),
    ).toBe("unsupported_parameter");
    expect(
      extractCacheErrorCode(
        'data: {"error":{"code":"private request text with spaces"}}\n\n',
      ),
    ).toBeUndefined();
    expect(extractCacheErrorCode('{"code":123,"message":"private"}')).toBe(123);
  });
  it("keeps only usage fields from all three SSE formats, including explicit zero", () => {
    const wire = [
      'data: {"choices":[{"delta":{"content":"private text"}}],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":0},"private":"omit"}}',
      'data: {"type":"response.completed","response":{"output":[{"secret":"omit"}],"usage":{"input_tokens":200,"output_tokens":6,"input_tokens_details":{"cached_tokens":80,"cache_write_tokens":20}}}}',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":180,"cache_creation_input_tokens":0,"output_tokens":1}}}',
      'data: {"type":"message_delta","usage":{"output_tokens":7}}',
      "data: [DONE]",
    ].join("\n\n");
    expect(extractCacheUsageEvidence(wire)).toEqual([
      {
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 0 },
      },
      {
        input_tokens: 200,
        output_tokens: 6,
        input_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
      },
      {
        input_tokens: 20,
        cache_read_input_tokens: 180,
        cache_creation_input_tokens: 0,
        output_tokens: 1,
      },
      { output_tokens: 7 },
    ]);
  });

  it("preserves missing cache details rather than manufacturing zero", () => {
    expect(
      extractCacheUsageEvidence(
        'data: {"usage":{"input_tokens":100,"output_tokens":5}}\n\n',
      ),
    ).toEqual([{ input_tokens: 100, output_tokens: 5 }]);
    expect(
      extractCacheUsageEvidence(
        'data: not-json\n\ndata: {"error":{"message":"private"}}\n\n',
      ),
    ).toEqual([]);
  });
});
