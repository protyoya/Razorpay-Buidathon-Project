import { VoiceBlob, Level } from "./blob.js";

const $ = (id) => document.getElementById(id);
const chat = $("chat"), trail = $("trail");
const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const scroll = (el) => (el.scrollTop = el.scrollHeight);

function bubble(text, dir) {
  const d = document.createElement("div");
  d.className = `msg ${dir}`;
  d.innerHTML = esc(text) + `<span class="t">${now()}</span>`;
  chat.appendChild(d); scroll(chat); return d;
}
function note(text) {
  const d = document.createElement("div");
  d.className = "tool"; d.textContent = text;
  chat.appendChild(d); scroll(chat);
}

// ---- streaming assistant bubble ----
let live = null, liveText = "";
function delta(t) {
  if (!live) { live = bubble("", "in"); liveText = ""; }
  liveText += t;
  live.innerHTML = esc(liveText) + `<span class="t">${now()}</span>`;
  scroll(chat);
}
const settle = () => { live = null; liveText = ""; };

// ---- audit trail ----
function entry(e) {
  const d = document.createElement("div");
  d.className = `ent ${e.decision || ""}`;
  d.innerHTML = `
    <div class="meta"><span class="actor">${e.actor}</span><span>#${e.seq} · ${e.ts.slice(11, 19)}</span></div>
    <div class="sum">${esc(e.summary)}</div>
    ${e.reasons?.length ? `<div class="why">${e.reasons.map((r) => `<div>• ${esc(r)}</div>`).join("")}</div>` : ""}
    <div class="hash">${e.prev_hash.slice(0, 8)} → ${e.hash}</div>`;
  trail.appendChild(d); scroll(trail);
}

// ---- SSE ----
const es = new EventSource("/api/stream");
es.addEventListener("delta", (m) => delta(JSON.parse(m.data).text));
es.addEventListener("message_done", (m) => { settle(); speak(JSON.parse(m.data).text); });
es.addEventListener("audit", (m) => { entry(JSON.parse(m.data)); refreshMandate(); });
es.addEventListener("tool_start", (m) => {
  settle();
  const { name } = JSON.parse(m.data);
  note({ search_catalog: "🔎 searching catalogue", add_to_cart: "🛒 updating cart",
         remove_from_cart: "🛒 updating cart", check_policy: "🛡️ checking spend policy",
         request_approval: "✋ needs your approval", create_payment_link: "💳 creating Razorpay payment link",
         start_checkout: "💳 opening Razorpay checkout",
         suggest_addons: "✨ finding things that go with it",
         search_catalog: "🔎 searching catalogue",
         check_payment_status: "🔄 checking payment status" }[name] || name);
});
es.addEventListener("payment_link", (m) => {
  settle();
  const { url, total_inr, id } = JSON.parse(m.data);
  const d = document.createElement("div");
  d.className = "paylink";
  d.innerHTML = `<b>Razorpay payment link</b><br><span style="color:#8696a0;font-size:12px">
    ₹${total_inr.toLocaleString("en-IN")} · ${id} · test mode</span>
    <a href="${url}" target="_blank" rel="noopener">Pay ₹${total_inr.toLocaleString("en-IN")} →</a>`;
  chat.appendChild(d); scroll(chat);
});
// ---- Razorpay Standard Checkout, opened inline in the chat ----
function renderPayButton(total_inr, label) {
  const box = document.createElement("div");
  box.className = "paybtn";
  box.innerHTML = `<div class="lbl">${label ?? "Pay securely without leaving the chat"}</div>
    <button>Pay ₹${total_inr.toLocaleString("en-IN")}</button>
    <div class="sec">Razorpay · test mode</div>`;
  const btn = box.querySelector("button");
  btn.onclick = () => openCheckout(btn, total_inr);
  chat.appendChild(box); scroll(chat);
  return box;
}

es.addEventListener("checkout_ready", (m) => {
  settle();
  renderPayButton(JSON.parse(m.data).total_inr);
});

/**
 * The cart changed, so anything already priced is void. Retire the stale Pay
 * button rather than leaving a control that would charge the old amount, and
 * offer a fresh one at the new total.
 */
