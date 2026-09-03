import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { record } from "./audit.js";

/**
 * LLM transport with automatic failover.
 *
 * Primary  : Anthropic Messages API (direct, or OpenRouter's Anthropic Skin)
 * Fallback : Groq — OpenAI-shaped, so requests and responses are translated
 *
 * Both backends expose the slice of the Anthropic SDK's streaming interface
 * that src/agent.js uses: `.on("text", cb)` and `await .finalMessage()`.
 * The agent loop is unchanged and does not know which provider answered.
 */

const RETRY_AFTER_MS = 5 * 60_000;     // park a failing provider this long
let primaryBlockedUntil = 0;

/** Errors that mean "this provider can't serve me right now" - worth failing over. */
function isCapacityError(err) {
  const s = err?.status;
  if (s === 429 || s === 402 || s === 529 || s === 503) return true;
  const t = `${err?.message ?? ""} ${JSON.stringify(err?.error ?? "")}`.toLowerCase();
  return /rate.?limit|quota|credit|insufficient|payment_required|overloaded|capacity/.test(t);
}

// ── primary: Anthropic-shaped ────────────────────────────────────────────────

const anthropic = new Anthropic({
  ...(config.llm.baseURL ? { baseURL: config.llm.baseURL } : {}),
  ...(config.llm.authToken ? { authToken: config.llm.authToken } : { apiKey: config.llm.apiKey }),
  ...(config.llm.provider === "openrouter"
    ? { defaultHeaders: { "HTTP-Referer": config.publicBaseUrl, "X-Title": "Kaira - Agentic Commerce Rail" } }
    : {}),
});

// ── fallback: Groq (OpenAI chat-completions) ─────────────────────────────────

/** Anthropic message list -> OpenAI message list. */
function toOpenAiMessages(system, messages) {
  const out = [];
  const sysText = Array.isArray(system) ? system.map((b) => b.text).join("\n") : system;
  if (sysText) out.push({ role: "system", content: sysText });

  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }

    if (m.role === "user") {
      // tool_result blocks become individual `tool` messages
      const results = m.content.filter((b) => b.type === "tool_result");
      const texts = m.content.filter((b) => b.type === "text");
      for (const r of results) {
        out.push({ role: "tool", tool_call_id: r.tool_use_id,
                   content: typeof r.content === "string" ? r.content : JSON.stringify(r.content) });
      }
      if (texts.length) out.push({ role: "user", content: texts.map((t) => t.text).join("\n") });
      continue;
    }

    const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const calls = m.content.filter((b) => b.type === "tool_use").map((b) => ({
      id: b.id, type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
    out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
  }
  return out;
}

const toOpenAiTools = (tools) => (tools ?? []).map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

/** Groq's 429s carry "try again in 1.5s" / "in 30ms" - honour it instead of guessing. */
function retryDelayMs(msg = "") {
  const m = /try again in ([\d.]+)\s*(ms|s)/i.exec(msg);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Math.ceil(m[2].toLowerCase() === "ms" ? n : n * 1000);
}

/** Streams Groq and rebuilds an Anthropic-shaped Message. */
function groqStream({ system, messages, tools, max_tokens }) {
  const listeners = { text: [] };
  const done = (async () => {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.llm.groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.llm.groqModel,
        messages: toOpenAiMessages(system, messages),
        ...(tools?.length ? { tools: toOpenAiTools(tools), tool_choice: "auto" } : {}),
        max_tokens: max_tokens ?? 1200,
        temperature: 0.5,
        stream: true,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const e = new Error(body?.error?.message || `Groq HTTP ${res.status}`);
      e.status = res.status; e.error = body; e.provider = "groq";
      throw e;
    }

    let text = "";
    const calls = new Map();          // index -> {id, name, args}
    let finish = null, buf = "";

    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString("utf8");
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let j; try { j = JSON.parse(payload); } catch { continue; }
        const c = j.choices?.[0]; if (!c) continue;
        if (c.finish_reason) finish = c.finish_reason;

        const piece = c.delta?.content;
        if (piece) { text += piece; for (const fn of listeners.text) fn(piece); }

        for (const tc of c.delta?.tool_calls ?? []) {
          const slot = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          calls.set(tc.index, slot);
        }
      }
    }

    const content = [];
    if (text) content.push({ type: "text", text });
    for (const s of calls.values()) {
      let input = {};
      try { input = s.args ? JSON.parse(s.args) : {}; } catch {}
      content.push({ type: "tool_use", id: s.id || `call_${Math.random().toString(36).slice(2)}`, name: s.name, input });
    }
    return {
      content,
      stop_reason: calls.size ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn",
      _provider: "groq",
    };
  })();

  return {
    on(evt, fn) { listeners[evt]?.push(fn); return this; },
    finalMessage: () => done,
  };
}

