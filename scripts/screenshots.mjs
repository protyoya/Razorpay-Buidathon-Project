/**
 * Capture the README screenshots by driving the real app.
 *   1. npm run dev          (storefront must be running)
 *   2. node scripts/screenshots.mjs
 *
 * Uses the system Chrome via puppeteer-core, so nothing large is downloaded.
 * Each shot is a genuine application state, not a mock-up.
 */
import puppeteer from "puppeteer-core";

const BASE = process.env.KAIRA_URL || "http://localhost:4123";
const OUT = "docs/screenshots";
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const chat = async (text) => {
  await fetch(`${BASE}/api/chat`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
};

/** Poll the audit trail until `pred` holds, so we never screenshot a half-finished turn. */
async function until(pred, timeout = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const a = await (await fetch(`${BASE}/api/audit`)).json();
    if (pred(a.entries)) return a.entries;
    await wait(900);
  }
  throw new Error("timed out waiting for the agent");
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--window-size=1280,940", "--force-device-scale-factor=2",
         "--use-fake-ui-for-media-stream", "--font-render-hinting=none"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 940, deviceScaleFactor: 2 });

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ✓ ${name}.png`);
};

await fetch(`${BASE}/api/reset`, { method: "POST" });
await page.goto(BASE, { waitUntil: "networkidle2" });
await page.evaluate(() => document.fonts.ready);
await wait(900);

// 1 — the agent finds real stock and shows it
console.log("capturing…");
await chat("show me blue kurtas under 1500");
await until((e) => e.some((x) => x.action === "search_catalog"));
await wait(3500);
await shot("01-conversation");

// 2 — cross-sell, grounded in the catalogue
await chat("the indigo one in M please");
await until((e) => e.some((x) => x.action === "suggest_addons"));
await wait(3500);
await shot("02-cross-sell");

// 3 — the gate: agent stops and asks a human
await chat("add the kolhapuri chappal in size 9 too, then pay");
await until((e) => e.some((x) => x.action === "request_approval"));
await wait(3000);
await shot("03-approval-gate");

// 4 — the evidence
await page.click("#audit-toggle");
await wait(900);
await shot("04-audit-trail");
await page.click("#audit-close");
await wait(600);

// 5 — the catalogue overlay
await page.click("#explore");
await wait(1400);
await shot("05-explore-shop");
await page.click("#shop-close");
await wait(500);

// 6 — voice mode (the mic itself needs a real device, so the dock is driven directly)
await page.evaluate(async () => {
  const m = await import("./blob.js");
  document.getElementById("voicedock").classList.remove("hidden");
  const b = new m.VoiceBlob(document.getElementById("blob"));
  b.setState("speaking"); b.setLevel(0.62); b.start();
  document.getElementById("vstatus").textContent = "Speaking…";
  document.getElementById("vheard").textContent = "“add the kolhapuri chappal in size nine too”";
});
await wait(1200);
await shot("06-voice-mode");

await browser.close();
console.log(`\ndone → ${OUT}/`);
