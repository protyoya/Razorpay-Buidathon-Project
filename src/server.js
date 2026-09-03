import crypto from "node:crypto";
import express from "express";
import { config, assertRazorpay, assertLlm } from "./config.js";
import { runTurn } from "./agent.js";
import { newSession, cartItems, cartTotal, cartSnapshot, catalog, toolDefs, execute } from "./tools.js";
import { getTrail, subscribe, verifyChain, record, reset } from "./audit.js";

import { transcribe, synthesize, voiceEnabled, providers } from "./voice.js";
import { verifyPaymentLinkSignature, verifyCheckoutSignature, createOrder, rupeesToPaise, cancelPaymentLink } from "./razorpay.js";
import { evaluate, commitSpend, mandate } from "./policy.js";
import { RazorpayError } from "./razorpay.js";

assertRazorpay();
assertLlm();

const app = express();
app.use(express.json());
app.use(express.static("public"));

// Single in-memory session. One shopper, one demo - deliberately not multi-tenant.
let session = { ...newSession(), messages: [] };

/** SSE: text deltas, tool activity and audit entries all flow down this one channel. */
const clients = new Set();
app.get("/api/stream", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": connected\n\n");
  clients.add(res);
  const unsub = subscribe((entry) => send(res, "audit", entry));
  req.on("close", () => { clients.delete(res); unsub(); });
});
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const emit = (event, data) => { for (const c of clients) send(c, event, data); };

app.post("/api/chat", async (req, res) => {
  const { text } = req.body;
  res.json({ accepted: true });
  try { await runTurn({ session, userText: text, emit }); }
  catch (err) {
    console.error(err.message);
    // A provider billing/quota failure is an operator problem, not a shopper problem.
    // Say so plainly rather than pretending the agent misunderstood.
    // Distinguish "no money" from "too fast" - they need different fixes, and
    // an upgrade URL containing the word "billing" must not be read as the former.
    const msg = err?.message ?? "";
    const rateLimited = err?.status === 429 || /rate.?limit|tokens per minute|too many requests/i.test(msg);
    const outOfCredit = !rateLimited &&
      (err?.status === 402 || /insufficient|out of credit|payment_required|requires more credits/i.test(msg));
    const who = err?.provider ?? config.llm.provider;

    record({ actor: "agent", action: "error",
      summary: rateLimited ? `${who} rate-limited the request (all retries used).`
             : outOfCredit ? `${who} refused the request: out of credit.`
             : `Agent turn failed: ${msg}`,
      decision: "deny", reasons: [msg.slice(0, 300) || String(err)] });

    emit("message_done", { text: rateLimited
      ? "⚠️ Both model providers are rate-limited right now. Give it a minute and try again."
      : outOfCredit
      ? "⚠️ The model provider is out of credit, so I can't reply. Top up and try again."
      : "Something went wrong on my end — mind trying that again?" });
  }
});

/**
 * Run an agent turn without letting a model outage swallow the interaction.
 * /api/chat had this; the approval and payment callbacks did not, so a
 * rate-limited turn used to end in silence.
 */
async function safeTurn(userText, fallbackText) {
  try {
    await runTurn({ session, userText, emit });
  } catch (err) {
    const msg = err?.message ?? String(err);
    const rateLimited = err?.status === 429 || /rate.?limit|tokens per minute|too many requests/i.test(msg);
    record({ actor: "agent", action: "error",
      summary: rateLimited ? `Model provider rate-limited the follow-up turn.` : `Follow-up turn failed: ${msg}`,
      decision: "deny", reasons: [msg.slice(0, 300)] });
    emit("message_done", { text: fallbackText });
  }
}

