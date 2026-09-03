/**
 * HOUR ZERO SMOKE TEST. Run this FIRST: `npm run smoke`
 * Proves your Razorpay test key works end-to-end before you build anything on top.
 * If this fails, nothing else matters. Fix this before writing a line of agent code.
 */
import "dotenv/config";

const { RAZORPAY_KEY_ID: ID, RAZORPAY_KEY_SECRET: SECRET } = process.env;
const BASE = "https://api.razorpay.com/v1";

function die(msg) { console.error("\n❌ " + msg + "\n"); process.exit(1); }
const ok = (m) => console.log("✅ " + m);

if (!ID || !SECRET) die("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing. Copy .env.example -> .env and fill them in.");
if (!ID.startsWith("rzp_test_")) die(`Key id is "${ID.slice(0, 12)}..." - that is NOT a test key. Never run this project on a live key.`);
ok(`Test key loaded (${ID})`);

const auth = "Basic " + Buffer.from(`${ID}:${SECRET}`).toString("base64");

async function rzp(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    console.error(`\n   HTTP ${res.status} on ${method} ${path}`);
    console.error("   " + JSON.stringify(json.error ?? json, null, 2).replace(/\n/g, "\n   "));
    die("Razorpay rejected the call. Common causes: wrong secret, or Payment Links not enabled on this test account (Dashboard -> Payment Links -> activate).");
  }
  return json;
}

// 1. Auth check - cheapest authenticated GET.
await rzp("GET", "/payments?count=1");
ok("Authentication works (GET /payments)");

// 2. Orders API - amounts are in PAISE (integer). 149900 = Rs 1,499.00
const order = await rzp("POST", "/orders", {
  amount: 149900,
  currency: "INR",
  receipt: "smoke_" + Date.now(),
  notes: { source: "buildathon-smoke-test" },
});
ok(`Orders API works -> ${order.id} (amount ${order.amount} paise, status ${order.status})`);

// 3. Payment Links API - this is what the agent will actually hand the user.
//    notify.* = false so no real SMS/email goes out during the demo.
const link = await rzp("POST", "/payment_links", {
  amount: 149900,
  currency: "INR",
  accept_partial: false,
  description: "Smoke test - Buildathon",
  customer: { name: "Test Buyer", email: "test@example.com", contact: "+919000090000" },
  notify: { sms: false, email: false },
  reminder_enable: false,
  notes: { source: "buildathon-smoke-test" },
  callback_url: (process.env.PUBLIC_BASE_URL || "http://localhost:3000") + "/payment/callback",
  callback_method: "get",
});
ok(`Payment Links API works -> ${link.id} (${link.status})`);

// 4. Read it back - this is the polling call the agent uses to confirm payment.
const readback = await rzp("GET", `/payment_links/${link.id}`);
ok(`Read-back works -> status "${readback.status}", amount_paid ${readback.amount_paid} paise`);

console.log(`
────────────────────────────────────────────────
 ALL GREEN. Open this link and pay it with a test card:

   ${link.short_url}

 Test card : 4111 1111 1111 1111
 Expiry    : any future date   CVV: any 3 digits
 OTP page  : click "Success"
 Test UPI  : success@razorpay  (or failure@razorpay to force a failure)

 Then re-run \`npm run smoke\` -> the read-back status should flip to "paid".
────────────────────────────────────────────────
`);
