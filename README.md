# Kaira — a policy-gated agentic commerce rail on Razorpay

**Razorpay AI Buildathon · Track 01 — AI Growth & Agentic Commerce**

Anyone can wire an LLM to a payment link. The hard part is letting an agent spend
someone else's money **safely**. Kaira is a conversational checkout agent for a Razorpay
merchant, built around the part that actually matters: a **spend mandate** enforced in
code, and a **tamper-evident audit trail** of every rupee-affecting decision.

Everything below runs against Razorpay's **test mode** and creates **real** Orders and
Payment Links. No live keys, ever.

---

## The idea in one paragraph

A customer grants a standing, bounded authority — a *spend mandate* — to an agent:
*"you may spend up to ₹2,000 per order without asking me, never more than ₹10,000 in one
go, ₹15,000 a month, apparel and accessories only, three orders an hour."* The agent then
shops and pays inside a chat. Every money action is checked against that mandate **before**
any Razorpay call is made, in a pure function the model cannot argue with, and every
decision is written to a hash-chained log with the reasoning in plain English.

## Why this is not just a chatbot

| | Typical chat-to-payment demo | Kaira |
|---|---|---|
| Limits | Prompt says "don't spend over ₹2000" | `src/policy.js` — pure function, evaluated server-side; the tool refuses |
| Approval | Model decides it asked nicely | Single-use token minted by the UI, verified against the exact cart + total |
| Audit | `console.log` | Append-only SHA-256 hash chain; `/api/audit/verify` proves nothing was edited |
| Failure | Stack trace or silence | Structured error → agent apologises, explains, offers a real retry |

---

## Track 01 — where each requirement lives

**The bar**

| Requirement | Where |
|---|---|
| Every money action **explainable** | `policy.js` returns plain-English reasons; the agent relays them verbatim and they appear in the audit trail |
| **Bounded** | Hard ceiling ₹10,000/order, ₹15,000/month, category allow-list, 3 orders/hour — enforced in code, not prompt |
| **Gated** | Above ₹2,000 the agent stops; a single-use token bound to one exact cart *and* total unlocks payment |
| **Visible audit trail** | SHA-256 hash chain, tamper-evident, `GET /api/audit` and the in-app drawer |
| **One failure handled gracefully** | Simulated decline → apology, human explanation, retry offered. Never claims false success |

**Both halves of the brief**

| | |
|---|---|
| *Grow the merchant's revenue* | Conversational checkout + a cross-sell/upsell agent grounded in real catalogue data |
| *Make them sellable to AI buyers* | An MCP server and a `/.well-known/agent-manifest.json` — an outside agent can discover, browse and pay, under the same mandate |

## Run it

```bash
npm install
cp .env.example .env      # add your keys
npm run smoke             # ← 1. proves the Razorpay key works end-to-end
npm run smoke:llm         # ← 2. proves the model provider works end-to-end
npm run dev               # http://localhost:4123
```

Run both preflights before touching anything else. `npm run smoke` authenticates against
Razorpay, creates an Order, creates a Payment Link, reads it back, and prints a live test
link. `npm run smoke:llm` checks that your provider accepts the exact request shape
`src/agent.js` sends — probing each feature separately, so a failure names the field to drop
rather than just returning `400`.

### Model provider — Anthropic or OpenRouter

Set **one** of these in `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...        # Anthropic direct
OPENROUTER_API_KEY=sk-or-v1-...     # or OpenRouter (wins if both are set)
```

OpenRouter needs **no code change**: its "Anthropic Skin" serves the real Messages API at
`https://openrouter.ai/api/v1/messages`, so streaming, native tool use and multi-turn
context behave as they do against Anthropic directly. `src/config.js` switches the auth
header (`Authorization: Bearer` vs `x-api-key`) and prefixes the model id
(`claude-opus-5` → `anthropic/claude-opus-5`) automatically.

If `npm run smoke:llm` reports that your gateway rejects an Anthropic-native field
(`output_config.effort`, `cache_control`, or `strict: true` on tools), set
`LLM_STRICT_COMPAT=true` to drop them. Turns get slightly slower and prompt caching is
lost; nothing else changes.

**Test payment credentials:** card `4111 1111 1111 1111`, any future expiry, any CVV, then
click *Success*. UPI: `success@razorpay` (or `failure@razorpay` to force a real decline).

---

## Architecture