/** Human approval gate. The token is what unlocks the payment tool. */
app.post("/api/approve", async (req, res) => {
  const { approved } = req.body;
  const pending = session.pendingApproval;
  if (!pending) return res.status(400).json({ error: "nothing pending" });
  session.pendingApproval = null;

  if (approved) {
    session.approvalToken = pending.token;
    record({ actor: "user", action: "approve",
      summary: `${mandate.granted_by} APPROVED the ₹${pending.total_inr} order in chat.`,
      decision: "allow", reasons: [`Human approval given for ₹${pending.total_inr}.`], detail: { token: pending.token } });
  } else {
    session.approvalToken = null;
    record({ actor: "user", action: "decline",
      summary: `${mandate.granted_by} DECLINED the ₹${pending.total_inr} order.`, decision: "deny", reasons: ["Human declined."] });
  }
  res.json({ ok: true });

  if (!approved) {
    return void safeTurn("[Customer tapped Decline. Do not create a payment link.]",
      "No problem — I haven't charged anything. Tell me if you'd like to change the order.");
  }

  // The human has approved and the policy already allows it, so the checkout is
  // created here rather than depending on the model to remember to call it.
  // A model outage must not strand a customer who has already said yes.
  const out = await execute("start_checkout", {}, session);
  if (out.ok) {
    emit("checkout_ready", session.checkoutReady);
    emit("cart_updated", cartSnapshot(session));
  }

  await safeTurn(
    out.ok
      ? `[Customer approved. The Pay button is already showing — do NOT call start_checkout again. Just confirm the total in one short line.]`
      : `[Customer approved but checkout could not start: ${out.reasons?.[0] ?? out.message}. Explain briefly and offer to try again.]`,
    out.ok
      ? `Approved — tap the Pay button above to finish.`
      : `Sorry, I couldn't start the payment just now. Shall I try again?`);
});


// ─────────────────────────────────────────────────────────────────────────────
// Razorpay Standard Checkout (checkout.js modal, paid without leaving the chat)
// ─────────────────────────────────────────────────────────────────────────────

/** Publishable key only. KEY_SECRET must never be sent to a browser. */
app.get("/api/config", (_q, res) => res.json({ key_id: config.razorpay.keyId }));

/**
 * POST /api/create-order
 * The amount is derived from the server-held cart and gated by the spend
 * mandate. It is deliberately NOT accepted from the client - taking a
 * client-supplied amount here would let the browser bypass the policy engine,
 * which is the entire point of this project.
 */
app.post("/api/create-order", async (req, res) => {
  try {
    if (!session.cart.length) return res.status(400).json({ error: "cart_empty", message: "Nothing in the cart." });

    const items = cartItems(session);
    const totalInr = cartTotal(session);
    const amountPaise = rupeesToPaise(totalInr);

    if (amountPaise < 100) {
      return res.status(400).json({ error: "amount_too_small", message: "Minimum chargeable amount is 100 paise (₹1)." });
    }

    const verdict = evaluate({ items, totalInr, approvalToken: session.approvalToken });
    if (verdict.decision !== "allow") {
      record({ actor: "policy", action: "block_checkout",
        summary: `BLOCKED in-chat checkout for ₹${totalInr} — policy said ${verdict.decision}.`,
        decision: verdict.decision, reasons: verdict.reasons, detail: { total_inr: totalInr } });
      return res.status(403).json({ error: "policy_blocked", decision: verdict.decision, reasons: verdict.reasons });
    }

    // Demo switch: fail the first attempt so the graceful-failure path can be
    // shown on the checkout flow, not just the payment-link one.
    if (config.demo.forcePaymentFailure && !session.failureShown) {
      session.failureShown = true;
      record({ actor: "razorpay", action: "create_order",
        summary: `Payment for ₹${totalInr} FAILED — the issuing bank declined the card.`,
        decision: "deny",
        reasons: ["Razorpay returned BAD_REQUEST_ERROR: the payment could not be completed."],
        detail: { total_inr: totalInr, simulated: true } });
      res.status(502).json({ error: "payment_failed", code: "BAD_REQUEST_ERROR",
        message: "The bank declined that card." });
      return void safeTurn(
        "[The payment failed — the issuing bank declined the card. Apologise once, briefly, say what happened in human terms, and offer to try again. Do not claim it succeeded.]",
        "Sorry — the bank declined that card. Shall I try again?");
    }

    const order = await createOrder({
      amountPaise,
      receipt: `chk_${Date.now()}`,
      notes: { mandate_id: "mandate_demo_001", channel: "standard_checkout", items: items.map((i) => i.id).join(",") },
    });

    session.pendingCheckout = { order_id: order.id, amountPaise, totalInr };
    record({ actor: "razorpay", action: "create_order",
      summary: `Created Razorpay order ${order.id} for ₹${totalInr} (in-chat checkout).`,
      decision: "allow", reasons: verdict.reasons,
      detail: { order_id: order.id, amount_paise: amountPaise } });

    res.json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: config.razorpay.keyId });
  } catch (err) {
    const status = err instanceof RazorpayError && (err.status === 401 || err.status === 400) ? err.status : 500;
    record({ actor: "razorpay", action: "create_order",
      summary: `Order creation failed: ${err.message}`, decision: "deny", reasons: [err.message] });
    res.status(status === 400 ? 500 : status).json({ error: "razorpay_error", message: err.message, code: err.code });
  }
});

