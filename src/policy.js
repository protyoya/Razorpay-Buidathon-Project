import { record } from "./audit.js";

/**
 * SPEND MANDATE - the standing, bounded authority a human grants the agent.
 * The agent never sees this as prompt text it could be talked out of; it is
 * enforced in code, before any Razorpay call is made.
 */
export const mandate = {
  id: "mandate_demo_001",
  granted_by: "Aarav S.",
  granted_at: "2026-09-01T10:00:00Z",
  expires_at: "2026-12-31T23:59:59Z",
  auto_approve_ceiling_inr: 2000,   // agent may transact alone up to here
  max_per_order_inr: 10000,         // hard ceiling - never, even with consent
  cycle_cap_inr: 15000,             // per calendar month
  allowed_categories: ["apparel", "accessories", "footwear"],
  max_orders_per_hour: 3,
  spent_this_cycle_inr: 0,
  orders_last_hour: [],
};

/** Human approvals are single-use tokens minted by the UI, consumed by the tool. */
const approvals = new Map();
export function mintApproval(totalInr, itemIds) {
  const token = "apv_" + Math.random().toString(36).slice(2, 10);
  approvals.set(token, { totalInr, itemIds: [...itemIds].sort().join(","), used: false, at: Date.now() });
  return token;
}

const RULES = {
  R1_MANDATE_ACTIVE:   "Mandate must be active and unexpired.",
  R2_CATEGORY:         "Every item must be in a category the mandate allows.",
  R3_HARD_CEILING:     "Order total must not exceed the per-order hard ceiling.",
  R4_CYCLE_CAP:        "Order must fit within the remaining monthly budget.",
  R5_VELOCITY:         "No more than N orders may be placed per hour.",
  R6_AUTO_APPROVE:     "Totals above the auto-approve ceiling need a human OK.",
};

/**
 * Pure function: cart -> decision. No side effects, so the agent can call it
 * to *explain* a purchase before attempting one.
 * @returns {{decision:"allow"|"confirm_required"|"deny", reasons:string[], checks:object[]}}
 */
export function evaluate({ items, totalInr, approvalToken = null }) {
  const checks = [];
  const add = (rule, pass, msg) => checks.push({ rule, pass, message: msg });

  const active = new Date(mandate.expires_at) > new Date();
  add("R1_MANDATE_ACTIVE", active,
    active ? `Mandate ${mandate.id} from ${mandate.granted_by} is active until ${mandate.expires_at.slice(0,10)}.`
           : `Mandate ${mandate.id} expired on ${mandate.expires_at.slice(0,10)}.`);

  const bad = items.filter((i) => !mandate.allowed_categories.includes(i.category));
  add("R2_CATEGORY", bad.length === 0,
    bad.length === 0 ? `All items are in allowed categories (${mandate.allowed_categories.join(", ")}).`
                     : `"${bad[0].name}" is in category "${bad[0].category}", which this mandate does not cover.`);

  const underHard = totalInr <= mandate.max_per_order_inr;
  add("R3_HARD_CEILING", underHard,
    underHard ? `₹${totalInr} is within the ₹${mandate.max_per_order_inr} per-order hard ceiling.`
              : `₹${totalInr} exceeds the ₹${mandate.max_per_order_inr} per-order hard ceiling. This cannot be approved by anyone in chat.`);

  const remaining = mandate.cycle_cap_inr - mandate.spent_this_cycle_inr;
  const underCycle = totalInr <= remaining;
  add("R4_CYCLE_CAP", underCycle,
    underCycle ? `₹${totalInr} fits the ₹${remaining} left in this month's ₹${mandate.cycle_cap_inr} budget.`
               : `Only ₹${remaining} is left of this month's ₹${mandate.cycle_cap_inr} budget.`);

  const hourAgo = Date.now() - 3600_000;
  mandate.orders_last_hour = mandate.orders_last_hour.filter((t) => t > hourAgo);
  const underVelocity = mandate.orders_last_hour.length < mandate.max_orders_per_hour;
  add("R5_VELOCITY", underVelocity,
    underVelocity ? `${mandate.orders_last_hour.length} of ${mandate.max_orders_per_hour} hourly orders used.`
                  : `Hourly limit of ${mandate.max_orders_per_hour} orders reached.`);

  // R6 is the *gate*, not a hard stop: it upgrades allow -> confirm_required.
  const withinAuto = totalInr <= mandate.auto_approve_ceiling_inr;
  const tok = approvalToken ? approvals.get(approvalToken) : null;
  const validApproval = !!tok && !tok.used && tok.totalInr === totalInr
    && tok.itemIds === [...items.map((i) => i.id)].sort().join(",");
  add("R6_AUTO_APPROVE", withinAuto || validApproval,
    withinAuto ? `₹${totalInr} is at or below the ₹${mandate.auto_approve_ceiling_inr} auto-approve ceiling, so I can proceed on my own.`
    : validApproval ? `₹${totalInr} is above the ₹${mandate.auto_approve_ceiling_inr} auto-approve ceiling, but ${mandate.granted_by} approved this exact cart.`
    : `₹${totalInr} is above the ₹${mandate.auto_approve_ceiling_inr} auto-approve ceiling, so I need an explicit OK before paying.`);

  const hardFails = checks.filter((c) => !c.pass && c.rule !== "R6_AUTO_APPROVE");
  const decision = hardFails.length ? "deny"
    : checks.find((c) => c.rule === "R6_AUTO_APPROVE").pass ? "allow"
    : "confirm_required";

  // Lead with what actually drove the decision, then the supporting checks.
  const r6 = checks.find((c) => c.rule === "R6_AUTO_APPROVE");
  const reasons = decision === "deny"
    ? hardFails.map((c) => c.message)
    : decision === "confirm_required"
      ? [r6.message, ...checks.filter((c) => c.pass).map((c) => c.message)]
      : checks.filter((c) => c.pass).map((c) => c.message);

  return { decision, reasons, checks, rule_book: RULES };
}

/** Consumes the approval token and books the spend. Call only after Razorpay succeeds. */
export function commitSpend({ totalInr, approvalToken }) {
  if (approvalToken && approvals.has(approvalToken)) approvals.get(approvalToken).used = true;
  mandate.spent_this_cycle_inr += totalInr;
  mandate.orders_last_hour.push(Date.now());
  record({
    actor: "policy", action: "commit_spend",
    summary: `Booked ₹${totalInr} against the mandate. ₹${mandate.cycle_cap_inr - mandate.spent_this_cycle_inr} remains this month.`,
    detail: { totalInr, spent_this_cycle_inr: mandate.spent_this_cycle_inr },
  });
}