es.addEventListener("checkout_stale", (m) => {
  const { total_inr, has_items } = JSON.parse(m.data);
  const stale = chat.querySelectorAll(".paybtn, .paylink");
  if (!stale.length) return;
  for (const el of stale) {
    el.classList.add("void");
    const b = el.querySelector("button");
    if (b) { b.disabled = true; b.textContent = "Price changed"; }
    const a = el.querySelector("a");
    if (a) { a.replaceWith(Object.assign(document.createElement("div"),
      { className: "sec", textContent: "Link cancelled — cart changed" })); }
  }
  note("🔄 cart changed — that price is no longer valid");
  if (has_items) renderPayButton(total_inr, "Updated total after your change");
});

async function openCheckout(btn, totalInr) {
  btn.disabled = true; btn.textContent = "Opening…";
  const reset = (label) => { btn.disabled = false; btn.textContent = label; };

  let order;
  try {
    const r = await fetch("/api/create-order", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    order = await r.json();
    if (!r.ok) {
      note(order.reasons?.[0] ? `🛡️ ${order.reasons[0]}` : `⚠️ ${order.message || "Could not start checkout"}`);
      return reset(`Pay ₹${totalInr.toLocaleString("en-IN")}`);
    }
  } catch {
    note("⚠️ Couldn't reach the server. Check it's still running.");
    return reset(`Pay ₹${totalInr.toLocaleString("en-IN")}`);
  }

  if (typeof window.Razorpay !== "function") {
    note("⚠️ Razorpay checkout script didn't load — check your connection.");
    return reset(`Pay ₹${totalInr.toLocaleString("en-IN")}`);
  }

  const rzp = new window.Razorpay({
    key: order.key_id,                 // publishable key only
    order_id: order.order_id,
    amount: order.amount,
    currency: order.currency,
    name: "Kurta Company",
    description: "Order via Kaira",
    theme: { color: "#00a884" },
    handler: async (resp) => {
      btn.textContent = "Verifying…";
      const v = await fetch("/api/verify-payment", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          razorpay_order_id: resp.razorpay_order_id,
          razorpay_payment_id: resp.razorpay_payment_id,
          razorpay_signature: resp.razorpay_signature,
        }),
      }).then((r) => r.json()).catch(() => ({ verified: false }));

      if (v.verified) { btn.textContent = `✅ Paid ₹${v.amount_inr.toLocaleString("en-IN")}`; }
      else { note("⚠️ Payment could not be verified — nothing has been charged to your account."); reset("Try again"); }
    },
    modal: {
      ondismiss: () => {
        reset(`Pay ₹${totalInr.toLocaleString("en-IN")}`);
        fetch("/api/payment-cancelled", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "dismissed" }) });
      },
    },
  });

  rzp.on("payment.failed", (e) => {
    reset("Try again");
    note(`❌ ${e.error?.description || "Payment failed"}`);
    fetch("/api/payment-cancelled", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "failed", code: e.error?.code }) });
  });

  rzp.open();
  reset(`Pay ₹${totalInr.toLocaleString("en-IN")}`);
}

es.addEventListener("approval_required", (m) => {
  settle();
  const p = JSON.parse(m.data);
  const box = $("approval");
  box.innerHTML = `<h4>Approval required</h4>
    <p>${esc(p.reason)}<br><b style="color:#e9edef">Total ₹${p.total_inr.toLocaleString("en-IN")}</b>
    — ${p.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(", ")}</p>
    <div class="row"><button class="yes">Approve ₹${p.total_inr.toLocaleString("en-IN")}</button>
    <button class="no">Decline</button></div>`;
  box.classList.remove("hidden");
  box.querySelector(".yes").onclick = () => decide(true);
  box.querySelector(".no").onclick = () => decide(false);
});

async function decide(approved) {
  $("approval").classList.add("hidden");
  note(approved ? "✅ you approved" : "🚫 you declined");
  await fetch("/api/approve", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved }) });
}