/**
 * POST /api/verify-payment
 * Nothing is treated as paid until the HMAC over "<order_id>|<payment_id>"
 * matches. A mismatch is a hard 400 and is written to the audit trail.
 */
app.post("/api/verify-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body ?? {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: "missing_fields", message: "order_id, payment_id and signature are all required." });
  }

  const pending = session.pendingCheckout;
  if (!pending || pending.order_id !== razorpay_order_id) {
    record({ actor: "razorpay", action: "verify_payment",
      summary: `Rejected a payment for an order this session never created (${razorpay_order_id}).`,
      decision: "deny", reasons: ["order_id does not match the pending checkout."] });
    return res.status(400).json({ error: "unknown_order", verified: false });
  }

  const valid = verifyCheckoutSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature });
  record({ actor: "razorpay", action: "verify_payment",
    summary: valid
      ? `Signature verified — ₹${pending.totalInr} paid via in-chat checkout (${razorpay_payment_id}).`
      : `SIGNATURE MISMATCH on ${razorpay_order_id}. Payment NOT accepted.`,
    decision: valid ? "allow" : "deny",
    reasons: [valid ? `HMAC-SHA256 over "${razorpay_order_id}|${razorpay_payment_id}" matched.`
                    : "Computed HMAC did not match the signature the browser reported."],
    detail: { razorpay_order_id, razorpay_payment_id, signature_valid: valid } });

  if (!valid) return res.status(400).json({ verified: false, error: "signature_mismatch" });

  commitSpend({ totalInr: pending.totalInr, approvalToken: session.approvalToken });
  session.cart = []; session.approvalToken = null; session.pendingCheckout = null; session.retryCount = 0;

  emit("cart_updated", cartSnapshot(session));
  res.json({ verified: true, payment_id: razorpay_payment_id, amount_inr: pending.totalInr });
  await safeTurn(
    `[Payment of ₹${pending.totalInr} succeeded and was verified. Payment id ${razorpay_payment_id}. Confirm the order warmly in one short line.]`,
    `Payment of ₹${pending.totalInr.toLocaleString("en-IN")} received — thank you! 🎉`);
});

/** Client reports a dismissed modal or a failed payment. Never trusted as state. */
app.post("/api/payment-cancelled", async (req, res) => {
  const { reason, code } = req.body ?? {};
  record({ actor: "user", action: "payment_cancelled",
    summary: reason === "failed"
      ? `Payment failed in the checkout modal${code ? ` (${code})` : ""}.`
      : `Customer closed the payment window without paying.`,
    decision: "deny", reasons: [reason === "failed" ? "Razorpay reported payment.failed." : "Checkout modal dismissed."] });
  res.json({ ok: true });
  await safeTurn(
    reason === "failed"
      ? `[The payment failed in the checkout window${code ? ` with code ${code}` : ""}. Apologise once, briefly, and offer to try again.]`
      : `[The customer closed the payment window without paying. Acknowledge lightly and offer to reopen it whenever they're ready. Do not pressure them.]`,
    reason === "failed"
      ? `Sorry — that payment didn't go through. Shall I try again?`
      : `No rush — tap Pay whenever you're ready.`);
});


