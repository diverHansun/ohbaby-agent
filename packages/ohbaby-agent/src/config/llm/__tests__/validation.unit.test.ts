/**
 * Unit tests for validation functions.
 */

import { describe, it, expect } from "vitest";
import { validateModelJson } from "../validation.js";
import { ConfigError } from "../types.js";

describe("validateModelJson", () => {
  const validConfig = {
    provider: "openai",
    defaultModel: "gpt-4",
    apiConfig: {
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    llmParams: {
      temperature: 0.7,
      maxTokens: 4096,
    },
  };

  it("should pass for valid configuration", () => {
    expect(() => {
      validateModelJson(validConfig);
    }).not.toThrow();
  });

  it("should accept optional context window tokens", () => {
    const config = {
      ...validConfig,
      llmParams: {
        ...validConfig.llmParams,
        contextWindowTokens: 128_000,
      },
    };

    expect(() => {
      validateModelJson(config);
    }).not.toThrow();
  });

  it("should accept optional apiConfig.interfaceProvider", () => {
    const config = {
      ...validConfig,
      apiConfig: {
        ...validConfig.apiConfig,
        interfaceProvider: "openai-compatible",
      },
    };

    expect(() => {
      validateModelJson(config);
    }).not.toThrow();
  });

  it("should reject unknown apiConfig.interfaceProvider", () => {
    const config = {
      ...validConfig,
      apiConfig: {
        ...validConfig.apiConfig,
        interfaceProvider: "deepseek",
      },
    };

    expect(() => {
      validateModelJson(config);
    }).toThrow(ConfigError);
    try {
      validateModelJson(config);
    } catch (error) {
      expect((error as ConfigError).code).toBe("INVALID_FIELD");
    }
  });

  it("should accept user-registered model profiles", () => {
    const config = {
      ...validConfig,
      models: [
        {
          contextWindowTokens: 256_000,
          id: "openai:gpt-4o-large",
          label: "GPT-4o Large",
          maxOutputTokens: 32_000,
          model: "gpt-4o",
          provider: "openai",
        },
      ],
    };

    expect(() => {
      validateModelJson(config);
    }).not.toThrow();
  });

  it("should throw for null input", () => {
    expect(() => {
      validateModelJson(null);
    }).toThrow(ConfigError);
  });

  it("should throw for non-object input", () => {
    expect(() => {
      validateModelJson("string");
    }).toThrow(ConfigError);
  });

  it("should throw for missing provider", () => {
    const config = { ...validConfig, provider: undefined };
    expect(() => {
      validateModelJson(config);
    }).toThrow(ConfigError);
    expect(() => {
      validateModelJson(config);
    }).toThrow(/provider/);
  });

  it("should throw for missing defaultModel", () => {
    const config = { ...validConfig, defaultModel: undefined };
    expect(() => {
      validateModelJson(config);
    }).toThrow(ConfigError);
    expect(() => {
      validateModelJson(config);
    }).toThrow(/defaultModel/);
  });

  it("should throw for missing apiConfig", () => {
    const config = { ...validConfig, apiConfig: undefined };
    expect(() => {
      validateModelJson(config);
    }).toThrow(ConfigError);
    expect(() => {
      validateModelJson(config);
    }).toThrow(/apiConfig/);
  });

  it("should throw for missing apiConfig.baseUrl", () => {
    const config = {
      ...validConfig,
      apiConfig: { ...validConfig.apiConfig, baseUrl: undefined },
    };
    expect(() => {
      validateModelJson(config);
    }).toThrow(ConfigError);
    expect(() => {
      validateModelJson(config);
    }).toThrow(/baseUrl/);
  });

  it("should allow missing apiConfig.apiKeyEnv for keyless endpoints", () => {
    const config = {
      ...validConfig,
      apiConfig: { ...validConfig.apiConfig, apiKeyEnv: undefined },
    };
    expect(() => {
      validateModelJson(config);
    }).not.toThrow();
  });

  it("should reject invalid apiConfig.apiKeyEnv names", () => {
    for (const apiKeyEnv of ["1_BAD", "BAD-NAME", " OPENAI_API_KEY "]) {
      const config = {
        ...validConfig,
        apiConfig: { ...validConfig.apiConfig, apiKeyEnv },
      };

      expect(() => {
        validateModelJson(config);
      }).toThrow(ConfigError);
      try {
        validateModelJson(config);
      } catch (error) {
        expect((error as ConfigError).code).toBe("INVALID_FIELD");
      }
    }
  });

  it("should reject full endpoint URLs in apiConfig.baseUrl", () => {
    const config = {
      ...validConfig,
      apiConfig: {
        ...validConfig.apiConfig,
        baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      },
    };

    expect(() => {
      validateModelJson(config);
    }).toThrow(ConfigError);
    expect(() => {
      validateModelJson(config);
    }).toThrow(/SDK base URL/);
    try {
      validateModelJson(config);
    } catch (error) {
      expect((error as ConfigError).code).toBe("INVALID_FIELD");
    }
  });

  it("should throw for missing llmParams", () => {
    const config = { ...validConfig, llmParams: undefined };
    expect(() => {
      validateModelJson(config);
    }).toThrow(ConfigError);
    expect(() => {
      validateModelJson(config);
    }).toThrow(/llmParams/);
  });

  it("should throw for missing llmParams.temperature", () => {
    const config = {
      ...validConfig,
      llmParams: { ...validConfig.llmParams, temperature: undefined },
    };
    expect(() => {
      validateModelJson(config);
    }).toThrow(ConfigError);
    expect(() => {
      validateModelJson(config);
    }).toThrow(/temperature/);
  });

  it("should throw for temperature below 0", () => {
    const config = {
      ...validConfig,
      llmParams: { ...validConfig.llmParams, temperature: -0.1 },
    };
    expect(() => {
      validateModelJson(config);
    }).toThrow(ConfigError);
    try {
      validateModelJson(config);
    } catch (error) {
      expect((error as ConfigError).code).toBe("INVALID_TEMPERATURE");
    }
  });

  it("should throw for temperature above 2", () => {
    const config = {
      ...validConfig,
      llmParams: { ...validConfig.llmParams, temperature: 2.1 },
    };
    expect(() => {
      validateModelJson(config);
    }).toThrow(ConfigError);
    try {
      validateModelJson(config);
    } catch (error) {
      expect((error as ConfigError).code).toBe("INVALID_TEMPERATURE");
    }
  });

  it("should accept temperature at boundary 0", () => {
    const config = {
      ...validConfig,
      llmParams: { ...validConfig.llmParams, temperature: 0 },
    };
    expect(() => {
      validateModelJson(config);
    }).not.toThrow();
  });

  it("should accept temperature at boundary 2", () => {
    const config = {
      ...validConfig,
      llmParams: { ...validConfig.llmParams, temperature: 2 },
    };
    expect(() => {
      validateModelJson(config);
    }).not.toThrow();
  });

  it("should throw for missing llmParams.maxTokens", () => {
    const config = {
      ...validConfig,
      llmParams: { ...validConfig.llmParams, maxTokens: undefined },
    };
    expect(() => {
      validateModelJson(config);
    }).toThrow(ConfigError);
    expect(() => {
      validateModelJson(config);
    }).toThrow(/maxTokens/);
  });

  it("should throw for maxTokens <= 0", () => {
    const config = {
      ...validConfig,
      llmParams: { ...validConfig.llmParams, maxTokens: 0 },
    };
    expect(() => {
      validateModelJson(config);
    }).toThrow(ConfigError);
    try {
      validateModelJson(config);
    } catch (error) {
      expect((error as ConfigError).code).toBe("INVALID_MAX_TOKENS");
    }
  });

  it("should throw for negative maxTokens", () => {
    const config = {
      ...validConfig,
      llmParams: { ...validConfig.llmParams, maxTokens: -100 },
    };
    expect(() => {
      validateModelJson(config);
    }).toThrow(ConfigError);
  });

  it("should throw for non-integer maxTokens", () => {
    const config = {
      ...validConfig,
      llmParams: { ...validConfig.llmParams, maxTokens: 100.5 },
    };
    expect(() => {
      validateModelJson(config);
    }).toThrow(ConfigError);
  });

  it("should accept maxTokens = 1", () => {
    const config = {
      ...validConfig,
      llmParams: { ...validConfig.llmParams, maxTokens: 1 },
    };
    expect(() => {
      validateModelJson(config);
    }).not.toThrow();
  });

  it("should reject invalid context window tokens", () => {
    for (const contextWindowTokens of [0, -1, 100.5, "128000"]) {
      const config = {
        ...validConfig,
        llmParams: {
          ...validConfig.llmParams,
          contextWindowTokens,
        },
      };

      expect(() => {
        validateModelJson(config);
      }).toThrow(ConfigError);
    }
  });

  it("should reject invalid user-registered model profiles", () => {
    for (const modelProfile of [
      { model: "custom", contextWindowTokens: 0 },
      { model: "custom", contextWindowTokens: 128_000, maxOutputTokens: -1 },
      { contextWindowTokens: 128_000 },
      "custom",
    ]) {
      const config = {
        ...validConfig,
        models: [modelProfile],
      };

      expect(() => {
        validateModelJson(config);
      }).toThrow(ConfigError);
    }
  });

  it("should ignore extra fields", () => {
    const config = {
      ...validConfig,
      extraField: "ignored",
      apiConfig: {
        ...validConfig.apiConfig,
        extraNested: "also ignored",
      },
    };
    expect(() => {
      validateModelJson(config);
    }).not.toThrow();
  });
});