// ---- product cards ----
es.addEventListener("products", (m) => {
  settle();
  const { products } = JSON.parse(m.data);
  if (vActive) showTiles(products);      // voice mode: floating tiles
  // Append one at a time so options arrive at reading pace instead of flooding.
  const row = document.createElement("div");
  row.className = "products";
  chat.appendChild(row);
  products.forEach((p, i) => setTimeout(() => {
    const card = document.createElement("div");
    card.className = "pcard";
    card.innerHTML = `<img src="${p.image}" alt="${esc(p.name)}" loading="lazy">
      <div class="n">${esc(p.name)}</div>
      <div class="p">₹${p.price_inr.toLocaleString("en-IN")}</div>`;
    row.appendChild(card); scroll(chat);
  }, i * 320));
});

// ---- cart panel ----
function renderCart(c) {
  const lines = $("cart-lines");
  $("cart-count").textContent = `${c.count} item${c.count === 1 ? "" : "s"}`;
  $("cart-total").textContent = inr(c.total_inr);
  if (!c.items.length) { lines.innerHTML = `<p class="empty">Nothing yet.</p>`; return; }
  lines.innerHTML = c.items.map((i) => `
    <div class="cline">
      <img src="${i.image}" alt="">
      <div class="info">
        <div class="nm">${esc(i.name)}</div>
        <div class="sub">${inr(i.price_inr)}${i.size ? ` · size ${esc(i.size)}` : ""}</div>
        <div class="qty">
          <button data-id="${i.id}" data-q="${i.qty - 1}" title="Fewer">−</button>
          <span class="n">${i.qty}</span>
          <button data-id="${i.id}" data-q="${i.qty + 1}" title="More">+</button>
          <button class="rm" data-id="${i.id}" data-q="0" title="Remove">remove</button>
        </div>
      </div>
      <div class="amt">${inr(i.line_total_inr)}</div>
    </div>`).join("");

  for (const b of lines.querySelectorAll("button")) {
    b.onclick = async () => {
      const qty = Number(b.dataset.q);
      if (qty < 0 || qty > 5) return;
      const r = await fetch("/api/cart/update", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: b.dataset.id, qty }) });
      if (r.ok) renderCart(await r.json());
    };
  }
}

/**
 * Floating product tiles. In voice mode there is no room to read a chat bubble,
 * so what the agent found surfaces briefly as tiles over the conversation.
 */
let tileTimer = null;
function showTiles(products) {
  const box = $("tiles");
  clearTimeout(tileTimer);
  box.innerHTML = products.slice(0, 3).map((p) => `
    <div class="tile">
      <img src="${p.image}" alt="${esc(p.name)}">
      <div class="n">${esc(p.name)}</div>
      <div class="p">₹${p.price_inr.toLocaleString("en-IN")}</div>
    </div>`).join("");
  tileTimer = setTimeout(() => {
    for (const t of box.children) t.classList.add("out");
    setTimeout(() => (box.innerHTML = ""), 500);
  }, 4500);
}
es.addEventListener("cart_updated", (m) => renderCart(JSON.parse(m.data)));

// ═══════════════════════════════════════════════════════════════════════
// Voice mode — ChatGPT-style: a reactive blob, hands-free turn taking.
// ═══════════════════════════════════════════════════════════════════════
let voiceOn = false, blob = null, micLevel = null, ttsLevel = null;
let recorder = null, chunks = [], stream = null;
let vActive = false, paused = false, meterRaf = null;

// Speech-to-text: the browser does it free, in-process, with live interim text.
// Fish Audio's ASR is the fallback for browsers without it (it needs paid API credit).
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, finalText = "";
let sttProvider = null, ttsProvider = null, preferBrowserStt = true;
const useNativeStt = () => !!SR && preferBrowserStt;

/**
 * The orb runs on the browser's own Web Audio analyser, so voice mode is always
 * available. A Fish Audio key adds the two things that need a server:
 * transcription of what you said, and Kaira speaking back.
 */
async function initVoice() {
  $("mic").classList.remove("hidden");         // orb works with or without a key
  const st = await (await fetch("/api/voice/status")).json().catch(() => ({}));
  voiceOn = !!st.enabled;
  sttProvider = st.stt; ttsProvider = st.tts;
  if (st.preferBrowserStt === false) preferBrowserStt = false;
}