// ─────────────────────────────────────────────────────────────────────────────
// Voice (Fish Audio). Both directions are proxied so the API key stays server-side.
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/voice/status", (_q, res) =>
  res.json({ enabled: voiceEnabled(), ...providers(), preferBrowserStt: config.voice.preferBrowserStt }));

/** Raw audio body from MediaRecorder -> transcript. Does NOT run the agent; the
 *  browser shows the transcript first so the shopper can correct a misheard order. */
app.post("/api/voice/transcribe", express.raw({ type: "*/*", limit: "12mb" }), async (req, res) => {
  if (!voiceEnabled()) return res.status(503).json({ error: "voice_disabled" });
  if (!req.body?.length) return res.status(400).json({ error: "empty_audio" });
  try {
    const { text, duration, provider } = await transcribe(req.body, req.headers["content-type"] || "audio/webm");
    record({ actor: "user", action: "voice_input",
      summary: text ? `Spoke (${duration?.toFixed?.(1) ?? "?"}s, via ${provider}): "${text}"`
                    : `Sent audio with no speech in it (via ${provider}).` });
    res.json({ text, duration, provider });
  } catch (err) {
    record({ actor: "user", action: "voice_input", summary: `Transcription failed: ${err.message}`, decision: "deny", reasons: [err.message] });
    res.status(err.status === 401 ? 401 : 502).json({ error: "asr_failed", message: err.message });
  }
});

/**
 * Text -> speech in two steps so the browser can play progressively.
 *   POST /api/voice/speak      -> starts synthesis, returns { id }
 *   GET  /api/voice/speak/:id  -> streams the audio; an <audio src> plays it
 *                                 as bytes arrive instead of after the last one
 */
const pendingSpeech = new Map();

app.post("/api/voice/speak", async (req, res) => {
  const text = String(req.body?.text ?? "").slice(0, 1900);
  if (!text.trim()) return res.status(400).json({ error: "empty_text" });
  try {
    const { res: upstream, provider } = await synthesize(text);
    const id = crypto.randomUUID();
    pendingSpeech.set(id, { upstream, provider, at: Date.now() });
    // Never let an unclaimed stream leak.
    setTimeout(() => { const e = pendingSpeech.get(id); if (e) { try { e.upstream.body?.cancel(); } catch {} pendingSpeech.delete(id); } }, 60_000);
    res.json({ id, provider });
  } catch (err) {
    res.status(err.status === 401 ? 401 : 502).json({ error: "tts_failed", message: err.message });
  }
});

app.get("/api/voice/speak/:id", async (req, res) => {
  const entry = pendingSpeech.get(req.params.id);
  if (!entry) return res.status(404).end();
  pendingSpeech.delete(req.params.id);
  res.setHeader("Content-Type", entry.upstream.headers.get("content-type") || "audio/mpeg");
  res.setHeader("X-Voice-Provider", entry.provider);
  res.setHeader("Cache-Control", "no-store");
  try {
    for await (const chunk of entry.upstream.body) res.write(chunk);
    res.end();
  } catch { res.end(); }
});


