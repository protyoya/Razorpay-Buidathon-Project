import fs from "node:fs";
import { record } from "./audit.js";
import { evaluate, mandate, mintApproval, commitSpend } from "./policy.js";
import * as rzp from "./razorpay.js";
import { config } from "./config.js";

const STRICT = !config.llm.strictCompat;

const catalog = JSON.parse(fs.readFileSync("data/catalog.json", "utf8"));
const byId = new Map(catalog.products.map((p) => [p.id, p]));

/** Per-conversation state. One session per browser tab is plenty for a demo. */
export function newSession() {
  return { cart: [], pendingApproval: null, approvalToken: null, lastLink: null, pendingCheckout: null };
}
const cartItems = (s) => s.cart.map((c) => ({ ...byId.get(c.product_id), qty: c.qty, size: c.size }));

/** Shape the right-hand cart panel renders. */
export function cartSnapshot(s) {
  const items = cartItems(s).map((i) => ({
    id: i.id, name: i.name, qty: i.qty, size: i.size ?? null,
    price_inr: i.price_inr, line_total_inr: i.price_inr * i.qty, image: i.image,
  }));
  return { items, count: items.reduce((n, i) => n + i.qty, 0), total_inr: cartTotal(s) };
}
const cartTotal = (s) => s.cart.reduce((t, c) => t + byId.get(c.product_id).price_inr * c.qty, 0);

export const toolDefs = [
  {
    name: "search_catalog",
    description: "Search the catalogue. Required before recommending anything.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "e.g. blue cotton kurta" },
        max_price_inr: { type: "number", description: "max price in ₹" },
        category: { type: "string", enum: ["apparel", "accessories", "footwear"] },
      },
      required: ["query"], additionalProperties: false,
    },
    strict: STRICT,
  },
  {
    name: "add_to_cart",
    description: "Add a product to the cart by catalogue id.",
    input_schema: {
      type: "object",
      properties: {
        product_id: { type: "string" },
        qty: { type: "integer", minimum: 1, maximum: 5 },
        size: { type: "string" },
      },
      required: ["product_id", "qty"], additionalProperties: false,
    },
    strict: STRICT,
  },
  {
    name: "remove_from_cart",
    description: "Remove a product from the cart.",
    input_schema: {
      type: "object",
      properties: { product_id: { type: "string" } },
      required: ["product_id"], additionalProperties: false,
    },
    strict: STRICT,
  },
  {
    name: "suggest_addons",
    description: "Things that go with what is already in the cart, plus a dearer alternative where one exists. Call once after adding an item, before taking payment. Offer at most two, in one short line.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: STRICT,
  },
  {
    name: "check_policy",
    description: "Check the cart against the spend mandate. Read-only. Required before any payment. Returns allow | confirm_required | deny plus reasons to relay.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: STRICT,
  },
  {
    name: "request_approval",
    description: "Ask the human to approve this cart. Only after check_policy returns confirm_required. Pauses until they answer.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "one sentence on why approval is needed" } },
      required: ["reason"], additionalProperties: false,
    },
    strict: STRICT,
  },
  {
    name: "start_checkout",
    description: "Preferred payment method. Puts a Pay button in the chat. Refuses unless policy allows.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: STRICT,
  },
  {
    name: "create_payment_link",
    description: "Create a shareable Razorpay payment link. Only if they want a link they can forward.",
    input_schema: {
      type: "object",
      properties: { description: { type: "string", description: "short order description" } },
      required: ["description"], additionalProperties: false,
    },
    strict: STRICT,
  },
  {
    name: "check_payment_status",
    description: "Check whether the payment link has been paid.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: STRICT,
  },
];

/** Every tool goes through here, so every tool call lands in the audit trail. */
export async function execute(name, input, session) {
  try {
    const out = await handlers[name](input, session);
    return out;
  } catch (err) {
    record({
      actor: "razorpay", action: name,
      summary: `${name} failed: ${err.message}`,
      decision: "deny", reasons: [err.message],
      detail: { code: err.code, status: err.status },
    });
    return { ok: false, error_code: err.code || "TOOL_ERROR", message: err.message,
             guidance: "Tell the customer plainly that this step failed and offer to retry. Do not claim success." };
  }
}

