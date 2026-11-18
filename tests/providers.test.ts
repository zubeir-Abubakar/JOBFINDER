import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPermittedModel,
  assertPinnedResolution,
  classifyGatewayError,
  classifyGatewayHealth,
  freeLlmConfigured,
  freeLlmPolicyIssue,
  isBillableModelId,
  ollamaConfigured,
  providerConfigured,
  scrubProviderError,
} from "../lib/providers.ts";

const MANAGED = [
  "FREELLMAPI_ENABLED",
  "FREELLMAPI_BASE_URL",
  "FREELLMAPI_API_KEY",
  "FREELLMAPI_MODEL",
  "FREELLMAPI_ALLOWED_MODELS",
  "FREELLMAPI_MODEL_ALIASES",
  "GEMINI_API_KEY",
  "OPENROUTER_ENABLED",
  "OPENROUTER_API_KEY",
  "OLLAMA_ENABLED",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "OLLAMA_CODER_MODEL",
];

function withEnv(values: Record<string, string | undefined>, fn: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const key of MANAGED) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const GATEWAY = {
  FREELLMAPI_ENABLED: "true",
  FREELLMAPI_BASE_URL: "http://127.0.0.1:31415/v1",
  FREELLMAPI_API_KEY: "test-key-not-real-000000",
  FREELLMAPI_MODEL: "gpt-oss-120b",
  FREELLMAPI_ALLOWED_MODELS: "gpt-oss-120b",
  OLLAMA_ENABLED: "false",
};

test("a pinned, catalogued, allowlisted model is permitted", () => {
  withEnv(GATEWAY, () => {
    assert.equal(freeLlmConfigured(), true);
    assert.equal(freeLlmPolicyIssue(), null);
    assert.equal(providerConfigured(), true);
    assert.doesNotThrow(() => assertPermittedModel("gpt-oss-120b"));
    assert.deepEqual(classifyGatewayHealth(200).kind, "ok");
  });
});

test("missing key is treated as unconfigured", () => {
  withEnv({ ...GATEWAY, FREELLMAPI_API_KEY: "" }, () => {
    assert.equal(freeLlmConfigured(), false);
    assert.equal(providerConfigured(), false);
  });
});

test("disabled gateway is unconfigured even with a key", () => {
  withEnv({ ...GATEWAY, FREELLMAPI_ENABLED: "false" }, () => {
    assert.equal(freeLlmConfigured(), false);
    assert.equal(providerConfigured(), false);
  });
});

test("auto and routing aliases are refused", () => {
  for (const alias of ["auto", "free-router", "fusion", "kilo-auto"]) {
    withEnv({ ...GATEWAY, FREELLMAPI_MODEL: alias }, () => {
      assert.match(freeLlmPolicyIssue() ?? "", /routing alias|refused/i);
      assert.equal(providerConfigured(), false);
      assert.throws(() => assertPermittedModel(alias), /routing aliases/i);
    });
  }
});

test("an empty allowlist permits nothing", () => {
  withEnv({ ...GATEWAY, FREELLMAPI_ALLOWED_MODELS: "" }, () => {
    assert.match(freeLlmPolicyIssue() ?? "", /ALLOWED_MODELS is empty/);
    assert.equal(providerConfigured(), false);
    assert.throws(() => assertPermittedModel("gpt-oss-120b"), /not listed/);
  });
});

test("the pinned model must appear in the allowlist", () => {
  withEnv({ ...GATEWAY, FREELLMAPI_ALLOWED_MODELS: "gemini-flash-lite" }, () => {
    assert.match(freeLlmPolicyIssue() ?? "", /not listed in FREELLMAPI_ALLOWED_MODELS/);
    assert.throws(() => assertPermittedModel("gpt-oss-120b"), /not listed/);
  });
});

test("the allowlist cannot bypass the billable-model policy", () => {
  withEnv({ ...GATEWAY, FREELLMAPI_MODEL: "claude-opus-4-5", FREELLMAPI_ALLOWED_MODELS: "claude-opus-4-5" }, () => {
    assert.equal(isBillableModelId("claude-opus-4-5"), true);
    assert.match(freeLlmPolicyIssue() ?? "", /billable vendor id/);
    assert.throws(() => assertPermittedModel("claude-opus-4-5"), /billable vendor id/);
  });
  withEnv({ ...GATEWAY, FREELLMAPI_ALLOWED_MODELS: "gpt-oss-120b,claude-sonnet-4-5" }, () => {
    assert.match(freeLlmPolicyIssue() ?? "", /never permitted/);
  });
});