const vstatus = (t) => ($("vstatus").textContent = t);
const vheard  = (t) => ($("vheard").textContent = t);

function setPhase(p, label) { blob?.setState(p); vstatus(label); }

async function openVoice() {
  Level.resume();                              // browsers need a gesture first
  $("voicedock").classList.remove("hidden");
  vActive = true; paused = false;
  blob ??= new VoiceBlob($("blob"));
  blob.start();
  vheard("");
  await listen();
}

function closeVoice() {
  vActive = false;
  stopSpeaking();
  stopListening();
  cancelAnimationFrame(meterRaf); meterRaf = null;
  blob?.stop();
  $("voicedock").classList.add("hidden");
  $("tiles").innerHTML = "";
}

/** Drives the blob from whichever source is live. */
function meter(src) {
  cancelAnimationFrame(meterRaf);
  const tick = () => { meterRaf = requestAnimationFrame(tick); blob?.setLevel(src.read()); };
  tick();
}

// ---- listening, with silence detection so it's hands-free ----
async function listen() {
  if (!vActive || paused || recorder) return;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { setPhase("idle", "Microphone blocked"); return; }

  micLevel = new Level().fromStream(stream);
  meter(micLevel);
  setPhase("listening", "Listening…");

  if (useNativeStt()) return listenNative();     // free, live captions

  if (!sttProvider) {                      // no browser STT and no server provider
    setPhase("listening", "Listening…");
    vheard("No speech-to-text available. Use Chrome, or set DEEPGRAM_API_KEY in .env.");
    return;
  }

  chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = onClipReady;
  recorder.start();

  // Wait for speech, then for ~1.1s of quiet after it.
  let spoke = false, quietFor = 0, last = performance.now();
  const watch = () => {
    if (!recorder || recorder.state !== "recording") return;
    const now = performance.now(), dt = now - last; last = now;
    const lvl = micLevel.read();
    if (lvl > 0.10) { spoke = true; quietFor = 0; }
    else if (spoke) quietFor += dt;
    if (spoke && quietFor > 1100) return stopListening();
    if (!spoke && now - startedAt > 9000) return stopListening();   // nothing said
    requestAnimationFrame(watch);
  };
  const startedAt = performance.now();
  requestAnimationFrame(watch);
}

/** Browser-native recognition. The analyser stream still drives the orb. */
function listenNative() {
  setPhase("listening", "Listening…");
  finalText = "";
  recog = new SR();
  recog.lang = "en-IN";
  recog.interimResults = true;
  recog.continuous = false;
  recog.maxAlternatives = 1;

  recog.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    vheard(finalText + interim);           // live caption under the orb
  };

  recog.onerror = (e) => {
    recog = null;
    if (e.error === "not-allowed") return setPhase("idle", "Microphone blocked");
    if (e.error === "no-speech") return vActive && !paused && listen();
    setPhase("listening", "Didn't catch that");
    if (vActive && !paused) listen();
  };

  recog.onend = async () => {
    recog = null;
    const said = finalText.trim();
    stream?.getTracks().forEach((t) => t.stop());
    micLevel?.detach();
    if (!vActive) return;
    if (!said) return paused ? undefined : listen();

    vheard(`“${said}”`);
    setPhase("thinking", "Thinking…");
    blob?.setLevel(0.35);
    bubble(said, "out"); settle();
    await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: said }) });
    // reply arrives over SSE -> speak() continues the loop
  };

  recog.start();
}

function stopListening() {
  if (recog) { try { recog.stop(); } catch {} return; }
  if (recorder?.state === "recording") recorder.stop();
  else { stream?.getTracks().forEach((t) => t.stop()); recorder = null; micLevel?.detach(); }
}

async function onClipReady() {
  stream?.getTracks().forEach((t) => t.stop());
  const blobData = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
  recorder = null; micLevel?.detach();
  if (!vActive) return;
  if (blobData.size < 1500) return listen();            // nothing worth sending

  setPhase("thinking", "Thinking…");
  blob?.setLevel(0.35);
  try {
    const r = await fetch("/api/voice/transcribe", { method: "POST",
      headers: { "Content-Type": blobData.type }, body: blobData });
    const j = await r.json();
    if (!r.ok || !j.text) { setPhase("listening", "Didn't catch that"); return listen(); }
    vheard(`“${j.text}”`);
    bubble(j.text, "out"); settle();
    await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: j.text }) });
    // the reply arrives over SSE; speak() takes it from there
  } catch {
    setPhase("listening", "Connection problem");
    listen();
  }
}