const handlers = {
  search_catalog({ query, max_price_inr, category }) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results = catalog.products
      .filter((p) => (!category || p.category === category) && (!max_price_inr || p.price_inr <= max_price_inr) && p.stock > 0)
      .map((p) => {
        const hay = `${p.name} ${p.color} ${p.category} ${p.tags.join(" ")}`.toLowerCase();
        return { p, score: terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0) };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.p.price_inr - b.p.price_inr)
      .slice(0, 5)
      .map((r) => r.p);

    record({ actor: "agent", action: "search_catalog",
      summary: `Searched the catalogue for "${query}"${max_price_inr ? ` under ₹${max_price_inr}` : ""} — ${results.length} match(es).`,
      detail: { query, max_price_inr, category, result_ids: results.map((p) => p.id) } });

    // The model only needs enough to recommend and add to cart. Images, tags,
    // stock and category are for the UI, carried out-of-band on `_ui` so they
    // never enter the prompt. Cuts a search result from ~270 to ~70 tokens.
    return {
      ok: true,
      results: results.slice(0, 3).map((p) => ({
        id: p.id, name: p.name, price: p.price_inr,
        // Comma-separated, not "S/M/L/XL" - slashes are read aloud as an abrupt
        // run of letters by the TTS voice.
        sizes: p.sizes.join(", "),
      })),
      note: results.length === 0 ? "Nothing matched. Offer a broader search — do not invent products." : undefined,
      _ui: results.slice(0, 3),
    };
  },

  add_to_cart({ product_id, qty, size }, s) {
    const p = byId.get(product_id);
    if (!p) return { ok: false, error_code: "NOT_FOUND", message: `No product ${product_id} in this catalogue.` };
    if (p.stock < qty) return { ok: false, error_code: "OUT_OF_STOCK", message: `Only ${p.stock} of ${p.name} left.` };
    const line = s.cart.find((c) => c.product_id === product_id);
    if (line) line.qty += qty; else s.cart.push({ product_id, qty, size });
    record({ actor: "agent", action: "add_to_cart",
      summary: `Added ${qty} × ${p.name} (₹${p.price_inr}) to the cart. Cart total is now ₹${cartTotal(s)}.`,
      detail: { product_id, qty, size, cart_total_inr: cartTotal(s) } });
    return { ok: true, cart: cartItems(s).map((i) => ({ id: i.id, name: i.name, qty: i.qty, price_inr: i.price_inr })), total_inr: cartTotal(s) };
  },

  remove_from_cart({ product_id }, s) {
    s.cart = s.cart.filter((c) => c.product_id !== product_id);
    record({ actor: "agent", action: "remove_from_cart",
      summary: `Removed ${byId.get(product_id)?.name ?? product_id} from the cart. Cart total is now ₹${cartTotal(s)}.`,
      detail: { product_id, cart_total_inr: cartTotal(s) } });
    return { ok: true, total_inr: cartTotal(s) };
  },

  /**
   * Cross-sell and upsell, grounded in the catalogue rather than invented.
   * Everything suggested is real stock at a real price, and anything the
   * customer accepts still passes through the same spend mandate.
   */
  suggest_addons(_input, s) {
    if (!s.cart.length) return { ok: false, error_code: "EMPTY_CART", message: "The cart is empty." };
    const inCart = new Set(s.cart.map((c) => c.product_id));

    const addons = [];
    for (const line of s.cart) {
      for (const id of byId.get(line.product_id)?.pairs_with ?? []) {
        const p = byId.get(id);
        if (p && p.stock > 0 && !inCart.has(id) && !addons.some((a) => a.id === id)) {
          addons.push({ id: p.id, name: p.name, price: p.price_inr,
                        goes_with: byId.get(line.product_id).name });
        }
      }
    }

    // Upsell only on the dearest line, and only as an alternative to consider.
    const priciest = [...s.cart].sort((a, b) =>
      byId.get(b.product_id).price_inr - byId.get(a.product_id).price_inr)[0];
    const upId = byId.get(priciest.product_id)?.upgrade_to;
    const up = upId && byId.get(upId);
    const upgrade = up && up.stock > 0 && !inCart.has(upId)
      ? { id: up.id, name: up.name, price: up.price_inr,
          instead_of: byId.get(priciest.product_id).name,
          extra_inr: up.price_inr - byId.get(priciest.product_id).price_inr }
      : null;

    const top = addons.slice(0, 3);
    record({ actor: "agent", action: "suggest_addons",
      summary: `Offered ${top.length} add-on(s)${upgrade ? ` and an upgrade to ${upgrade.name}` : ""} on a ₹${cartTotal(s)} cart.`,
      detail: { addon_ids: top.map((a) => a.id), upgrade_id: upgrade?.id } });

    return { ok: true, addons: top, upgrade, _ui: { addons: top.map((a) => byId.get(a.id)), upgrade: upgrade && byId.get(upgrade.id) },
      guidance: "Mention at most two, in one short line, as a genuine suggestion. If they say no, drop it and move to payment. Never add anything to the cart without being asked." };
  },

  check_policy(_input, s) {
    if (!s.cart.length) return { ok: false, error_code: "EMPTY_CART", message: "The cart is empty." };
    const total = cartTotal(s);
    const verdict = evaluate({ items: cartItems(s), totalInr: total, approvalToken: s.approvalToken });
    record({ actor: "policy", action: "check_policy",
      summary: `Policy check on a ₹${total} cart → ${verdict.decision.toUpperCase()}.`,
      decision: verdict.decision, reasons: verdict.reasons,
      detail: { total_inr: total, checks: verdict.checks, mandate_id: mandate.id } });
    // Small models reliably ignore a system-prompt rule here and just *describe*
    // a Pay button. Putting the next step in the tool result, where the model is
    // already reading, is what actually makes it chain.
    const next_step = {
      allow: "Call start_checkout NOW, in this same turn, before replying. A Pay button does not exist until you do — never write one yourself.",
      confirm_required: "Call request_approval NOW, in this same turn. Do not attempt payment.",
      deny: "Do not attempt payment. Explain the reason and offer a cheaper alternative.",
    }[verdict.decision];

    return { ok: true, total_inr: total, decision: verdict.decision, reasons: verdict.reasons, next_step,
      mandate: { auto_approve_ceiling_inr: mandate.auto_approve_ceiling_inr, max_per_order_inr: mandate.max_per_order_inr,
                 remaining_this_month_inr: mandate.cycle_cap_inr - mandate.spent_this_cycle_inr } };
  },

  request_approval({ reason }, s) {
    const total = cartTotal(s);
    const token = mintApproval(total, s.cart.map((c) => c.product_id));
    s.pendingApproval = { token, total_inr: total, reason,
      items: cartItems(s).map((i) => ({ name: i.name, qty: i.qty, price_inr: i.price_inr })) };
    record({ actor: "agent", action: "request_approval",
      summary: `Paused for human approval on ₹${total}: ${reason}`,
      decision: "confirm_required", reasons: [reason], detail: { total_inr: total, token } });
    return { ok: true, status: "awaiting_human",
             instruction: "Approval buttons are now showing in the chat. Tell the customer what you need and STOP — do not call create_payment_link until they approve." };
  },

  start_checkout(_input, s) {
    if (!s.cart.length) return { ok: false, error_code: "EMPTY_CART", message: "The cart is empty." };
    const total = cartTotal(s);
    const verdict = evaluate({ items: cartItems(s), totalInr: total, approvalToken: s.approvalToken });

    if (verdict.decision !== "allow") {
      record({ actor: "policy", action: "block_checkout",
        summary: `BLOCKED in-chat checkout for ₹${total} — policy said ${verdict.decision}.`,
        decision: verdict.decision, reasons: verdict.reasons, detail: { total_inr: total } });
      return { ok: false, error_code: "POLICY_BLOCKED", decision: verdict.decision, reasons: verdict.reasons,
               guidance: verdict.decision === "confirm_required"
                 ? "Call request_approval and wait. Do not retry this tool."
                 : "Do not retry. Explain the reason and offer a cheaper alternative." };
    }

    s.checkoutReady = { total_inr: total, items: cartItems(s).map((i) => ({ name: i.name, qty: i.qty })) };
    record({ actor: "agent", action: "start_checkout",
      summary: `Put a Pay ₹${total} button in the chat (Razorpay Standard Checkout).`,
      decision: "allow", reasons: verdict.reasons, detail: { total_inr: total } });
    return { ok: true, total_inr: total,
             instruction: "A Pay button is now showing in the chat. Tell the customer to tap it. Do NOT also create a payment link." };
  },

  async create_payment_link({ description }, s) {
    const total = cartTotal(s);
    const items = cartItems(s);

    // Server-side gate. The model cannot talk its way past this.
    const verdict = evaluate({ items, totalInr: total, approvalToken: s.approvalToken });
    if (verdict.decision !== "allow") {
      record({ actor: "policy", action: "block_payment_link",
        summary: `BLOCKED a ₹${total} payment link — policy said ${verdict.decision}.`,
        decision: verdict.decision, reasons: verdict.reasons, detail: { total_inr: total } });
      return { ok: false, error_code: "POLICY_BLOCKED", decision: verdict.decision, reasons: verdict.reasons,
               guidance: verdict.decision === "confirm_required"
                 ? "Call request_approval and wait. Do not retry this tool."
                 : "Do not retry. Explain the reason and offer a cheaper alternative." };
    }

    const amountPaise = rzp.rupeesToPaise(total);
    const order = await rzp.createOrder({
      amountPaise, receipt: `agent_${Date.now()}`,
      notes: { mandate_id: mandate.id, agent: "kaira", items: items.map((i) => i.id).join(",") },
    });
    const link = await rzp.createPaymentLink({
      amountPaise, description,
      customer: { name: mandate.granted_by, email: "buyer@example.com", contact: "+919000090000" },
      notes: { mandate_id: mandate.id, razorpay_order_id: order.id, policy_decision: verdict.decision },
    });

    s.lastLink = { id: link.id, short_url: link.short_url, total_inr: total, order_id: order.id };
    record({ actor: "razorpay", action: "create_payment_link",
      summary: `Created a real Razorpay test payment link for ₹${total} (${link.id}).`,
      decision: "allow", reasons: verdict.reasons,
      detail: { razorpay_order_id: order.id, payment_link_id: link.id, short_url: link.short_url, amount_paise: amountPaise } });

    return { ok: true, payment_link_url: link.short_url, payment_link_id: link.id, razorpay_order_id: order.id,
             total_inr: total,
             instruction: "Send the URL to the customer as a normal chat message and ask them to tell you once they've paid." };
  },

  async check_payment_status(_input, s) {
    if (!s.lastLink) return { ok: false, error_code: "NO_LINK", message: "No payment link has been created yet." };

    const link = await rzp.getPaymentLink(s.lastLink.id);
    const paid = link.status === "paid";
    record({ actor: "razorpay", action: "check_payment_status",
      summary: paid ? `Payment confirmed: ₹${rzp.paiseToRupees(link.amount_paid)} received for ${link.id}.`
                    : `Payment link ${link.id} is still "${link.status}" — not paid yet.`,
      decision: paid ? "allow" : null, detail: { payment_link_id: link.id, status: link.status, amount_paid: link.amount_paid } });

    if (paid) {
      commitSpend({ totalInr: s.lastLink.total_inr, approvalToken: s.approvalToken });
      s.cart = []; s.approvalToken = null;
    }
    return { ok: true, status: link.status, paid, amount_paid_inr: rzp.paiseToRupees(link.amount_paid),
             remaining_budget_inr: mandate.cycle_cap_inr - mandate.spent_this_cycle_inr };
  },
};

export { cartItems, cartTotal, catalog };