/** Shopper-driven cart edits. Not a money action - policy still gates payment. */
app.post("/api/cart/update", async (req, res) => {
  const { product_id, qty } = req.body ?? {};
  const line = session.cart.find((c) => c.product_id === product_id);
  if (!line) return res.status(404).json({ error: "not_in_cart" });
  const n = Number(qty);
  if (!Number.isInteger(n) || n < 0 || n > 5) return res.status(400).json({ error: "bad_qty" });

  if (n === 0) session.cart = session.cart.filter((c) => c.product_id !== product_id);
  else line.qty = n;

  const snap = cartSnapshot(session);
  record({ actor: "user", action: "cart_edit",
    summary: n === 0 ? `Removed ${product_id} from the cart. Total is now ₹${snap.total_inr}.`
                     : `Changed ${product_id} to qty ${n}. Total is now ₹${snap.total_inr}.`,
    detail: { product_id, qty: n, total_inr: snap.total_inr } });

  // A changed cart invalidates everything priced against the old one: the human
  // approval, the pending Razorpay order, and any live payment link. Otherwise a
  // Pay button left in the chat would still charge the previous total.
  session.approvalToken = null;
  session.pendingApproval = null;
  await invalidatePricedArtifacts(session, snap.total_inr);

  emit("cart_updated", snap);
  emit("checkout_stale", { total_inr: snap.total_inr, has_items: snap.count > 0 });
  res.json(snap);
});

/**
 * Voids anything that was priced against a previous cart total.
 * Cancelling the Razorpay link matters: without it the old link stays payable at
 * the old amount even after the button disappears from this page.
 */