/**
 * The mic dictates one message into the box; the black button is hands-free
 * voice mode. Two different jobs, matching the two icons.
 */
let dictating = null;
$("mic").onclick = () => {
  if (dictating) { try { dictating.stop(); } catch {} return; }
  if (!SR) return note("Dictation needs Chrome or Edge.");
  const mic = $("mic");
  const r = new SR();
  r.lang = "en-IN"; r.interimResults = true; r.continuous = false;
  let finalT = "";
  r.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) finalT += res[0].transcript; else interim += res[0].transcript;
    }
    $("input").value = (finalT + interim).trim();
    syncPrimary();
  };
  r.onerror = () => {};
  r.onend = () => { dictating = null; mic.classList.remove("rec"); $("input").focus(); syncPrimary(); };
  dictating = r; mic.classList.add("rec"); r.start();
};

$("plus").onclick = openShop;

/** The primary button sends when there is text, and opens voice mode when empty. */
function syncPrimary() {
  const has = $("input").value.trim().length > 0;
  const b = $("primary");
  b.classList.toggle("send", has);
  b.setAttribute("aria-label", has ? "Send" : "Voice mode");
  b.title = has ? "Send" : "Voice mode";
}
$("input").addEventListener("input", syncPrimary);
syncPrimary();
$("v-close").onclick = closeVoice;
$("v-mute").onclick = () => {
  paused = !paused;
  $("v-mute").textContent = paused ? "Resume" : "Pause";
  if (paused) { stopListening(); blob?.setLevel(0); setPhase("idle", "Paused"); } else listen();
};

/**
 * Speak the agent's reply, driving the blob from the TTS output.
 *
 * One turn can emit several `message_done` events (a line before a tool call,
 * then the real answer), and each used to start its own clip — two voices
 * talking over each other. A generation counter makes the newest utterance the
 * only one: anything older is stopped and its response discarded.
 */
let audioEl = null, speechGen = 0;

function stopSpeaking() {
  speechGen++;
  if (audioEl) { try { audioEl.pause(); audioEl.removeAttribute("src"); audioEl.load(); } catch {} }
}

async function speak(text) {
  // Only the tab actually in voice mode speaks. The server broadcasts SSE to
  // every connected client, so without this a second open tab (or a stale one
  // from a reload) plays the same reply over the top of the first.
  if (!text || !vActive) return;
  if (!voiceOn) { listen(); return; }                // no TTS key -> stay hands-free anyway

  stopSpeaking();                    // cancel whatever is currently talking
  const gen = speechGen;
  try {
    const r = await fetch("/api/voice/speak", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (gen !== speechGen) return;   // superseded while synthesising
    if (!r.ok) { if (vActive) listen(); return; }
    const { id } = await r.json();
    if (gen !== speechGen) return;

    // Point the element at the streaming URL so playback starts on the first
    // bytes rather than after the whole clip has been synthesised.
    audioEl ??= new Audio();
    audioEl.preload = "auto";
    audioEl.src = `/api/voice/speak/${id}`;
    if (vActive) {
      ttsLevel ??= new Level();
      ttsLevel.fromElement(audioEl);
      meter(ttsLevel);
      setPhase("speaking", "Speaking…");
      audioEl.onended = () => { if (vActive && gen === speechGen) listen(); };
    }
    await audioEl.play().catch(() => { if (vActive) listen(); });
  } catch { if (vActive) listen(); }
}

// ---- composer ----
async function send(text) {
  if (!text) return;
  $("input").value = "";
  bubble(text, "out"); settle();
  await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }) });
}
$("composer").onsubmit = (e) => {
  e.preventDefault();
  const text = $("input").value.trim();
  if (text) { send(text); syncPrimary(); }
  else openVoice();                            // empty box -> hands-free mode
};