test("exact resolution is accepted and unexpected substitution is refused", () => {
  withEnv(GATEWAY, () => {
    assert.doesNotThrow(() => assertPinnedResolution("gpt-oss-120b", "gpt-oss-120b"));
    assert.throws(() => assertPinnedResolution("gpt-oss-120b", "openai/gpt-oss-120b"), /declared alias/);
    assert.throws(
      () => assertPinnedResolution("llama-3.1-8b", "@cf/meta/llama-3.1-8b-instruct-fp8"),
      /Silent substitution is not permitted/,
    );
  });
});

test("a declared resolution alias is accepted, undeclared ones are not", () => {
  withEnv({ ...GATEWAY, FREELLMAPI_MODEL_ALIASES: "openai/gpt-oss-120b" }, () => {
    assert.equal(freeLlmPolicyIssue(), null);
    assert.doesNotThrow(() => assertPinnedResolution("gpt-oss-120b", "openai/gpt-oss-120b"));
    assert.throws(() => assertPinnedResolution("gpt-oss-120b", "openai/gpt-oss-20b"), /declared alias/);
  });
});

test("aliases cannot smuggle billable or routing ids", () => {
  withEnv({ ...GATEWAY, FREELLMAPI_MODEL_ALIASES: "claude-opus-4-5" }, () => {
    assert.match(freeLlmPolicyIssue() ?? "", /ALIASES contains ids that are never permitted/);
  });
  withEnv({ ...GATEWAY, FREELLMAPI_MODEL_ALIASES: "free-router" }, () => {
    assert.match(freeLlmPolicyIssue() ?? "", /ALIASES contains ids that are never permitted/);
  });
});

test("unreachable gateway is distinguishable from missing configuration", () => {
  const classified = classifyGatewayError(new TypeError("fetch failed"), "http://127.0.0.1:31415/v1");
  assert.equal(classified.kind, "unreachable");
  assert.match(classified.detail, /127\.0\.0\.1:31415/);
  assert.doesNotMatch(classified.detail, /API_KEY/);
});

test("authentication failure is classified without leaking the key", () => {
  const classified = classifyGatewayHealth(401, JSON.stringify({ error: { message: "Invalid API key" } }));
  assert.equal(classified.kind, "auth");
  assert.match(classified.detail, /FREELLMAPI_API_KEY was rejected/);
  assert.doesNotMatch(classified.detail, /test-key-not-real/);
});

test("Ollama disabled alone never makes a provider available", () => {
  withEnv({ OLLAMA_ENABLED: "false" }, () => {
    assert.equal(providerConfigured(), false);
  });
});

test("an unset FreeLLMAPI model does not disable a healthy Ollama fallback", () => {
  withEnv(
    {
      FREELLMAPI_ENABLED: "true",
      FREELLMAPI_BASE_URL: "http://127.0.0.1:31415/v1",
      FREELLMAPI_API_KEY: "test-key-not-real-000000",
      FREELLMAPI_MODEL: "",
      FREELLMAPI_ALLOWED_MODELS: "",
      OLLAMA_ENABLED: "true",
      OLLAMA_BASE_URL: "http://localhost:11434",
      OLLAMA_MODEL: "llama3.2:3b",
      OLLAMA_CODER_MODEL: "qwen2.5-coder:1.5b",
    },
    () => {
      assert.equal(freeLlmConfigured(), false, "an unset model leaves the gateway incomplete, not the fallback");
      assert.equal(ollamaConfigured(), true);
      assert.equal(providerConfigured(), true, "the enabled local fallback is a complete configuration on its own");
    },
  );
});

test("provider errors never expose the gateway key", () => {
  const secret = "super-secret-unified-key-value";
  withEnv({ ...GATEWAY, FREELLMAPI_API_KEY: secret }, () => {
    const scrubbed = scrubProviderError(`request failed with bearer ${secret} at gateway`);
    assert.doesNotMatch(scrubbed, new RegExp(secret));
    assert.match(scrubbed, /\[redacted\]/);
  });
});
