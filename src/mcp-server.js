#!/usr/bin/env node
/**
 * Kurta Company — MCP server.
 *
 * Exposes the merchant to any MCP-speaking agent (Claude Desktop, Claude Code,
 * anything else) so it can browse, build a cart and pay, end to end.
 *
 * It is a thin client over the running storefront's agent API rather than a
 * second copy of the logic. That matters twice over:
 *   · the spend mandate and audit trail are the same ones the in-house agent
 *     obeys — an outside buyer cannot be given a softer gate by accident;
 *   · state is shared, so the browser UI updates live while an external agent
 *     shops. Two buyers, one merchant, one audit trail.
 *
 * Usage:  node src/mcp-server.js          (talks to KAIRA_URL, default :4123)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = process.env.KAIRA_URL || "http://localhost:4123";

async function call(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Cannot reach the storefront at ${BASE}. Start it with \`npm run dev\` and retry.`);
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const invoke = (tool, input = {}) => call(`/api/agent/tools/${tool}`, { method: "POST", body: input });

/** Every tool answers with readable text plus the raw object. */
function reply(obj, text) {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(obj, null, 2) }],
    structuredContent: obj,
    isError: obj?.ok === false,
  };
}

const inr = (n) => "₹" + Number(n).toLocaleString("en-IN");

const server = new McpServer({ name: "kurta-company-mcp-server", version: "1.0.0" });

// ── browse ──────────────────────────────────────────────────────────────────

