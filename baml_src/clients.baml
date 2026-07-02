// Cerebras is OpenAI-compatible; reuse the generic OpenAI provider.
// Mirrors backend/app/agents.py: CEREBRAS_API_KEY, CEREBRAS_BASE_URL from .env.
client<llm> Cerebras {
  provider openai-generic
  retry_policy TwoRetries
  options {
    base_url "https://api.cerebras.ai/v1"
    api_key env.CEREBRAS_API_KEY
    // ponytail: BAML client options don't take an env-var-with-default for a
    // plain string field, so this mirrors agents.MODEL_ID's default
    // ("gemma-4-31b", env FOUNDRY_MODEL_ID) hardcoded. Update here if the
    // model changes.
    model "gemma-4-31b"
    // mirrors the old raw-openai-client call's temperature=0.2,
    // max_tokens=FOUNDRY_MAX_OUTPUT_TOKENS default (8192).
    temperature 0.2
    max_tokens 8192
  }
}

retry_policy TwoRetries {
  max_retries 2
  strategy {
    type exponential_backoff
    delay_ms 300
    multiplier 1.5
    max_delay_ms 10000
  }
}