```
Browser (WhatsApp-styled UI)
   │  POST /api/chat                    ┌───────────────────────────────┐
   │  SSE  /api/stream ◄── deltas ──────┤ agent.js  manual tool-use loop │
   ▼                     ── audit ──────┤ Claude Opus 5, streaming       │
server.js (Express)                     └──────────────┬────────────────┘
   │                                                   │ every tool call
   │  POST /api/approve  ── mints single-use token     ▼
   │                                        ┌──────────────────────┐
   │                                        │ tools.js             │
   │                                        │  search / cart /     │
   │                                        │  check_policy /      │
   │                                        │  request_approval /  │
   │                                        │  create_payment_link │
   │                                        └───┬──────────────┬───┘
   │                                            │              │
   │                                   ┌────────▼─────┐  ┌─────▼──────────┐
   └── GET /payment/callback ◄─────────┤ policy.js    │  │ razorpay.js    │
       (HMAC signature verified)       │ THE GATE     │  │ Orders API     │
                                       │ allow /      │  │ Payment Links  │
                                       │ confirm /    │  │ (raw REST)     │
                                       │ deny         │  └────────────────┘
                                       └──────┬───────┘
                                              ▼
                                       audit.js — SHA-256 hash chain
```

### The gate (`src/policy.js`)

Six rules, evaluated as a pure function over `{items, totalInr, approvalToken}`:

| Rule | Effect on failure |
|---|---|
| `R1_MANDATE_ACTIVE` | deny |
| `R2_CATEGORY` | deny |
| `R3_HARD_CEILING` | deny — cannot be overridden by anyone in chat |
| `R4_CYCLE_CAP` | deny |
| `R5_VELOCITY` | deny |
| `R6_AUTO_APPROVE` | **upgrades** `allow` → `confirm_required` |

`create_payment_link` re-evaluates the policy itself immediately before calling Razorpay.
Prompt injection, a jailbroken model, or a hallucinated approval all hit the same wall.

### The audit trail (`src/audit.js`)

Each entry commits to the previous entry's hash. Editing record #3 invalidates #4 onward,
and `GET /api/audit` reports the break. Every entry carries a `summary` written for a
human, plus the `reasons` array the policy engine produced — the panel on the right of the
UI is that log, live.

### Paying without leaving the chat (Standard Checkout)

The agent's preferred path is `start_checkout`, which puts a Pay button in the conversation
and opens Razorpay's checkout modal inline via `checkout.js`.

| Endpoint | Purpose |
|---|---|
| `GET /api/config` | Returns the **publishable** `key_id` only. The secret never leaves the server. |
| `POST /api/create-order` | Creates the Razorpay order. **Takes no amount from the client** — see below. |
| `POST /api/verify-payment` | Verifies `HMAC-SHA256("<order_id>\|<payment_id>")`. Nothing counts as paid until this matches. |
| `POST /api/payment-cancelled` | Modal dismissed or `payment.failed` — the agent responds in chat rather than failing silently. |

**Why `create-order` ignores a client-supplied amount.** The conventional integration accepts
`{amount, currency}` from the browser. Here that would let anyone open devtools and charge
₹1 for a ₹9,798 cart — walking straight past the spend mandate that is the entire point of
this project. Instead the endpoint reads the server-held cart, computes the total, and runs
`evaluate()` before it calls Razorpay. A `POST` carrying `{"amount": 1}` is answered with a
₹1,299 order, and a cart that needs human approval gets a `403` with the policy's reasons.

A payment is only ever booked against the mandate after the signature verifies — a forged
signature returns `400`, is written to the audit trail as a denial, and changes no state.

### Razorpay endpoints used (`src/razorpay.js`)

| Call | Purpose |
|---|---|
| `POST /v1/orders` | Canonical record of intent. Amounts in **paise** (integer). |
| `POST /v1/payment_links` | The link handed to the shopper. `notify.*` is `false` so no real SMS/email goes out. |
| `GET /v1/payment_links/:id` | Polled to confirm payment — no webhook tunnel needed for the demo. |
| `GET /payment/callback` | Payment-link redirect, HMAC verified: `link_id\|ref_id\|status\|payment_id`. |

Note the two signature schemes differ: Standard Checkout signs `order_id|payment_id`, while
the Payment Link redirect signs `link_id|ref_id|status|payment_id`. Both are implemented.