server.registerTool("shop_search_catalog", {
  title: "Search the catalogue",
  description: "Search Kurta Company's catalogue. Returns real products with real prices and stock. Use this before recommending or adding anything.",
  inputSchema: {
    query: z.string().min(1).describe("Free text, e.g. 'blue cotton kurta'"),
    max_price_inr: z.number().positive().optional().describe("Only items at or below this price, in rupees"),
    category: z.enum(["apparel", "accessories", "footwear"]).optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async (input) => {
  const { json } = await invoke("search_catalog", input);
  if (!json.ok) return reply(json, json.message ?? "Search failed.");
  const lines = (json.results ?? []).map((p) => `• ${p.name} — ${inr(p.price)} (${p.id}, sizes ${p.sizes})`);
  return reply(json, lines.length ? lines.join("\n") : "Nothing matched that search.");
});

server.registerTool("shop_get_cart", {
  title: "View the cart",
  description: "The current cart contents and total.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  const { json } = await call("/api/cart");
  const lines = (json.items ?? []).map((i) => `• ${i.qty} × ${i.name} — ${inr(i.line_total_inr)}`);
  return reply(json, lines.length ? `${lines.join("\n")}\nTotal: ${inr(json.total_inr)}` : "The cart is empty.");
});

// ── build an order ──────────────────────────────────────────────────────────

server.registerTool("shop_add_to_cart", {
  title: "Add to cart",
  description: "Add a product to the cart by its catalogue id. Adding does not spend anything; payment is gated separately.",
  inputSchema: {
    product_id: z.string().describe("Catalogue id, e.g. sku_001"),
    qty: z.number().int().min(1).max(5).default(1),
    size: z.string().optional().describe("Required for items that have sizes"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  const { json } = await invoke("add_to_cart", input);
  return reply(json, json.ok ? `Added. Cart total is now ${inr(json.total_inr)}.` : json.message ?? "Could not add that.");
});

server.registerTool("shop_remove_from_cart", {
  title: "Remove from cart",
  description: "Remove a product from the cart.",
  inputSchema: { product_id: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const { json } = await invoke("remove_from_cart", input);
  return reply(json, json.ok ? `Removed. Cart total is now ${inr(json.total_inr)}.` : json.message ?? "Could not remove that.");
});

server.registerTool("shop_suggest_addons", {
  title: "Things that go with the cart",
  description: "Complementary items for what is already in the cart, plus a dearer alternative where one exists. Suggestions only — nothing is added.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  const { json } = await invoke("suggest_addons");
  if (!json.ok) return reply(json, json.message ?? "Nothing to suggest.");
  const a = (json.addons ?? []).map((x) => `• ${x.name} — ${inr(x.price)} (goes with ${x.goes_with})`);
  if (json.upgrade) a.push(`• Upgrade: ${json.upgrade.name} — ${inr(json.upgrade.price)}, ${inr(json.upgrade.extra_inr)} more than ${json.upgrade.instead_of}`);
  return reply(json, a.join("\n") || "Nothing to suggest.");
});

// ── spending, under the mandate ─────────────────────────────────────────────

server.registerTool("shop_check_spend_policy", {
  title: "Check the spend mandate",
  description: "Evaluate the current cart against the account holder's spend mandate. Read-only — nothing is charged. ALWAYS call this before attempting payment. Returns 'allow', 'confirm_required' or 'deny' with plain-English reasons you should relay verbatim.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  const { json } = await invoke("check_policy");
  if (!json.ok) return reply(json, json.message ?? "Could not evaluate the cart.");
  return reply(json, [
    `Decision: ${json.decision.toUpperCase()} for ${inr(json.total_inr)}`,
    ...(json.reasons ?? []).map((r) => `  · ${r}`),
    json.next_step ? `\nNext: ${json.next_step}` : "",
  ].join("\n"));
});

server.registerTool("shop_request_human_approval", {
  title: "Ask the account holder to approve",
  description: "Ask the human to approve this exact cart. Only call this after shop_check_spend_policy returns 'confirm_required'. Approval buttons appear in the account holder's chat; you must stop and wait for their answer.",
  inputSchema: { reason: z.string().describe("One plain sentence on why approval is needed") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (input) => {
  const { json } = await invoke("request_approval", input);
  return reply(json, json.ok
    ? "Approval requested. The account holder has been asked in their chat — stop here and wait; do not attempt payment."
    : json.message ?? "Could not request approval.");
});

server.registerTool("shop_create_payment", {
  title: "Create a payment",
  description: "Create a real Razorpay payment link for the current cart. Refuses unless the spend mandate allows it, or the human has approved this exact cart. Never call this without checking the policy first.",
  inputSchema: { description: z.string().describe("Short order description shown on the payment page") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (input) => {
  const { json } = await invoke("create_payment_link", input);
  if (!json.ok) {
    const why = (json.reasons ?? []).map((r) => `  · ${r}`).join("\n");
    return reply(json, `Refused (${json.decision ?? json.error_code}).\n${why}\n${json.guidance ?? ""}`);
  }
  return reply(json, `Payment link for ${inr(json.total_inr)}:\n${json.payment_link_url}\n\nRazorpay order ${json.razorpay_order_id}. Ask the buyer to complete it, then call shop_check_payment_status.`);
});

server.registerTool("shop_check_payment_status", {
  title: "Check payment status",
  description: "Check whether the outstanding payment has been completed. Never claim an order succeeded without calling this.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => {
  const { json } = await invoke("check_payment_status");
  if (!json.ok) return reply(json, `${json.message ?? "Payment not completed."}\n${json.guidance ?? ""}`);
  return reply(json, json.paid
    ? `Paid: ${inr(json.amount_paid_inr)} received. ${inr(json.remaining_budget_inr)} remains on the mandate this month.`
    : `Not paid yet — status "${json.status}".`);
});

// ── transparency ────────────────────────────────────────────────────────────

server.registerTool("shop_get_audit_trail", {
  title: "Read the audit trail",
  description: "The merchant's tamper-evident log of every action taken on this account, including your own, with the reasoning behind each decision.",
  inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ limit }) => {
  const { json } = await call("/api/audit");
  const rows = (json.entries ?? []).slice(-limit)
    .map((e) => `#${e.seq} [${e.actor}]${e.decision ? ` (${e.decision})` : ""} ${e.summary}`);
  return reply({ entries: json.entries?.slice(-limit) ?? [], integrity: json.integrity },
    `${rows.join("\n")}\n\nChain: ${json.integrity?.valid ? "intact" : "BROKEN"} over ${json.integrity?.entries ?? 0} entries.`);
});

await server.connect(new StdioServerTransport());