async function invalidatePricedArtifacts(session, newTotalInr) {
  const had = [];
  if (session.pendingCheckout) { had.push(`order ${session.pendingCheckout.order_id}`); session.pendingCheckout = null; }
  if (session.lastLink) {
    const id = session.lastLink.id;
    session.lastLink = null;
    had.push(`payment link ${id}`);
    try { await cancelPaymentLink(id); }
    catch (err) { record({ actor: "razorpay", action: "cancel_payment_link",
      summary: `Could not cancel stale payment link ${id}: ${err.message}`, decision: "deny", reasons: [err.message] }); }
  }
  if (had.length) {
    record({ actor: "policy", action: "invalidate_checkout",
      summary: `Cart changed — voided ${had.join(" and ")}. A new checkout must be created at ₹${newTotalInr}.`,
      decision: "deny", reasons: [`Priced against a cart total that no longer applies.`],
      detail: { new_total_inr: newTotalInr } });
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Agent-facing surface — makes this merchant transactable by an outside AI
// buyer, not just by the chat UI in this repo. Same tools, same policy gate,
// same audit trail; only the caller differs.
// ═══════════════════════════════════════════════════════════════════════════

/** Discovery. An agent that finds this URL learns what the merchant sells and the rules it must transact under. */
app.get("/.well-known/agent-manifest.json", (_q, res) => {
  res.json({
    schema_version: "0.1",
    merchant: { ...catalog.merchant, endpoint: config.publicBaseUrl },
    payments: { processor: "razorpay", mode: "test", currency: "INR", methods: ["card", "upi", "netbanking"] },
    catalog: { url: "/api/agent/catalog", count: catalog.products.length },
    tools: { invoke: "POST /api/agent/tools/{name}", list: toolDefs.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) },
    // Published up front so a buying agent knows the limits before it tries to spend.
    spend_policy: {
      auto_approve_ceiling_inr: mandate.auto_approve_ceiling_inr,
      max_per_order_inr: mandate.max_per_order_inr,
      cycle_cap_inr: mandate.cycle_cap_inr,
      allowed_categories: mandate.allowed_categories,
      max_orders_per_hour: mandate.max_orders_per_hour,
      human_approval: "Totals above the auto-approve ceiling return decision 'confirm_required' and must be approved by the account holder before payment.",
    },
    audit: { url: "/api/audit", scheme: "sha256-hash-chain" },
  });
});

/** Machine-readable product feed. */
app.get("/api/agent/catalog", (_q, res) => {
  res.json({
    merchant: catalog.merchant,
    updated_at: new Date().toISOString(),
    products: catalog.products.map((p) => ({
      id: p.id, name: p.name, category: p.category, price: { amount: p.price_inr, currency: "INR" },
      colour: p.color, sizes: p.sizes, in_stock: p.stock > 0, stock: p.stock,
      tags: p.tags, image: `${config.publicBaseUrl}${p.image}`,
      frequently_bought_with: p.pairs_with ?? [],
    })),
  });
});

/**
 * Direct tool invocation, with no model in the loop.
 * The policy gate lives inside the tools themselves, so an external agent is
 * bounded by exactly the same mandate as the in-house one.
 */
app.post("/api/agent/tools/:name", async (req, res) => {
  const name = req.params.name;
  if (!toolDefs.some((t) => t.name === name)) {
    return res.status(404).json({ ok: false, error: "unknown_tool",
      available: toolDefs.map((t) => t.name) });
  }
  record({ actor: "agent", action: "external_invoke",
    summary: `External AI buyer called ${name}.`, detail: { tool: name, input: req.body ?? {} } });

  const out = await execute(name, req.body ?? {}, session);
  const { _ui, ...forCaller } = out;

  if (name === "search_catalog" && out.ok && out._ui?.length) emit("products", { products: out._ui });
  if (name === "suggest_addons" && out.ok) emit("addons", { addons: out._ui.addons ?? [], upgrade: out._ui.upgrade ?? null });
  if (["add_to_cart", "remove_from_cart"].includes(name)) emit("cart_updated", cartSnapshot(session));
  if (name === "request_approval" && session.pendingApproval) emit("approval_required", session.pendingApproval);
  if (name === "start_checkout" && out.ok) emit("checkout_ready", session.checkoutReady);

  res.status(out.ok === false ? 409 : 200).json(forCaller);
});

app.get("/api/audit", (_q, res) => res.json({ entries: getTrail(), integrity: verifyChain() }));
/** Full catalogue for the Explore-shop overlay. */
app.get("/api/catalog", (_q, res) => res.json({ products: catalog.products, merchant: catalog.merchant }));

app.get("/api/mandate", (_q, res) => res.json(mandate));
app.get("/api/cart", (_q, res) => res.json({ ...cartSnapshot(session), pendingApproval: session.pendingApproval }));

app.post("/api/demo/failure", (req, res) => {
  config.demo.forcePaymentFailure = !!req.body.enabled;
  record({ actor: "user", action: "demo_toggle",
    summary: `Payment-failure simulation turned ${config.demo.forcePaymentFailure ? "ON" : "OFF"}.` });
  res.json({ forcePaymentFailure: config.demo.forcePaymentFailure });
});

app.post("/api/reset", (_q, res) => {
  session = { ...newSession(), messages: [] };
  config.demo.forcePaymentFailure = false;
  reset(); res.json({ ok: true });
});

/** Razorpay redirects the browser here after a hosted-page payment. */
app.get("/payment/callback", (req, res) => {
  const valid = verifyPaymentLinkSignature(req.query);
  record({ actor: "razorpay", action: "payment_callback",
    summary: valid
      ? `Razorpay redirect verified — payment ${req.query.razorpay_payment_id} is ${req.query.razorpay_payment_link_status}.`
      : `Razorpay redirect FAILED signature verification. Ignored.`,
    decision: valid ? "allow" : "deny", detail: { ...req.query, signature_valid: valid } });
  res.send(`<body style="font-family:system-ui;text-align:center;padding:80px">
    <h2>${valid ? "✅ Payment received" : "⚠️ Signature could not be verified"}</h2>
    <p>Head back to the chat — Kaira will confirm.</p></body>`);
});

app.listen(config.port, () => {
  console.log(`\n  Kaira running on http://localhost:${config.port}`);
  console.log(`  Razorpay: ${config.razorpay.keyId} (TEST MODE)`);
  console.log(`  LLM:      ${config.llm.model} via ${config.llm.provider}` +
              (config.llm.groqKey ? ` (failover: Groq ${config.llm.groqModel})` : "") +
              (config.llm.strictCompat ? " (strict-compat mode)" : ` @ effort=${config.llm.effort}`) + "\n");
});
