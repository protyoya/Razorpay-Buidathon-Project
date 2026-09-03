import crypto from "node:crypto";
import fs from "node:fs";

const LOG = "data/audit.log.jsonl";
const listeners = new Set();
let chain = [];
let prevHash = "GENESIS";

/**
 * Append-only, hash-chained audit log.
 * Each entry commits to the previous entry's hash, so any edit to an earlier
 * record invalidates every hash after it. That is what makes the trail
 * *tamper-evident* rather than just a list of console.logs.
 */
export function record({ actor, action, summary, detail = {}, decision = null, reasons = [] }) {
  const entry = {
    seq: chain.length + 1,
    ts: new Date().toISOString(),
    actor,           // "agent" | "policy" | "razorpay" | "user"
    action,          // machine-readable, e.g. "create_payment_link"
    summary,         // PLAIN ENGLISH - this is what a human reads
    decision,        // "allow" | "confirm_required" | "deny" | null
    reasons,         // plain-English rule explanations
    detail,
    prev_hash: prevHash,
  };
  entry.hash = crypto.createHash("sha256")
    .update(prevHash + JSON.stringify({ ...entry, hash: undefined }))
    .digest("hex").slice(0, 16);
  prevHash = entry.hash;
  chain.push(entry);
  try { fs.appendFileSync(LOG, JSON.stringify(entry) + "\n"); } catch {}
  for (const fn of listeners) { try { fn(entry); } catch {} }
  return entry;
}

export const getTrail = () => chain;
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** Re-walk the chain. Used by GET /api/audit/verify - proves nothing was edited. */
export function verifyChain() {
  let prev = "GENESIS";
  for (const e of chain) {
    const expect = crypto.createHash("sha256")
      .update(prev + JSON.stringify({ ...e, hash: undefined }))
      .digest("hex").slice(0, 16);
    if (expect !== e.hash) return { valid: false, brokenAt: e.seq };
    prev = e.hash;
  }
  return { valid: true, entries: chain.length };
}

export function reset() { chain = []; prevHash = "GENESIS"; try { fs.rmSync(LOG, { force: true }); } catch {} }
