import "dotenv/config";

// Claude Code (and some IDE shells) export ANTHROPIC_BASE_URL pointing at a local
// proxy. If that leaks into this process the SDK silently talks to the wrong host.
delete process.env.ANTHROPIC_BASE_URL;

/**
 * Two ways to reach Claude:
 *   1. Anthropic direct  - ANTHROPIC_API_KEY  (x-api-key header)
 *   2. OpenRouter        - OPENROUTER_API_KEY (Authorization: Bearer)
 *
 * OpenRouter's "Anthropic Skin" speaks the real Messages API at
 * https://openrouter.ai/api/v1/messages, so the SDK and the whole agent loop
 * work unchanged - only the client construction and the model id differ.
 * OpenRouter wins if both keys are present.
 */
const useOpenRouter = !!process.env.OPENROUTER_API_KEY;

function resolveModel(id) {
  if (!useOpenRouter) return id;
  // OpenRouter namespaces models by vendor: anthropic/claude-opus-5
  return id.includes("/") ? id : `anthropic/${id}`;
}

export const config = {
  port: Number(process.env.PORT || 4123),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:4123",
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    base: "https://api.razorpay.com/v1",
  },
  llm: {
    provider: useOpenRouter ? "openrouter" : "anthropic",
    // The SDK appends /v1/messages to baseURL.
    baseURL: useOpenRouter ? "https://openrouter.ai/api" : undefined,
    authToken: useOpenRouter ? process.env.OPENROUTER_API_KEY : undefined,
    apiKey: useOpenRouter ? undefined : process.env.ANTHROPIC_API_KEY,
    model: resolveModel(process.env.MODEL_ID || "claude-opus-5"),
    effort: process.env.MODEL_EFFORT || "low",
    maxTokens: Number(process.env.LLM_MAX_TOKENS || 4096),
    // Failover: used automatically when the primary is rate-limited or out of credit.
    // "groq" pins Groq as the primary; otherwise it is only the failover.
    forceProvider: process.env.LLM_PROVIDER || "",
    groqKey: process.env.GROQ_API_KEY,
    groqModel: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
    // Anthropic-only request fields. If OpenRouter's skin rejects any of them,
    // set LLM_STRICT_COMPAT=true to drop them. Run `npm run smoke:llm` to find out.
    strictCompat: process.env.LLM_STRICT_COMPAT === "true",
  },
  voice: {
    fishKey: process.env.FISH_AUDIO_API_KEY,
    deepgramKey: process.env.DEEPGRAM_API_KEY,
    // "auto" resolves against whichever keys exist: STT prefers Deepgram
    // (free credits cover it), TTS prefers Fish (s2.1-pro-free is free).
    sttProvider: process.env.VOICE_STT_PROVIDER || "auto",
    ttsProvider: process.env.VOICE_TTS_PROVIDER || "auto",
    fishModel: process.env.FISH_AUDIO_MODEL || "s2.1-pro-free",
    fishVoiceId: process.env.FISH_AUDIO_VOICE_ID,
    dgSttModel: process.env.DEEPGRAM_STT_MODEL || "nova-3",
    dgTtsModel: process.env.DEEPGRAM_TTS_MODEL || "aura-2-thalia-en",
    language: process.env.VOICE_LANGUAGE || "",
    // Chrome's own recogniser is free and gives live interim captions, so it is
    // preferred where available; Deepgram covers every other browser.
    preferBrowserStt: process.env.VOICE_PREFER_BROWSER_STT !== "false",
    speed: Number(process.env.FISH_AUDIO_SPEED || 1),
  },
  demo: { forcePaymentFailure: process.env.DEMO_FORCE_PAYMENT_FAILURE === "true" },
};

/**
 * Validation is per-subsystem and lazy, so `npm run smoke:llm` works before the
 * Razorpay keys exist and `npm run smoke` works before the LLM key does.
 */
const isPlaceholder = (v) => !v || /x{6,}/i.test(v);

export function assertRazorpay() {
  const { keyId, keySecret } = config.razorpay;
  if (!keyId?.startsWith("rzp_test_"))
    throw new Error("RAZORPAY_KEY_ID must be a rzp_test_ key. This project is test-mode only.");
  if (isPlaceholder(keyId) || isPlaceholder(keySecret))
    throw new Error("Razorpay keys are still the placeholders from .env.example. Put real test keys in .env.");
}

export function assertLlm() {
  const key = config.llm.apiKey ?? config.llm.authToken;
  if (!key) throw new Error("Set either ANTHROPIC_API_KEY or OPENROUTER_API_KEY in .env");
  if (isPlaceholder(key))
    throw new Error(`${config.llm.provider === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY"} is still the placeholder from .env.example.`);
}
