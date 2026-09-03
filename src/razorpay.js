import crypto from "node:crypto";
import { config } from "./config.js";

const { keyId, keySecret, base } = config.razorpay;
const auth = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");

export class RazorpayError extends Error {
  constructor(status, body) {
    const e = body?.error ?? {};
    super(e.description || `Razorpay HTTP ${status}`);
    this.name = "RazorpayError";
    this.status = status;
    this.code = e.code || "UNKNOWN";
    this.reason = e.reason;
    this.raw = body;
  }
}

async function call(method, path, body, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(base + path, {
        method,
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) return json;
      const err = new RazorpayError(res.status, json);
      // 4xx is our fault - don't burn retries on it.
      if (res.status < 500 && res.status !== 429) throw err;
      lastErr = err;
    } catch (e) {
      if (e instanceof RazorpayError && e.status < 500 && e.status !== 429) throw e;
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
  }
  throw lastErr;
}

export const rupeesToPaise = (rupees) => Math.round(Number(rupees) * 100);
export const paiseToRupees = (paise) => Number(paise) / 100;

/** POST /v1/orders - the canonical record of intent. Amount in paise. */
export function createOrder({ amountPaise, receipt, notes }) {
  return call("POST", "/orders", { amount: amountPaise, currency: "INR", receipt, notes });
}

/** POST /v1/payment_links - what the agent hands the shopper in chat. */
export function createPaymentLink({ amountPaise, description, customer, notes }) {
  return call("POST", "/payment_links", {
    amount: amountPaise,
    currency: "INR",
    accept_partial: false,
    description,
    customer,
    notify: { sms: false, email: false }, // no real messages during a demo
    reminder_enable: false,
    notes,
    callback_url: `${config.publicBaseUrl}/payment/callback`,
    callback_method: "get",
  });
}

/** GET /v1/payment_links/:id - poll instead of webhooks so the demo needs no tunnel. */
export const getPaymentLink = (id) => call("GET", `/payment_links/${id}`);
/** POST /v1/payment_links/:id/cancel - kills a link so a stale price can't be paid. */
export const cancelPaymentLink = (id) => call("POST", `/payment_links/${id}/cancel`);
export const getPayment = (id) => call("GET", `/payments/${id}`);

/**
 * Standard Checkout signature (checkout.js modal):
 *   HMAC_SHA256("<order_id>|<payment_id>", key_secret)
 * This is a DIFFERENT payload from the Payment Link redirect below. Never trust a
 * client-reported payment until this passes.
 */
export function verifyCheckoutSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpay_signature || ""));
  } catch { return false; }
}

/**
 * Payment Link redirect signature:
 *   HMAC_SHA256("<link_id>|<link_ref_id>|<link_status>|<payment_id>", key_secret)
 * Verify before trusting a browser redirect. (Webhook bodies use a different
 * scheme: HMAC of the RAW request body with the WEBHOOK secret, not this key.)
 */
export function verifyPaymentLinkSignature(q) {
  const payload = [
    q.razorpay_payment_link_id,
    q.razorpay_payment_link_reference_id,
    q.razorpay_payment_link_status,
    q.razorpay_payment_id,
  ].join("|");
  const expected = crypto.createHmac("sha256", keySecret).update(payload).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(q.razorpay_signature || ""));
  } catch { return false; }
}