/**
 * Groq's free tier is 8,000 tokens/minute, and this agent's system prompt plus
 * tool definitions is ~2k per call - so brushing the ceiling is normal, and the
 * window reopens in seconds. Wait the interval Groq names and try again.
 */
function groqStreamRetrying(params, attempts = 3) {
  const listeners = { text: [] };
  const done = (async () => {
    let last;
    for (let i = 0; i < attempts; i++) {
      const s = groqStream(params);
      s.on("text", (d) => { for (const fn of listeners.text) fn(d); });
      try { return await s.finalMessage(); }
      catch (err) {
        last = err;
        if (err.status !== 429 || i === attempts - 1) throw err;
        const wait = Math.max(retryDelayMs(err.message) ?? 0, 400) + i * 600;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw last;
  })();
  return { on(evt, fn) { listeners[evt]?.push(fn); return this; }, finalMessage: () => done };
}

/** Failover runs both ways: if Groq is exhausted too, try the primary again. */
function groqWithPrimaryBackstop(params, pinned) {
  const listeners = { text: [] };
  const done = (async () => {
    const g = groqStreamRetrying(params);
    g.on("text", (d) => { for (const fn of listeners.text) fn(d); });
    try { return await g.finalMessage(); }
    catch (err) {
      if (pinned || !isCapacityError(err)) throw err;
      record({ actor: "agent", action: "provider_failback",
        summary: `Groq is rate-limited too — trying ${config.llm.provider} again.`,
        reasons: [String(err.message ?? err).slice(0, 200)] });
      primaryBlockedUntil = 0;
      const s = anthropic.messages.stream(params);
      s.on("text", (d) => { for (const fn of listeners.text) fn(d); });
      return await s.finalMessage();
    }
  })();
  return { on(evt, fn) { listeners[evt]?.push(fn); return this; }, finalMessage: () => done };
}

// ── public surface ───────────────────────────────────────────────────────────

export const groqAvailable = () => !!config.llm.groqKey;
export const activeProvider = () =>
  (groqAvailable() && (config.llm.forceProvider === "groq" || Date.now() < primaryBlockedUntil)
    ? "groq" : config.llm.provider);

/**
 * Same call shape as `client.messages.stream(...)`. Falls back to Groq when the
 * primary is rate-limited or out of credit, and stays there briefly so we don't
 * retry a wall on every turn.
 */
export function stream(params) {
  const pinned = config.llm.forceProvider === "groq";
  const useGroq = groqAvailable() && (pinned || Date.now() < primaryBlockedUntil);
  if (useGroq) return groqWithPrimaryBackstop(params, pinned);

  const listeners = { text: [] };
  let failedOver = null;

  const done = (async () => {
    try {
      const s = anthropic.messages.stream(params);
      s.on("text", (d) => { for (const fn of listeners.text) fn(d); });
      return await s.finalMessage();
    } catch (err) {
      if (!isCapacityError(err) || !groqAvailable()) throw err;

      primaryBlockedUntil = Date.now() + RETRY_AFTER_MS;
      record({ actor: "agent", action: "provider_failover",
        summary: `${config.llm.provider} is rate-limited or out of credit — switched to Groq (${config.llm.groqModel}) for the next 5 minutes.`,
        reasons: [String(err.message ?? err).slice(0, 200)] });

      failedOver = groqStreamRetrying(params);
      failedOver.on("text", (d) => { for (const fn of listeners.text) fn(d); });
      return await failedOver.finalMessage();
    }
  })();

  return { on(evt, fn) { listeners[evt]?.push(fn); return this; }, finalMessage: () => done };
}
