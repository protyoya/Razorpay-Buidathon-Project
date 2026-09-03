import fs from "node:fs";
import * as llm from "./llm.js";
import { config } from "./config.js";
import { toolDefs, execute, cartSnapshot } from "./tools.js";
import { record } from "./audit.js";

const { model, effort, strictCompat, maxTokens } = config.llm;

const SYSTEM = fs.readFileSync("src/prompts/system.md", "utf8");

/**
 * Keep the prompt bounded. A shopping conversation only needs recent context,
 * and the cart itself lives server-side rather than in the transcript. Trimming
 * never splits a tool_use from its tool_result - that pairing must stay intact.
 */
const MAX_TURNS = Number(process.env.LLM_HISTORY_TURNS || 12);
function trimHistory(session) {
  const m = session.messages;
  if (m.length <= MAX_TURNS) return;
  let cut = m.length - MAX_TURNS;
  // Walk forward to a plain user message so we never start mid tool exchange.
  while (cut < m.length && !(m[cut].role === "user" && typeof m[cut].content === "string")) cut++;
  if (cut < m.length) session.messages = m.slice(cut);
}

/** Request fields shared by every call, minus anything the gateway can't take. */
function baseParams() {
  const p = {
    model,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
  };
  // effort + prompt caching are Anthropic-native. OpenRouter's skin passes them
  // through, but drop them if your gateway 400s - see npm run smoke:llm.
  if (!strictCompat) p.output_config = { effort };
  else p.system = SYSTEM;
  return p;
}

/**
 * One turn of the manual agentic loop.
 * A manual loop (rather than the SDK tool runner) so we can stream text deltas
 * and audit events into the same SSE channel the UI listens on.
 *
 * @param emit  (event, data) => void  - pushes to the browser over SSE
 */
export async function runTurn({ session, userText, emit }) {
  record({ actor: "user", action: "message", summary: `Customer said: "${userText}"` });
  session.messages ??= [];
  session.messages.push({ role: "user", content: userText });
  trimHistory(session);

  for (let hop = 0; hop < 8; hop++) {
    const stream = llm.stream({
      ...baseParams(),
      max_tokens: maxTokens,
      tools: toolDefs,
      messages: session.messages,
    });

    stream.on("text", (delta) => emit("delta", { text: delta }));
    const msg = await stream.finalMessage();

    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (text) {
      emit("message_done", { text });
      record({ actor: "agent", action: "reply", summary: `Replied: "${text.slice(0, 140)}${text.length > 140 ? "…" : ""}"` });
    }

    if (msg.stop_reason !== "tool_use") { session.messages.push({ role: "assistant", content: msg.content }); return; }

    session.messages.push({ role: "assistant", content: msg.content });
    const toolUses = msg.content.filter((b) => b.type === "tool_use");
    const results = [];

    for (const t of toolUses) {
      emit("tool_start", { name: t.name, input: t.input });
      const out = await execute(t.name, t.input, session);

      // Product cards render from the tool's own results, so the pictures never
      // depend on the model formatting anything correctly.
      if (t.name === "search_catalog" && out.ok && out._ui?.length) {
        emit("products", { products: out._ui });
      }
      if (t.name === "suggest_addons" && out.ok) {
        emit("addons", { addons: out._ui.addons ?? [], upgrade: out._ui.upgrade ?? null });
      }
      if (["add_to_cart", "remove_from_cart", "check_payment_status"].includes(t.name)) {
        emit("cart_updated", cartSnapshot(session));
      }
      const { _ui, ...forModel } = out;          // keep UI-only data out of the prompt
      results.push({ type: "tool_result", tool_use_id: t.id, content: JSON.stringify(forModel), is_error: out.ok === false });

      // Surface interactive UI for the approval gate.
      if (t.name === "request_approval" && session.pendingApproval) {
        emit("approval_required", session.pendingApproval);
      }
      if (t.name === "start_checkout" && out.ok) {
        emit("checkout_ready", session.checkoutReady);
      }
      if (t.name === "create_payment_link" && out.ok) {
        emit("payment_link", { url: out.payment_link_url, id: out.payment_link_id, total_inr: out.total_inr });
      }
    }

    session.messages.push({ role: "user", content: results });

    // Hard stop: never let the model keep going while a human is being asked.
    if (session.pendingApproval) {
      const stream2 = llm.stream({
        ...baseParams(),
        max_tokens: Math.min(1024, maxTokens),
        messages: session.messages, // no tools -> it can only talk
      });
      stream2.on("text", (d) => emit("delta", { text: d }));
      const m2 = await stream2.finalMessage();
      session.messages.push({ role: "assistant", content: m2.content });
      const t2 = m2.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      if (t2) emit("message_done", { text: t2 });
      return;
    }
  }
  emit("message_done", { text: "Sorry, I got stuck on that one. Could you rephrase?" });
}
