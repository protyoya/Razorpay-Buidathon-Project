/**
 * LLM PREFLIGHT. Run: `npm run smoke:llm`
 * Verifies your provider (Anthropic direct or OpenRouter) accepts the exact
 * request shape src/agent.js sends. Tests each feature separately so a failure
 * tells you WHICH field to drop rather than just "400".
 */
import Anthropic from "@anthropic-ai/sdk";
import { config, assertLlm } from "../src/config.js";

assertLlm();

const { provider, baseURL, apiKey, authToken, model } = config.llm;
const client = new Anthropic({
  ...(baseURL ? { baseURL } : {}),
  ...(authToken ? { authToken } : { apiKey }),
  ...(provider === "openrouter"
    ? { defaultHeaders: { "HTTP-Referer": config.publicBaseUrl, "X-Title": "Kaira - Agentic Commerce Rail" } }
    : {}),
});

console.log(`\n  provider : ${provider}`);
console.log(`  baseURL  : ${baseURL ?? "https://api.anthropic.com (default)"}`);
console.log(`  model    : ${model}\n`);

const results = [];
async function probe(label, params, critical = true) {
  try {
    const r = await client.messages.create({ max_tokens: 64, ...params });
    results.push({ label, ok: true, critical });
    console.log(`  ✅ ${label}`);
    return r;
  } catch (e) {
    results.push({ label, ok: false, critical, err: e.message });
    console.log(`  ❌ ${label}\n       ${String(e.message).slice(0, 160)}`);
    return null;
  }
}

const HELLO = [{ role: "user", content: "Reply with exactly: ok" }];

await probe("basic message", { model, messages: HELLO });

await probe("system prompt + prompt caching (cache_control)", {
  model, messages: HELLO,
  system: [{ type: "text", text: "You are terse.", cache_control: { type: "ephemeral" } }],
}, false);

await probe("output_config.effort", {
  model, messages: HELLO, output_config: { effort: "low" },
}, false);

const TOOL = {
  name: "get_price",
  description: "Look up the price of a product by id.",
  input_schema: { type: "object", properties: { product_id: { type: "string" } },
                  required: ["product_id"], additionalProperties: false },
};
const t1 = await probe("tool use (non-strict)", {
  model, tools: [TOOL], messages: [{ role: "user", content: "What does sku_001 cost? Use the tool." }],
});
if (t1) console.log(`       stop_reason=${t1.stop_reason}` +
  (t1.stop_reason === "tool_use" ? " — model actually called the tool 👍" : " — ⚠️ did NOT call the tool"));

await probe("tool use with strict:true", {
  model, tools: [{ ...TOOL, strict: true }],
  messages: [{ role: "user", content: "What does sku_001 cost? Use the tool." }],
}, false);

// Streaming is what the chat UI depends on.
try {
  const s = client.messages.stream({ model, max_tokens: 64, messages: HELLO });
  let got = 0;
  s.on("text", () => got++);
  await s.finalMessage();
  results.push({ label: "streaming", ok: got > 0, critical: true });
  console.log(got > 0 ? `  ✅ streaming (${got} text deltas)` : "  ❌ streaming produced no deltas");
} catch (e) {
  results.push({ label: "streaming", ok: false, critical: true, err: e.message });
  console.log(`  ❌ streaming\n       ${String(e.message).slice(0, 160)}`);
}

const criticalFails = results.filter((r) => !r.ok && r.critical);
const optionalFails = results.filter((r) => !r.ok && !r.critical);

console.log("\n────────────────────────────────────────────────");
if (criticalFails.length) {
  console.log(" ❌ NOT USABLE. These must work:");
  criticalFails.forEach((r) => console.log(`    - ${r.label}`));
  console.log("\n    Check the key, and that the model id is right for this provider.");
  console.log(`    On OpenRouter, model ids are namespaced: anthropic/claude-opus-5`);
} else if (optionalFails.length) {
  console.log(" ⚠️  USABLE, but this gateway rejects some Anthropic-native fields:");
  optionalFails.forEach((r) => console.log(`    - ${r.label}`));
  console.log("\n    Set  LLM_STRICT_COMPAT=true  in .env to drop them and run anyway.");
  console.log("    Cost: slightly slower turns, no prompt caching. Everything still works.");
} else {
  console.log(" ✅ ALL GREEN — full Anthropic feature set works through this provider.");
}
console.log("────────────────────────────────────────────────\n");
process.exit(criticalFails.length ? 1 : 0);