// ---- audit drawer: collapsed by default, opened on demand ----
const drawer = $("auditdrawer"), atoggle = $("audit-toggle");
function setDrawer(open) {
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  atoggle.classList.toggle("open", open);
  atoggle.setAttribute("aria-expanded", String(open));
  atoggle.title = open ? "Hide the audit trail" : "Show the audit trail";
}
atoggle.onclick = () => setDrawer(!drawer.classList.contains("open"));
$("audit-close").onclick = () => setDrawer(false);
addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("shop").classList.contains("hidden")) return closeShop();
  setDrawer(false);
});

// ---- explore shop: glass overlay over the whole screen ----
let shopLoaded = false;
async function openShop() {
  const box = $("shop");
  box.classList.remove("hidden");
  if (shopLoaded) return;
  const { products } = await (await fetch("/api/catalog")).json();
  $("shop-grid").innerHTML = products.map((p, i) => `
    <div class="sitem${p.stock ? "" : " out"}" style="animation-delay:${Math.min(i, 12) * 28}ms">
      <img src="${p.image}" alt="${esc(p.name)}" loading="lazy">
      <div class="b">
        <div class="n">${esc(p.name)}</div>
        <div class="m">${esc(p.category)}${p.sizes[0] !== "free" ? ` · ${esc(p.sizes.join(", "))}` : ""}</div>
        <div class="p">${inr(p.price_inr)}</div>
      </div>
    </div>`).join("");
  shopLoaded = true;
}
const closeShop = () => $("shop").classList.add("hidden");
$("explore").onclick = openShop;
$("shop-close").onclick = closeShop;
$("shop").onclick = (e) => { if (e.target === $("shop")) closeShop(); };

// ---- cross-sell / upsell strip ----
es.addEventListener("addons", (m) => {
  settle();
  const { addons, upgrade } = JSON.parse(m.data);
  if (!addons.length && !upgrade) return;
  const box = document.createElement("div");
  box.className = "addons";
  box.innerHTML = `
    ${addons.length ? `<div class="cap">Goes well with</div>
    <div class="row">${addons.slice(0, 3).map((a) => `
      <div class="a"><img src="${a.image}" alt="${esc(a.name)}">
        <div class="n">${esc(a.name)}</div>
        <div class="p">${inr(a.price_inr)}</div></div>`).join("")}</div>` : ""}
    ${upgrade ? `<div class="up">Or step up to <b>${esc(upgrade.name)}</b> at ${inr(upgrade.price_inr)}</div>` : ""}`;
  chat.appendChild(box); scroll(chat);
});

// ---- mandate panel ----
const inr = (n) => "₹" + n.toLocaleString("en-IN");
async function refreshMandate() {
  const m = await (await fetch("/api/mandate")).json();
  $("mandate-id").textContent = m.id;
  $("m-auto").textContent = inr(m.auto_approve_ceiling_inr);
  $("m-hard").textContent = inr(m.max_per_order_inr);
  $("m-left").textContent = inr(m.cycle_cap_inr - m.spent_this_cycle_inr);
  renderCart(await (await fetch("/api/cart")).json());
  const v = await (await fetch("/api/audit")).json();
  const p = $("integrity");
  p.textContent = v.integrity.valid ? `${v.integrity.entries} entries · chain intact` : "CHAIN BROKEN";
  p.className = "pill" + (v.integrity.valid ? " good" : "");
  $("audit-count").textContent = v.integrity.entries;
  return v;
}

/**
 * The trail is fed by live SSE, so a page reload would leave it empty while the
 * counter still claimed entries existed. Replay what the server already holds.
 */
async function hydrateTrail() {
  const v = await refreshMandate();
  if (!v?.entries?.length || trail.children.length) return;
  for (const e of v.entries) entry(e);
}
$("reset").onclick = async () => { await fetch("/api/reset", { method: "POST" });
  chat.innerHTML = ""; trail.innerHTML = ""; refreshMandate(); greet(); };

function greet() { bubble("Hi! I'm Kaira from Kurta Company 👋\n\nTell me what you're looking for and I'll sort out the payment right here.", "in"); }
hydrateTrail(); greet(); initVoice();