Auth is HTTP Basic — `key_id` as username, `key_secret` as password. 5xx and 429 are
retried with backoff; 4xx is surfaced immediately as a structured tool error.

---

## The demo, in six moments

1. **Auto-approved** — *"get me a blue kurta under ₹1500"* → ₹1,299, under the ceiling.
   The agent transacts alone and says *why* it could. A Pay button appears in the chat and
   opens Razorpay's checkout inline; pay it with `4111 1111 1111 1111`.
2. **Sold up** — it offers what goes with the kurta from real stock, in one line. Accept one
   and the total climbs past ₹2,000.
3. **Gated** — the agent **stops**, names the limit it crossed, and approval buttons appear.
   Nothing is charged until they are tapped, and editing the cart afterwards voids the
   approval and cancels the link.
4. **Denied** — *"also grab me a MacBook"* → category outside the mandate. No workaround is
   attempted; a genuine alternative is offered instead.
5. **Failed gracefully** — tick *Simulate payment failure* → the payment declines. The agent
   apologises once, says the bank declined it, and offers to retry. It never claims success.
6. **A second buyer** — drive the same purchase from Claude Desktop over MCP and watch the
   identical policy stop it. Two buyers, one merchant, one audit trail.

---

## LLM transport, failover and token budget

`src/llm.js` sits between the agent loop and the model. It exposes the slice of the
Anthropic SDK's streaming interface the loop uses (`.on("text")`, `.finalMessage()`), so
`src/agent.js` never learns which provider answered.

| | |
|---|---|
| Primary | Anthropic Messages API — direct, or OpenRouter's Anthropic Skin |
| Failover | **Groq** (`openai/gpt-oss-120b`), free, no card |

Groq speaks OpenAI's shape, so requests and responses are translated: content blocks ↔
`tool_calls`, `tool_result` blocks ↔ `role:"tool"` messages, `input_schema` ↔ `parameters`,
`finish_reason` ↔ `stop_reason`.

Failover triggers on 429/402/529/503 or a rate-limit/credit message, parks the failed
provider for 5 minutes, and writes a `provider_failover` entry to the audit trail. It runs
**both ways** — if Groq is exhausted too, the primary is retried. Groq's own 429s carry
`"try again in 30ms"`, which is honoured rather than guessed at. `LLM_PROVIDER=groq` pins
Groq as primary.

### Token budget

Groq's free tier allows 8,000 tokens/minute, and every agent turn costs at least two
requests — so prompt size directly limits how fast you can converse.

| | Before | After |
|---|---|---|
| System prompt | ~977 | ~569 |
| Tool definitions | ~805 | ~624 |
| One search result | ~272 | ~69 |
| **Measured prompt** | ~1,500 | **~1,000** |
| **Turns per minute** | ~4 | **~7** |

Three changes got that: the system prompt and tool descriptions were compressed without
dropping a rule; `search_catalog` returns three lean products (`id`, `name`, `price`,
`sizes`) instead of five full records, with images, tags and stock carried out-of-band on
`_ui` so the browser still renders cards from data the prompt never sees; and history is
trimmed to the last 12 messages, never splitting a `tool_use` from its `tool_result`.

One behavioural note worth keeping: small models ignore a system-prompt rule to chain
`check_policy` → `start_checkout` and instead *describe* a Pay button that was never
created. Returning an explicit `next_step` in the policy tool's own result — where the model
is already reading — fixed it where prompt wording did not.

## Design

A warm glass surface: a slow orange-to-periwinkle wash sits behind frosted panels, with
`Instrument Serif` for headings and totals and `Inter` for UI text. The chat inside the glass
runs a **light** messenger theme, so the consumer surface and the operator surface still read
as different things without needing a dark/light split.

`public/styles.css` is a design system rather than ad-hoc rules — a 4pt spacing scale, a
paper-opacity ramp for glass depth, a three-step ink ramp, semantic decision colours shared
by the audit trail and the approval gate, tabular numerals on every money figure so digits
do not jitter as totals change, and one easing curve. `:focus-visible` rings and a
`prefers-reduced-motion` block are included. Favicon at `public/favicon.svg`.

Two notes from building it. Panels had to drop to ~48% opacity before the wash read as glass
rather than as flat white; and the voice orb had to stay **dark-bodied** — a light orb on a
light panel leaves the rim nothing to sit against, so it keeps a deep core with the brand
wash on its rim and a contact shadow to ground it.

## Transactable by an outside AI buyer

The chat UI in this repo is only one buyer. The same merchant is exposed to **any**
MCP-speaking agent, so an outside AI can browse, build a cart and pay end to end.

```bash
npm run dev      # storefront must be running
npm run mcp      # MCP server over stdio
```

Claude Desktop — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kurta-company": {
      "command": "node",
      "args": ["/absolute/path/to/Razorpay_proj/src/mcp-server.js"],
      "env": { "KAIRA_URL": "http://localhost:4123" }
    }
  }
}
```

Ten tools: `shop_search_catalog`, `shop_get_cart`, `shop_add_to_cart`,
`shop_remove_from_cart`, `shop_suggest_addons`, `shop_check_spend_policy`,
`shop_request_human_approval`, `shop_create_payment`, `shop_check_payment_status`,
`shop_get_audit_trail`.

### Discovery

An agent that finds the storefront learns how to transact with it before trying:

```
GET /.well-known/agent-manifest.json    merchant, tool schemas, spend policy, audit scheme
GET /api/agent/catalog                  machine-readable product feed
POST /api/agent/tools/{name}            invoke a tool directly, no model in the loop
```

The manifest publishes the **spend limits up front**, so a buying agent knows the ceiling
before it builds a cart it will not be allowed to pay for.

### Why it is a thin client

`src/mcp-server.js` calls the storefront's agent API rather than re-implementing anything.
Two consequences, both deliberate:

- **The gate cannot drift.** An external buyer is bounded by the same `policy.js` as the
  in-house agent — there is no second code path that could be given a softer rule.
  Verified: an outside agent adding a ₹9,798 cart is refused with `confirm_required` and the
  same plain-English reasons.
- **State is shared.** The browser UI updates live while an external agent shops — its
  searches, cart changes and approval requests all appear in the same session and the same
  hash-chained audit trail, tagged `external_invoke`.

Two buyers, one merchant, one audit trail.

## Surviving a model outage

Once a human has approved a cart, the policy has already allowed the spend — so the checkout
is created **server-side in `/api/approve`**, not by asking the model to remember to call a
tool. A rate-limited or failed model turn can no longer strand a customer who has already
said yes; the Pay button appears either way and the model only narrates afterwards.

Every agent turn outside `/api/chat` runs through `safeTurn`, which catches a provider
failure, records it, and emits a written fallback line. The earlier behaviour — an unhandled
rejection that logged an error and left the chat silent — is the worst possible outcome for
a payment flow, because the customer cannot tell whether they have been charged.

## Growing the order (cross-sell / upsell)

Track 01 asks for agents that grow merchant revenue, so the agent can suggest — never
assume. `suggest_addons` reads `pairs_with` and `upgrade_to` from the catalogue and returns
complementary items plus one dearer alternative for the priciest line. Everything offered is
real stock at a real price; the model cannot invent a product to upsell.

Three rules keep it from feeling like a pushy bot: at most two suggestions in one short
line, nothing enters the cart unless the customer asks, and a declined suggestion is dropped
immediately. An upgrade is mentioned once as a choice, never applied as a swap. Anything
accepted still passes the spend mandate like any other item, and the suggestion itself is
written to the audit trail.

## Layout

Three panes, so nothing hides anything else:

| Pane | Contents |
|---|---|
| Left | WhatsApp chat. In voice mode the orb **docks beneath it** (86px) rather than covering it |
| Middle | Cart — thumbnails, per-item −/+ and remove |
| Right | Cart on top, **Explore shop** beneath it |
| Drawer | The audit trail and spend mandate live in a **collapsible drawer**, closed by default — a tab on the right edge opens it, ✕ or `Esc` closes it |

The audit trail is the merchant's evidence, not the shopper's furniture, so it stays out of
the way until asked for. **Explore shop** opens a full-screen glass overlay with the whole
catalogue in a soft-cornered grid.

Editing the cart by hand clears any approval token: an approval is bound to one exact cart
and total, so changing the cart must invalidate it rather than carry consent across.

During voice mode there is no room to read a chat bubble while talking, so search results
surface as **floating rounded tiles** over the conversation for ~4.5s, then fade.

## Catalogue images

Each product carries an `image` field pointing at an SVG in `public/img/`, generated by
`node scripts/gen-images.mjs` from the product's colour and tags. They are offline,
dependency-free and licence-free, and they read clearly at thumbnail size. To use real
photography instead, drop `<sku>.jpg` into `public/img/` and update that product's `image`.

Product cards are rendered by the UI from `search_catalog`'s **own results**, not from the
model's prose — so the pictures and prices are always the catalogue's, never a hallucination.

## Voice shopping (optional, Fish Audio)

Tap the mic to enter **voice mode**: a full-panel reactive orb, hands-free turn taking,
and Kaira answering out loud. Off by default — with no `FISH_AUDIO_API_KEY` the mic button
hides and the app is exactly as before.

The orb (`public/blob.js`) is a dependency-free canvas renderer. Its radius, surface motion,
rim brightness and palette are driven by a live audio level read through a Web Audio
`AnalyserNode` — from the **microphone** while you speak, and from the **TTS output** while
Kaira speaks, so the same object animates both halves of the conversation.

| Phase | Orb |
|---|---|
| `listening` | cyan/blue, fast attack on your voice |
| `thinking` | amber/magenta, spins faster, ignores input |
| `speaking` | magenta/cyan, driven by the synthesised audio |
| `idle` | slow teal breathing |

Turn taking is automatic: it records until it hears ~1.1s of silence after speech, sends the
transcript, then re-opens the mic when Kaira finishes talking. Pause and ✕ are always
available.

```
Web Speech API (in-browser, free) ─────────┐
  live interim captions under the orb      │ transcript
  fallback: MediaRecorder ──▶ /api/voice/transcribe ──▶ Fish ASR (/v1/asr, paid credit)
                                           ▼
                                   normal agent turn
                                           │ reply text
browser <audio> ◀── POST /api/voice/speak ◀── Fish TTS (/v1/tts, s2.1-pro-free)
```

### Voice providers

`src/voice.js` routes each direction independently, so both run on a free tier:

| Direction | Default | Why |
|---|---|---|
| Speech-to-text, Chrome/Edge | **Web Speech API** (in-browser) | Free, no upload, live interim captions |
| Speech-to-text, other browsers | **Deepgram** `nova-3` | $200 free credits, no card. Fish ASR needs paid API credit |
| Text-to-speech | **Fish Audio** `s2.1-pro-free` | Genuinely free under fair use |

`VOICE_STT_PROVIDER` / `VOICE_TTS_PROVIDER` accept `auto` (default), `deepgram` or `fish`;
`auto` resolves against whichever keys are present. `VOICE_PREFER_BROWSER_STT=false` forces
the server-side recogniser even in Chrome. The provider that handled each utterance is named
in the audit trail.

**Latency.** Synthesis takes 3–4s for a typical reply, which would be dead air. So
`/api/voice/speak` is two steps: the `POST` starts synthesis and returns an id, and an
`<audio>` element points at `GET /api/voice/speak/:id`, which pipes Fish's chunked response
straight through. Playback begins on the first bytes rather than the last, so **audio starts
in ~0.3s regardless of how long the reply is** — measured, not estimated.

Verify whatever you configure before relying on it:

```bash
npm run smoke:voice     # synthesises a phrase, then transcribes it back
```

| Choice | Why |
|---|---|
| Audio proxied through our server | `FISH_AUDIO_API_KEY` never reaches the browser |
| `s2.1-pro-free` model | Free under Fish Audio's fair-use policy |
| Transcript fills the input box before sending | A misheard order is visible before it becomes a purchase |
| TTS response streamed (chunked) | Speech starts before the whole clip is synthesised |

The transcript is written to the audit trail as a `voice_input` entry, so a spoken order is
as reviewable as a typed one. Voice changes *how the shopper talks*, never what the agent is
allowed to do — every spoken request still passes through the same policy gate.

Config: `FISH_AUDIO_API_KEY`, plus optional `FISH_AUDIO_MODEL`, `FISH_AUDIO_VOICE_ID`
(a cloned or community voice), `FISH_AUDIO_SPEED`.

## Deliberate limits

- One in-memory session; not multi-tenant. This is a demo of a mechanism, not a product.
- Mandate lives in `src/policy.js`, not a database. In production it would be a signed,
  revocable credential issued at grant time.
- Payment confirmation is polled, not webhook-driven, so the demo needs no public tunnel.
  `verifyPaymentLinkSignature` shows the verification path a webhook build would use.
- The catalogue is a static JSON file standing in for a merchant's product feed.
